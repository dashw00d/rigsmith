// What the skeleton's generators do to the document (DESIGN.md §2.2), apart from running them: a finger trace (a new
// finger level, or the fingers detected again), a template switch, a refit of a creature template, a rigged import's
// conversion. Generators write `skeleton.detected`; the user's placements (`overrides`) are kept, or set aside as
// `stale` when they no longer mean what they meant, never dropped silently. Pure: the routes' jobs run Blender or the
// fit and hand the result here, inside the store lock. Each returns the journal's lines.
import { fingerLevelOf, isFingerJoint } from '../../src/engine/mixamo.ts'
import { templateName } from '../../src/engine/templates.ts'
import { jointsOf } from '../../src/model/select.ts'
import { hierarchyOf, humanHierarchy, TEMPLATE_PARENTS } from '../../src/model/skeletons.ts'
import type { Character, FingerLevel, Joints, StaleOverride, Vec3 } from '../../src/model/types.ts'
import { HttpError } from '../http.ts'
import { assertUnlocked } from './skin-policy.ts'

const INDEX = /^(Left|Right)HandIndex[1-4]$/
/** The marker board's finger tips (static/templates/markers.json, the human set's hand view). */
const TIP = /^(thumb|index|middle|ring|pinky)_tip(_[lr])?$/

export const LEVEL_NAMES: Record<FingerLevel, string> = { none: 'no fingers', one: 'one finger chain', two: 'two finger chains', three: 'three finger chains', full: 'all five fingers' }

const close = (a: Vec3, b: Vec3, d: number): boolean => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= d

function names (items: string[], max = 6): string {
  const shown = items.slice(0, items.length > max ? max - 1 : max)
  const rest = items.length - shown.length
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`
  return shown.length <= 1 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
}
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** Only the joints the skeleton has (in its order); a template this build doesn't know keeps them all. */
function restrict (joints: Joints, c: Pick<Character, 'skeleton'>): Joints {
  const { template } = c.skeleton
  if (template !== 'human' && TEMPLATE_PARENTS[template] === undefined) return Object.fromEntries(Object.entries(joints).map(([j, p]) => [j, [...p]]))
  const out: Joints = {}
  for (const [j] of hierarchyOf(c)) if (joints[j] !== undefined) out[j] = [...joints[j]]
  return out
}

const withoutFingers = (joints: Joints): Joints => Object.fromEntries(Object.entries(joints).filter(([j]) => !isFingerJoint(j)))

// ---- finger trace -------------------------------------------------------------------------------------------------

/** What a finger trace starts from: the skeleton as placed, without its fingers (every finger is traced again from
 * the mesh, at the wrists as placed). */
export function traceInput (c: Pick<Character, 'skeleton'>): Joints {
  return withoutFingers(jointsOf(c))
}

/** A new finger level changes a rigged character's bones, so its rig no longer fits and it would need rigging again:
 * refused while its weights are locked (DESIGN.md §6 row 13). Detecting the fingers again at the same level keeps the
 * bones, so the lock allows it. */
export function assertLevelUnlocked (c: Pick<Character, 'name' | 'skin' | 'files' | 'skeleton'>, level: FingerLevel): void {
  if (level !== c.skeleton.fingerLevel && c.files.rigged !== undefined) assertUnlocked(c)
}

/**
 * A finger trace (blender/autorig/rig.py --placements-only, from traceInput) put into the skeleton at `level`:
 * - detected: every finger joint replaced by the trace's (both hands); joints the trace completed that the input
 *   lacked are added (body joints detection failed on);
 * - overrides: at a level change, the ones the new level hasn't, and the index chain when crossing full <-> a mitten
 *   (at one and two it is the middle of the four fingers, at full the index finger), are set aside; on a detection
 *   again, both hands' finger placements are;
 * - markers: the board's finger entries go (their joints were traced again), so it seats their tips afresh.
 * Refused (409) when the wrists the trace ran at have moved meanwhile, or the level changed, or (at a new level) the
 * rig's weights are locked.
 */
export function applyFingerTrace (c: Character, o: { level: FingerLevel, redetect: boolean, from: FingerLevel, input: Joints, result: Joints }): string[] {
  const s = c.skeleton
  if (s.template !== 'human' || s.fingerLevel !== o.from) throw new HttpError(409, 'The skeleton changed while the fingers were traced; try again')
  assertLevelUnlocked(c, o.level)
  const now = traceInput(c)
  const shifted = Object.entries(o.input).filter(([j, p]) => now[j] === undefined || !close(now[j], p, 1e-6)).map(([j]) => j)
  if (shifted.length > 0) throw new HttpError(409, `${names(shifted)} moved while the fingers were traced; try again`)
  const out: string[] = []
  // (rig.py moves joints placed before the model stood on the floor up with it: the trace taken back by the same)
  const hips = o.input.Hips !== undefined && o.result.Hips !== undefined ? o.result.Hips.map((v, i) => v - o.input.Hips[i]) as Vec3 : [0, 0, 0] as Vec3
  const lift = Math.hypot(...hips) > 1e-5
  const back = (p: Vec3): Vec3 => (lift ? [p[0] - hips[0], p[1] - hips[1], p[2] - hips[2]] : [p[0], p[1], p[2]])
  if (lift) out.push(`skeleton: the trace came back moved by ${hips.map(v => v.toFixed(3)).join(', ')} (joints placed before the model stood on the floor); taken back`)

  const want = humanHierarchy(o.level).map(([j]) => j)
  const detected: Joints = withoutFingers(s.detected ?? {})
  const completed: string[] = []
  for (const j of want) {
    const p = o.result[j]
    if (p === undefined) continue
    if (isFingerJoint(j)) detected[j] = back(p)
    else if (o.input[j] === undefined) { detected[j] = back(p); completed.push(j) }
  }
  s.detected = detected
  s.fingerLevel = o.level
  out.unshift(o.redetect ? 'skeleton: fingers detected again from the mesh' : `skeleton: finger level ${o.from} -> ${o.level} (${LEVEL_NAMES[o.level]}), fingers traced from the mesh`)
  if (completed.length > 0) out.push(`skeleton: ${names(completed)} detected (they were missing)`)

  const known = new Set(want)
  // (the Index chain is the index finger at three and full, a mitten down the middle of the four at one and two)
  const realIndex = (level: FingerLevel): boolean => level === 'three' || level === 'full'
  const crossing = o.from !== o.level && realIndex(o.from) !== realIndex(o.level)
  const aside: StaleOverride[] = []
  for (const [j, at] of Object.entries(s.overrides)) {
    let reason: string | null = null
    if (o.redetect && isFingerJoint(j)) reason = 'the fingers were detected again'
    else if (!known.has(j)) reason = `finger level ${o.level} has no ${j}`
    else if (crossing && INDEX.test(j)) reason = realIndex(o.from) ? 'the index chain became the middle of a mitten' : 'the middle of the mitten became the index finger'
    if (reason === null) continue
    aside.push({ joint: j, at: [...at], reason, template: s.template, level: o.from })
    delete s.overrides[j]
  }
  if (aside.length > 0) {
    s.stale = [...(s.stale ?? []), ...aside]
    out.push(`skeleton: ${plural(aside.length, 'placement')} set aside (${names(aside.map(x => x.joint))}): restore them at finger level ${o.from}`)
  }

  if (s.markers !== undefined) {
    const base = Object.fromEntries(Object.entries(s.markers.base).filter(([k]) => !isFingerJoint(k)))
    const positions = Object.fromEntries(Object.entries(s.markers.positions).filter(([k]) => !TIP.test(k)))
    if (Object.keys(base).length !== Object.keys(s.markers.base).length || Object.keys(positions).length !== Object.keys(s.markers.positions).length) {
      s.markers = { ...s.markers, base, positions }
      out.push('markers: the finger tips start again on the traced fingers')
    }
  }
  return out
}

// ---- template switch ------------------------------------------------------------------------------------------------

/** Switching back to the human: the import's own detection, at the character's finger level. `trace`: its fingers
 * (or all of it, when the import found none) must be traced again first, from `joints`. */
export function humanSeed (c: Pick<Character, 'skeleton'>, level: FingerLevel): { joints: Joints, trace: boolean } {
  const imported = c.skeleton.imported
  if (imported === undefined || Object.keys(imported).length === 0) return { joints: {}, trace: true }
  const want = humanHierarchy(level).map(([j]) => j)
  const own: Joints = {}
  for (const j of want) if (imported[j] !== undefined) own[j] = [...imported[j]]
  // (traced at another level, its index chain means something else: the fingers are traced again)
  if (fingerLevelOf(imported) !== level) return { joints: withoutFingers(own), trace: true }
  return { joints: own, trace: want.some(j => own[j] === undefined) }
}

/**
 * The skeleton put on another template: `detected` the fit (a creature) or the import's own detection (the human),
 * and everything made for the old skeleton cleared (placements, set-aside placements, markers) with the clips (they
 * were another family's). A rigged import is on Rigsmith's rig from then on (converted).
 */
export function applyTemplate (c: Character, template: string, detected: Joints | undefined, o: { fingers?: FingerLevel } = {}): string[] {
  const s = c.skeleton
  const from = s.template
  s.template = template
  if (o.fingers !== undefined) s.fingerLevel = o.fingers
  const fit = detected === undefined ? undefined : restrict(detected, c)
  if (fit === undefined || Object.keys(fit).length === 0) delete s.detected
  else s.detected = fit
  const cleared = [
    ...(Object.keys(s.overrides).length > 0 ? [plural(Object.keys(s.overrides).length, 'placed joint')] : []),
    ...((s.stale?.length ?? 0) > 0 ? [plural(s.stale!.length, 'set-aside placement')] : []),
    ...(s.markers !== undefined ? ['the markers'] : []),
    ...(c.clips.length > 0 ? [plural(c.clips.length, 'clip')] : []),
  ]
  s.overrides = {}
  delete s.stale
  delete s.markers
  c.clips = []
  const out = [`skeleton: ${templateName(from)} -> ${templateName(template)}${s.detected === undefined ? ' (no joints found: place them by hand)' : ` (${plural(Object.keys(s.detected).length, 'joint')})`}`]
  if (c.source.kind === 'rigged' && s.converted !== true) {
    s.converted = true
    out.push('skeleton: its own rig set aside for the Rigsmith rig')
  }
  if (cleared.length > 0) out.push(`cleared: ${names(cleared)} (made for the ${templateName(from)} skeleton)`)
  return out
}

// ---- refit, convert -------------------------------------------------------------------------------------------------

/** A creature template fitted to the mesh again: the fit becomes `detected`; the placements stay on top of it. */
export function applyRefit (c: Character, fit: Joints, how: string): string[] {
  const s = c.skeleton
  s.detected = restrict(fit, c)
  const out = [`skeleton: the ${templateName(s.template)} template fitted again (${how})`]
  const kept = Object.keys(s.overrides).filter(j => s.detected![j] !== undefined)
  if (kept.length > 0) out.push(`skeleton: ${plural(kept.length, 'placed joint')} kept over the new fit (${names(kept)}): Reset to use the fit`)
  return out
}

/** A rigged import put on the Rigsmith rig: its own skeleton's joints become the detected ones (what Reset goes
 * back to), at the finger level its hands have; placements cleared. Its files and weights stay as they are until it
 * is rigged here. */
export function applyConvert (c: Character, joints: Joints, level: FingerLevel): string[] {
  const s = c.skeleton
  if (s.template !== 'human') throw new HttpError(409, `It is on the ${templateName(s.template)} skeleton; switch it to a person first`)
  s.fingerLevel = level
  s.detected = restrict(joints, c)
  s.converted = true
  const placed = Object.keys(s.overrides).length
  s.overrides = {}
  const out = [`skeleton: converted onto the Rigsmith rig (${plural(Object.keys(s.detected).length, 'joint')} from its own skeleton, ${LEVEL_NAMES[level]})`]
  if (placed > 0) out.push(`cleared: ${plural(placed, 'placed joint')}`)
  return out
}
