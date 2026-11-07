// What every file the app loads holds, by its content (docs/dressing-plan.md Phase 0): an index of path -> { size,
// mtimeMs, ino, hash } over the characters' folders and the clip library, a file hashed again only when its stat
// changes. A recursive watcher on characters/** and library/{clips,creatures}/** notices files changed on disk by
// anything (a skin repainted in GIMP, a tool, a job), so nothing has to guess from a document counter: the page asks
// for a file by its hash (/files/...?h=<hash>, served immutable) and hears the SSE `files` event { character, changed }
// when one changes. Writers through the store touch what they wrote before its `character` event goes out (store.ts
// onWritten), so a page never sees a document before the files it names. A character.json changed by someone else is
// read again and sent to every page.
//
// The index is kept across restarts in workspace/.cache/files.json, so a restart only stats.
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, watch, type FSWatcher, type Stats } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { servable } from './http.ts'
import { CHARACTERS, events, LIBRARY, WORKSPACE } from './store.ts'

export interface FileInfo { size: number, mtimeMs: number, ino: number, hash: string }
/** A `files` event: paths inside the character's folder (character null: inside library/), each with its new hash
 * (null: gone). */
export interface FilesChanged { character: string | null, changed: Record<string, string | null> }
/** A manifest: path inside the character's folder (or library/) -> hash, the files the app may load. */
export type Manifest = Record<string, string>

/** The library folders the app loads clips from. */
const LIBRARY_DIRS = ['clips', 'creatures']
const INDEX_FILE = path.join(WORKSPACE, '.cache', 'files.json')
const ID = /^[a-z0-9-]+$/
/** Files never indexed: appended on every command, written as temp files then renamed over the real one, or a piece's
 * derived data (named by its content's inputs, read by its own route: server/routes/derived.ts). */
const IGNORED = /(^|\/)(journal\.jsonl|[^/]*\.tmp|\.[^/]*)$|(^|\/)garments\/[^/]+\/derived\//
/** How long the watcher waits for a burst of writes to end, and at most. */
const QUIET_MS = 60
const MAX_WAIT_MS = 400
const HASH_CONCURRENCY = 4

/** By path inside the workspace ('/' separated). */
const index = new Map<string, FileInfo>()
/** Folders scanned whole since the start (a character's, 'library'): their manifest is complete. */
const scanned = new Set<string>()

const toKey = (file: string): string => path.relative(WORKSPACE, file).split(path.sep).join('/')
const sameStat = (a: FileInfo, s: Stats): boolean => a.size === s.size && a.mtimeMs === s.mtimeMs && a.ino === s.ino

// ---- one job per folder at a time ------------------------------------------------------------------------------

const chains = new Map<string, Promise<unknown>>()
async function serial<T> (key: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(key) ?? Promise.resolve()).then(fn)
  const tail = next.catch(() => {})
  chains.set(key, tail)
  try {
    return await next
  } finally {
    if (chains.get(key) === tail) chains.delete(key)
  }
}

// ---- hashing -----------------------------------------------------------------------------------------------------

/** The first 16 hex of the file's SHA-1 (small files read whole, big ones streamed). */
export async function hashFile (file: string, size?: number): Promise<string> {
  if ((size ?? (await stat(file)).size) < 8 << 20) return createHash('sha1').update(await readFile(file)).digest('hex').slice(0, 16)
  const h = createHash('sha1')
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer)
  return h.digest('hex').slice(0, 16)
}

let hashing = 0
const hashQueue: Array<() => void> = []
async function limited<T> (fn: () => Promise<T>): Promise<T> {
  if (hashing >= HASH_CONCURRENCY) await new Promise<void>(resolve => { hashQueue.push(resolve) })
  hashing++
  try {
    return await fn()
  } finally {
    hashing--
    hashQueue.shift()?.()
  }
}

/** The file's entry brought up to date: hashed again only when its stat changed. Null when it isn't a file (gone). */
async function refresh (key: string): Promise<{ info: FileInfo | null, changed: boolean }> {
  const file = path.join(WORKSPACE, key)
  const first = await stat(file).catch(() => null)
  const was = index.get(key)
  if (first === null || !first.isFile()) {
    if (was === undefined) return { info: null, changed: false }
    index.delete(key)
    dirty()
    return { info: null, changed: true }
  }
  if (was !== undefined && sameStat(was, first)) return { info: was, changed: false }
  let s: Stats = first
  let hash = await limited(async () => await hashFile(file, first.size))
  // (written again while it was read: read once more)
  const after = await stat(file).catch(() => null)
  if (after !== null && !(after.size === s.size && after.mtimeMs === s.mtimeMs && after.ino === s.ino)) {
    s = after
    hash = await limited(async () => await hashFile(file, after.size))
  }
  const info: FileInfo = { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino, hash }
  index.set(key, info)
  dirty()
  return { info, changed: was?.hash !== hash }
}

/** Whether a path inside the workspace is indexed by the scans and the watcher: what the app may load (a character's
 * record is followed on its own: recordChanged). */
const indexed = (key: string): boolean => !IGNORED.test(key) && servable(key)

/** Every file under `dir` (paths inside the workspace) that is indexed. */
async function walk (dir: string): Promise<string[]> {
  const out: string[] = []
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) { if (!e.name.startsWith('.')) out.push(...await walk(full)) } else if (e.isFile()) {
      const key = toKey(full)
      if (indexed(key)) out.push(key)
    }
  }
  return out
}

// ---- the index across restarts ---------------------------------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | null = null
function dirty (): void {
  if (saveTimer !== null || !started) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void save().catch((error: unknown) => { console.error('rigsmith: could not keep the file index:', error) })
  }, 3000)
}

async function save (): Promise<void> {
  await mkdir(path.dirname(INDEX_FILE), { recursive: true })
  const temp = `${INDEX_FILE}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(Object.fromEntries(index)))
  await rename(temp, INDEX_FILE)
}

async function loadIndex (): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(INDEX_FILE, 'utf8')) as Record<string, FileInfo>
    for (const [key, info] of Object.entries(saved)) {
      if (typeof info?.hash === 'string' && !index.has(key)) index.set(key, info)
    }
  } catch { /* (none yet, or unreadable: everything is hashed again) */ }
}

// ---- scanning and touching -------------------------------------------------------------------------------------

/** Which folder a workspace path belongs to: a character's id, 'library', or null (not indexed). */
function folderOf (key: string): { folder: string, character: string | null, inside: string } | null {
  const parts = key.split('/')
  if (parts[0] === 'characters' && parts.length >= 3 && ID.test(parts[1])) return { folder: parts[1], character: parts[1], inside: parts.slice(2).join('/') }
  if (parts[0] === 'library' && parts.length >= 3 && LIBRARY_DIRS.includes(parts[1])) return { folder: 'library', character: null, inside: parts.slice(1).join('/') }
  return null
}

const prefixOf = (folder: string): string => (folder === 'library' ? 'library/' : `characters/${folder}/`)

function emit (folder: string, changed: Record<string, string | null>): void {
  if (Object.keys(changed).length === 0 || !started) return
  const event: FilesChanged = { character: folder === 'library' ? null : folder, changed }
  events.emit('files', event)
}

/** A folder scanned whole: every file stat'ed (hashed when changed), entries of files gone dropped. */
async function scanFolder (folder: string, report: boolean): Promise<Record<string, string | null>> {
  const prefix = prefixOf(folder)
  const keys = folder === 'library'
    ? (await Promise.all(LIBRARY_DIRS.map(async d => await walk(path.join(LIBRARY, d))))).flat()
    : await walk(path.join(CHARACTERS, folder))
  const changed: Record<string, string | null> = {}
  const seen = new Set(keys)
  await Promise.all(keys.map(async key => {
    const r = await refresh(key)
    if (r.changed) changed[key.slice(prefix.length)] = r.info?.hash ?? null
  }))
  for (const key of [...index.keys()]) {
    if (key.startsWith(prefix) && indexed(key) && !seen.has(key)) { index.delete(key); changed[key.slice(prefix.length)] = null; dirty() }
  }
  scanned.add(folder)
  if (report) emit(folder, changed)
  return changed
}

/** Paths (inside the workspace) brought up to date: a folder among them rescanned under it, a file gone dropped. */
async function touchKeys (folder: string, keys: Iterable<string>): Promise<Record<string, string | null>> {
  const prefix = prefixOf(folder)
  const changed: Record<string, string | null> = {}
  const files = new Set<string>()
  for (const key of keys) {
    if (IGNORED.test(key)) continue
    const s = await stat(path.join(WORKSPACE, key)).catch(() => null)
    if (s?.isDirectory() === true) {
      for (const k of await walk(path.join(WORKSPACE, key))) files.add(k)
      // (and whatever was under it before: a folder renamed over another)
      for (const k of index.keys()) if (k.startsWith(`${key}/`)) files.add(k)
    } else if (s === null) {
      // (a file, or a whole folder, gone)
      if (index.has(key)) files.add(key)
      for (const k of index.keys()) if (k.startsWith(`${key}/`)) files.add(k)
    } else if (indexed(key)) {
      files.add(key)
    }
  }
  await Promise.all([...files].map(async key => {
    const r = await refresh(key)
    if (r.changed && indexed(key)) changed[key.slice(prefix.length)] = r.info?.hash ?? null
  }))
  emit(folder, changed)
  return changed
}

/**
 * Files of a character (paths inside its folder; none: the whole folder) or of the library (character null, paths
 * inside library/) brought up to date now, and the `files` event sent for what changed. Writers call it after writing
 * and before saying so; the store does it for every write it commits (character.json; a job's write: the whole
 * folder). Answers what changed.
 */
export async function touch (character: string | null, files?: readonly string[]): Promise<Record<string, string | null>> {
  const folder = character ?? 'library'
  if (character !== null && !ID.test(character)) return {}
  return await serial(folder, async () => {
    if (files === undefined) return await scanFolder(folder, true)
    const prefix = prefixOf(folder)
    return await touchKeys(folder, files.map(f => prefix + f.split(path.sep).join('/')))
  })
}

/** The files of a character the app may load (not its records), by path inside its folder. Scanned the first time. */
export async function manifest (character: string): Promise<Manifest> {
  if (!ID.test(character)) return {}
  await serial(character, async () => { if (!scanned.has(character)) await scanFolder(character, true) })
  const prefix = prefixOf(character)
  const out: Manifest = {}
  for (const [key, info] of index) if (key.startsWith(prefix) && servable(key)) out[key.slice(prefix.length)] = info.hash
  return out
}

/** One file of a character (a path inside its folder) brought up to date and its hash (null: none), without scanning
 * the folder: the list's thumbnails. */
export async function fileHash (character: string, file: string): Promise<string | null> {
  if (!ID.test(character)) return null
  const key = `${prefixOf(character)}${file}`
  if (!indexed(key)) return null
  return await serial(character, async () => (await refresh(key)).info?.hash ?? null)
}

/** The library's clip files (clips/, creatures/), by path inside library/. */
export async function libraryManifest (): Promise<Manifest> {
  await serial('library', async () => { if (!scanned.has('library')) await scanFolder('library', true) })
  const out: Manifest = {}
  for (const [key, info] of index) if (key.startsWith('library/')) out[key.slice('library/'.length)] = info.hash
  return out
}

/** The current hash of a file (a path inside the workspace), its stat checked first: null when it isn't indexed or
 * changed since (then brought up to date in the background). */
export function currentHash (key: string, s: Stats): string | null {
  const info = index.get(key)
  if (info !== undefined && sameStat(info, s)) return info.hash
  const f = folderOf(key)
  if (f !== null) void serial(f.folder, async () => await touchKeys(f.folder, [key])).catch(() => {})
  return null
}

/** The library clips' hashes by clip file (library/<file>), for the library's listing. */
export function hashOf (key: string): string | undefined {
  return index.get(key)?.hash
}

// ---- watching ----------------------------------------------------------------------------------------------------

let started = false
const watchers: FSWatcher[] = []
const pending = new Map<string, Set<string>>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let firstPending = 0

function noticed (key: string): void {
  const parts = key.split('/')
  // (a character's own record: read again when someone else wrote it)
  if (parts[0] === 'characters' && parts.length === 3 && parts[2] === 'character.json') { recordChanged(parts[1]); return }
  if (IGNORED.test(key)) return
  if (parts[0] === 'characters' && parts.length === 2 && ID.test(parts[1])) {
    // (a whole character's folder came or went)
    const set = pending.get(parts[1]) ?? new Set()
    set.add(key)
    pending.set(parts[1], set)
  } else {
    const f = folderOf(key)
    if (f === null) return
    const set = pending.get(f.folder) ?? new Set()
    set.add(key)
    pending.set(f.folder, set)
  }
  const now = Date.now()
  if (flushTimer === null) firstPending = now
  if (flushTimer !== null) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => { void flush() }, now - firstPending > MAX_WAIT_MS ? 0 : QUIET_MS)
}

/** The writes the watcher heard, brought into the index (and told), folder by folder. */
export async function flush (folder?: string): Promise<void> {
  const folders = folder === undefined ? [...pending.keys()] : pending.has(folder) ? [folder] : []
  if (folder === undefined && flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null }
  await Promise.all(folders.map(async f => {
    const keys = pending.get(f)
    pending.delete(f)
    if (keys === undefined) return
    try {
      await serial(f, async () => await touchKeys(f, keys))
    } catch (error) {
      console.error(`rigsmith: could not read the changed files of ${f}:`, error)
    }
  }))
}

// ---- character.json written by someone else ---------------------------------------------------------------------

type RecordHook = (id: string) => Promise<void>
let onRecord: RecordHook | null = null
/** Who reads a character's record again when it changed on disk (server/api.ts: the store's adopt). */
export function onRecordChanged (fn: RecordHook | null): void { onRecord = fn }

const recordTimers = new Map<string, ReturnType<typeof setTimeout>>()
function recordChanged (id: string): void {
  if (!ID.test(id)) return
  clearTimeout(recordTimers.get(id))
  recordTimers.set(id, setTimeout(() => {
    recordTimers.delete(id)
    void serial(`record:${id}`, async () => {
      const key = `characters/${id}/character.json`
      const s = await stat(path.join(WORKSPACE, key)).catch(() => null)
      const was = index.get(key)
      if (s === null || (was !== undefined && sameStat(was, s))) return
      const r = await refresh(key)
      if (!r.changed) return
      await onRecord?.(id)
    }).catch((error: unknown) => { console.error(`rigsmith: could not read ${id}'s character.json again:`, error) })
  }, QUIET_MS))
}

/** The store wrote a character's record (store.ts onWritten): its stat noted, so the watcher doesn't take it for
 * someone else's; the writes the watcher heard in the folder read now (a job's: the whole folder looked over), so
 * their `files` event goes out before the document's. */
export async function written (id: string, o: { whole: boolean }): Promise<void> {
  if (!ID.test(id)) return
  await refresh(`characters/${id}/character.json`)
  if (o.whole) await touch(id)
  else await flush(id)
}

/** Watch the workspace (once): the index read back, characters/** and library/{clips,creatures}/** watched. */
export async function startFiles (): Promise<void> {
  if (started) return
  started = true
  await loadIndex()
  const roots: Array<[string, string]> = [[CHARACTERS, 'characters'], ...LIBRARY_DIRS.map((d): [string, string] => [path.join(LIBRARY, d), `library/${d}`])]
  for (const [dir, base] of roots) {
    if (!existsSync(dir)) continue
    try {
      const w = watch(dir, { recursive: true }, (_event, name) => {
        if (name === null) return
        noticed(`${base}/${String(name).split(path.sep).join('/')}`)
      })
      w.on('error', (error) => { console.error(`rigsmith: watching ${base} failed:`, error) })
      watchers.push(w)
    } catch (error) {
      console.error(`rigsmith: could not watch ${base} (files changed on disk will show after a reload):`, error)
    }
  }
}

/** Stop watching (tests). */
export async function stopFiles (): Promise<void> {
  for (const w of watchers.splice(0)) w.close()
  if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null }
  for (const t of recordTimers.values()) clearTimeout(t)
  recordTimers.clear()
  pending.clear()
  if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; await save().catch(() => {}) }
  started = false
}

/** Forget everything (tests). */
export function resetFiles (): void {
  index.clear()
  scanned.clear()
}
