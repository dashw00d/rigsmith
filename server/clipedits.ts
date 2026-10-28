// Clips made in the animation editor (src/state/clipedit.svelte.ts), saved into the library: the edit (its frames on
// the base clip's own skeleton, and what it was made of: its keys and gear paths, to open it again) as
// workspace/library/sources/custom/<id>.edit.json, its line in the library's sources (made by blender/clips/edit.py),
// then the library's build: convert (which makes it) and aggregate (which lists it, tagged custom, in the base clip's
// category). A creature's edit (any template but the human) is a clip file of its own instead (saveCreatureClip). One
// save at a time: they share the library.
//
// A made clip is saved over in place only when no slot but the one it was saved from plays it (usesOf): otherwise the
// save forks it under a new id, so editing one character's clip never changes another's.
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Character, ClipKey } from '../src/model/types.ts'
import { spawnJob } from './jobs.ts'
import { LIBRARY, listCharacters, readJson, ROOT } from './store.ts'

export interface EditFrames { fps: number, bones: string[], rotations: number[][][], hips: number[][] }
/** Each gear piece's path through the clip (by the piece's name: library clips are shared across characters), as keys
 * from where it is placed: what a slot's keys on gear are, so a clip made with gear leading plays it as the editor
 * showed it. */
export type PropPaths = Record<string, ClipKey[]>
/** What an edit was made of, kept with it to open it again: how it was opened, the keys on bones, and each piece of
 * gear's path (by gear name: locked, it led). */
export interface EditMaking {
  mode?: 'plays' | 'alone' | 'held'
  /** The slot it was made on (its name then), and the character. */
  slot?: string
  character?: string
  keys?: Record<string, ClipKey[]>
  gear?: Record<string, { locked: boolean, keys: ClipKey[] }>
  /** A held clip's length (seconds). */
  length?: number
}
export interface SavedEdit {
  name: string
  /** The library clip it was made from (its skeleton's rest is the saved frames'). */
  base: string
  loop?: boolean
  propPaths?: PropPaths
  frames: EditFrames
  making?: EditMaking
  /** A clip made here before (custom-…) to save over, as itself (same id): refused (409) when a slot other than
   * `characterId`'s `slot` plays it. */
  replace?: string
  /** Who saves it: the character (its template decides library or creature clip) and its slot (by id) it goes into. */
  characterId?: string
  slot?: string
}

/** A slot that plays a library clip. */
export interface ClipUse { character: string, characterName: string, slot: string, slotName: string }

const MAKE = 'blender/clips/edit.py'
const ID = /^[\w.-]+$/

function slug (name: string): string {
  return name.trim().replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('_').slice(0, 60) || 'Clip'
}

/** A clip's name as saved: trimmed, and an edit of an edit not growing a second "edit" ("Attack edit edit" is
 * "Attack edit"; the id tells two clips of a name apart). */
export function editName (name: string): string {
  return name.trim().replace(/\s+/g, ' ').replace(/(\s+edit\b(\s+\d+)?){2,}$/i, ' edit')
}

/** Every slot of `characters` that plays clip `clipId`. */
export function usesOf (characters: readonly Character[], clipId: string): ClipUse[] {
  return characters.flatMap(c => c.clips.filter(s => s.clip.id === clipId).map(s => ({ character: c.id, characterName: c.name, slot: s.id, slotName: s.name })))
}

/** The slots playing `clipId` other than `slot` of character `characterId`: what saving over it would change. */
export function othersUsing (uses: readonly ClipUse[], characterId: string | undefined, slot: string | undefined): ClipUse[] {
  return uses.filter(u => !(u.character === characterId && u.slot === slot))
}

export async function clipUsage (clipId: string): Promise<ClipUse[]> {
  return usesOf(await listCharacters(), clipId)
}

/** Who uses `clip` besides `characterId`'s `slot`, in words. */
export function usesText (uses: readonly ClipUse[]): string {
  const shown = uses.slice(0, 3).map(u => `${u.characterName}'s ${u.slotName}`)
  return uses.length > 3 ? `${shown.join(', ')} and ${uses.length - 3} more` : shown.join(' and ')
}

/** The FBX whose armature has the base clip's rest: its source; a made clip's first input; an edit's own. */
async function restOf (base: string): Promise<string> {
  const meta = await readJson<{ sourcePath?: string, make?: string } | null>(path.join(LIBRARY, 'meta', `${base}.json`), null)
  if (meta === null) throw new Error(`No library clip ${base} (a clip from a bundled set can't be saved as a library clip)`)
  let rest: string | undefined
  if (meta.make === MAKE && meta.sourcePath !== undefined) rest = (await readJson<{ restFrom?: string }>(meta.sourcePath, {})).restFrom
  else if (meta.make !== undefined) {
    const sources = await readJson<Array<{ id: string, inputs?: string[] }>>(path.join(LIBRARY, 'work', 'sources.json'), [])
    rest = sources.find(s => s.id === base)?.inputs?.find(p => p.toLowerCase().endsWith('.fbx'))
  } else rest = meta.sourcePath
  if (rest === undefined || !rest.toLowerCase().endsWith('.fbx') || !existsSync(rest)) throw new Error(`The skeleton ${base} came from isn't here (${rest ?? 'unknown'})`)
  return rest
}

const isKey = (k: unknown): boolean => {
  const c = k as ClipKey
  return typeof c === 'object' && c !== null && Number.isFinite(c.u) && Array.isArray(c.q) && c.q.length === 4 && c.q.every(Number.isFinite) &&
    (c.p === undefined || (Array.isArray(c.p) && c.p.length === 3 && c.p.every(Number.isFinite)))
}
const isKeys = (ks: unknown): boolean => Array.isArray(ks) && ks.length <= 30 * 120 + 1 && ks.every(isKey)
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

export function checkEdit (e: SavedEdit): void {
  if (typeof e.name !== 'string' || e.name.trim() === '' || e.name.length > 80) throw new Error('Name the clip')
  if (typeof e.base !== 'string' || !ID.test(e.base)) throw new Error('Which clip was edited?')
  const f = e.frames
  if (f === undefined || !Array.isArray(f.bones) || !Array.isArray(f.rotations) || !Array.isArray(f.hips) || f.rotations.length !== f.hips.length || f.rotations.length < 1 || f.rotations.length > 30 * 120) throw new Error('No frames')
  if (!f.rotations.every(r => Array.isArray(r) && r.length === f.bones.length && r.every(q => Array.isArray(q) && q.length === 4 && q.every(Number.isFinite)))) throw new Error('Bad frames')
  if (!f.hips.every(p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))) throw new Error('Bad hips')
  if (!(Number.isFinite(f.fps) && f.fps > 1 && f.fps <= 240)) throw new Error('Bad frame rate')
  checkPropPaths(e.propPaths)
  checkMaking(e.making)
}

/** A prop path is a list of keys per gear name (or none). */
export function checkPropPaths (x: unknown): asserts x is PropPaths | undefined {
  if (x === undefined) return
  if (!isRecord(x) || !Object.entries(x).every(([n, ks]) => n.length <= 200 && isKeys(ks))) throw new Error('Bad gear paths')
}

export function checkMaking (x: unknown): asserts x is EditMaking | undefined {
  if (x === undefined) return
  if (!isRecord(x)) throw new Error('Bad edit record')
  if (x.mode !== undefined && !['plays', 'alone', 'held'].includes(x.mode as string)) throw new Error('Bad edit mode')
  for (const k of ['slot', 'character'] as const) if (x[k] !== undefined && (typeof x[k] !== 'string' || (x[k] as string).length > 200)) throw new Error(`Bad ${k}`)
  if (x.length !== undefined && !(Number.isFinite(x.length) && (x.length as number) > 0)) throw new Error('Bad length')
  if (x.keys !== undefined && !(isRecord(x.keys) && Object.values(x.keys).every(isKeys))) throw new Error('Bad keys')
  if (x.gear !== undefined && !(isRecord(x.gear) && Object.values(x.gear).every(p => isRecord(p) && typeof p.locked === 'boolean' && isKeys(p.keys)))) throw new Error('Bad gear paths')
}

async function run (command: string, args: string[], onLine: (line: string) => void, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnJob(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }, signal)
    let tail = ''
    const take = (d: Buffer): void => { const s = d.toString(); tail = (tail + s).slice(-3000); for (const l of s.split('\n')) if (l.trim() !== '') onLine(l) }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.on('error', reject)
    child.on('close', code => {
      if (signal?.aborted === true) reject(signal.reason instanceof Error ? signal.reason : new Error('Cancelled'))
      else if (code === 0) resolve()
      else reject(new Error(`${path.basename(args[0] ?? command)} ${args[1] ?? ''} failed: ${tail.trim().split('\n').slice(-3).join(' ')}`))
    })
  })
}

let queue: Promise<unknown> = Promise.resolve()
/** Ids handed out and not yet in the sources (a save still queued): never handed out twice. */
const reserved = new Set<string>()

/** The id an edit saves as: the made clip it replaces (one made here before), else a new one, reserved at once. */
export async function editId (e: SavedEdit): Promise<string> {
  if (typeof e.replace === 'string' && /^custom-[A-Za-z0-9_]+$/.test(e.replace) && existsSync(path.join(LIBRARY, 'meta', `${e.replace}.json`)) && !reserved.has(e.replace)) {
    reserved.add(e.replace)
    return e.replace
  }
  return await newId(editName(e.name))
}

/** The id a new clip of this name gets (one the library hasn't, nor a save still queued), reserved at once. */
export async function newId (name: string): Promise<string> {
  const base = `custom-${slug(name)}`
  const sources = await readJson<Array<{ id: string }>>(path.join(LIBRARY, 'work', 'sources.json'), [])
  const taken = new Set(sources.map(s => s.id))
  // (no await from here to the reservation: two calls at once can't pick the same id)
  let id = base
  for (let k = 2; taken.has(id) || reserved.has(id) || existsSync(path.join(LIBRARY, 'meta', `${id}.json`)); k++) id = `${base}_${k}`
  reserved.add(id)
  return id
}

/** Give back an id reserved for a save that never ran (refused before its job). */
export function release (id: string): void { reserved.delete(id) }

/** What an edit's record says, without its frames: how to open it again. Null when `id` wasn't made here. */
export async function editRecord (id: string): Promise<Record<string, unknown> | null> {
  if (!/^custom-[A-Za-z0-9_]+$/.test(id)) return null
  const record = await readJson<Record<string, unknown> | null>(path.join(LIBRARY, 'sources', 'custom', `${id}.edit.json`), null)
  if (record === null) return null
  delete record.frames
  return record
}

/** Save an edit into the library as clip `id`. On a failure (or a cancel) the sources and the record are put back as
 * they were, so the library's next build doesn't try a half-made clip. */
export async function saveEdit (id: string, e: SavedEdit, update: (progress: number, message: string) => void, signal?: AbortSignal): Promise<void> {
  try { checkEdit(e) } catch (error) { reserved.delete(id); throw error }
  const turn = queue.then(async () => {
    signal?.throwIfAborted()
    update(0.05, 'Finding the skeleton it came from')
    const restFrom = await restOf(e.base)
    const manifest = await readJson<{ clips: Array<{ id: string, name: string, category: string }> }>(path.join(LIBRARY, 'manifest.json'), { clips: [] })
    const from = manifest.clips.find(c => c.id === e.base)
    const dir = path.join(LIBRARY, 'sources', 'custom')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, `${id}.edit.json`)
    const name = editName(e.name)
    const edit = {
      id, name, base: e.base, category: from?.category ?? null, tags: ['custom'],
      description: `Made in Rigsmith's animation editor from ${from?.name ?? e.base}.`,
      restFrom, loop: e.loop ?? true, making: e.making ?? {}, propPaths: e.propPaths ?? {}, frames: e.frames, createdAt: new Date().toISOString(),
    }
    const sourcesFile = path.join(LIBRARY, 'work', 'sources.json')
    // (what to put back if it fails)
    const hadRecord = existsSync(file) ? await readFile(file, 'utf8') : null
    const hadSources = existsSync(sourcesFile) ? await readFile(sourcesFile, 'utf8') : null
    try {
      await writeFile(file, JSON.stringify(edit))
      // its line in the sources: the build makes it with blender/clips/edit.py
      const sources = await readJson<Array<Record<string, unknown>>>(sourcesFile, [])
      const line = {
        id, sha256: '', kind: 'clip', source: 'custom', sourcePath: file, make: MAKE, args: ['--edit', file],
        inputs: [file, restFrom, path.join(ROOT, 'blender', 'clips', 'common.py')], sourceName: id, name, originalName: name,
        description: edit.description, tags: edit.tags, category: edit.category,
      }
      await mkdir(path.dirname(sourcesFile), { recursive: true })
      await writeFile(sourcesFile, JSON.stringify([...sources.filter(s => s.id !== id), line], null, 1))
      update(0.2, 'Writing it into the library (Blender)')
      await run('python3', [path.join(ROOT, 'blender', 'library', 'build.py'), 'convert', '--sources', 'custom'], l => { if (/making|convert done/.test(l)) update(0.5, l.replace(/^\S+ /, '').slice(0, 100)) }, signal)
      if (!existsSync(path.join(LIBRARY, 'clips', `${id}.glb`))) throw new Error('Blender wrote no clip (see workspace/library/failures.json)')
      update(0.75, 'Listing it in the library')
      await run('python3', [path.join(ROOT, 'blender', 'library', 'build.py'), 'aggregate'], () => {}, signal)
    } catch (error) {
      if (hadRecord === null) await rm(file, { force: true })
      else await writeFile(file, hadRecord)
      if (hadSources === null) await rm(sourcesFile, { force: true })
      else await writeFile(sourcesFile, hadSources)
      throw error
    }
    update(1, `${name} is in the library (${id}, ${edit.category ?? 'its own category'})`)
  })
  queue = turn.catch(() => {})
  try { await turn } finally { reserved.delete(id) }
}

export interface CreatureClip { rig: string, name: string, base: string, category: string, loop: boolean, inPlace: boolean, duration: number, propPaths?: PropPaths, replace?: string }

/** A creature's clip (a horse's: not a library clip) saved as made: its file into workspace/library/creatures/<rig>/,
 * its line in creatures/index.json (server/library.ts lists them beside the bundled ones: source custom, tagged
 * custom, in the category of the clip it came from). `replace`: a creature clip made here before, saved over as
 * itself (the route checks no other slot plays it). */
export async function saveCreatureClip (p: CreatureClip, glb: Buffer): Promise<{ id: string, url: string }> {
  checkPropPaths(p.propPaths)
  if (!/^[a-z0-9_-]+$/.test(p.rig)) throw new Error('Which body?')
  if (p.name.trim() === '' || p.name.length > 80) throw new Error('Name the clip')
  if (!ID.test(p.base)) throw new Error('Which clip was edited?')
  if (glb.length < 20 || glb.readUInt32LE(0) !== 0x46546C67) throw new Error('Not a .glb')
  // (one save at a time: each reads and rewrites the creatures' index)
  const turn = queue.then(async () => await writeCreatureClip(p, glb))
  queue = turn.catch(() => {})
  return await turn
}

/** A creature clip made here before that `id` names (its index line), if any. */
export async function creatureClip (id: string): Promise<Record<string, unknown> | null> {
  const index = await readJson<{ clips: Array<Record<string, unknown>> }>(path.join(LIBRARY, 'creatures', 'index.json'), { clips: [] })
  return index.clips.find(c => c.id === id && c.source === 'custom') ?? null
}

async function writeCreatureClip (p: CreatureClip, glb: Buffer): Promise<{ id: string, url: string }> {
  const dir = path.join(LIBRARY, 'creatures')
  const indexFile = path.join(dir, 'index.json')
  const index = await readJson<{ clips: Array<Record<string, unknown>> }>(indexFile, { clips: [] })
  const name = editName(p.name)
  const own = p.replace === undefined ? undefined : index.clips.find(c => c.id === p.replace && c.source === 'custom' && c.rig === p.rig)
  let id = own?.id as string | undefined
  if (id === undefined) {
    const stem = `custom-${p.rig}-${slug(name)}`
    id = stem
    for (let k = 2; index.clips.some(c => c.id === id); k++) id = `${stem}_${k}`
  }
  await mkdir(path.join(dir, p.rig), { recursive: true })
  const file = `creatures/${p.rig}/${id}.glb`
  await writeFile(path.join(LIBRARY, file), glb)
  const frames = Math.round(p.duration * 30) + 1
  index.clips = [...index.clips.filter(c => c.id !== id), {
    id, name, description: `Made in Rigsmith's animation editor from ${p.base}.`, source: 'custom', nameSource: 'source', file, fps: 30, frames,
    duration: Math.round(p.duration * 1e4) / 1e4, category: p.category, tags: ['custom', p.loop ? 'loop' : 'one-shot', p.inPlace ? 'in-place' : 'root-motion'],
    loop: p.loop, inPlace: p.inPlace, rig: p.rig, base: p.base, ...(p.propPaths !== undefined && Object.keys(p.propPaths).length > 0 ? { propPaths: p.propPaths } : {}),
    createdAt: (own?.createdAt as string | undefined) ?? new Date().toISOString(), ...(own !== undefined ? { updatedAt: new Date().toISOString() } : {}),
  }]
  await writeFile(indexFile, JSON.stringify(index, null, 1))
  return { id, url: `/files/library/${file}` }
}
