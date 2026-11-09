// Layers (docs/motion-plan.md §12.1): another clip played on some of the body, laid over a slot's source as the last
// step of making it (after its pieces are composed), so everything after (the timing, the blow fit, pace, footsteps,
// hands, keys) sees the body with it. A bone's part is the nearest of the part roots at or above it; a masked bone's
// turn goes from the source's to the layer's by the layer's weight times its envelope (src/model/envelope.ts) times the
// bone's share: 1, but along the torso when the hips aren't masked, graded from the waist up (an upper-body layer bends
// in from the Spine instead of snapping at it). With the hips masked their turn and their height come from the layer;
// their travel over the ground never does (the source's root motion stays).
//
// The layer's content time at source second s: `offset` + the seconds since its window started (no windows: since the
// clip did); past the content's end it holds its last pose, or loops round when `loop`.
import * as THREE from 'three'
import type { Adjustment, BodyPart } from '../model/types.ts'
import { envelope, windowAt } from '../model/envelope.ts'
import { frameTimes } from './keys.ts'
import { pelvisName, restUpOf, type RestSkeleton } from './retarget.ts'

export type Layer = Extract<Adjustment, { kind: 'layer' }>

/** The bone each part starts at. */
export const PART_ROOTS: Record<BodyPart, string> = {
  hips: 'Hips', torso: 'Spine', head: 'Neck', leftArm: 'LeftShoulder', rightArm: 'RightShoulder', leftLeg: 'LeftUpLeg', rightLeg: 'RightUpLeg',
}

/** Each bone's part (the nearest part root at or above it; the pelvis counts as the hips' root whatever its name). */
export function partsOf (rest: RestSkeleton): Map<string, BodyPart> {
  const roots = new Map<string, BodyPart>(Object.entries(PART_ROOTS).map(([part, bone]) => [bone, part as BodyPart]))
  roots.set(pelvisName(rest), 'hips')
  const out = new Map<string, BodyPart>()
  for (const name of rest.order) {
    const own = roots.get(name)
    if (own !== undefined) { out.set(name, own); continue }
    const parent = rest.bones.get(name)?.parent ?? null
    const inherited = parent === null ? undefined : out.get(parent)
    if (inherited !== undefined) out.set(name, inherited)
  }
  return out
}

/** Each masked bone's share of the layer (bones not in the mask are left out). Along the torso, without the hips, the
 * chain from the Spine up is graded k/n (Spine 1/3, Spine1 2/3, Spine2 1); its other bones take the share of the torso
 * bone they hang from. */
export function maskShares (rest: RestSkeleton, mask: readonly BodyPart[]): Map<string, number> {
  const parts = partsOf(rest)
  const out = new Map<string, number>()
  const graded = mask.includes('torso') && !mask.includes('hips')
  // (the torso's chain: from the Spine, each next torso bone a child of the last, up to the neck or the shoulders)
  const chain: string[] = []
  if (graded) {
    let at: string | undefined = rest.bones.has(PART_ROOTS.torso) ? PART_ROOTS.torso : undefined
    while (at !== undefined) {
      chain.push(at)
      at = rest.order.find(n => rest.bones.get(n)?.parent === at && parts.get(n) === 'torso' && !n.includes('_End'))
    }
  }
  for (const name of rest.order) {
    const part = parts.get(name)
    if (part === undefined || !mask.includes(part)) continue
    if (graded && part === 'torso') {
      const k = chain.indexOf(name)
      if (k >= 0) { out.set(name, (k + 1) / chain.length); continue }
      const parent = rest.bones.get(name)?.parent ?? null
      out.set(name, parent === null ? 1 : out.get(parent) ?? 1)
      continue
    }
    out.set(name, 1)
  }
  return out
}

/** The layer's content second at source second `s` (a source `seconds` long), or null outside its windows. */
export function contentTime (layer: Pick<Layer, 'windows' | 'offset' | 'loop'>, s: number, seconds: number, length: number): number | null {
  const u = seconds > 0 ? s / seconds : 0
  let since = s
  if (layer.windows !== undefined) {
    const w = windowAt(u, layer.windows)
    if (w === null) return null
    since = s - w[0] * seconds
  }
  const t = (layer.offset ?? 0) + Math.max(0, since)
  if (length <= 0) return 0
  if (layer.loop === true) return ((t % length) + length) % length
  return Math.min(length, t)
}

/** `raw` (a slot's source) with each layer's `contents` (its clip, as read for the slot) laid over it on KEY_FPS frames.
 * `report` gets each layer's bones. */
export function layClips (raw: THREE.AnimationClip, layers: ReadonlyArray<{ layer: Layer, content: THREE.AnimationClip }>, rest: RestSkeleton,
  report: Record<string, unknown> = {}): THREE.AnimationClip {
  const on = layers.filter(l => (l.layer.weight ?? 1) > 0)
  if (on.length === 0 || raw.duration <= 0) return raw
  const D = raw.duration
  const times = frameTimes(D)
  const pelvis = pelvisName(rest)
  const hipsNode = rest.bones.get(pelvis)?.node.name
  const up = restUpOf(rest, pelvis).normalize()

  /** A clip's track read at any second (its interpolant made once), or null without it. */
  const reader = (clip: THREE.AnimationClip, name: string): ((t: number) => number[]) | null => {
    const track = clip.tracks.find(x => x.name === name)
    if (track === undefined) return null
    const size = track.getValueSize()
    const i = (track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant()
    return t => Array.from(i.evaluate(Math.min(clip.duration, Math.max(0, t))) as ArrayLike<number>).slice(0, size)
  }

  // the base, frame by frame, per track touched (the source's values, or the rest's where it has none)
  const values = new Map<string, number[][]>()
  const base = (name: string, fallback: number[]): number[][] => {
    let v = values.get(name)
    if (v === undefined) {
      const read = reader(raw, name)
      v = times.map(t => (read === null ? [...fallback] : read(t)))
      values.set(name, v)
    }
    return v
  }

  const a = new THREE.Quaternion(); const b = new THREE.Quaternion()
  for (const { layer, content } of on) {
    const shares = maskShares(rest, layer.mask)
    const weight = layer.weight ?? 1
    const at = times.map(t => contentTime(layer, t, D, content.duration))
    const mix = times.map((t, i) => (at[i] === null ? 0 : weight * envelope(t / D, layer.windows, (layer.fade ?? 0) / D)))
    const bones: string[] = []
    for (const [bone, share] of shares) {
      const r = rest.bones.get(bone)!
      const node = r.node.name
      const readQ = reader(content, `${node}.quaternion`)
      const readP = node === hipsNode ? reader(content, `${node}.position`) : null
      if (readQ === null && readP === null) continue
      bones.push(bone)
      if (readQ !== null) {
        const qs = base(`${node}.quaternion`, r.localQuaternion.toArray())
        times.forEach((_, i) => {
          const w = mix[i] * share
          if (w <= 0) return
          a.fromArray(qs[i]); b.fromArray(readQ(at[i]!))
          qs[i] = w >= 1 ? b.normalize().toArray() : a.slerp(b, w).normalize().toArray()
        })
      }
      // (the hips' height from the layer, never their travel)
      if (readP !== null) {
        const ps = base(`${node}.position`, r.localPosition.toArray())
        times.forEach((_, i) => {
          const w = mix[i] * share
          if (w <= 0) return
          const now = new THREE.Vector3().fromArray(ps[i])
          const rise = new THREE.Vector3().fromArray(readP(at[i]!)).sub(now).dot(up)
          ps[i] = now.addScaledVector(up, rise * w).toArray()
        })
      }
    }
    report[layer.id] = { kind: 'layer', mask: layer.mask, bones: bones.length, ...(bones.length === 0 ? { missing: true } : {}) }
  }
  if (values.size === 0) return raw
  const tracks = raw.tracks.filter(t => !values.has(t.name))
  for (const [name, v] of values) {
    const flat = v.flat()
    tracks.push(v[0].length === 4 ? new THREE.QuaternionKeyframeTrack(name, times, flat) : new THREE.VectorKeyframeTrack(name, times, flat))
  }
  return new THREE.AnimationClip(raw.name, D, tracks)
}
