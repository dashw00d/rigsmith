// What tools/migrate.ts --check asserts of a character migrated from v1 (docs/rebuild/DESIGN.md §2.3), as pure
// functions of the v1 record and the schema 2 document: the effective skeleton is the old one, the detected joints
// alone still cover the skeleton, and every slot's hands close on the same fist or pose (or none) as v1 closed them.
// Also the hash list format --hashes reads and writes.
import path from 'node:path'
import { handAt, handLayers, type HandLayer } from '../../src/engine/hands.ts'
import { holdFactor } from '../../src/engine/pulls.ts'
import { DEFAULT_FIST, hierarchyOf, jointsOf } from '../../src/model/select.ts'
import type { Character, HandPoseRef, Side, Vec3 } from '../../src/model/types.ts'
import type { V1Character, V1GripScript } from '../../src/model/v1.ts'

const SIDES: Side[] = ['Left', 'Right']
/** The migration keeps a joint as placed by hand when it moved more than this (src/model/migrate.ts). */
const PLACED = 1e-7
/** Phases sampled per slot and hand: finer than any ease (0.06 before a window, 0.02 after it). */
const SAMPLES = 1000

const list = (names: string[], max = 8): string => names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`
const gap = (a: Vec3, b: Vec3): number => Math.max(...a.map((x, i) => Math.abs(x - b[i])))

/** The skeleton checks: what is wrong, in plain words (none: it passed); `info`, differences too small to matter. */
export function jointProblems (v: V1Character, c: Character): { problems: string[], info: string[] } {
  const problems: string[] = []
  const info: string[] = []
  const old = v.joints ?? {}
  const now = jointsOf(c)
  const lost = Object.keys(old).filter(j => now[j] === undefined)
  const added = Object.keys(now).filter(j => old[j] === undefined)
  const kept = Object.keys(old).filter(j => now[j] !== undefined)
  const moved = kept.filter(j => gap(old[j], now[j]) > PLACED)
  const nudged = kept.filter(j => gap(old[j], now[j]) > 0 && gap(old[j], now[j]) <= PLACED)
  if (lost.length > 0) problems.push(`joints lost: ${list(lost)}`)
  if (added.length > 0) problems.push(`joints added: ${list(added)}`)
  if (moved.length > 0) problems.push(`joints moved: ${list(moved.map(j => `${j} by ${gap(old[j], now[j]).toExponential(1)}`))}`)
  if (nudged.length > 0) info.push(`${nudged.length} joint${nudged.length === 1 ? '' : 's'} within ${PLACED} of before (below the placed-by-hand threshold)`)
  if (Object.keys(old).length > 0) {
    const bare = jointsOf({ skeleton: { ...c.skeleton, overrides: {} } })
    const missing = hierarchyOf(c).map(([j]) => j).filter(j => bare[j] === undefined)
    if (missing.length > 0) problems.push(`without its overrides the skeleton lacks ${list(missing)}`)
  }
  return { problems, info }
}

/** One of v1's grips as applyScripts laid it: a fist clip id or 'pose:<id>', and where it let go (`open`) or the only
 * places it held (`during`), by animation entry name. */
export interface V1Grip {
  side: Side
  clip: string
  open?: Record<string, Array<[number, number]>>
  during?: Record<string, Array<[number, number]>>
}

/** v1's handScripts (src/engine/scripts.ts before schema 2) as applyScripts used it: the character's enabled grip
 * scripts; for a hand with none, the shown ready rigid garment on it closing the hand (unless its carryPose was
 * 'open'); then every pull of a worn garment by a hand with a pose, held only in its holds. Bottom to top. A pose that
 * no longer exists was the default fist. */
export function v1Grips (v: V1Character): V1Grip[] {
  const resolve = (clip: string): string =>
    !clip.startsWith('pose:') || (v.handPoses ?? []).some(p => p.id === clip.slice(5)) ? clip : DEFAULT_FIST
  const own = (v.scripts ?? []).filter((s): s is V1GripScript => s.kind === 'grip' && s.enabled)
  const out: V1Grip[] = own.map(s => ({ side: s.side, clip: resolve(s.clip), open: s.open }))
  const worn = (v.garments ?? []).filter(g => g.mode === 'rigid' && g.status === 'ready' && g.hidden !== true)
  for (const side of SIDES) {
    if (own.some(s => s.side === side)) continue
    const g = worn.find(x => x.bone === `${side}Hand`)
    if (g === undefined || g.carryPose === 'open') continue
    out.push({ side, clip: resolve(g.carryPose ?? DEFAULT_FIST), open: g.carryOpen })
  }
  for (const g of worn) {
    for (const p of g.pulls ?? []) {
      const side = /^(Left|Right)Hand$/.exec(p.bone)?.[1] as Side | undefined
      if (side === undefined || p.pose === undefined || p.pose === 'open') continue
      out.push({ side, clip: resolve(p.pose), during: p.holds ?? {} })
    }
  }
  return out
}

/** What a hand closes on: 'fist:<library clip id>', 'pose:<id>', or 'none' (the clip's own hand). */
export type HandKey = string

/** v1 at phase `u` of the entry `entry`: the topmost grip holding there. One letting go (inside its open windows, as
 * soon as it starts to ease) shows what is under it; one held only in windows (a pull) counts as soon as it eases in. */
export function v1HandAt (grips: V1Grip[], side: Side, entry: string, u: number): HandKey {
  let hand: HandKey = 'none'
  for (const g of grips) {
    if (g.side !== side) continue
    const key = g.clip.startsWith('pose:') ? g.clip : `fist:${g.clip}`
    if (g.during !== undefined) {
      if (holdFactor(g.during[entry] ?? [], u, 0.06) > 0) hand = key
    } else if (holdFactor(g.open?.[entry], u, 0.06) === 0) hand = key
  }
  return hand
}

export function refKey (ref: HandPoseRef): HandKey {
  if (ref === 'clip') return 'none'
  if (ref === 'default') return `fist:${DEFAULT_FIST}`
  return 'pose' in ref ? `pose:${ref.pose}` : `fist:${ref.fist}`
}

/** Schema 2 at phase `u`: the winning layer's pose ('clip' and no layer both leave the clip's own hand). */
export function v2HandAt (layers: HandLayer[], u: number): HandKey {
  const { layer } = handAt(layers, u)
  return layer === null ? 'none' : refKey(layer.ref)
}

const label = (key: HandKey): string => key === 'none' ? 'the clip\'s own hand' : key.replace(/^fist:/, 'fist ').replace(/^pose:/, 'pose ')

/** The hand checks: for every slot (the migration's slot i is v1's animation entry i) and hand, where schema 2 closes
 * the hand on something else than v1 did, as runs of phases. Compares references, not finger turns. */
export function handProblems (v: V1Character, c: Character): string[] {
  const problems: string[] = []
  const grips = v1Grips(v)
  const entries = v.animations ?? []
  if (entries.length !== c.clips.length) problems.push(`${entries.length} animation entries became ${c.clips.length} slots`)
  c.clips.forEach((slot, i) => {
    const entry = entries[i]
    if (entry === undefined) return
    for (const side of SIDES) {
      const layers = handLayers(c, slot, side)
      const runs: Array<{ from: number, to: number, was: HandKey, now: HandKey }> = []
      for (let k = 0; k <= SAMPLES; k++) {
        const u = k / SAMPLES
        const was = v1HandAt(grips, side, entry.name, u)
        const now = v2HandAt(layers, u)
        if (was === now) continue
        const last = runs.at(-1)
        if (last !== undefined && last.to === (k - 1) / SAMPLES && last.was === was && last.now === now) last.to = u
        else runs.push({ from: u, to: u, was, now })
      }
      for (const r of runs) {
        problems.push(`${slot.name}, ${side} hand, ${r.from === r.to ? `at ${r.from}` : `${r.from}-${r.to}`}: v1 ${label(r.was)}, now ${label(r.now)}`)
      }
    }
  })
  return problems
}

// ---- hash lists ---------------------------------------------------------------------------------------------------

/** A hash list as sha256sum writes it ('<hex>  <path>', '*' before the path in binary mode; # comments): file -> hash.
 * Relative paths are inside the workspace (what `cd workspace && sha256sum characters/x/rigged.glb` gives); absolute
 * ones inside it are made relative, others kept as they are. */
export function parseHashes (text: string, workspace: string): Map<string, string> {
  const out = new Map<string, string>()
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '' || line.startsWith('#')) return
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.replace(/\r$/, ''))
    if (m === null) throw new Error(`Line ${i + 1} of the hash list is not '<sha256>  <path>'`)
    const file = path.isAbsolute(m[2]) && m[2].startsWith(workspace + path.sep) ? path.relative(workspace, m[2]) : m[2]
    out.set(file.split(path.sep).join('/'), m[1].toLowerCase())
  })
  return out
}

/** The other way round, in path order. */
export function formatHashes (hashes: Map<string, string>): string {
  return [...hashes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, hash]) => `${hash}  ${file}\n`).join('')
}
