// Accept a delivery as one journaled command batch. Imports and copied files are staged first, so a failed import
// cannot leave half of a batch on the character. Files kept after undo are intentional: redo needs them.
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Command } from '../../src/model/command-types.ts'
import { applyCommands } from '../../src/model/commands.ts'
import { setsOf } from '../../src/model/folk.ts'
import { isFolk } from '../../src/engine/folk.ts'
import type { Character, Gear, Placement, Skin, ClothSlot } from '../../src/model/types.ts'
import { runCommands } from '../commands.ts'
import { HttpError } from '../http.ts'
import { characterDir, events, getCharacter, getSettings, paths } from '../store.ts'
import { glbBounds, placementOf } from '../forge/publish.ts'
import { safeCharacterFolder, uploadPiece } from '../routes/gear.ts'
import { incomingDir, listIncoming, readPackage, safeFile, type IncomingPart, type IncomingManifest } from './read.ts'
import { changeState } from './state.ts'

export interface AcceptRequest { package: string, parts: string[], character: string, set?: string, replace?: Record<string, string> }
export interface IngestSink {
  character: (id: string) => Promise<Character | null>
  upload: (id: string, bytes: Buffer, name: string, from: string | undefined, signal?: AbortSignal) => Promise<Gear>
  commands: (id: string, make: (c: Character) => Command[], by?: string) => Promise<number | undefined>
  placement: (c: Character) => Promise<Placement>
}
const sink: IngestSink = {
  character: getCharacter,
  upload: uploadPiece,
  commands: async (id, make, by) => (await runCommands(id, make, { by, what: 'incoming.accept' })).entry?.seq,
  placement: async c => {
    const worn = c.gear.find(g => g.attach.kind === 'skin' && g.from?.startsWith('emberhold:'))
    if (worn?.attach.kind === 'skin') return structuredClone(worn.attach.place)
    // A configured Forge body is the v6 reference used by the existing publish path.
    const settings = await getSettings()
    const config = JSON.parse(await readFile(path.join(settings.gameRepo, 'forge.json'), 'utf8')) as { body?: string }
    if (!config.body) throw new Error('No v6 body reference or existing skin placement; cannot place this delivery')
    return placementOf(await glbBounds(path.resolve(settings.gameRepo, config.body)), await glbBounds(path.join(characterDir(c.id), c.source.file)))
  },
}
interface Staged { part: IncomingPart, gear?: Gear, texture?: Skin, targetId?: string, replacementModel?: string }
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** Resolve and validate the complete request before starting a job. */
export async function validateAccept (req: AcceptRequest): Promise<void> {
  if (!req || typeof req !== 'object' || typeof req.package !== 'string' || typeof req.character !== 'string' || !ID.test(req.package) || !ID.test(req.character) || !Array.isArray(req.parts) || !req.parts.length || req.parts.some(p => typeof p !== 'string' || !ID.test(p)) || new Set(req.parts).size !== req.parts.length || (req.set !== undefined && (typeof req.set !== 'string' || !ID.test(req.set))) || (req.replace !== undefined && (!req.replace || typeof req.replace !== 'object' || Array.isArray(req.replace) || Object.entries(req.replace).some(([k, v]) => !req.parts.includes(k) || typeof v !== 'string' || !ID.test(v))))) throw new HttpError(400, 'Name a package, character and distinct parts')
  const character = await getCharacter(req.character)
  if (!character) throw new HttpError(404, 'No such character')
  if (!isFolk(character)) throw new HttpError(400, 'Incoming parts require a dynamic character')
  const listing = await listIncoming(character)
  const pkg = listing.packages.find(p => p.id === req.package)
  if (!pkg) throw new HttpError(404, 'No such package')
  const targets = new Set<string>()
  for (const id of req.parts) {
    const part = pkg.parts.find(p => p.id === id)
    if (!part) throw new HttpError(404, `No part ${id}`)
    if (part.damaged || part.status !== 'pending') throw new HttpError(409, `${id}: ${part.damaged ?? `already ${part.status}`}`)
    const target = req.replace?.[id]
    if (target && (!['piece', 'hair', 'beard'].includes(part.type) || !character.gear.some(g => g.id === target))) throw new HttpError(400, `${id}: invalid replacement`)
    const resolved = target ?? (part.from ? character.gear.find(g => g.from === part.from)?.id : undefined)
    if (resolved && targets.has(resolved)) throw new HttpError(400, `${id}: more than one part replaces the same gear`)
    if (resolved) targets.add(resolved)
  }
}

function commandsFor (c: Character, staged: Staged[], manifest: IncomingManifest, req: AcceptRequest, place: Placement | null): Command[] {
  const commands: Command[] = []
  let work = c
  const add = (command: Command): void => { commands.push(command); work = applyCommands(work, [command]).character }
  for (const { part, gear, texture, targetId, replacementModel } of staged) {
    if (gear) {
      const currentTarget = req.replace?.[part.id] ?? (part.from ? work.gear.find(g => g.from === part.from)?.id : undefined)
      if (currentTarget !== targetId) throw new Error(`${part.name}: the replacement changed while importing`)
      if (targetId) {
        if (!work.gear.some(g => g.id === targetId)) throw new Error(`Replacement ${targetId} disappeared`)
        add({ type: 'gear.update', id: targetId, patch: { model: replacementModel, ...(part.from ? { from: part.from } : {}) } })
      } else {
        if (!place) throw new Error('No placement for the new piece')
        const setId = req.set ?? part.set
        if (setId && work.folk === undefined) throw new Error('This character needs its legacy dressing migrated before accepting into a set')
        let set = setId ? setsOf(work).find(s => s.id === setId) : undefined
        if (setId && !set) {
          const source = manifest.sets?.find(s => s.id === setId)
          add({ type: 'folk.set.add', set: { id: setId, name: source?.name ?? setId, pieces: [], tags: source?.tags ?? [], grants: [] } })
          set = setsOf(work).find(s => s.id === setId)
        }
        const role = part.role ?? (part.type === 'hair' || part.type === 'beard' ? part.type : undefined)
        const piece: Gear = { ...gear, attach: { kind: 'skin', policy: part.policy ?? 'body', place, ...(part.hideBody ? { hideBody: true } : {}) }, ...(part.tags?.length ? { tags: part.tags } : {}), ...(role ? { role } : {}), ...(part.swapSet ? { swapSet: part.swapSet } : {}), ...(set && work.folk?.sets.find(s => s.name === set!.name)?.id === set.id ? { outfit: set.name } : {}) }
        add({ type: 'gear.add', gear: piece })
        if (set) {
          const current = work.folk?.sets.find(s => s.id === set!.id)
          if (!current) throw new Error(`Set ${set.id} disappeared`)
          if (!current.pieces.includes(piece.id)) add({ type: 'folk.set.pieces', id: current.id, pieces: [...current.pieces, piece.id] })
        }
      }
    } else if (texture) {
      const type = part.type === 'skin' ? 'look.skins.set' : 'look.clothes.set'
      const old = type === 'look.skins.set' ? work.look.skins ?? [] : work.look.clothes ?? []
      const existing = old.find(x => x.name === texture.name)
      const replacement = { ...texture, ...(texture.hair === undefined && existing?.hair !== undefined ? { hair: existing.hair } : {}), ...(texture.tags === undefined && existing?.tags !== undefined ? { tags: existing.tags } : {}) }
      add(type === 'look.skins.set' ? { type, skins: [...old.filter(x => x.name !== texture.name), replacement] } : { type, clothes: [...old.filter(x => x.name !== texture.name), replacement] })
      if (type === 'look.skins.set' && existing?.bare !== undefined) add({ type: 'look.skin.bare', name: texture.name, file: null })
      if (type === 'look.clothes.set' && part.slots?.length) {
        const layer = work.look.cloth?.find(x => x.name === texture.name)
        const slots = part.slots.filter((s): s is ClothSlot => ['top', 'bottom', 'over'].includes(s))
        if (!layer || slots.length !== part.slots.length) throw new Error(`${part.name}: invalid clothing slots`)
        add({ type: 'look.cloth.update', id: layer.id, patch: { slots } })
      }
    }
  }
  return commands
}

/** Run inside a character files job. A failed import leaves the delivery pending and makes no journal entry. */
export async function ingest (req: AcceptRequest, o: { by?: string, signal?: AbortSignal, sink?: IngestSink, progress?: (n: number, text: string) => void } = {}): Promise<void> {
  await validateAccept(req)
  const impl = o.sink ?? sink
  const root = path.join(await incomingDir(), req.package)
  const { manifest, errors } = await readPackage(root)
  const c = await impl.character(req.character)
  if (!c || !isFolk(c)) throw new Error('Incoming parts require a dynamic character')
  const staged: Staged[] = []
  const created: string[] = []
  const temporary: string[] = []
  let committed = false
  try {
    for (const [i, id] of req.parts.entries()) {
      o.signal?.throwIfAborted()
      const index = manifest.parts.findIndex(p => p.id === id)
      if (index < 0 || errors[index]) throw new Error(`${id}: ${errors[index] ?? 'not found'}`)
      const part = manifest.parts[index]
      const bytes = await readFile(await safeFile(root, part.file))
      if (createHash('sha256').update(bytes).digest('hex') !== part.sha256.toLowerCase()) throw new Error(`${id}: SHA256 mismatch`)
      o.progress?.(i / req.parts.length, `Importing ${part.name}`)
      if (['piece', 'hair', 'beard'].includes(part.type)) {
        const gear = await impl.upload(c.id, bytes, `${part.name}.glb`, part.from, o.signal)
        const dir = paths(c.id).garment(gear.id)
        created.push(dir)
        const targetId = req.replace?.[id] ?? (part.from ? c.gear.find(g => g.from === part.from)?.id : undefined)
        let replacementModel: string | undefined
        if (targetId) {
          if (!c.gear.some(g => g.id === targetId) || !gear.model) throw new Error(`${id}: invalid replacement`)
          replacementModel = `garments/${targetId}/incoming-${randomBytes(8).toString('hex')}.glb`
          const dest = path.join(characterDir(c.id), replacementModel)
          await safeCharacterFolder(c.id, 'garments', targetId)
          await copyFile(path.join(characterDir(c.id), gear.model), dest, constants.COPYFILE_EXCL)
          created.push(dest); temporary.push(dir)
        }
        staged.push({ part, gear, targetId, replacementModel })
      } else {
        const png = Buffer.from('89504e470d0a1a0a', 'hex')
        if (bytes.length < 33 || !bytes.subarray(0, 8).equals(png) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20) || ![8, 16].includes(bytes[24]) || bytes[25] !== 6) throw new Error(`${id}: expected an RGBA PNG`)
        const folder = part.type === 'skin' ? 'skins' : 'clothes'
        const rel = `${folder}/incoming-${randomBytes(8).toString('hex')}.png`
        const dest = path.join(characterDir(c.id), rel)
        await safeCharacterFolder(c.id, folder); await writeFile(dest, bytes, { flag: 'wx' }); created.push(dest)
        staged.push({ part, texture: { name: part.name, file: rel, ...(part.hair ? { hair: part.hair } : {}), ...(part.tags?.length ? { tags: part.tags } : {}) } })
      }
    }
    const needsPlace = staged.some(({ part, gear }) => gear && !req.replace?.[part.id] && !(part.from && c.gear.some(g => g.from === part.from)))
    const place = needsPlace ? await impl.placement(c) : null
    o.signal?.throwIfAborted()
    const seq = await impl.commands(c.id, now => commandsFor(now, staged, manifest, req, place), o.by)
    committed = true
    if (seq === undefined) throw new Error('Incoming acceptance produced no journal entry')
    await changeState(state => { for (const { part, gear } of staged) state[`${req.package}/${part.id}`] = { status: 'accepted', sha: part.sha256, at: new Date().toISOString(), character: c.id, seq, ...(gear ? { gear: req.replace?.[part.id] ?? c.gear.find(g => part.from && g.from === part.from)?.id ?? gear.id } : {}) } })
    for (const dir of temporary) await rm(dir, { recursive: true, force: true }).catch(() => {})
    events.emit('incoming', { pending: (await listIncoming()).pending })
  } finally {
    if (!committed) for (const file of created) await rm(file, { recursive: true, force: true })
  }
}
