// What tools/migrate.ts --check asserts of a character migrated from v1 (docs/rebuild/DESIGN.md §2.3), as pure
// functions of the v1 record and the schema 2 document: the effective skeleton is the old one, the detected joints
// alone still cover the skeleton, and every slot's hands close on the same fist or pose (or none) as v1 closed them.
// Also the hash list format --hashes reads and writes, and what it asserts of a schema 2 character moved to schema 3
// (docs/motion-plan.md §5): every key, window and picked blow it had maps back to the phase it was at; and of a dynamic
// character moved to schema 5, that the pick engine allows what the schema 4 rules did (folkProblems).
import path from 'node:path'
import { handAt, handLayers, type HandLayer } from '../../src/engine/hands.ts'
import { holdFactor } from '../../src/engine/pulls.ts'
import { v2TimeMap, type ClipTimes } from '../../src/model/migrate.ts'
import { DEFAULT_FIST, hierarchyOf, hitOf, jointsOf } from '../../src/model/select.ts'
import type { Character, HandPoseRef, Side, Vec3, Window } from '../../src/model/types.ts'
import type { V1Character, V1GripScript } from '../../src/model/v1.ts'
import type { V2Adjustment, V2Character, V2Window } from '../../src/model/v2.ts'
import type { V3Character } from '../../src/model/v3.ts'
import { layoutOf } from '../../src/model/pieces.ts'
import { stableJson } from '../../src/model/entities.ts'
import { warpAt } from '../../src/model/keyedit.ts'
import { clothesFor, coversFace, coversHair, fits, isFolk, outfitsOf } from '../../src/engine/folk.ts'
import { candidates, tagsAfter, worldOf } from '../../src/engine/folkpick.ts'
import { clothOf } from '../../src/model/folk.ts'
import type { GameSpec } from '../../src/model/unit.ts'

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

// ---- schema 2 -> 3 -------------------------------------------------------------------------------------------------

/** How near a phase must come back (it went through one multiply and add each way). */
const PHASE = 1e-9

/** The phase checks of a schema 2 character moved to schema 3: per slot, every key (bones and gear), every hand pose
 * and handle hold window, mapped back through the cut schema 2 played it by (`times`, measured), lands where it was;
 * a blow picked by hand became the hit at the same moment. What is wrong, in plain words (none: it passed). */
export function phaseProblems (v: V2Character, c: Character, times: Record<string, ClipTimes>): string[] {
  const problems: string[] = []
  for (const was of v.clips) {
    const now = c.clips.find(s => s.id === was.id)
    if (now === undefined) { problems.push(`clip ${was.name}: gone`); continue }
    const map = v2TimeMap(was, times[was.id])
    if (map === null) { problems.push(`clip ${was.name}: its cut couldn't be measured`); continue }
    const off = (a: number, b: number): boolean => !(Math.abs(map.toPlayed(a) - b) <= PHASE)
    const keysOff = (what: string, before: Array<{ u: number }> | undefined, after: Array<{ u: number }> | undefined): void => {
      const n = (before ?? []).length
      if ((after ?? []).length !== n) { problems.push(`clip ${was.name}: ${what} had ${n} keys, now ${(after ?? []).length}`); return }
      const bad = (before ?? []).filter((k, i) => off(after![i].u, k.u)).length
      if (bad > 0) problems.push(`clip ${was.name}: ${bad} of ${what}'s keys moved`)
    }
    const windowsOff = (what: string, before: V2Window[] | undefined, after: Window[] | undefined): void => {
      if (before === undefined && after === undefined) return
      if (before === undefined || after === undefined || before.length !== after.length) { problems.push(`clip ${was.name}: ${what}'s windows changed in number`); return }
      if (before.some((w, i) => off(after[i][0], w[0]) || off(after[i][1], w[1]))) problems.push(`clip ${was.name}: ${what}'s windows moved`)
    }
    for (const a of was.adjustments) {
      switch (a.kind) {
        case 'keys':
          for (const [b, ks] of Object.entries(a.bones ?? {})) if (ks.length > 0) keysOff(b, ks, now.bones?.[b])
          for (const [g, ks] of Object.entries(a.gear ?? {})) if (ks.length > 0) keysOff(`gear ${g}`, ks, now.gear?.[g]?.keys)
          break
        case 'handPose':
        case 'handleHold': {
          const mine = now.adjustments.find(x => x.id === a.id)
          if (mine === undefined || mine.kind !== a.kind) { problems.push(`clip ${was.name}: ${a.kind} ${a.id} gone`); break }
          windowsOff(`${a.kind} ${a.id}`, a.windows, (mine as Extract<typeof mine, { kind: 'handPose' | 'handleHold' }>).windows)
          break
        }
        case 'blowTiming':
          if (now.time?.fit === undefined || now.time.fit.at !== a.at || now.time.fit.enabled !== a.enabled) problems.push(`clip ${was.name}: its blow timing changed`)
          if (a.blowU !== undefined && hitOf(now)?.u !== a.blowU) problems.push(`clip ${was.name}: its blow picked at ${a.blowU} isn't its hit`)
          break
        case 'pace':
          if (now.time?.pace?.like !== a.like) problems.push(`clip ${was.name}: its pace changed`)
          break
        case 'ground':
          if (!now.adjustments.some(x => x.kind === 'ground' && x.id === a.id && x.lift === (a as Extract<V2Adjustment, { kind: 'ground' }>).lift)) problems.push(`clip ${was.name}: its ground changed`)
      }
    }
  }
  return problems
}

// ---- hash lists ---------------------------------------------------------------------------------------------------

// ---- schema 3 -> 4 -------------------------------------------------------------------------------------------------

/** The checks of a schema 3 character moved to schema 4: per slot with holds, every key (bones and gear), event, holder,
 * shown switch and hand window plays at the same second of its clip before speed (schema 3: W(u)·D and the seconds of
 * the holds before it; schema 4: W'(u')·D' of its pieces' composite, W' its markers' warp), within a microsecond; every
 * other slot is as it was. What is wrong, in plain words (none: it passed). */
export function heldProblems (v: V3Character, c: Character, times: Record<string, ClipTimes>): string[] {
  const problems: string[] = []
  for (const was of v.clips) {
    const now = c.clips.find(s => s.id === was.id)
    if (now === undefined) { problems.push(`clip ${was.name}: gone`); continue }
    const holds = (was.time?.holds ?? []).filter(h => h.seconds > 0)
    if (holds.length === 0) {
      const time = Object.fromEntries(Object.entries(was.time ?? {}).filter(([k]) => k !== 'holds'))
      const plain = { ...was, time: Object.keys(time).length > 0 ? time : undefined }
      if (stableJson(plain) !== stableJson(now)) problems.push(`clip ${was.name}: changed, though it had no holds`)
      continue
    }
    const D = times[was.id]?.seconds
    if (D === undefined) { problems.push(`clip ${was.name}: its clip couldn't be measured`); continue }
    if (now.pieces === undefined) { problems.push(`clip ${was.name}: its holds aren't pieces`); continue }
    const D2 = layoutOf(now.pieces).seconds
    const before = (u: number): number => holds.reduce((n, h) => n + (h.u < u ? h.seconds : 0), 0)
    const old = (u: number): number => warpAt(was.time?.markers, u) * D + before(u)
    const neu = (u: number): number => warpAt(now.time?.markers, u) * D2
    const pairs: Array<[string, number, number]> = []
    for (const [b, ks] of Object.entries(was.bones ?? {})) ks.forEach((k, i) => pairs.push([`${b} key ${i}`, k.u, now.bones?.[b]?.[i]?.u ?? NaN]))
    for (const [g, t] of Object.entries(was.gear ?? {})) {
      ;(t.keys ?? []).forEach((k, i) => pairs.push([`gear ${g} key ${i}`, k.u, now.gear?.[g]?.keys?.[i]?.u ?? NaN]))
      ;(t.heldBy ?? []).forEach((x, i) => pairs.push([`gear ${g} holder ${i}`, x.u, now.gear?.[g]?.heldBy?.[i]?.u ?? NaN]))
      ;(t.shown ?? []).forEach((x, i) => pairs.push([`gear ${g} shown ${i}`, x.u, now.gear?.[g]?.shown?.[i]?.u ?? NaN]))
    }
    ;(was.events ?? []).forEach((e, i) => {
      const n = now.events?.[i]
      pairs.push([`event ${e.name}`, e.u, n?.u ?? NaN])
      if (e.to !== undefined) pairs.push([`event ${e.name}'s end`, e.to, n?.to ?? NaN])
    })
    was.adjustments.forEach((a, i) => {
      const n = now.adjustments[i]
      if (a.kind === 'ground' || n === undefined || n.kind === 'ground') return
      ;(a.windows ?? []).forEach((w, j) => { pairs.push([`${a.kind} window ${j}`, w[0], n.windows?.[j]?.[0] ?? NaN]); pairs.push([`${a.kind} window ${j}`, w[1], n.windows?.[j]?.[1] ?? NaN]) })
    })
    const off = pairs.filter(([, a, b]) => !(Math.abs(old(a) - neu(b)) <= 1e-6))
    if (off.length > 0) problems.push(`clip ${was.name}: ${off.length} times play elsewhere (${off.slice(0, 3).map(x => x[0]).join(', ')})`)
  }
  return problems
}

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

// ---- schema 4 -> 5: the folk pick ------------------------------------------------------------------------------

/** What tools/migrate.ts --check asserts of a dynamic character moved to schema 5 (docs/dressing-plan.md Phase 1):
 * for every set (and none) and every skin (and none), the pick engine (src/engine/folkpick.ts) allows exactly the hair,
 * beards and clothes the schema 4 rules (src/engine/folk.ts fits, coversHair, coversFace, clothesFor) allowed of the
 * outfit, and each kind wears the outfits its unit spec named (all of them without one). In plain words (none: it
 * passed). */
export function folkProblems (v4: Pick<Character, 'id' | 'gear' | 'look'>, c: Character, units?: GameSpec): string[] {
  if (c.folk === undefined) return isFolk(v4) ? ['its outfits, hair and beards were not made a folk section'] : []
  const problems: string[] = []
  const w = worldOf(c)
  const sameList = (a: string[], b: string[]): boolean => stableJson([...a].sort()) === stableJson([...b].sort())
  const setOf = new Map(c.folk.sets.map(s => [s.id, s.name]))
  const layerOf = new Map(clothOf(c).map(l => [l.id, l.name]))
  const ready = v4.gear.filter(g => g.status === 'ready')
  const skins = v4.look.skins ?? []
  for (const outfit of [...outfitsOf(v4.gear), null]) {
    const set = outfit === null ? null : c.folk.sets.find(s => s.name === outfit)
    if (set === undefined) { problems.push(`outfit ${outfit}: no set of it`); continue }
    for (const skin of [...skins, undefined]) {
      const tags = tagsAfter(w, { set: set?.id ?? null, skin: skin?.name ?? null })
      const allowed = (step: string): string[] => candidates(w, step, tags).filter(x => x.ok).map(x => x.ref)
      const where = `outfit ${outfit ?? '(none)'}, skin ${skin?.name ?? '(none)'}`
      const hair = coversHair(v4.gear, outfit) ? [] : ready.filter(g => g.role === 'hair' && fits(g, skin)).map(g => g.id)
      const beard = coversFace(v4.gear, outfit) ? [] : ready.filter(g => g.role === 'beard' && fits(g, skin)).map(g => g.id)
      const clothes = clothesFor(v4.gear, outfit, v4.look.clothes ?? []).map(k => k.name)
      if (!sameList(allowed('hair'), hair)) problems.push(`${where}: hair ${list(allowed('hair'))} allowed, was ${list(hair)}`)
      if (!sameList(allowed('beard'), beard)) problems.push(`${where}: beards ${list(allowed('beard'))} allowed, was ${list(beard)}`)
      const cloth = allowed('bottom').map(id => layerOf.get(id) ?? id)
      if (!sameList(cloth, clothes)) problems.push(`${where}: clothes ${list(cloth)} allowed, was ${list(clothes)}`)
    }
  }
  const specs = Object.entries(units?.units ?? {}).filter(([, u]) => u.character === c.id && u.folk?.outfits !== undefined)
  const kinds = specs.length > 0 ? specs.map(([unit, u]) => [unit, u.folk!.outfits!.filter(o => outfitsOf(v4.gear).includes(o))] as const)
    : [['folk', outfitsOf(v4.gear)] as const]
  for (const [kind, outfits] of kinds) {
    if (!c.folk.kinds.some(k => k.id === kind)) { problems.push(`kind ${kind}: missing`); continue }
    const sets = candidates(w, 'set', [], { kind }).filter(x => x.ok).map(x => setOf.get(x.ref) ?? x.ref)
    if (!sameList(sets, [...outfits])) problems.push(`kind ${kind}: wears ${list(sets)}, was ${list([...outfits])}`)
  }
  return problems
}
