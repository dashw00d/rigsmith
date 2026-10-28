// The game's units, Rigsmith's own: which character is which unit, its height, budget, levels, the clip names it
// plays, its companion (workspace/game/units.json, src/model/unit.ts). Edited here, live in every open page and in each
// unit's journal; the game's repo (Settings.gameRepo) is written only by Export: the unit's entry in its
// tools/rigsmith/units.json (that block of the file alone, the rest byte for byte), then its build
// (tools/rigsmith/build.sh: the model, its maps, the holds check).
//
// An export is trusted only when it shows: the game's build pipes Rigsmith's export through grep, so a crash of it
// doesn't fail the script. So each build gets a run token (RIGSMITH_RUN, through build.sh's environment into the
// unit's build record), and the export passes only when every unit's record carries it and its .glb was written after
// the build started. Anything else (the build failing, a record missing, a cancel) puts the game's units.json back as
// it was, so a failed export leaves the game as it found it (except the build's own outputs).
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { slotByName } from '../src/model/select.ts'
import type { Character } from '../src/model/types.ts'
import type { BuildRecord, CompanionSpec, GameSpec, UnitSpec } from '../src/model/unit.ts'
import { HttpError } from './http.ts'
import { spawnJob, type Update } from './jobs.ts'
import { append } from './journal.ts'
import { events, getCharacter, getSettings, locked, readJson, ROOT, UNITS_FILE, withFiles, WORKSPACE, writeJson } from './store.ts'

export type { BuildRecord, CompanionSpec, GameSpec, UnitSpec }
export { UNITS_FILE }

/** What the last export of a unit did (workspace/game/builds/<unit>.json): the Ship step's "last build". */
export interface UnitBuild {
  unit: string
  /** The job that ran it, who asked, when it started and ended. */
  job: string
  by: string
  at: number
  finishedAt: number
  /** The run token its build record must carry. */
  run: string
  status: 'done' | 'failed' | 'cancelled'
  error?: string
  /** The game's units.json was put back as it was before the export. */
  restored?: boolean
  walkStride?: number | null
  runStride?: number | null
  /** The holds check's failures for this unit (HOLDS lines). */
  holdsFailed: string[]
  /** Every warning about this unit: the export's (its build record's and what it printed) and the build's errors. */
  warnings: string[]
  /** Every line the build printed that is about this unit or about the whole build. */
  log: string[]
}

/** A unit's build as the Ship step shows it: the last export, the record its build wrote and the model's time. */
export interface UnitBuildView {
  last: UnitBuild | null
  record: BuildRecord | null
  glb: { file: string, mtime: number } | null
}

export interface GameStatus {
  repo: string
  units: Record<string, { ours: UnitSpec | null, game: UnitSpec | null, differs: boolean }>
  /** Rigsmith's defaults under every unit (its levels, ...). */
  defaults: Partial<UnitSpec>
}

const BUILDS = path.join(WORKSPACE, 'game', 'builds')
/** The game's units.json as it was before an export spliced it: kept until the export ends, so a restart in the middle
 * of a build can still put it back. */
const BACKUP = path.join(WORKSPACE, 'game', 'export-backup.json')
const UNIT_NAME = /^[a-z0-9_]+$/

export async function gameRepo (): Promise<string> {
  return (await getSettings()).gameRepo
}
export const gameUnitsFile = (repo: string): string => path.join(repo, 'tools', 'rigsmith', 'units.json')
const buildScript = (repo: string): string => path.join(repo, 'tools', 'rigsmith', 'build.sh')
/** Where the game's build puts a unit's work files (its build record among them): build.sh's own .work dir. */
export const workDirOf = (repo: string, unit: string): string => path.join(repo, '.work', 'rigsmith', unit)
/** Where a unit's .glb goes: its models_dir (relative to the game's repo) when it names one, else the units' folder. */
export function modelFileOf (repo: string, unit: string, spec: Pick<UnitSpec, 'models_dir'>): string {
  const dir = typeof spec.models_dir === 'string' && spec.models_dir !== '' ? path.join(repo, spec.models_dir) : path.join(repo, 'assets', 'models', 'units')
  return path.join(dir, `${unit}.glb`)
}

async function readSpec (file: string): Promise<GameSpec | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as GameSpec } catch { return null }
}

/** Rigsmith's units; the first time, a copy of the game's. */
export async function units (): Promise<GameSpec> {
  const own = await readSpec(UNITS_FILE)
  if (own !== null) return own
  const game = await readSpec(gameUnitsFile(await gameRepo()))
  const seeded: GameSpec = game ?? { units: {} }
  await saveUnits(seeded)
  return seeded
}

/** Change Rigsmith's units: `fn` edits the spec it is given, which is then saved. One writer at a time. */
export async function updateUnits<T> (fn: (spec: GameSpec) => T | Promise<T>): Promise<T> {
  return await locked('#units', async () => {
    const spec = await units()
    const out = await fn(spec)
    await saveUnits(spec)
    return out
  })
}

// (json.dumps style, as the game's file is written: a unit's keys a line each, their values on one line)
const compact = (v: unknown): string => JSON.stringify(v, null, 1).replace(/\n\s*/g, ' ').replace(/\[ /g, '[').replace(/ \]/g, ']').replace(/\{ /g, '{').replace(/ \}/g, '}')
export function unitBlock (name: string, entry: UnitSpec): string {
  const keys = Object.entries(entry)
  return [`  ${JSON.stringify(name)}: {`, ...keys.map(([k, v], i) => `   ${JSON.stringify(k)}: ${compact(v)}${i < keys.length - 1 ? ',' : ''}`), '  }'].join('\n')
}
function format (spec: GameSpec): string {
  const out: string[] = ['{']
  const top = Object.entries(spec)
  top.forEach(([k, v], i) => {
    const comma = i < top.length - 1 ? ',' : ''
    if (k === 'units') {
      const list = Object.entries(spec.units)
      out.push(' "units": {', ...list.map(([u, e], j) => unitBlock(u, e) + (j < list.length - 1 ? ',' : '')), ` }${comma}`)
    } else if (Array.isArray(v) && v.every(x => typeof x === 'string')) {
      out.push(` ${JSON.stringify(k)}: [`, ...v.map((x, j) => `  ${JSON.stringify(x)}${j < v.length - 1 ? ',' : ''}`), ` ]${comma}`)
    } else out.push(` ${JSON.stringify(k)}: ${compact(v)}${comma}`)
  })
  out.push('}')
  return out.join('\n') + '\n'
}

export async function saveUnits (spec: GameSpec): Promise<void> {
  await mkdir(path.dirname(UNITS_FILE), { recursive: true })
  await writeFile(UNITS_FILE, format(spec))
}

/** The game's units.json text with one unit's block replaced (or added, or taken out), every other byte kept. */
export function spliceUnit (text: string, name: string, entry: UnitSpec | null): string {
  const head = `\n  ${JSON.stringify(name)}: {`
  const start = text.indexOf(head)
  if (start >= 0) {
    const close = text.indexOf('\n  }', start + head.length)
    if (close < 0) throw new Error(`units.json: ${name}'s entry doesn't close`)
    let end = close + 4
    if (entry !== null) return text.slice(0, start + 1) + unitBlock(name, entry) + text.slice(end)
    // taken out: its line and the comma that joined it
    if (text[end] === ',') end++
    else if (text[start - 1] === ',') return text.slice(0, start - 1) + text.slice(end)
    return text.slice(0, start) + text.slice(end)
  }
  if (entry === null) return text
  const unitsAt = text.indexOf('\n "units": {')
  const closeAt = unitsAt < 0 ? -1 : text.indexOf('\n }', unitsAt + 1)
  if (closeAt < 0) throw new Error("units.json: no units block")
  const empty = text.slice(unitsAt, closeAt).trim() === '"units": {'
  return text.slice(0, closeAt) + (empty ? '\n' : ',\n') + unitBlock(name, entry) + text.slice(closeAt)
}

/** A unit's entry as the game gets it: no longer a draft (it is in the game now). */
export function shipped (entry: UnitSpec): UnitSpec {
  const out: UnitSpec = { ...entry }
  delete out.draft
  delete out._draft
  return out
}

/** Each unit: Rigsmith's entry, the game's, and whether they differ (what Export would write). */
export async function gameStatus (): Promise<GameStatus> {
  const repo = await gameRepo()
  const spec = await units()
  const ours = spec.units
  const game = (await readSpec(gameUnitsFile(repo)))?.units ?? {}
  const out: GameStatus['units'] = {}
  for (const name of new Set([...Object.keys(ours), ...Object.keys(game)])) {
    const a = ours[name] ?? null; const b = game[name] ?? null
    out[name] = { ours: a, game: b, differs: JSON.stringify(a) !== JSON.stringify(b) }
  }
  return { repo, units: out, defaults: spec.defaults ?? {} }
}

// ---- checking an entry -------------------------------------------------------------------------------------------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/**
 * What is wrong with a unit's entry, in words (none: it can be saved). `slots`: the slot names of its character (null
 * when it has none to check against); `before`: the entry it replaces, whose clip names stay allowed (a slot renamed or
 * removed since doesn't block every other edit; the Ship checks still flag it); `exists`: whether a character id is
 * one.
 */
export function unitProblems (entry: unknown, o: { slots: string[] | null, before: UnitSpec | null, exists: (id: string) => boolean }): string[] {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return ['A unit is an object']
  const e = entry as Record<string, unknown>
  const out: string[] = []
  if (!isText(e.character)) out.push('A unit names its character')
  else if (!o.exists(e.character)) out.push(`There is no character ${e.character}`)
  if (!isNum(e.height) || e.height <= 0) out.push('Its height is a number of game units above 0')
  if (!isNum(e.budget) || e.budget <= 0) out.push('Its budget is a number of triangles above 0')
  if (!Array.isArray(e.clips) || !e.clips.every(isText)) out.push('Its clips are the names the game plays, a list')
  else {
    const seen = new Set<string>()
    for (const n of e.clips as string[]) {
      if (seen.has(n)) out.push(`${n} is listed twice`)
      seen.add(n)
    }
    const allowed = new Set([...(o.slots ?? []), ...(o.before?.clips ?? [])])
    const missing = (e.clips as string[]).filter(n => !allowed.has(n))
    if (o.slots !== null && missing.length > 0) out.push(`${missing.join(', ')}: not a clip of its character (name a slot in Motion first)`)
  }
  if (e.lods !== undefined) {
    const lods = e.lods
    if (!Array.isArray(lods) || !lods.every(r => isNum(r) && r > 0 && r < 1) || lods.some((r, i) => i > 0 && (r as number) >= (lods[i - 1] as number))) {
      out.push('Its levels are shares of LOD0 between 0 and 1, each smaller than the one before')
    }
  }
  if (e.draft !== undefined && typeof e.draft !== 'boolean') out.push('Draft is true or false')
  if (e.models_dir !== undefined && (typeof e.models_dir !== 'string' || path.isAbsolute(e.models_dir) || e.models_dir.split(/[\\/]/).includes('..'))) {
    out.push("Its models_dir is a folder inside the game's repo")
  }
  if (e.head !== undefined && (typeof e.head !== 'object' || e.head === null || !isText((e.head as { name?: unknown }).name))) out.push('Its head names the mesh it splits off')
  if (e.companion !== undefined) {
    const c = e.companion as Record<string, unknown> | null
    if (typeof c !== 'object' || c === null) out.push('Its companion is an object')
    else {
      if (!isText(c.character)) out.push('Its companion names a character')
      else if (c.character === e.character) out.push("A unit can't be its own companion")
      else if (!o.exists(c.character)) out.push(`There is no character ${c.character} (its companion)`)
      if (!isNum(c.height) || c.height <= 0) out.push("Its companion's height is a number above 0")
      if (typeof c.prefix !== 'string' || !/^\w+$/.test(c.prefix)) out.push("Its companion's bone prefix is a word (Horse_)")
      if (!isNum(c.budget) || c.budget <= 0) out.push("Its companion's budget is a number of triangles above 0")
      if (!isText(c.material)) out.push("Its companion's material names its surface (Atlas_<material>)")
      if (c.ridden !== undefined && typeof c.ridden !== 'boolean') out.push('Ridden is true or false')
    }
  }
  return out
}

/** In words, what an entry changed, for the journal of the characters it names. */
export function unitChanges (name: string, before: UnitSpec | null, entry: UnitSpec | null): string[] {
  if (entry === null) return before === null ? [] : [`game unit ${name}: taken off Rigsmith's list`]
  if (before === null) return [`game unit ${name}: made (${entry.height} tall, ${entry.clips.length} clip${entry.clips.length === 1 ? '' : 's'})`]
  const keys = [...new Set([...Object.keys(before), ...Object.keys(entry)])].filter(k => JSON.stringify(before[k]) !== JSON.stringify(entry[k]))
  return keys.map(k => `game unit ${name}: ${k} ${entry[k] === undefined ? 'unset' : JSON.stringify(entry[k])}`)
}

/** Save one unit's entry (null takes it off Rigsmith's list), checked first; journaled on the characters it names. */
export async function putUnit (name: string, entry: UnitSpec | null, by: string): Promise<void> {
  if (!UNIT_NAME.test(name)) throw new HttpError(400, 'A unit name is lower case letters, digits and _')
  const characters = new Map<string, Character | null>()
  const character = async (id: string): Promise<Character | null> => {
    if (!characters.has(id)) characters.set(id, await getCharacter(id))
    return characters.get(id) ?? null
  }
  // (the characters it names, read before the lock: the check needs their slots)
  if (entry !== null && typeof entry === 'object') {
    for (const id of [entry.character, entry.companion?.character]) if (typeof id === 'string' && /^[a-z0-9-]+$/.test(id)) await character(id)
  }
  const before = await updateUnits(async spec => {
    const was = spec.units[name] ?? null
    if (entry !== null) {
      const own = typeof entry.character === 'string' ? characters.get(entry.character) ?? null : null
      const problems = unitProblems(entry, { slots: own === null ? null : own.clips.map(s => s.name), before: was, exists: id => characters.get(id) != null })
      if (problems.length > 0) throw new HttpError(400, problems.join('; '))
      spec.units[name] = entry
    } else delete spec.units[name]
    return was
  })
  const lines = unitChanges(name, before, entry)
  const ids = new Set([before?.character, entry?.character, before?.companion?.character, entry?.companion?.character].filter((x): x is string => typeof x === 'string'))
  for (const id of ids) if (lines.length > 0 && await character(id) !== null) await journalLine(id, by, 'unit', lines)
  events.emit('game', name)
}

/** A line in a character's journal for a change made outside its document (a unit edited, an export). */
async function journalLine (id: string, by: string, what: string, changes: string[]): Promise<void> {
  try {
    await locked(id, async () => await append(id, { at: new Date().toISOString(), by, what, changes }))
    events.emit('journal', id)
  } catch (error) {
    console.error(`rigsmith: could not journal ${what} on ${id}:`, error)
  }
}

// ---- export -----------------------------------------------------------------------------------------------------

export interface ExportOptions {
  by: string
  job: string
  signal: AbortSignal
  update: Update
}

/** The characters an export of `names` reads: each unit's character and its companion (a ridden horse is the
 * companion), once each, in the order met. Units the spec doesn't have read nothing. */
export function exportReads (spec: Pick<GameSpec, 'units'>, names: string[]): string[] {
  const out = new Set<string>()
  for (const name of names) {
    const entry = spec.units[name]
    if (entry === undefined) continue
    for (const id of [entry.character, entry.companion?.character]) if (typeof id === 'string' && id !== '') out.add(id)
  }
  return [...out]
}

/** Run `fn` holding the model files (store.withFiles) of every character in `ids`. Taken in sorted order, so two
 * holders of several never wait on each other; every other holder takes one. */
export async function holdFiles<T> (ids: string[], fn: () => Promise<T>): Promise<T> {
  const sorted = [...new Set(ids)].sort()
  const hold = async (i: number): Promise<T> => i === sorted.length ? await fn() : await withFiles(sorted[i], async () => await hold(i + 1))
  return await hold(0)
}

/** The lines of a build's output that concern a unit: its own (by name), and those about the whole build. */
export function linesFor (log: string[], unit: string, all: string[]): string[] {
  const own = new RegExp(`\\b${unit}\\b`)
  const other = all.filter(u => u !== unit).map(u => new RegExp(`\\b${u}\\b`))
  return log.filter(l => own.test(l) || !other.some(r => r.test(l)))
}

/** From a build's output: the holds check's failures for a unit and the warnings about it. */
export function readLog (log: string[], unit: string): { holdsFailed: string[], warnings: string[] } {
  const holdsFailed = log.filter(l => /^HOLDS\s/.test(l) && l.split(/\s+/)[1] === unit && /\bFAIL\b/.test(l))
  const warnings = log.filter(l => l.startsWith(`warning: ${unit}: `)).map(l => l.slice(`warning: ${unit}: `.length))
  const errors = log.filter(l => /^(Error|Traceback)|\bError:/.test(l) && !l.startsWith('warning:'))
  return { holdsFailed, warnings: [...warnings, ...errors] }
}

/**
 * Export units into the game: their entries into its units.json (a draft stops being one), then its build for them,
 * trusted only when every unit's build record carries this run's token and its .glb is new. While the build runs, the
 * model files of every character it reads (each unit's and its companion's) are held, so nothing rewrites them under
 * it (server/routes/ship.ts also refuses to start one while a job of theirs does). On a failure or a cancel
 * the game's units.json goes back as it was. Each unit's outcome is kept (workspace/game/builds/<unit>.json) and
 * journaled on its character.
 */
export async function exportUnits (names: string[], o: ExportOptions): Promise<UnitBuild[]> {
  const repo = await gameRepo()
  const file = gameUnitsFile(repo)
  const script = buildScript(repo)
  if (!existsSync(file) || !existsSync(script)) throw new Error(`The game's repo (${repo}) has no tools/rigsmith/units.json or build.sh: set it in Settings`)
  const spec = await units()
  // (refused before the game is touched: what the export would stop on anyway)
  for (const name of names) {
    const entry = spec.units[name]
    if (entry === undefined) throw new Error(`There is no unit ${name}`)
    const c = await getCharacter(entry.character)
    if (c === null) throw new Error(`${name}: its character ${entry.character} is gone`)
    const missing = entry.clips.filter(n => slotByName(c, n) === undefined)
    if (missing.length > 0) throw new Error(`${name}: ${c.name} has no clip named ${missing.join(', ')} (fill it in Motion)`)
    const comp = entry.companion
    if (comp !== undefined && await getCharacter(comp.character) === null) throw new Error(`${name}: its companion ${comp.character} is gone`)
    if (comp?.ridden === true && c.mount?.character !== comp.character) throw new Error(`${name}: rides ${comp.character} in the game, but ${c.name} rides ${c.mount?.character ?? 'nothing'} in Rigsmith`)
  }

  const original = await readFile(file, 'utf8')
  let text = original
  for (const name of names) text = spliceUnit(text, name, shipped(spec.units[name]))
  // (a splice that broke the file stops here, before anything is written)
  const game = JSON.parse(text) as GameSpec
  const run = randomBytes(8).toString('hex')
  const at = Date.now()
  await writeJson(BACKUP, { file, original, spliced: text, units: names, run, at })
  await writeFile(file, text)

  const log: string[] = []
  const outcome = (unit: string, status: UnitBuild['status'], extra: Partial<UnitBuild> = {}): UnitBuild => {
    const lines = linesFor(log, unit, names)
    return { unit, job: o.job, by: o.by, at, finishedAt: Date.now(), run, status, ...readLog(lines, unit), log: lines, ...extra }
  }
  let builds: UnitBuild[]
  try {
    // (the model files of every character the build reads, the companions' too, are held till it is checked: a rig,
    // a paint save or a texture landing halfway would mix two versions of one character. Their writers wait.)
    builds = await holdFiles(exportReads(spec, names), async () => {
      o.signal.throwIfAborted()
      await build(repo, script, names, run, o, log)
      const failed: string[] = []
      const done: UnitBuild[] = []
      for (const name of names) {
        const problem = await verify(repo, name, { ...game.defaults, ...game.units[name] } as UnitSpec, run, at)
        if (problem !== null) { failed.push(`${name}: ${problem}`); continue }
        const record = (await readJson<BuildRecord | null>(path.join(workDirOf(repo, name), 'rigsmith.json'), null))!
        const b = outcome(name, 'done', { walkStride: record.walkStride, runStride: record.runStride ?? null })
        b.warnings = [...new Set([...(record.warnings ?? []), ...b.warnings])]
        done.push(b)
      }
      if (failed.length > 0) throw new Error(failed.join('; '))
      return done
    })
  } catch (error) {
    const cancelled = o.signal.aborted
    const message = cancelled ? 'Cancelled' : error instanceof Error ? error.message : String(error)
    let restored = false
    try {
      await writeFile(file, original)
      restored = true
      await rm(BACKUP, { force: true })
    } catch (e) {
      console.error(`rigsmith: could not put back ${file} (its copy is in ${BACKUP}):`, e)
    }
    const status = cancelled ? 'cancelled' : 'failed'
    const failed: UnitBuild[] = []
    for (const name of names) {
      const b = outcome(name, status, { error: message, restored })
      failed.push(b)
      await keep(b)
      const id = spec.units[name].character
      await journalLine(id, o.by, 'export', [`export to the game as ${name} ${cancelled ? 'cancelled' : `failed: ${message}`}${restored ? "; the game's units.json is back as it was" : ''}`])
    }
    // (the job keeps what each unit's build said, its whole output too)
    o.update({ result: { units: names, builds: failed } })
    throw new Error(`${message}${restored ? " (the game's units.json is back as it was)" : ` (the game's units.json could not be put back: its copy is in ${path.relative(WORKSPACE, BACKUP)})`}`, { cause: error })
  }

  await rm(BACKUP, { force: true })
  // (in the game now: no longer drafts here either)
  await updateUnits(s => { for (const name of names) if (s.units[name] !== undefined) { delete s.units[name].draft; delete s.units[name]._draft } })
  for (const b of builds) {
    await keep(b)
    const entry = spec.units[b.unit]
    await journalLine(entry.character, o.by, 'export', [`exported to the game as ${b.unit} (${strides(b)}${b.holdsFailed.length > 0 ? `; ${b.holdsFailed.length} holds failed` : ''}${b.warnings.length > 0 ? `; ${b.warnings.length} warning${b.warnings.length === 1 ? '' : 's'}` : ''})`])
    if (entry.companion !== undefined) await journalLine(entry.companion.character, o.by, 'export', [`exported to the game with ${b.unit} (its ${entry.companion.ridden === true ? 'horse' : 'companion'})`])
  }
  return builds
}

export const strides = (b: Pick<UnitBuild, 'walkStride' | 'runStride'>): string =>
  b.walkStride != null ? `walk ${b.walkStride}${b.runStride != null ? `, run ${b.runStride}` : ''}` : 'no walk'

/** Why a unit's build can't be trusted to be this run's, or null when it can. */
async function verify (repo: string, unit: string, spec: UnitSpec, run: string, started: number): Promise<string | null> {
  const record = await readJson<BuildRecord | null>(path.join(workDirOf(repo, unit), 'rigsmith.json'), null)
  if (record === null || record.run !== run) return "the build left no record of this run (Rigsmith's export likely stopped: see the log)"
  const glb = modelFileOf(repo, unit, spec)
  const st = await stat(glb).catch(() => null)
  // (a little slack: some file systems keep coarse times)
  if (st === null || st.mtimeMs < started - 2000) return `${path.relative(repo, glb)} wasn't written by this run`
  return null
}

/** Run the game's build for `names`, its lines into `log` (all of them) and the job's progress. */
async function build (repo: string, script: string, names: string[], run: string, o: ExportOptions, log: string[]): Promise<void> {
  // (progress: each unit exported, its maps made, then the holds check, three steps a unit)
  const steps = names.length * 3
  let done = 0
  const step = (line: string): void => {
    if (/^\{"unit":/.test(line) || /^RIGSMITH_MAPS\s/.test(line)) done++
    else if (/^HOLDS_DONE\b/.test(line)) done = Math.max(done, steps)
    o.update({ progress: Math.min(0.95, 0.05 + 0.9 * done / steps), message: line.length > 140 ? `${line.slice(0, 139)}…` : line })
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawnJob('sh', [script, ...names], {
      cwd: repo, env: { ...process.env, RIGSMITH: ROOT, RIGSMITH_RUN: run }, stdio: ['ignore', 'pipe', 'pipe'],
    }, o.signal)
    let buffer = ''
    const take = (d: Buffer): void => {
      buffer += d.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const l of lines) if (l.trim() !== '') { log.push(l); step(l) }
    }
    child.stdout!.on('data', take)
    child.stderr!.on('data', take)
    child.on('error', error => { reject(new Error(`Could not start the game's build: ${error.message}`)) })
    child.on('close', code => {
      if (buffer.trim() !== '') log.push(buffer)
      if (o.signal.aborted) reject(o.signal.reason instanceof Error ? o.signal.reason : new Error('Cancelled'))
      else if (code === 0) resolve()
      else reject(new Error(`the game's build failed (exit ${code}): ${log.slice(-3).join(' · ')}`))
    })
  })
}

async function keep (b: UnitBuild): Promise<void> {
  try { await writeJson(path.join(BUILDS, `${b.unit}.json`), b) } catch (error) { console.error(`rigsmith: could not keep ${b.unit}'s build:`, error) }
}

/** A unit's last export, the build record the game has for it and when its model was written. */
export async function unitBuild (unit: string): Promise<UnitBuildView> {
  if (!UNIT_NAME.test(unit)) throw new HttpError(400, 'Bad unit name')
  const repo = await gameRepo()
  const last = await readJson<UnitBuild | null>(path.join(BUILDS, `${unit}.json`), null)
  const record = await readJson<BuildRecord | null>(path.join(workDirOf(repo, unit), 'rigsmith.json'), null)
  const game = await readSpec(gameUnitsFile(repo))
  const entry = { ...game?.defaults, ...(game?.units[unit] ?? (await units()).units[unit]) } as UnitSpec
  const file = modelFileOf(repo, unit, entry)
  const st = await stat(file).catch(() => null)
  return { last, record, glb: st === null ? null : { file: path.relative(repo, file), mtime: st.mtimeMs } }
}

/** After a restart: an export cut off in its build leaves the game's units.json spliced; put it back (only when it is
 * still what the export wrote) and note the cut-off build. */
export async function restoreInterruptedExport (): Promise<void> {
  const b = await readJson<{ file: string, original: string, spliced: string, units: string[], run: string, at: number } | null>(BACKUP, null)
  if (b === null) return
  let restored = false
  const now = await readFile(b.file, 'utf8').catch(() => null)
  if (now === b.spliced) {
    await writeFile(b.file, b.original)
    restored = true
    await rm(BACKUP, { force: true })
  } else {
    // (set aside, so the next start doesn't ask again)
    const kept = BACKUP.replace(/\.json$/, `-${b.at}.json`)
    await rename(BACKUP, kept)
    console.warn(`rigsmith: an export was cut off by a restart, but ${b.file} changed since; left as it is (the copy from before the export is in ${kept})`)
  }
  const spec = await units()
  for (const unit of b.units) {
    await keep({ unit, job: '', by: 'server', at: b.at, finishedAt: Date.now(), run: b.run, status: 'failed', error: 'a restart cut the build off', restored, holdsFailed: [], warnings: [], log: [] })
    const id = spec.units[unit]?.character
    if (id !== undefined && await getCharacter(id) !== null) {
      await journalLine(id, 'server', 'export', [`export to the game as ${unit} cut off by a restart${restored ? "; the game's units.json is back as it was" : ''}`])
    }
  }
}

/** The game's side of a character: the unit it is (or is the companion of) and the clip names the game plays for it, in
 * the spec's order (Rigsmith's units). Null when no unit names it. */
export async function gameSlots (id: string): Promise<{ unit: string, role: 'unit' | 'companion', clips: string[], height: number | null, spec: string,
  companion?: { character: string, height: number | null, ridden: boolean } } | null> {
  const spec = UNITS_FILE
  const json = await units()
  const list = Object.entries(json.units) as Array<[string, { character?: string, height?: number, clips?: string[] | Record<string, unknown>, companion?: { character?: string, height?: number, ridden?: boolean } }]>
  const clipsOf = (u: { clips?: string[] | Record<string, unknown> }): string[] => Array.isArray(u.clips) ? u.clips : Object.keys(u.clips ?? {})
  for (const [unit, u] of list) {
    const companion = u.companion?.character !== undefined ? { character: u.companion.character, height: u.companion.height ?? null, ridden: u.companion.ridden === true } : undefined
    if (u.character === id) return { unit, role: 'unit', clips: clipsOf(u), height: u.height ?? null, spec, companion }
  }
  // a companion several units share (one horse, dressed per rider): every name any of them plays
  const with_ = list.filter(([, u]) => u.companion?.character === id)
  if (with_.length === 0) return null
  const clips = [...new Set(with_.flatMap(([, u]) => clipsOf(u)))]
  return { unit: with_.map(([unit]) => unit).join(', '), role: 'companion', clips, height: with_[0][1].companion?.height ?? null, spec }
}
