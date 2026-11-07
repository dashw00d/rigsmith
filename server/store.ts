// The on-disk workspace: characters, library, settings. Plain files, no database. Every character document goes
// through here and is always schema 2 (src/model/types.ts): a v1 file is migrated the first time it is read
// (src/model/migrate.ts), its v1 copy kept beside it as character.v1.json.
//
// Every write is updateCharacter (or commit): under a per-character lock it reads the document, applies the change,
// bumps `version` and `updatedAt`, works out the entities it touched (src/model/entities.ts) and, for an undoable
// write, what undo needs; writes the file; journals it (server/journal.ts) unless told not to; then tells every open
// page (SSE `character`) and the afterChange hooks.
//
// Two locks per character: the store lock (character.json and journal.jsonl) and withFiles (model.glb, rigged.glb,
// weight_edits.json, garments/*/weights.json). A writer needing both takes withFiles first, then the store lock
// inside it, never the other way round.
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { constants, existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { bindJoints, readGlb } from '../src/engine/glb.ts'
import { touchedBy, undoRecord } from '../src/model/entities.ts'
import { migrate, migrateSettings, needsClipTimes, unmeasured, type MeasuredTimes, type MigrateContext, type Migration } from '../src/model/migrate.ts'
import type { Character, JournalEntry, Settings } from '../src/model/types.ts'
import type { GameSpec } from '../src/model/unit.ts'
import { HttpError } from './http.ts'
import { append, forgetJournal, note, readJournal } from './journal.ts'

export type { Character, JournalEntry, Settings, Vec3 } from '../src/model/types.ts'

export const ROOT = path.resolve(import.meta.dirname, '..')
export const WORKSPACE = path.resolve(process.env.RIGSMITH_WORKSPACE ?? path.join(ROOT, 'workspace'))
export const CHARACTERS = path.join(WORKSPACE, 'characters')
export const LIBRARY = path.join(WORKSPACE, 'library')
export const TRASH = path.join(WORKSPACE, 'trash')
/** Rigsmith's game units (server/game.ts owns it; read here to see what a delete would leave dangling). */
export const UNITS_FILE = path.join(WORKSPACE, 'game', 'units.json')
const SETTINGS = path.join(WORKSPACE, 'settings.json')
const DEFAULT_GAME_REPO = path.join(homedir(), 'dev', 'games', 'emberhold')

/** What open pages hear (server/routes/characters.ts streams it): 'job' Job, 'character' { character, entry? },
 * 'removed' id, 'journal' id, 'game' unit names. */
export const events = new EventEmitter()
events.setMaxListeners(100)

export async function ensureWorkspace (): Promise<void> {
  for (const dir of [CHARACTERS, LIBRARY]) await mkdir(dir, { recursive: true })
}

export async function readJson<T> (file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Atomic JSON write (temp file + rename) so a crash never leaves half a file. */
export async function writeJson (file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 1))
  await rename(temp, file)
}

const ID = /^[a-z0-9-]+$/
const PART = /^[A-Za-z0-9_-]+$/

export function characterDir (id: string): string {
  if (!ID.test(id)) throw new HttpError(400, 'Bad character id')
  return path.join(CHARACTERS, id)
}

/** Where a character's files are. Ids are checked, so a path never leaves the character's folder. */
export function paths (id: string): {
  dir: string, textures: string, layers: string, garment: (gid: string) => string, projection: (pid: string) => string
} {
  const dir = characterDir(id)
  return {
    dir,
    textures: path.join(dir, 'textures'),
    layers: path.join(dir, 'textures', 'layers'),
    garment: gid => {
      if (!PART.test(gid)) throw new HttpError(400, 'Bad gear id')
      return path.join(dir, 'garments', gid)
    },
    projection: pid => {
      if (!PART.test(pid)) throw new HttpError(400, 'Bad projection id')
      return path.join(dir, 'projections', pid)
    },
  }
}

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-')

// ---- locks ------------------------------------------------------------------------------------------------------

function chain (locks: Map<string, Promise<unknown>>) {
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const next = (locks.get(key) ?? Promise.resolve()).then(fn)
    const tail = next.catch(() => {})
    locks.set(key, tail)
    try {
      return await next
    } finally {
      if (locks.get(key) === tail) locks.delete(key)
    }
  }
}

/** The store lock: one reader-writer of a character's document and journal at a time. `fn` must not call
 * updateCharacter for the same character (it would wait for itself). */
export const locked = chain(new Map())

const migrations = chain(new Map())
const run = promisify(execFile)
const filesLock = chain(new Map())
/** One writer of a character's model files at a time (model.glb, rigged.glb, weight_edits.json,
 * garments/<id>/weights.json): writeWeights, swapImages, transformGlb, publishRig, compose take it. */
export async function withFiles<T> (id: string, fn: () => Promise<T>): Promise<T> { return await filesLock(id, fn) }

// ---- reading ----------------------------------------------------------------------------------------------------

/** The last version handed out per character: a v1 file written over a newer document by an offline tool must not
 * come back with an older version (pages ignore copies older than theirs). */
const versions = new Map<string, number>()

const fileOf = (id: string): string => path.join(characterDir(id), 'character.json')

/** The character as schema 5; null when there is none. Reading an older file migrates it. */
export async function getCharacter (id: string): Promise<Character | null> {
  const raw = await readJson<Record<string, unknown> | null>(fileOf(id), null)
  if (raw === null) return null
  if (raw.schema === 5) {
    versions.set(id, raw.version as number)
    return raw as unknown as Character
  }
  // (read again under the lock: another reader may have migrated it meanwhile)
  return await locked(id, async () => await loadLocked(id))
}

export async function listCharacters (): Promise<Character[]> {
  const entries = existsSync(CHARACTERS) ? await readdir(CHARACTERS) : []
  const all = await Promise.all(entries.filter(id => ID.test(id)).map(async id => {
    try {
      return await getCharacter(id)
    } catch (error) {
      // (one unreadable character must not hide the others)
      console.error(`rigsmith: could not read character ${id}:`, error)
      return null
    }
  }))
  return all.filter((c): c is Character => c !== null).sort((a, b) => a.createdAt - b.createdAt)
}

/** The document under the store lock (the caller holds it), migrated first if it is older than schema 5. */
async function loadLocked (id: string): Promise<Character | null> {
  const raw = await readJson<Record<string, unknown> | null>(fileOf(id), null)
  if (raw === null) return null
  if (raw.schema === 5) {
    versions.set(id, raw.version as number)
    return raw as unknown as Character
  }
  // (one at a time: the first start migrates every character, each reading its rig)
  return await migrations('all', async () => await migrateLocked(id, raw))
}

/** v1 to v4 -> v5 in place (DESIGN.md §2.3, docs/motion-plan.md §5, §11.5, docs/dressing-plan.md Phase 1): what the model needs to know from the
 * files, then the old copy kept (once: character.v1.json to character.v4.json), the migration's file copies, the write, and one
 * journal entry with its notes. GLBs and weight_edits.json are only read. */
async function migrateLocked (id: string, raw: Record<string, unknown>): Promise<Character> {
  const { ctx, notes } = await migrationContext(id, raw)
  const out = migrate(raw, ctx)
  const known = versions.get(id)
  if (known !== undefined && out.character.version <= known) out.character.version = known + 1
  const entry = await writeMigration(id, out, notes)
  events.emit('character', { character: out.character, entry })
  return out.character
}

/** What migrate needs to know from an old character's files, and lines on what could not be read. Only reads.
 * (tools/migrate.ts migrates the workspace with this and writeMigration, as the store does on first read; it passes
 * its own `measure`, in process.) The clips of slots whose phases move into source time are measured on the rig by
 * tools/measure_clips.ts, a child, so three's headless shims stay out of the server. When that fails for a clip that
 * is there (the child crashed or timed out, its answer didn't parse, the clip didn't load) it throws: the old file is
 * left as it is, to be measured again the next time it is read (src/model/migrate.ts unmeasured). Only a clip that
 * doesn't exist is migrated unmeasured, its phases kept with a note. */
export async function migrationContext (id: string, raw: Record<string, unknown>,
  measure: (id: string) => Promise<MeasuredTimes> = measureChild): Promise<{ ctx: MigrateContext, notes: string[] }> {
  const dir = characterDir(id)
  const notes: string[] = []
  const ctx: MigrateContext = { textureFiles: await textureFiles(dir), units: await readJson<GameSpec | undefined>(UNITS_FILE, undefined) }
  if (needsClipTimes(raw)) {
    const schema = typeof raw.schema === 'number' ? raw.schema : 1
    const left = `left at schema ${schema}, to be measured again when it is next read (or by node tools/migrate.ts)`
    let m: MeasuredTimes
    try {
      m = await measure(id)
    } catch (error) {
      throw new Error(`${id}: its clips could not be measured (${(error as Error).message}): ${left}`, { cause: error })
    }
    ctx.clipTimes = m.times
    for (const p of m.problems) notes.push(`not measured: ${p}`)
    const failed = unmeasured(raw, m.times, m.missing ?? [])
    if (failed.length > 0) throw new Error(`${id}: clips ${failed.join(', ')} could not be measured (${m.problems.join('; ') || 'no times for them'}): ${left}`)
  }
  const edits = await readJson<Record<string, unknown> | null>(path.join(dir, 'weight_edits.json'), null)
  if (edits !== null && typeof edits === 'object') ctx.paintedCount = Object.keys(edits).length
  const rigged = (raw.files as { rigged?: unknown } | undefined)?.rigged
  if (raw.status === 'rigged' && typeof rigged === 'string' && existsSync(path.join(dir, rigged))) {
    try {
      ctx.bindJoints = bindJoints(readGlb(new Uint8Array(await readFile(path.join(dir, rigged)))))
    } catch (error) {
      notes.push(`the rig's joints could not be read from ${rigged} (${(error as Error).message}); its placed joints stand in`)
    }
  }
  return { ctx, notes }
}

/** tools/measure_clips.ts run on a character (as a child, with this store's workspace). */
async function measureChild (id: string): Promise<MeasuredTimes> {
  const { stdout } = await run(process.execPath, [path.join(ROOT, 'tools', 'measure_clips.ts'), id], {
    cwd: ROOT, env: { ...process.env, RIGSMITH_WORKSPACE: WORKSPACE }, timeout: 120_000, maxBuffer: 1 << 22,
  })
  return JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as MeasuredTimes
}

/** A migration written, the caller holding the store lock (or no server running): the old copy kept (once: a v1 file
 * as character.v1.json, a v2 one as character.v2.json, a v3 one as character.v3.json, a v4 one as character.v4.json), the file copies made (never over a file; a missing source is
 * added to `notes`), the document written, and one journal entry with the migration's notes and `notes`. */
export async function writeMigration (id: string, out: Migration, notes: string[], by = 'server'): Promise<JournalEntry> {
  const dir = characterDir(id)
  const character = out.character
  const backup = path.join(dir, `character.v${out.from === 5 ? 4 : out.from}.json`)
  if (!existsSync(backup)) await copyFile(fileOf(id), backup, constants.COPYFILE_EXCL)
  for (const op of out.fileOps) {
    const from = inside(dir, op.from)
    const to = inside(dir, op.to)
    if (!existsSync(from)) { notes.push(`${op.from} was missing, not copied to ${op.to}`); continue }
    if (existsSync(to)) continue
    await mkdir(path.dirname(to), { recursive: true })
    await copyFile(from, to, constants.COPYFILE_EXCL)
  }
  await writeJson(fileOf(id), character)
  versions.set(id, character.version)
  forgetJournal(id)
  return await append(id, { at: new Date().toISOString(), by, what: 'migrate', changes: [...out.notes, ...notes] })
}

/** textures/*.png made before layers existed (not the hole masks): each becomes a snapshot layer. */
async function textureFiles (dir: string): Promise<string[]> {
  const root = path.join(dir, 'textures')
  if (!existsSync(root)) return []
  const entries = await readdir(root, { withFileTypes: true })
  return entries.filter(e => e.isFile() && /\.png$/i.test(e.name) && !/\.mask\.png$/i.test(e.name)).map(e => e.name).sort()
}

function inside (dir: string, relative: string): string {
  const file = path.resolve(dir, relative)
  if (!file.startsWith(dir + path.sep)) throw new Error(`Migration file ${relative} lies outside the character`)
  return file
}

// ---- writing ----------------------------------------------------------------------------------------------------

export interface WriteMeta {
  /** 'app', or the tool (x-rigsmith-by). */
  by?: string
  /** The command type, or the job kind. */
  what: string
  /** In plain words; read after `fn` runs, so `fn` may fill it in. */
  changes?: string[]
  /** Keep what undo needs (commands). Job writes aren't undoable. */
  undoable?: boolean
  /** false: housekeeping, not journaled (thumbnail, status, gear status, migration write-back). */
  journal?: boolean
  cid?: string
  /** The entry this one takes back. */
  undoes?: number
}

export interface Change { id: string, character: Character, entry: JournalEntry | null, touched: string[] }
type Hook = (change: Change) => void | Promise<void>
const hooks: Array<[string, Hook]> = []

/** Run `fn` after every write that touched an entity whose key starts with `prefix` ('layer:' -> recompose the
 * texture): commands, undo and job writes alike. Runs after the lock is released; its errors are logged, never the
 * writer's. Returns a function that removes it. */
export function afterChange (prefix: string, fn: Hook): () => void {
  const hook: [string, Hook] = [prefix, fn]
  hooks.push(hook)
  return () => { const i = hooks.indexOf(hook); if (i >= 0) hooks.splice(i, 1) }
}

/** Change a character: `fn` edits the copy it is given in place, or returns the new document. Without `meta` the write
 * is housekeeping (not journaled). Throws (and writes nothing) when `fn` throws. */
export async function commit (id: string, fn: (c: Character) => void | Character | Promise<void | Character>, meta?: WriteMeta): Promise<Change> {
  const done = await locked(id, async (): Promise<Change> => {
    const before = await loadLocked(id)
    if (before === null) throw new HttpError(404, `No character ${id}`)
    const draft = structuredClone(before)
    const after = (await fn(draft)) ?? draft
    if (after.id !== id || after.schema !== 5) throw new Error('A write changed the character\'s id or schema')
    const changes = meta?.changes ?? []
    if (changes.length === 0 && JSON.stringify(after) === JSON.stringify(before)) return { id, character: before, entry: null, touched: [] }
    after.version = before.version + 1
    after.updatedAt = Date.now()
    const touched = touchedBy(before, after)
    await writeJson(fileOf(id), after)
    versions.set(id, after.version)
    let entry: JournalEntry | null = null
    if (meta !== undefined && meta.journal !== false) {
      entry = await append(id, {
        at: new Date().toISOString(), by: meta.by ?? 'app', what: meta.what, changes, touched,
        ...(meta.undoable === true ? { undo: undoRecord(before, after) } : {}),
        ...(meta.undoes !== undefined ? { undoes: meta.undoes } : {}),
        ...(meta.cid !== undefined ? { cid: meta.cid } : {}),
      })
    }
    events.emit('character', entry === null ? { character: after } : { character: after, entry })
    return { id, character: after, entry, touched }
  })
  if (done.touched.length > 0) {
    for (const [prefix, hook] of [...hooks]) {
      if (!done.touched.some(k => k.startsWith(prefix))) continue
      try {
        void Promise.resolve(hook(done)).catch(error => { console.error('rigsmith: afterChange hook failed:', error) })
      } catch (error) {
        console.error('rigsmith: afterChange hook failed:', error)
      }
    }
  }
  return done
}

/** commit, answering the document. */
export async function updateCharacter (id: string, fn: (c: Character) => void | Character | Promise<void | Character>, meta?: WriteMeta): Promise<Character> {
  return (await commit(id, fn, meta)).character
}

/** A job failed: the character shows it (status 'error', `error`), then the error goes on to the job. */
export async function failCharacter (id: string, error: unknown): Promise<never> {
  const message = error instanceof Error ? error.message : String(error)
  try {
    await updateCharacter(id, c => { c.status = 'error'; c.error = message })
  } catch { /* (deleted meanwhile: the job's own error says more) */ }
  throw error
}

export async function createCharacter (originalName: string, bytes: Buffer, by = 'app'): Promise<Character> {
  const stem = originalName.replace(/\.[^.]+$/, '').replace(/_rigged$/i, '')
  const slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'character'
  const id = `${slug}-${createHash('sha256').update(bytes).digest('hex').slice(0, 6)}`
  const dir = characterDir(id)
  return await locked(id, async () => {
    // (the same file again: the character it made)
    const existing = await loadLocked(id)
    if (existing !== null) return existing
    const ext = path.extname(originalName).toLowerCase()
    await mkdir(path.join(dir, 'source'), { recursive: true })
    const file = `source/original${ext}`
    await writeFile(path.join(dir, file), bytes)
    const now = Date.now()
    const character: Character = {
      schema: 5,
      id,
      name: stem.replace(/[_-]+/g, ' ').replace(/\b\w/g, m => m.toUpperCase()),
      createdAt: now,
      updatedAt: now,
      version: 1,
      revision: 0,
      files: {},
      status: 'importing',
      // (kind and stats are the import job's to say)
      source: { file, originalName, bytes: bytes.length, kind: 'mesh', scale: 1, warnings: [] },
      skeleton: { template: 'human', fingerLevel: 'full', overrides: {} },
      skin: { locked: false },
      hands: { poses: [] },
      gear: [],
      clips: [],
      look: { layers: [] },
    }
    await writeJson(fileOf(id), character)
    versions.set(id, character.version)
    forgetJournal(id)
    const entry = await append(id, { at: new Date(now).toISOString(), by, what: 'import', changes: [`imported from ${originalName}`] })
    events.emit('character', { character, entry })
    return character
  })
}

/** Delete a character: its folder moved to workspace/trash/<id>-<when> (put it back in characters/ to undo; empty the
 * trash to free the space). */
export async function deleteCharacter (id: string): Promise<void> {
  const dir = characterDir(id)
  await locked(id, async () => {
    if (!existsSync(dir)) return
    await mkdir(TRASH, { recursive: true })
    await rename(dir, path.join(TRASH, `${id}-${stamp()}`))
    versions.delete(id)
    forgetJournal(id)
  })
  events.emit('removed', id)
}

/** garments/<id>/ folders that no gear uses and no undoable journal entry could bring back (a gear removed before
 * schema 2, an upload that never finished) moved to trash/<character>/garments/<id>-<when>/. Nothing is deleted. */
export async function sweepOrphanGarments (): Promise<number> {
  let moved = 0
  for (const c of await listCharacters()) {
    const root = path.join(characterDir(c.id), 'garments')
    if (!existsSync(root)) continue
    const used = new Set(c.gear.flatMap(g => [g.id, g.model?.split('/')[1]]))
    for (const e of await readJournal(c.id)) {
      for (const { key } of e.undo?.entities ?? []) if (key.startsWith('gear:')) used.add(key.slice(5))
    }
    for (const folder of await readdir(root, { withFileTypes: true })) {
      if (!folder.isDirectory() || used.has(folder.name)) continue
      const to = path.join(TRASH, c.id, 'garments', `${folder.name}-${stamp()}`)
      await mkdir(path.dirname(to), { recursive: true })
      await rename(path.join(root, folder.name), to)
      await note(c.id, 'server', `garments/${folder.name} moved to ${path.relative(WORKSPACE, to)} (no gear uses it)`)
      moved++
    }
  }
  return moved
}

// ---- settings ---------------------------------------------------------------------------------------------------

const expand = (p: string): string => p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p

export async function getSettings (): Promise<Settings> {
  return migrateSettings(await readJson<unknown>(SETTINGS, {}), { gameRepo: DEFAULT_GAME_REPO })
}

/** Only what schema 2 settings have (the game repo, the shared hand poses, the ComfyUI address: '' clears it);
 * anything else is dropped. */
export async function saveSettings (change: Partial<Settings>): Promise<Settings> {
  return await locked('#settings', async () => {
    const next = await getSettings()
    if (typeof change.gameRepo === 'string' && change.gameRepo.trim() !== '') next.gameRepo = expand(change.gameRepo.trim())
    if (Array.isArray(change.handPoses)) next.handPoses = change.handPoses
    if (typeof change.comfyUrl === 'string') {
      if (change.comfyUrl.trim() === '') delete next.comfyUrl
      else next.comfyUrl = change.comfyUrl.trim()
    }
    await writeJson(SETTINGS, next)
    return next
  })
}
