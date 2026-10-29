// The pose toolbar's work against the timeline (src/app/motion/lanes.ts TimelineView): what each tool reads of the slot
// as it bakes (its clip, its clip before keys, its time map), which bones it works on (the selected Body tracks, else
// all of them), and the tracks it writes, as one `slot.keys.set`. The numbers are src/model/posetools.ts's; the poses
// are sampled from the bake (src/engine/onion.ts). Every tool works at the playhead, snapped to its frame.
import type * as THREE from 'three'
import type { Command, KeyTrack } from '../../../model/command-types.ts'
import type { ClipKey, Ease, Quat, SourceU, Vec3 } from '../../../model/types.ts'
import { gearKeysOf, hierarchyOf } from '../../../model/select.ts'
import {
  blendSeam, copyPose, easeOf, jumping, matchEnds, mirrorPose, mul, norm, pastePose, pushRelax, seamJump, selectedBones, selectedKeys, setEase,
  spreadChange, tween, valueAt, type Falloff, type Frames, type Pose, type PoseContext, type SeamJump, type Tracks,
} from '../../../model/posetools.ts'
import { framePhase, keySampler, poseAt, restFrames } from '../../../engine/onion.ts'
import { pelvisName, type RestSkeleton } from '../../../engine/retarget.ts'
import type { TimelineView } from '../lanes.ts'

/** What was copied: the pose, and where from (for the tooltip). */
export interface Clipboard { pose: Pose, from: string, bones: number }

/** A range set for range edit: the slot's Body track as it was then (what a change is measured against). */
export interface RangeEdit { slot: string, range: [SourceU, SourceU], before: Tracks }

export type TweenMode = 'tween' | 'push' | 'relax'

/** The playhead as a frame: its played phase, its source moment, its time in the baked clip. */
export function moment (view: TimelineView): { played: number, u: SourceU, t: number } {
  const played = Math.min(1, Math.max(0, view.snap(view.playhead)))
  return { played, u: view.toSource(played), t: played * (view.baked?.clip.duration ?? view.duration) }
}

/** What the model's tools need of the slot as it plays. */
export function contextOf (view: TimelineView): PoseContext {
  const range = view.baked?.time.range ?? [view.toSource(0), view.toSource(1)]
  return {
    loop: view.slot.loop,
    time: { toPlayed: view.toPlayed, toSource: view.toSource, range },
    frame: framePhase(view.baked?.clip.duration ?? view.duration),
    sample: keySampler,
  }
}

const framesOf = new WeakMap<RestSkeleton, Frames>()
export function frames (rest: RestSkeleton): Frames {
  let f = framesOf.get(rest)
  if (f === undefined) { f = restFrames(rest); framesOf.set(rest, f) }
  return f
}

/** The bones a tool works on: the selected Body tracks', else every bone of the skeleton (in the rest skeleton). */
export function bonesOf (view: TimelineView, rest: RestSkeleton): string[] {
  const picked = selectedBones(view.selection)
  const all = picked.length > 0 ? picked : hierarchyOf(view.character).map(([n]) => n)
  return all.filter(b => rest.bones.has(b))
}

/** The keyed bones a tween works on: the selected Body tracks', else every keyed one. */
export function keyedBonesOf (view: TimelineView): string[] {
  const picked = selectedBones(view.selection)
  const keyed = Object.keys(view.slot.bones ?? {})
  return picked.length > 0 ? picked.filter(b => keyed.includes(b)) : keyed
}

/** The pose at the playhead, as the slot shows it (the Hips' place too), of the bones a tool works on. */
export function copyAt (view: TimelineView, rest: RestSkeleton): Clipboard | null {
  if (view.baked === null) return null
  const { t, played } = moment(view)
  const bones = bonesOf(view, rest)
  const pose = copyPose(poseAt(view.baked.clip, t, rest, { bones, moves: [pelvisName(rest)] }))
  const n = Object.keys(pose).length
  return n === 0 ? null : { pose, bones: n, from: `${view.slot.name}, frame ${Math.round(played * view.frames)}` }
}

/** The tracks pasting `clip` (mirrored: Left <-> Right) at the playhead writes. */
export function pasteWrites (view: TimelineView, rest: RestSkeleton, clip: Clipboard, mirror: boolean): KeyTrack[] {
  if (view.baked === null) return []
  const { u, t } = moment(view)
  const pose = mirror ? mirrorPose(clip.pose, frames(rest)) : clip.pose
  const base = poseAt(view.baked.unkeyed, t, rest, { bones: Object.keys(pose), moves: [pelvisName(rest)] })
  return pastePose(view.slot.bones ?? {}, pose, u, base, contextOf(view), { frames: frames(rest) })
}

/** The tracks the tween slider writes at `amount` (0-1): tween between the neighbours, or push from / relax toward
 * their inbetween by that much. */
export function tweenWrites (view: TimelineView, mode: TweenMode, amount: number): KeyTrack[] {
  const bones = keyedBonesOf(view)
  const { u } = moment(view)
  const tracks = view.slot.bones ?? {}
  if (mode === 'tween') return tween(tracks, bones, u, amount, contextOf(view))
  return pushRelax(tracks, bones, u, mode === 'push' ? amount : -amount, contextOf(view))
}

/** How the slot would look at the playhead with `writes`: each written bone's local turn (and place), for a live
 * preview on the character before they are committed. */
export function previewOf (view: TimelineView, rest: RestSkeleton, writes: readonly KeyTrack[]): Map<THREE.Object3D, { q: Quat, p?: Vec3 }> {
  const out = new Map<THREE.Object3D, { q: Quat, p?: Vec3 }>()
  if (view.baked === null) return out
  const { u, t } = moment(view)
  const ctx = contextOf(view)
  const bones = writes.flatMap(w => ('bone' in w ? [w] : []))
  const base = poseAt(view.baked.unkeyed, t, rest, { bones: bones.map(w => w.bone), moves: [pelvisName(rest)] })
  for (const w of bones) {
    const b = rest.bones.get(w.bone); const at = base[w.bone]
    if (b === undefined || at === undefined) continue
    const k = valueAt(w.keys, u, ctx)
    const q = norm(mul(at.q, k.q))
    out.set(b.node, at.p === undefined || !w.keys.some(x => x.p !== undefined) ? { q } : { q, p: [at.p[0] + k.p[0], at.p[1] + k.p[1], at.p[2] + k.p[2]] })
  }
  return out
}

const seams = new WeakMap<THREE.AnimationClip, SeamJump>()
/** A loop's seam as it bakes (null for a one-shot, or while it bakes). */
export function seamOf (view: TimelineView, rest: RestSkeleton): SeamJump | null {
  const clip = view.baked?.clip
  if (clip === undefined || !view.slot.loop) return null
  let s = seams.get(clip)
  if (s === undefined) {
    const bones = hierarchyOf(view.character).map(([n]) => n).filter(b => rest.bones.has(b))
    s = seamJump(poseAt(clip, 0, rest, { bones }), poseAt(clip, clip.duration, rest, { bones }))
    seams.set(clip, s)
  }
  return s
}

/** The bones a seam tool closes: those that jump, of the selected Body tracks when there are. */
function seamBones (view: TimelineView, seam: SeamJump): string[] {
  const picked = selectedBones(view.selection)
  return jumping(seam, picked.length > 0 ? picked : undefined)
}

/** Match ends: the tracks keying the last frame to the first. */
export function matchWrites (view: TimelineView, rest: RestSkeleton): KeyTrack[] {
  const seam = seamOf(view, rest)
  if (seam === null || view.baked === null) return []
  const d = view.baked.clip.duration
  const moves = [pelvisName(rest)]
  const bones = seamBones(view, seam)
  return matchEnds(view.slot.bones ?? {}, bones, {
    first: poseAt(view.baked.clip, 0, rest, { bones, moves }), base: poseAt(view.baked.unkeyed, d, rest, { bones, moves }), frames: frames(rest),
  }, contextOf(view))
}

/** Blend across the seam over `n` frames either side. */
export function blendWrites (view: TimelineView, rest: RestSkeleton, n: number, kind: Falloff): KeyTrack[] {
  const seam = seamOf(view, rest)
  if (seam === null || view.baked === null) return []
  const d = view.baked.clip.duration
  const moves = [pelvisName(rest)]
  const bones = seamBones(view, seam)
  return blendSeam(view.slot.bones ?? {}, bones, {
    first: poseAt(view.baked.clip, 0, rest, { bones, moves }), last: poseAt(view.baked.clip, d, rest, { bones, moves }), frames: n, kind, rest: frames(rest),
  }, contextOf(view))
}

/** The ease the selected keys share ('mixed', or null with no key selected), and the tracks setting it. */
export function selectedEase (view: TimelineView): Ease | 'mixed' | null {
  return easeOf(view.slot.bones ?? {}, gearKeysOf(view.slot), selectedKeys(view.selection))
}
export function easeWrites (view: TimelineView, ease: Ease): KeyTrack[] {
  return setEase(view.slot.bones ?? {}, gearKeysOf(view.slot), selectedKeys(view.selection), ease)
}

/** Range edit: what changed at the playhead since the range was set, spread over it. Null when the playhead is
 * outside the range or the range was set on another slot. */
export function spreadWrites (view: TimelineView, edit: RangeEdit, kind: Falloff): KeyTrack[] | null {
  if (edit.slot !== view.slot.id) return null
  const { u } = moment(view)
  const [a, b] = edit.range
  if (u < a - 1e-6 || u > b + 1e-6) return null
  const now = view.slot.bones ?? {}
  const bones = [...new Set([...Object.keys(edit.before), ...Object.keys(now)])]
  return spreadChange(edit.before, now, bones, u, edit.range, kind, contextOf(view))
}

/** The Body track as it is now (a range's `before`). */
export function snapshot (view: TimelineView): Tracks {
  return Object.fromEntries(Object.entries(view.slot.bones ?? {}).map(([b, ks]) => [b, ks.map(k => ({ ...k }) as ClipKey)]))
}

export function keysCommand (view: TimelineView, tracks: KeyTrack[]): Command {
  return { type: 'slot.keys.set', slot: view.slot.id, tracks }
}

