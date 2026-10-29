// A character put back as a game build had it: POST /api/characters/:id/restore takes a unit's build record (what
// tools/lib/unit_export.ts wrote to <work>/<unit>/rigsmith.json; the game keeps it as `sources.rigsmith` of the unit's
// texture provenance) and applies it as one undoable batch of commands, journaled by the caller (x-rigsmith-by).
// tools/game_import.py is its client: it brings the parts the build carries in through the gear upload route first,
// then names them here (where each sits, whether it shows, a re-pivoted mesh).
//
//   record   schema 4 (or 3, its holds made pieces): its slots (gear named by name), hands (hands.hold) and gearIds (to map handle ids by name);
//            schema 2: the same, its slots moved into source time through the blow cut the record says (its clips'
//            `blow`, the library clip's length: src/model/migrate.ts slotFromV2); schema 1: its clips (clip, url, loop, inPlace, speed, lift, keyData,
//            blow) and scripts, read with the v1 converters (src/model/migrate.ts slotsFromV1 / holdsFromV1), its keys
//            moved into source time through the cut it records as a v1 file's are. A build from before Rigsmith held
//            the clips is sent as a schema 1 record game_import made from the game's old clip table.
//   clips    the game's clip names to take, in order (default: every clip of the record); a clip's variants (`Attack 2`...,
//            src/model/variants.ts) come with it, and one is taken alone by the name the game plays it as (Attack_2)
//   replace  as the build has it: the set replaced, the hands it held taken and, when `gear` is given, gear it doesn't
//            name removed (files are never deleted; an undo brings it back). Without it, only what the character lacks
//            comes in: clips of names it has no slot for, the hands only when it holds none, gear only as named.
//   gear     parts the build carries: each found by id, else by `from`; its name, bone, placement, shown or hidden, and
//            a new mesh (`model`: a GLB, base64, written beside the old one as garments/<id>/model.<hash>.glb)
//   dryRun   only work the batch out: { commands, notes }
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Command } from '../../src/model/command-types.ts'
import { applyCommands, CommandError } from '../../src/model/commands.ts'
import { newId } from '../../src/model/ids.ts'
import { holdsFromV1, piecesFromHolds, slotFromV2, slotsFromV1 } from '../../src/model/migrate.ts'
import { freshSet, gearById } from '../../src/model/select.ts'
import { exportName, gameNameOf, variantName, variantOf } from '../../src/model/variants.ts'
import type { Character, Gear, GearTrack, HandPoseRef, Placement, Side, Slot } from '../../src/model/types.ts'
import type { V1AnimationEntry, V1ClipScript } from '../../src/model/v1.ts'
import type { V2Slot } from '../../src/model/v2.ts'
import type { V3Slot } from '../../src/model/v3.ts'
import { runCommands } from '../commands.ts'
import { by, HttpError, readBody, route, send } from '../http.ts'
import { type Change, getCharacter, LIBRARY, paths, readJson, withFiles } from '../store.ts'

/** A part of the build, as game_import found it. */
export interface RestoreGear {
  /** Which piece: its id, else the piece whose `from` this is ('emberhold:<unit>/<part>'). */
  id?: string
  from?: string
  /** Its name (game parts are named by the game: Weapons_RightHand, GearAxe...). */
  name?: string
  /** The bone it rides (it is put on that bone if it rides another or isn't on a bone). */
  bone?: string
  place?: Placement
  hidden?: boolean
  /** A new mesh for it, a GLB as base64 (a part re-pivoted to where it is held, or rebuilt from the game's). */
  model?: string
}

export interface RestoreRequest {
  record?: unknown
  clips?: string[]
  replace?: boolean
  gear?: RestoreGear[]
  /** The unit it was built as, for the journal. */
  unit?: string
  dryRun?: boolean
}

export interface RestorePlan { commands: Command[], notes: string[] }

const SIDES: Side[] = ['Left', 'Right']
const fromGame = (g: Gear): boolean => g.from?.startsWith('emberhold:') === true
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** v2, v3 and v4 build record fields restore reads (src/model/unit.ts BuildRecord). */
interface RecordV2 {
  schema: 2 | 3 | 4
  /** Schema 4: as stored; schema 3: schema 3's (with holds); schema 2: schema 2's slots. */
  slots: Slot[] | V3Slot[] | V2Slot[]
  clips?: Record<string, { blow?: number }>
  hands?: Partial<Record<Side, HandPoseRef>>
  gearIds?: Record<string, { name: string, from?: string, handles?: Record<string, string> }>
}
/** v1 build record fields restore reads (tools/game_export.ts before schema 2). */
interface RecordV1 {
  /** `blow`: where its blow cut found the blow (seconds of the clip at its speed). */
  clips?: Record<string, { clip?: string, url?: string, loop?: boolean, inPlace?: boolean, speed?: number, lift?: number, keyData?: V1AnimationEntry['keys'], blow?: number }>
  /** `did` of a blow script: what its cut found (`blow` as above). */
  scripts?: Array<V1ClipScript & { did?: unknown }>
}

/**
 * The batch that puts `c` back as the build had it (see the header). Each command is applied as it is made, so the
 * next is made against what the batch will have by then; a refused one throws the reducers' CommandError.
 * `modelFile(gear, i)` is where the i-th gear entry's new mesh was written (relative to the character folder).
 */
export function restoreCommands (c: Character, req: RestoreRequest, makeId: () => string, modelFile: (gear: Gear, index: number) => string,
  o: { clipSeconds?: (clipId: string) => number | undefined } = {}): RestorePlan {
  const commands: Command[] = []
  const notes: string[] = []
  let work = c
  const run = (cmd: Command): void => {
    work = applyCommands(work, [cmd]).character
    commands.push(cmd)
  }
  const now = (id: string): Gear => gearById(work, id)!

  // The parts it carries: each where the build had it.
  const named = new Set<string>()
  for (const [i, e] of (req.gear ?? []).entries()) {
    const g = e.id !== undefined ? gearById(work, e.id) : e.from !== undefined ? work.gear.find(x => x.from === e.from) : undefined
    const what = e.name ?? e.from ?? e.id ?? `gear ${i + 1}`
    if (g === undefined) {
      if (req.dryRun === true) { notes.push(`${what}: not here yet (brought in before the batch is applied)`); continue }
      throw new CommandError(404, `No gear ${e.id ?? `from ${e.from ?? '?'}`}: bring it in first (the gear upload route)`)
    }
    named.add(g.id)
    const from = e.from ?? g.from
    if (e.name !== undefined && e.name !== g.name) {
      // (the game names its gear, so a piece from it is taken out of its hands for the rename and given back)
      run({ type: 'gear.update', id: g.id, patch: fromGame(g) ? { from: null, name: e.name } : { name: e.name } })
    }
    if (from !== now(g.id).from) run({ type: 'gear.update', id: g.id, patch: { from: from ?? null } })
    if (e.model !== undefined) run({ type: 'gear.update', id: g.id, patch: { model: modelFile(now(g.id), i) } })
    if (e.hidden !== undefined && e.hidden !== (now(g.id).hidden === true)) run({ type: 'gear.update', id: g.id, patch: { hidden: e.hidden } })
    const attach = now(g.id).attach
    if (e.bone !== undefined && (attach.kind !== 'bone' || attach.bone !== e.bone)) {
      run({ type: 'gear.attach', id: g.id, attach: { kind: 'bone', bone: e.bone, place: e.place ?? attach.place } })
    } else if (e.place !== undefined && (!same(attach.place, e.place) || (attach.kind === 'bone' && attach.legacyFrame !== undefined))) {
      run({ type: 'gear.place', id: g.id, place: e.place })
    }
  }
  if (req.replace === true && req.gear !== undefined) {
    for (const g of [...work.gear]) if (!named.has(g.id)) run({ type: 'gear.remove', id: g.id })
  }

  // Its clips and hands.
  const record = req.record
  if (isObj(record)) {
    const v2 = (record.schema === 2 || record.schema === 3 || record.schema === 4) && Array.isArray(record.slots)
    const set = v2 ? fromV2(record as unknown as RecordV2, work, req.clips, notes, o.clipSeconds) : fromV1(record as RecordV1, work, notes, o.clipSeconds)
    let slots = set.slots
    if (req.clips !== undefined) {
      const wanted = [...new Set(req.clips)]
      const missing = wanted.filter(n => picked(slots, [n]).length === 0)
      if (missing.length > 0) notes.push(`the build has no clip ${missing.join(', ')}`)
      slots = picked(slots, wanted)
    }
    const fresh = freshSet(slots, makeId)
    if (req.replace === true) {
      knownPoses(fresh, work, notes)
      run({ type: 'clips.replace', slots: fresh, ...set.names })
    } else {
      const have = new Map(work.clips.map(s => [s.name, s.id]))
      const added = fresh.filter(s => !have.has(s.name))
      // (a clip that paces like one this character has already follows that one)
      const byFresh = new Map(fresh.map(s => [s.id, s.name]))
      for (const s of added) {
        const pace = s.time?.pace
        if (pace !== undefined && !added.some(x => x.id === pace.like)) pace.like = have.get(byFresh.get(pace.like) ?? '') ?? pace.like
      }
      const kept = fresh.filter(s => have.has(s.name)).map(s => s.name)
      if (kept.length > 0) notes.push(`kept as they are here: ${kept.join(', ')} (--replace takes the build's)`)
      knownPoses(added, work, notes)
      if (added.length > 0) run({ type: 'clips.replace', slots: [...structuredClone(work.clips), ...added], ...set.names })
    }
    const hold = set.hold
    const holds = work.hands.hold ?? {}
    if (req.replace === true || Object.keys(holds).length === 0) {
      const poses = new Set(work.hands.poses.map(p => p.id))
      for (const side of SIDES) {
        let want = hold[side] ?? null
        if (want === null && req.replace !== true) continue
        if (want !== null && typeof want === 'object' && 'pose' in want && !poses.has(want.pose)) {
          notes.push(`the ${side.toLowerCase()} hand held in every clip: its hand pose ${want.pose} isn't one of this character's: the default fist instead`)
          want = 'default'
        }
        if (!same(holds[side] ?? null, want)) run({ type: 'hands.hold', side, pose: want })
      }
    } else if (SIDES.some(side => hold[side] !== undefined && !same(holds[side], hold[side]))) {
      notes.push('the hands it holds in every clip kept as they are here (--replace takes the build\'s)')
    }
  } else if (record !== undefined && record !== null) {
    throw new CommandError(400, 'record must be a build record (an object)')
  }
  return { commands, notes }
}

/** A schema 4 (3 or 2) record's slots, their gear references (by name in the record) made into ids clips.replace maps by
 * name: gearNames for every name (and this character's own gear ids, for the slots kept beside them), handleNames for
 * the handles by the names the record gives their ids. Only the slots named `only` (all when unset). A schema 2 record's
 * slots are moved into source time (slotFromV2) through the cut it records: the blow it found, the length of the
 * library clip (`clipSeconds`); without that length they keep their phases, said in `notes`. */
function fromV2 (r: RecordV2, c: Character, only: string[] | undefined, notes: string[], clipSeconds?: (clipId: string) => number | undefined): { slots: Slot[], hold: Partial<Record<Side, HandPoseRef>>, names: { gearNames: Record<string, string>, handleNames: Record<string, string> } } {
  const gearNames: Record<string, string> = {}
  const handleNames: Record<string, string> = {}
  for (const g of c.gear) gearNames[g.id] = g.name
  const handlesOf = new Map<string, Record<string, string>>()
  for (const x of Object.values(r.gearIds ?? {})) if (!handlesOf.has(x.name)) handlesOf.set(x.name, x.handles ?? {})
  // (references become tokens no gear id here has, each standing for a name)
  const tokens = new Map<string, string>()
  const token = (gearName: string): string => {
    let t = tokens.get(gearName)
    if (t === undefined) {
      t = `restored_${tokens.size}`
      tokens.set(gearName, t)
      gearNames[t] = gearName
    }
    return t
  }
  const chosen = only === undefined ? r.slots as Array<Slot | V2Slot> : picked(r.slots as Array<Slot | V2Slot>, only)
  // (a schema 3 record's holds become pieces as a schema 3 file's do: through the library clip's length; without it,
  // dropped and said)
  const fromV3 = (s: V3Slot, i: number): Slot => {
    if (!(s.time?.holds ?? []).some(h => h.seconds > 0)) return piecesFromHolds(s, 1, '')
    const seconds = clipSeconds?.(s.clip.id)
    if (seconds !== undefined) return piecesFromHolds(s, seconds, `${c.id}:restored:${i}`)
    notes.push(`clip ${s.name}: its holds dropped (the length of ${s.clip.id} isn't known)`)
    return piecesFromHolds({ ...s, time: { ...s.time, holds: [] } }, 1, '')
  }
  const sources: Slot[] = r.schema === 4 ? structuredClone(chosen as Slot[]) : r.schema === 3 ? (structuredClone(chosen) as V3Slot[]).map(fromV3) : (structuredClone(chosen) as V2Slot[]).map((s, i) => {
    // (keys on gear by name, as the record has them, until the tokens below)
    const seconds = clipSeconds?.(s.clip.id)
    const blow = r.clips?.[s.name]?.blow
    return slotFromV2(s, { characterId: c.id, index: i, times: seconds === undefined ? undefined : { seconds, ...(blow !== undefined ? { blow } : {}) }, notes })
  })
  const slots = sources.map(s => {
    if (s.gear !== undefined) {
      const out: Record<string, GearTrack> = {}
      for (const [n, t] of Object.entries(s.gear)) out[token(n)] = t
      s.gear = out
    }
    if (s.muted !== undefined) s.muted = s.muted.map(m => (m.startsWith('gear:') ? `gear:${token(m.slice(5))}` : m))
    for (const a of s.adjustments) {
      if (a.kind === 'handPose' && a.gear !== undefined) a.gear = token(a.gear)
      if (a.kind === 'handleHold') {
        const gearName = a.gear
        a.gear = token(gearName)
        const handle = handlesOf.get(gearName)?.[a.handle]
        if (handle !== undefined) handleNames[`${a.gear}/${a.handle}`] = handle
      }
    }
    return s
  })
  return { slots, hold: structuredClone(r.hands ?? {}), names: { gearNames, handleNames } }
}

/** The slots `wanted` names (the game's clip names), in its order: each clip's own slot, then its variants (`Attack 2`
 * for Attack); a variant named as the game plays it (Attack_2) alone. */
function picked<S extends { name: string }> (slots: S[], wanted: string[]): S[] {
  // (the game's clips: those named, and the clip a name as the game plays a variant stands for, when the slots have
  // that variant: the clip itself may not be among them)
  const names = slots.map(s => s.name)
  const games = [...new Set([...wanted, ...wanted.map(n => {
    const m = /^(.+)_(\d+)$/.exec(n)
    return m !== null && names.includes(variantName(m[1], Number(m[2]))) ? gameNameOf(n, [...names, m[1]]) : n
  })])]
  const out: S[] = []
  for (const n of wanted) {
    for (const s of slots) {
      if (s.name !== n && exportName(s.name, games) !== n) continue
      if (!out.includes(s)) out.push(s)
    }
    const variants = slots.map(s => ({ s, v: variantOf(s.name, games) })).filter(x => x.v?.base === n).sort((a, b) => a.v!.n - b.v!.n)
    for (const { s } of variants) if (!out.includes(s)) out.push(s)
  }
  return out
}

/** A schema 1 record's clips and scripts as slots on this character's gear (by name) and hands, their keys moved into
 * source time through the cut the record says (as a v1 file's are: src/model/migrate.ts): the blow it found (its clip's
 * `blow`, else its blow script's `did.blow`) and the library clip's length (`clipSeconds`); without the length they keep
 * their phases, said in `notes`. */
function fromV1 (r: RecordV1, c: Character, notes: string[], clipSeconds?: (clipId: string) => number | undefined): { slots: Slot[], hold: Partial<Record<Side, HandPoseRef>>, names: Record<string, never> } {
  const animations: V1AnimationEntry[] = Object.entries(r.clips ?? {}).flatMap(([name, x]) => {
    if (typeof x?.clip !== 'string' || x.clip === '') {
      notes.push(`${name}: the build names no clip for it`)
      return []
    }
    return [{
      name, clipId: x.clip, url: x.url, loop: x.loop === true, inPlace: x.inPlace !== false, speed: x.speed ?? 1,
      lift: x.lift, keys: x.keyData,
    }]
  })
  const scripts = (r.scripts ?? []).map(s => {
    const { did, ...rest } = s
    void did
    return rest as V1ClipScript
  })
  const gearIdByName: Record<string, string> = {}
  for (const g of c.gear) gearIdByName[g.name] ??= g.id
  const poses = new Set(c.hands.poses.map(p => p.id))
  const found: Record<string, number> = {}
  for (const s of r.scripts ?? []) {
    const did = s.did as { blow?: unknown } | undefined
    if (s.kind === 'blow' && typeof did?.blow === 'number') found[s.clip] ??= did.blow
  }
  const slots = slotsFromV1(animations, scripts, gearIdByName, c.id, { poses, notes }).map((s, i) => {
    const seconds = clipSeconds?.(s.clip.id)
    const blow = r.clips?.[s.name]?.blow ?? found[s.name]
    const times = seconds === undefined ? undefined : { seconds, ...(typeof blow === 'number' ? { blow } : {}) }
    return slotFromV2(s, { characterId: c.id, index: i, times, notes, windowsInSource: true })
  })
  return { slots, hold: holdsFromV1(scripts, { poses, notes }), names: {} }
}

/** A hand pose these slots name that the character doesn't have becomes the default fist (as the migration does),
 * noted: a build's poses are its character's, which this one may lack. */
function knownPoses (slots: Slot[], c: Character, notes: string[]): void {
  const poses = new Set(c.hands.poses.map(p => p.id))
  for (const s of slots) {
    for (const a of s.adjustments) {
      if (a.kind !== 'handPose' || typeof a.pose !== 'object' || !('pose' in a.pose) || poses.has(a.pose.pose)) continue
      notes.push(`${s.name}: its hand pose ${a.pose.pose} isn't one of this character's: the default fist instead`)
      a.pose = 'default'
    }
  }
}

function same (a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

// ---- the route --------------------------------------------------------------------------------------------------

/** A request body checked for its shape (the reducers check the rest). */
export function requestOf (body: unknown): RestoreRequest {
  if (!isObj(body)) throw new HttpError(400, 'A restore is { record, clips?, replace?, gear?, dryRun? }')
  const clips = body.clips
  if (clips !== undefined && !(Array.isArray(clips) && clips.every(n => typeof n === 'string'))) throw new HttpError(400, 'clips is a list of clip names')
  const gear = body.gear
  if (gear !== undefined && !(Array.isArray(gear) && gear.every(isObj))) throw new HttpError(400, 'gear is a list of parts')
  for (const g of (gear ?? []) as Array<Record<string, unknown>>) {
    if (g.id === undefined && g.from === undefined) throw new HttpError(400, 'Each part names its gear id or where it is from')
    if (g.model !== undefined && typeof g.model !== 'string') throw new HttpError(400, 'A part\'s model is a GLB as base64')
  }
  return body as RestoreRequest
}

/** The library clips' lengths (seconds), what moving a schema 2 record's slots into source time needs. */
async function clipSeconds (): Promise<(clipId: string) => number | undefined> {
  const manifest = await readJson<{ clips?: Array<{ id: string, duration?: number }> } | null>(path.join(LIBRARY, 'manifest.json'), null)
  const by = new Map((manifest?.clips ?? []).map(x => [x.id, x.duration]))
  return id => by.get(id)
}

/** The batch a dry run shows (new meshes named by where they would go). */
export const dryRun = async (c: Character, body: RestoreRequest): Promise<RestorePlan> =>
  restoreCommands(c, { ...body, dryRun: true }, newId, (g, i) => `garments/${g.id}/model.<new mesh ${i + 1}>.glb`, { clipSeconds: await clipSeconds() })

const unwritten = (g: Gear): never => { throw new HttpError(409, `${g.name}: its new mesh wasn't written (it changed meanwhile; try again)`) }

/** A new mesh's bytes, checked to be a GLB. */
function glbOf (base64: string): Buffer {
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67) throw new HttpError(400, 'A part\'s model must be a GLB')
  return bytes
}

/** Restore `id` as one journal entry by `who`: the new meshes written first, each beside the piece's old one under a
 * name of its own (a page that has the old one cached loads the new one; the old stays for an undo), then the batch.
 * Also what tools/restore.ts runs while no server does. */
export async function restore (id: string, body: RestoreRequest, who?: string): Promise<{ character: Character, entry: Change['entry'], commands: Command[], notes: string[] }> {
  const notes: string[] = []
  let commands: Command[] = []
  const done = await withFiles(id, async () => {
    const c = await getCharacter(id)
    if (c === null) throw new HttpError(404, 'No such character')
    const files = new Map<number, string>()
    for (const [i, e] of (body.gear ?? []).entries()) {
      if (e.model === undefined) continue
      const g = e.id !== undefined ? gearById(c, e.id) : c.gear.find(x => x.from === e.from)
      if (g === undefined) continue
      const bytes = glbOf(e.model)
      const file = `garments/${g.id}/model.${createHash('sha256').update(bytes).digest('hex').slice(0, 8)}.glb`
      const at = path.join(paths(id).garment(g.id), path.basename(file))
      if (!existsSync(at)) {
        await mkdir(path.dirname(at), { recursive: true })
        await writeFile(at, bytes)
      }
      files.set(i, file)
    }
    // (the journal's lines after the reducers': read once the batch is worked out under the lock)
    const seconds = await clipSeconds()
    const extra = body.unit !== undefined ? [`as the game's build of ${body.unit} had it${body.replace === true ? ' (replaced)' : ''}`] : []
    return await runCommands(id, cur => {
      const plan = restoreCommands(cur, { ...body, dryRun: false }, newId, (g, i) => files.get(i) ?? unwritten(g), { clipSeconds: seconds })
      commands = plan.commands
      notes.push(...plan.notes)
      extra.push(...plan.notes)
      return plan.commands
    }, { by: who, what: 'restore', changes: extra })
  })
  return { character: done.character, entry: done.entry, commands, notes }
}

route('POST', /^\/api\/characters\/([a-z0-9-]+)\/restore$/, async (req, res, [id]) => {
  let raw: unknown
  try {
    raw = JSON.parse((await readBody(req)).toString('utf8') || '{}')
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
  const body = requestOf(raw)
  if (body.dryRun === true) {
    const c = await getCharacter(id)
    if (c === null) throw new HttpError(404, 'No such character')
    send(res, 200, await dryRun(c, body))
    return
  }
  send(res, 200, await restore(id, body, by(req)))
})
