// The game's units, Rigsmith's own: which character is which unit, its height, budget, the clip names it plays, its
// horse (workspace/game/units.json). Edited here, live in every open page and in each unit's journal; the game's repo
// (Settings.gameRepo) is written only by Export: the unit's entry in its tools/rigsmith/units.json (that block of the
// file alone, the rest byte for byte), then its build (tools/rigsmith/build.sh: the model, its maps, the holds check).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ROOT, WORKSPACE, getSettings } from './workspace.ts'

export interface UnitSpec {
  character: string
  height: number
  budget: number
  clips: string[]
  draft?: boolean
  companion?: { character: string, height: number, prefix: string, budget: number, material: string, ridden?: boolean, [k: string]: unknown }
  [k: string]: unknown
}
export interface GameSpec { units: Record<string, UnitSpec>, [k: string]: unknown }

export const UNITS_FILE = path.join(WORKSPACE, 'game', 'units.json')

export async function gameRepo (): Promise<string> {
  return (await getSettings()).gameRepo
}
export const gameUnitsFile = (repo: string): string => path.join(repo, 'tools', 'rigsmith', 'units.json')

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

/** Each unit: Rigsmith's entry, the game's, and whether they differ (what Export would write). */
export async function gameStatus (): Promise<{ repo: string, units: Record<string, { ours: UnitSpec | null, game: UnitSpec | null, differs: boolean }> }> {
  const repo = await gameRepo()
  const ours = (await units()).units
  const game = (await readSpec(gameUnitsFile(repo)))?.units ?? {}
  const out: Record<string, { ours: UnitSpec | null, game: UnitSpec | null, differs: boolean }> = {}
  for (const name of new Set([...Object.keys(ours), ...Object.keys(game)])) {
    const a = ours[name] ?? null; const b = game[name] ?? null
    out[name] = { ours: a, game: b, differs: JSON.stringify(a) !== JSON.stringify(b) }
  }
  return { repo, units: out }
}

export interface ExportReport { unit: string, walkStride?: number | null, runStride?: number | null, holdsFailed: string[], log: string[] }

/** Export units into the game: their entries into its units.json (a draft stops being one: it is in the game now),
 * then its build for them. */
export async function exportUnits (names: string[], onLine: (line: string) => void): Promise<ExportReport[]> {
  const repo = await gameRepo()
  const file = gameUnitsFile(repo)
  if (!existsSync(file)) throw new Error(`no ${file}: set the game's repo in Settings`)
  const spec = await units()
  let text = await readFile(file, 'utf8')
  for (const name of names) {
    const entry = spec.units[name]
    if (entry === undefined) throw new Error(`no unit ${name}`)
    if (entry.draft === true) { delete entry.draft; delete entry._draft }
    text = spliceUnit(text, name, entry)
  }
  JSON.parse(text)
  await writeFile(file, text)
  await saveUnits(spec)
  const log: string[] = []
  await new Promise<void>((resolve, reject) => {
    const child = spawn('sh', [path.join(repo, 'tools', 'rigsmith', 'build.sh'), ...names], { cwd: repo, env: { ...process.env, RIGSMITH: ROOT }, stdio: ['ignore', 'pipe', 'pipe'] })
    let buffer = ''
    const take = (d: Buffer): void => {
      buffer += d.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const l of lines) if (l.trim() !== '') { log.push(l); onLine(l) }
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', reject)
    child.on('close', code => { if (buffer.trim() !== '') log.push(buffer); code === 0 ? resolve() : reject(new Error(`the game's build failed: ${log.slice(-3).join(' ')}`)) })
  })
  return names.map(unit => {
    const report = log.map(l => { try { return JSON.parse(l) as { unit?: string, walkStride?: number | null, runStride?: number | null } } catch { return null } }).find(r => r?.unit === unit)
    return { unit, walkStride: report?.walkStride, runStride: report?.runStride, holdsFailed: log.filter(l => l.startsWith('HOLDS') && l.includes('FAIL') && l.includes(unit)), log: log.filter(l => l.includes(unit) || l.startsWith('warning')) }
  })
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
