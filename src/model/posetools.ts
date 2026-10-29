// The pose tools on a slot's Body track (docs/motion-plan.md §9 C3): copy a pose and paste it, or its mirror, at another
// moment; tween a key between its neighbours (or push it away from them, or relax it toward them); spread a change made
// at one moment over a range with a falloff; measure a loop's seam and close it (the last frame keyed to the first, or
// the jump blended across the seam); set the ease of a key's span. Pure: what a tool needs of the clip (a pose sampled
// from the baked slot, the bones' rest frames, the keys tweened as the bake tweens them) is handed in, and every result
// is the new contents of the tracks it changed, for one `slot.keys.set` (one undo).
//
// A key is a turn on top of the clip's, in the bone's own frame (local = clip · key: keys.ts applyBoneKeys), so a pose
// is copied as each bone's local turn as the slot shows it, and pasted as the key that brings the clip there at the new
// moment: copied between moments, slots or characters with the same bone names, it lands looking as it looked. Keys
// are stored at moments of the source (SourceU) and tweened in played time: every tool converts through the slot's time
// map. Quaternions are [x, y, z, w], multiplied as three.js multiplies them (a · b: b first, in a's frame).
import type { ClipKey, Ease, Quat, SourceU, Vec3 } from './types.ts'
import type { KeyTrack } from './command-types.ts'
import type { TimeMap } from './timemap.ts'

/** A bone as a moment of the clip has it: its local turn, and (the Hips) its local place. */
export interface BonePose { q: Quat, p?: Vec3 }
/** Bones by name. */
export type Pose = Record<string, BonePose>
/** A bone's rest: its local turn, and its parent's world turn (the object holding it, for a top bone), both at rest in
 * the character's frame (+X its left, Y up, Z its front). Mirroring and the Hips' height are measured in these. */
export interface BoneFrame { rest: Quat, parent: Quat }
export type Frames = Record<string, BoneFrame>
/** A slot's Body track: keys by bone, in source time. */
export type Tracks = Readonly<Record<string, readonly ClipKey[]>>
/** keys.ts sampleKeys as plain numbers: the tweak keys give at played phase `v` (the keys' u already played phases). */
export type KeySampler = (keys: ClipKey[], v: number, loop: boolean) => { q: Quat, p: Vec3 }

/** What the tools need of the slot as it plays. */
export interface PoseContext {
  loop: boolean
  /** Source <-> played (the bake's `time`; timemap.ts IDENTITY while it bakes). */
  time: Pick<TimeMap, 'toPlayed' | 'toSource' | 'range'>
  /** One frame of the played clip, as a played phase (1 / its frames: keys.ts frameTimes). */
  frame: number
  sample: KeySampler
}

export type Falloff = 'linear' | 'smooth'
export const EASES: readonly Ease[] = ['smooth', 'linear', 'ease', 'step', 'hold']

/** The same moment (the reducer's SAME_MOMENT). */
const SAME = 1e-6
/** A seam jump smaller than this (radians) is no jump: those bones are left alone. */
export const SEAM_EPS = 1e-4
const I: Quat = [0, 0, 0, 1]

// ---- copy and paste ---------------------------------------------------------------------------------------------------

/** The pose of `bones` (all of `pose` when none are named) at a moment, as copied: their local turns as the slot shows
 * them (a deep copy, so the clipboard keeps it whatever plays next). */
export function copyPose (pose: Pose, bones?: Iterable<string>): Pose {
  const names = bones === undefined ? Object.keys(pose) : [...bones].filter(b => pose[b] !== undefined)
  return Object.fromEntries(names.map(b => [b, { q: [...pose[b].q] as Quat, ...(pose[b].p !== undefined ? { p: [...pose[b].p] as Vec3 } : {}) }]))
}

/** The bone on the other side: Left <-> Right (Mixamo names, with or without their `mixamorig:` prefix, and the
 * `_l` / `.L` suffixes of other rigs); a bone of the middle is itself. */
export function mirrorName (name: string): string {
  const m = /^(mixamorig\d*[:_]?)?(.*)$/.exec(name)!
  const prefix = m[1] ?? ''; const bare = m[2]
  const swap: Array<[RegExp, (s: string) => string]> = [
    [/^Left(?=[A-Z0-9_]|$)/, () => 'Right'], [/^Right(?=[A-Z0-9_]|$)/, () => 'Left'],
    [/^left(?=[_.A-Z0-9]|$)/, () => 'right'], [/^right(?=[_.A-Z0-9]|$)/, () => 'left'],
    [/([_.])([lLrR])$/, s => s[0] + ({ l: 'r', r: 'l', L: 'R', R: 'L' } as Record<string, string>)[s[1]]],
  ]
  for (const [re, to] of swap) if (re.test(bare)) return prefix + bare.replace(re, to)
  return name
}

/** A pose mirrored across the character's middle (its YZ plane): each bone's turn becomes the other side's, as a turn
 * from its rest. A bone's turn from rest is measured in the character's axes as if its parent stood at rest
 * (G = P · L · R⁻¹ · P⁻¹, P its parent's rest world turn, R its rest local turn), reflected (x, y, z, w) -> (x, -y, -z,
 * w), and put on the other side's bone (L' = P'⁻¹ · G' · P' · R'). Mirrored all the way down a chain, the world turns
 * are the mirror of the world turns, whatever each bone's own axes. A place (the Hips) is reflected the same way. Bones
 * whose other side isn't in `frames` are left out. */
export function mirrorPose (pose: Pose, frames: Frames): Pose {
  const out: Pose = {}
  for (const [bone, v] of Object.entries(pose)) {
    const other = mirrorName(bone)
    const f = frames[bone]; const g = frames[other]
    if (f === undefined || g === undefined) continue
    const turn = mul(mul(f.parent, mul(v.q, inv(f.rest))), inv(f.parent))
    const q = norm(mul(mul(mul(inv(g.parent), reflect(turn)), g.parent), g.rest))
    const mirrored: BonePose = { q }
    if (v.p !== undefined) {
      const w = rotate(f.parent, v.p)
      mirrored.p = rotate(inv(g.parent), [-w[0], w[1], w[2]])
    }
    out[other] = mirrored
  }
  return out
}

/** How a place is pasted (the Hips'): 'height' its height only (where the body stands at the new moment stays: the
 * clip's travel isn't pulled back), 'all' all of it, 'none' not at all. */
export type PastePlace = 'height' | 'all' | 'none'

/** Paste `pose` at source moment `u`: for each of its bones, the key that turns the slot's clip there (`base`: the
 * pose of the clip before keys at `u`, the bake's `unkeyed`) to the pose's turn. A bone with no keys yet that is
 * already there gets none; a first key pins the bone at the clip's ends (as the editor's first key does), so the
 * change eases in and back out. */
export function pastePose (tracks: Tracks, pose: Pose, u: SourceU, base: Pose, ctx: PoseContext,
  o: { place?: PastePlace, frames?: Frames } = {}): KeyTrack[] {
  const place = o.place ?? 'height'
  const out: KeyTrack[] = []
  for (const [bone, v] of Object.entries(pose)) {
    const b = base[bone]
    if (b === undefined) continue
    const q = norm(mul(inv(b.q), v.q))
    let p: Vec3 | undefined
    if (v.p !== undefined && b.p !== undefined && place !== 'none') {
      const d = sub(v.p, b.p)
      const up = upOf(o.frames?.[bone])
      p = place === 'all' || up === null ? d : scale(up, dot(d, up))
    }
    const keys = tracks[bone] ?? []
    if (keys.length === 0 && angle(q, I) < 1e-5 && (p === undefined || len(p) < 1e-7)) continue
    out.push({ bone, keys: putKey(keys, key(u, q, p), ctx) })
  }
  return changed(tracks, out)
}

// ---- tween, push, relax ------------------------------------------------------------------------------------------------

/** The keys before and after source moment `u` on a track (a key at `u` itself left out): round the loop on a loop,
 * the one there is twice on a one-shot's end; null with no other key. `wrap`: -1 the previous is the last key a cycle
 * back, +1 the next the first a cycle on. */
export function neighbours (keys: readonly ClipKey[], u: SourceU, loop: boolean): { prev: ClipKey, next: ClipKey, wrap: { prev: boolean, next: boolean } } | null {
  const others = [...keys].filter(k => Math.abs(k.u - u) >= SAME).sort((a, b) => a.u - b.u)
  if (others.length === 0) return null
  let prev = others.findLast(k => k.u < u); let next = others.find(k => k.u > u)
  const wrap = { prev: false, next: false }
  if (prev === undefined) { if (loop) { prev = others[others.length - 1]; wrap.prev = true } else prev = next }
  if (next === undefined) { if (loop) { next = others[0]; wrap.next = true } else next = prev }
  return { prev: prev!, next: next!, wrap }
}

/** Tween: a key at `u` on each of `bones` `t` of the way from its previous key to its next (0 the previous, 1 the
 * next), turns and moves both. Bones with no key but at `u` are left alone. */
export function tween (tracks: Tracks, bones: Iterable<string>, u: SourceU, t: number, ctx: PoseContext): KeyTrack[] {
  const out: KeyTrack[] = []
  for (const bone of bones) {
    const keys = tracks[bone] ?? []
    const n = neighbours(keys, u, ctx.loop)
    if (n === null) continue
    const q = slerp(n.prev.q, n.next.q, t)
    const p = n.prev.p === undefined && n.next.p === undefined ? undefined : lerp(n.prev.p ?? [0, 0, 0], n.next.p ?? [0, 0, 0], t)
    out.push({ bone, keys: putKey(keys, key(u, q, p), ctx) })
  }
  return changed(tracks, out)
}

/** Push (`amount` > 0) the key at `u` away from the even inbetween of its neighbours (the pose they'd tween to at
 * `u`), exaggerating it; relax (`amount` < 0) it toward that inbetween, -1 onto it. Keyed at `u` from what the track
 * gives there when there's no key yet. */
export function pushRelax (tracks: Tracks, bones: Iterable<string>, u: SourceU, amount: number, ctx: PoseContext): KeyTrack[] {
  const out: KeyTrack[] = []
  const at = ctx.time.toPlayed(u)
  for (const bone of bones) {
    const keys = tracks[bone] ?? []
    const n = neighbours(keys, u, ctx.loop)
    if (n === null) continue
    const a = ctx.time.toPlayed(n.prev.u) - (n.wrap.prev ? 1 : 0)
    const b = ctx.time.toPlayed(n.next.u) + (n.wrap.next ? 1 : 0)
    const f = b - a > 1e-9 ? Math.min(1, Math.max(0, (at - a) / (b - a))) : 0.5
    const mid = { q: slerp(n.prev.q, n.next.q, f), p: lerp(n.prev.p ?? [0, 0, 0], n.next.p ?? [0, 0, 0], f) }
    const now = valueAt(keys, u, ctx)
    const s = 1 + amount
    const q = slerp(mid.q, now.q, s)
    const moves = n.prev.p !== undefined || n.next.p !== undefined || keys.some(k => k.p !== undefined)
    out.push({ bone, keys: putKey(keys, key(u, q, moves ? lerp(mid.p, now.p, s) : undefined), ctx) })
  }
  return changed(tracks, out)
}

// ---- range edit ------------------------------------------------------------------------------------------------------

/** The falloff at `x` (0 at the range's edge, 1 at the moment changed). */
export function falloff (x: number, kind: Falloff): number {
  const c = Math.min(1, Math.max(0, x))
  return kind === 'linear' ? c : c * c * (3 - 2 * c)
}

/** How much of a change at played phase `peak` reaches played phase `v` over the played range [a, b]. */
export function rangeWeight (v: number, range: readonly [number, number], peak: number, kind: Falloff): number {
  const [a, b] = range
  if (v < a - 1e-12 || v > b + 1e-12) return 0
  const c = Math.min(b, Math.max(a, peak))
  if (Math.abs(v - c) < 1e-12) return 1
  return falloff(v < c ? (c - a > 1e-12 ? (v - a) / (c - a) : 1) : (b - c > 1e-12 ? (b - v) / (b - c) : 1), kind)
}

/** Spread what changed at source moment `u` between `before` and `after` (the Body track when the range was set, and
 * now) over the source range `range`: for each of `bones` whose turn (or move) at `u` changed, the change, as a turn on
 * top of the key (key' = key · change^w), reaches every moment of the range by the falloff, all of it at `u` and none
 * at the range's ends; outside the range the track is as it was before. The range is keyed at its ends, at `u`, at
 * the keys it had and at a few frames between (at most four spans a side), so the falloff's shape plays. */
export function spreadChange (before: Tracks, after: Tracks, bones: Iterable<string>, u: SourceU, range: readonly [SourceU, SourceU],
  kind: Falloff, ctx: PoseContext): KeyTrack[] {
  const out: KeyTrack[] = []
  const [a, b] = range[0] <= range[1] ? range : [range[1], range[0]]
  const played: [number, number] = [ctx.time.toPlayed(a), ctx.time.toPlayed(b)]
  const peak = ctx.time.toPlayed(u)
  for (const bone of bones) {
    const was = before[bone] ?? []; const now = after[bone] ?? []
    const v0 = valueAt(was, u, ctx); const v1 = valueAt(now, u, ctx)
    const turn = norm(mul(inv(v0.q), v1.q)); const move = sub(v1.p, v0.p)
    if (angle(turn, I) < 1e-7 && len(move) < 1e-9) continue
    const moves = was.some(k => k.p !== undefined) || now.some(k => k.p !== undefined)
    const points = spreadPoints(played, peak, was, ctx)
    const spread = points.map(s => {
      const v = valueAt(was, s, ctx)
      const w = rangeWeight(ctx.time.toPlayed(s), played, peak, kind)
      return key(s, mul(v.q, pow(turn, w)), moves ? add(v.p, scale(move, w)) : undefined)
    })
    out.push({ bone, keys: flatEdges(merged(was, spread, a, b), [a, b], ctx.loop) })
  }
  return changed(after, out)
}

// ---- the loop's seam -------------------------------------------------------------------------------------------------

export interface SeamJump {
  /** Each bone's jump (radians) from the clip's last frame to its first. */
  bones: Record<string, number>
  /** The largest. */
  worst: { bone: string, angle: number } | null
}

/** How far each bone jumps where a loop wraps round: its turn on the last frame against the first (both as the slot
 * shows them, the bake's clip at played 0 and 1). */
export function seamJump (first: Pose, last: Pose, bones?: Iterable<string>): SeamJump {
  const names = bones === undefined ? Object.keys(first) : [...bones]
  const out: Record<string, number> = {}
  let worst: SeamJump['worst'] = null
  for (const b of names) {
    if (first[b] === undefined || last[b] === undefined) continue
    const a = angle(first[b].q, last[b].q)
    out[b] = a
    if (worst === null || a > worst.angle) worst = { bone: b, angle: a }
  }
  return { bones: out, worst }
}

/** The bones that jump at the seam (more than SEAM_EPS), of `bones` when named. */
export function jumping (seam: SeamJump, bones?: Iterable<string>): string[] {
  const only = bones === undefined ? null : new Set(bones)
  return Object.entries(seam.bones).filter(([b, a]) => a > SEAM_EPS && (only === null || only.has(b))).map(([b]) => b)
}

/** Match ends: each of `bones` keyed on the last frame to the pose of the first (`first`: the slot as it shows the
 * first frame; `base`: the clip before keys on the last), the first frame keyed where it is when it has no key, so it
 * stays; the Hips' height matched too (not its travel). The correction tweens in from the key before the last. */
export function matchEnds (tracks: Tracks, bones: Iterable<string>, o: { first: Pose, base: Pose, frames?: Frames }, ctx: PoseContext): KeyTrack[] {
  const [s, e] = ctx.time.range
  const out: KeyTrack[] = []
  for (const bone of bones) {
    const f = o.first[bone]; const b = o.base[bone]
    if (f === undefined || b === undefined) continue
    let keys = [...(tracks[bone] ?? [])]
    const moves = keys.some(k => k.p !== undefined) || (f.p !== undefined && b.p !== undefined)
    if (!keys.some(k => Math.abs(k.u - s) < SAME)) {
      const v = valueAt(keys, s, ctx)
      keys = putKey(keys, key(s, v.q, moves ? v.p : undefined), { ...ctx, pin: false })
    }
    let p: Vec3 | undefined
    if (moves && f.p !== undefined && b.p !== undefined) {
      const now = valueAt(keys, e, ctx).p
      const d = sub(f.p, b.p)
      const up = upOf(o.frames?.[bone])
      p = up === null ? d : add(sub(now, scale(up, dot(now, up))), scale(up, dot(d, up)))
    }
    out.push({ bone, keys: putKey(keys, key(e, mul(inv(b.q), f.q), p), { ...ctx, pin: false }) })
  }
  return changed(tracks, out)
}

/** Blend across the seam: half of each bone's jump taken off the last frames and half off the first, fading over
 * `frames` frames either side by the falloff, so the loop meets in the middle with no frame keyed to stop dead.
 * `first` and `last`: the slot as it shows the first and last frames. The Hips' height meets the same way. */
export function blendSeam (tracks: Tracks, bones: Iterable<string>, o: { first: Pose, last: Pose, frames: number, kind?: Falloff, rest?: Frames },
  ctx: PoseContext): KeyTrack[] {
  const kind = o.kind ?? 'smooth'
  // (each side at most just under half the clip)
  const span = Math.max(1, Math.min(o.frames, Math.floor(0.49 / Math.max(ctx.frame, 1e-9)))) * ctx.frame
  const [s, e] = ctx.time.range
  const head: [number, number] = [0, span]; const tail: [number, number] = [1 - span, 1]
  const out: KeyTrack[] = []
  for (const bone of bones) {
    const f = o.first[bone]; const l = o.last[bone]
    if (f === undefined || l === undefined) continue
    const keys = tracks[bone] ?? []
    // (the turn the last frame needs to be the first, in its own frame; halved, either way)
    const jump = norm(mul(inv(l.q), f.q))
    const up = upOf(o.rest?.[bone])
    const moves = keys.some(k => k.p !== undefined) || (f.p !== undefined && l.p !== undefined && up !== null)
    const rise = moves && f.p !== undefined && l.p !== undefined && up !== null ? dot(sub(f.p, l.p), up) / 2 : 0
    const zone = (range: [number, number], peak: number, sign: 1 | -1): ClipKey[] =>
      spreadPoints(range, peak, keys, ctx).map(x => {
        const v = valueAt(keys, x, ctx)
        const w = rangeWeight(ctx.time.toPlayed(x), range, peak, kind)
        return key(x, mul(v.q, pow(jump, sign * w / 2)), moves ? add(v.p, scale(up ?? [0, 0, 0], sign * w * rise)) : undefined)
      })
    const tailKeys = zone(tail, 1, 1)
    const headKeys = zone(head, 0, -1)
    const inner = [ctx.time.toSource(span), ctx.time.toSource(1 - span)]
    const kept = merged(keys, headKeys, s, inner[0])
    out.push({ bone, keys: flatEdges(merged(kept, tailKeys, inner[1], e), inner, ctx.loop) })
  }
  return changed(tracks, out)
}

// ---- easing ----------------------------------------------------------------------------------------------------------

/** A selected key: its track (`body:<bone>`, `gear:<id>`) and its source moment (lanes.ts SelectedItem). */
export interface KeyRef { track: string, u: SourceU }

/** The ease of each selected key's span set to `ease` ('smooth' unsets it: the default). Body and gear keys alike. */
export function setEase (bones: Tracks, gear: Tracks, selected: readonly KeyRef[], ease: Ease): KeyTrack[] {
  const out: KeyTrack[] = []
  const byTrack = new Map<string, SourceU[]>()
  for (const s of selected) byTrack.set(s.track, [...(byTrack.get(s.track) ?? []), s.u])
  for (const [track, us] of byTrack) {
    const [kind, name] = splitTrack(track)
    const keys = kind === 'body' ? bones[name] : kind === 'gear' ? gear[name] : undefined
    if (keys === undefined) continue
    const next = keys.map(k => (us.some(u => Math.abs(u - k.u) < SAME) && (k.ease ?? 'smooth') !== ease ? withEase(k, ease) : k))
    if (next.every((k, i) => k === keys[i])) continue
    out.push(kind === 'body' ? { bone: name, keys: next } : { gear: name, keys: next })
  }
  return out
}

/** The ease the selected keys share ('smooth' for unset), 'mixed', or null with none selected. */
export function easeOf (bones: Tracks, gear: Tracks, selected: readonly KeyRef[]): Ease | 'mixed' | null {
  let seen: Ease | null = null
  for (const s of selected) {
    const [kind, name] = splitTrack(s.track)
    const k = (kind === 'body' ? bones[name] : kind === 'gear' ? gear[name] : undefined)?.find(x => Math.abs(x.u - s.u) < SAME)
    if (k === undefined) continue
    const e = k.ease ?? 'smooth'
    if (seen !== null && seen !== e) return 'mixed'
    seen = e
  }
  return seen
}

// ---- the selection ---------------------------------------------------------------------------------------------------

/** The bones of the Body tracks a selection touches (lanes.ts SelectedItem tracks `body:<bone>`). */
export function selectedBones (selection: readonly { track: string }[]): string[] {
  return [...new Set(selection.filter(s => s.track.startsWith('body:')).map(s => s.track.slice(5)))]
}

/** The selected keys (Body and Gear tracks). */
export function selectedKeys (selection: readonly { track: string, u: number }[]): KeyRef[] {
  return selection.filter(s => s.track.startsWith('body:') || s.track.startsWith('gear:')).map(s => ({ track: s.track, u: s.u }))
}

/** The source range a selection spans (null for less than two moments). */
export function selectionRange (selection: readonly { u: number }[]): [SourceU, SourceU] | null {
  if (selection.length === 0) return null
  const us = selection.map(s => s.u)
  const a = Math.min(...us); const b = Math.max(...us)
  return b - a < SAME ? null : [a, b]
}

// ---- keys ------------------------------------------------------------------------------------------------------------

/** `k` put on a track: over a key at its moment (whose ease it keeps unless it brings one), else between the keys
 * round it, easing as the span it lands in eases (a key dropped in a held span holds too). A first key also pins the
 * bone at the clip's ends (`pin`, default on), where it is unkeyed, so the change eases in and back out. */
export function putKey (keys: readonly ClipKey[], k: ClipKey, ctx: Pick<PoseContext, 'loop' | 'time'> & { pin?: boolean }): ClipKey[] {
  const at = keys.findIndex(x => Math.abs(x.u - k.u) < SAME)
  if (at >= 0) {
    const ease = k.ease ?? keys[at].ease
    return keys.map((x, i) => (i === at ? withEase({ ...k, u: x.u }, ease ?? 'smooth') : x))
  }
  if (keys.length === 0) {
    const out: ClipKey[] = [{ ...k }]
    if (ctx.pin !== false) {
      const [s, e] = ctx.time.range
      if (Math.abs(k.u - s) >= SAME) out.push({ u: s, q: [...I] })
      if (!ctx.loop && Math.abs(k.u - e) >= SAME) out.push({ u: e, q: [...I] })
    }
    return out.sort((a, b) => a.u - b.u)
  }
  const sorted = [...keys].sort((a, b) => a.u - b.u)
  const span = sorted.findLast(x => x.u < k.u) ?? (ctx.loop ? sorted[sorted.length - 1] : undefined)
  const put = k.ease !== undefined || span?.ease === undefined ? { ...k } : withEase({ ...k }, span.ease)
  return [...sorted, put].sort((a, b) => a.u - b.u)
}

/** What a track gives at source moment `u`, tweened as the bake tweens it. */
export function valueAt (keys: readonly ClipKey[], u: SourceU, ctx: Pick<PoseContext, 'loop' | 'time' | 'sample'>): { q: Quat, p: Vec3 } {
  if (keys.length === 0) return { q: [...I], p: [0, 0, 0] }
  const v = ctx.sample(keys.map(k => ({ ...k, u: ctx.time.toPlayed(k.u) })), ctx.time.toPlayed(u), ctx.loop)
  return { q: [...v.q] as Quat, p: [...v.p] as Vec3 }
}

// ---- inside ----------------------------------------------------------------------------------------------------------

/** The moments a spread keys over the played range [a, b]: its ends, the moment changed, the track's keys inside, and
 * frames between so each side has up to four spans; as source moments, distinct. */
function spreadPoints (range: readonly [number, number], peak: number, keys: readonly ClipKey[], ctx: PoseContext): SourceU[] {
  const [a, b] = range
  const c = Math.min(b, Math.max(a, peak))
  const f = Math.max(ctx.frame, 1e-9)
  const snap = (v: number): number => Math.min(b, Math.max(a, Math.round(v / f) * f))
  const played = [a, b, c]
  for (const [from, to] of [[a, c], [c, b]]) {
    const spans = Math.min(4, Math.floor((to - from) / f + 1e-9))
    for (let i = 1; i < spans; i++) played.push(snap(from + (to - from) * i / spans))
  }
  const src = played.map(v => ctx.time.toSource(v))
  for (const k of keys) {
    const v = ctx.time.toPlayed(k.u)
    if (v > a + 1e-9 && v < b - 1e-9) src.push(k.u)
  }
  src.sort((x, y) => x - y)
  return src.filter((u, i) => i === 0 || u - src[i - 1] >= SAME)
}

/** A track's keys outside the source range [a, b] (kept with their eases), with `inside` keyed over it: the eases of
 * keys `inside` that sit where the track had one kept, the rest easing as the span they land in. */
function merged (keys: readonly ClipKey[], inside: readonly ClipKey[], a: SourceU, b: SourceU): ClipKey[] {
  const sorted = [...keys].sort((x, y) => x.u - y.u)
  const outside = sorted.filter(k => k.u < a - SAME || k.u > b + SAME)
  const put = inside.map(k => {
    const own = sorted.find(x => Math.abs(x.u - k.u) < SAME)
    const span = own ?? sorted.findLast(x => x.u < k.u)
    return span?.ease === undefined ? k : withEase(k, span.ease)
  })
  return [...outside, ...put].sort((x, y) => x.u - y.u)
}

/** The spans either side of each of `edges` (where a spread fades to nothing) that join two keys of the same value
 * eased ('ease': no tangents), so the tween between them is that value all through: a smooth span there would bulge
 * with the change next to it (Catmull-Rom), letting it leak out of the range. */
function flatEdges (keys: ClipKey[], edges: readonly SourceU[], loop: boolean): ClipKey[] {
  const out = [...keys]
  const n = out.length
  const same = (x: ClipKey, y: ClipKey): boolean => angle(x.q, y.q) < 1e-7 && len(sub(x.p ?? [0, 0, 0], y.p ?? [0, 0, 0])) < 1e-9
  for (const e of edges) {
    const i = out.findIndex(k => Math.abs(k.u - e) < SAME)
    if (i < 0) continue
    for (const from of [i - 1, i]) {
      if (!loop && (from < 0 || from + 1 >= n)) continue
      const a = (from + n) % n; const b = (from + 1) % n
      if (a === b || out[a].ease !== undefined || !same(out[a], out[b])) continue
      out[a] = { ...out[a], ease: 'ease' }
    }
  }
  return out
}

/** Only the tracks that change. */
function changed (tracks: Tracks, out: KeyTrack[]): KeyTrack[] {
  return out.filter(t => 'bone' in t && JSON.stringify(tracks[t.bone] ?? []) !== JSON.stringify(t.keys))
}

function splitTrack (track: string): [string, string] {
  const i = track.indexOf(':')
  return i < 0 ? [track, ''] : [track.slice(0, i), track.slice(i + 1)]
}

function withEase (k: ClipKey, ease: Ease): ClipKey {
  const { ease: _was, ...rest } = k
  void _was
  return ease === 'smooth' ? rest : { ...rest, ease }
}

/** A key, its numbers rounded as the editor rounds them (keys stay short in the record). */
function key (u: SourceU, q: Quat, p?: Vec3): ClipKey {
  const r = (v: number): number => Math.round(v * 1e6) / 1e6 + 0
  const n = norm(q[3] < 0 ? q.map(c => -c) as Quat : q)
  const k: ClipKey = { u, q: n.map(r) as Quat }
  if (p !== undefined && len(p) > 1e-7) k.p = p.map(r) as Vec3
  return k
}

/** One unit straight up (world Y) in a bone's parent's frame. */
function upOf (f: BoneFrame | undefined): Vec3 | null {
  return f === undefined ? null : rotate(inv(f.parent), [0, 1, 0])
}

// quaternions and vectors, as plain numbers

export function mul (a: readonly number[], b: readonly number[]): Quat {
  const [ax, ay, az, aw] = a; const [bx, by, bz, bw] = b
  return [ax * bw + aw * bx + ay * bz - az * by, ay * bw + aw * by + az * bx - ax * bz, az * bw + aw * bz + ax * by - ay * bx, aw * bw - ax * bx - ay * by - az * bz]
}
export function inv (q: readonly number[]): Quat {
  const n = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] || 1
  return [-q[0] / n, -q[1] / n, -q[2] / n, q[3] / n]
}
export function norm (q: readonly number[]): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
}
/** The angle (radians) between two turns. */
export function angle (a: readonly number[], b: readonly number[]): number {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) / ((Math.hypot(...a) * Math.hypot(...b)) || 1)
  return 2 * Math.acos(Math.min(1, d))
}
/** A turn raised to `t` (the short way round): t of the way from none to it, any t. */
export function pow (q: readonly number[], t: number): Quat {
  const n = norm(q[3] < 0 ? q.map(c => -c) : q)
  const s = Math.hypot(n[0], n[1], n[2])
  if (s < 1e-12) return [0, 0, 0, 1]
  const half = Math.atan2(s, n[3]) * t
  const k = Math.sin(half) / s
  return [n[0] * k, n[1] * k, n[2] * k, Math.cos(half)]
}
/** `t` of the way from turn a to turn b, the short way (t beyond 0..1 runs on past them). */
export function slerp (a: readonly number[], b: readonly number[], t: number): Quat {
  return norm(mul(a, pow(mul(inv(a), b), t)))
}
/** Reflected across the YZ plane (x -> -x): a turn (x, y, z, w) -> (x, -y, -z, w). */
export function reflect (q: readonly number[]): Quat { return [q[0], -q[1], -q[2], q[3]] }
export function rotate (q: readonly number[], v: readonly number[]): Vec3 {
  const r = mul(mul(q, [v[0], v[1], v[2], 0]), inv(q))
  return [r[0], r[1], r[2]]
}
function sub (a: readonly number[], b: readonly number[]): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
function add (a: readonly number[], b: readonly number[]): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
function scale (a: readonly number[], s: number): Vec3 { return [a[0] * s, a[1] * s, a[2] * s] }
function dot (a: readonly number[], b: readonly number[]): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
function len (a: readonly number[]): number { return Math.hypot(a[0], a[1], a[2]) }
function lerp (a: readonly number[], b: readonly number[], t: number): Vec3 { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] }
