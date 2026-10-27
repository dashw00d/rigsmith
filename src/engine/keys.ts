// Keyframed tweaks on a clip, the same in the viewer and in the game export (tools/game_export.ts): the clip's ground
// height (its lift), turns (and the Hips' moves) on bones, and moves and turns of props. Applied last, on the clip as it
// plays: after its speed and the character's scripts. Keys sit at a phase of the clip (u: 0 its start, 1 its end), so a
// clip played faster keeps them on the same moment of the motion; a looping clip's keys wrap round, a one-shot's hold
// their first and last values.
import * as THREE from 'three'
import type { ClipKey } from '../../server/workspace.ts'

export const KEY_FPS = 30

/** The tweak at phase `u`: keys tweened smoothly (a cubic through them, Catmull-Rom tangents: a motion passes through
 * a key without stopping), wrapping round on a loop; a one-shot eases out of its first key and into its last, and holds
 * them beyond. */
export function sampleKeys (keys: ClipKey[], u: number, loop: boolean): { q: THREE.Quaternion, p: THREE.Vector3 } {
  if (keys.length === 0) return { q: new THREE.Quaternion(), p: new THREE.Vector3() }
  const ks = [...keys].sort((a, b) => a.u - b.u)
  const n = ks.length
  const val = (k: ClipKey): { q: number[], p: number[] } => ({ q: [...k.q], p: [...(k.p ?? [0, 0, 0])] })
  const out = (v: { q: number[], p: number[] }): { q: THREE.Quaternion, p: THREE.Vector3 } => ({ q: new THREE.Quaternion(...v.q as [number, number, number, number]).normalize(), p: new THREE.Vector3(...v.p as [number, number, number]) })
  if (n === 1) return out(val(ks[0]))
  // the segment: keys i and i+1 (indices past the ends wrap round a loop, a cycle on)
  const at = (i: number): { u: number, v: { q: number[], p: number[] } } => {
    const cycle = Math.floor(i / n)
    const k = ks[((i % n) + n) % n]
    return { u: k.u + cycle, v: val(k) }
  }
  let i: number
  let x = u
  if (u < ks[0].u || u >= ks[n - 1].u) {
    if (!loop) return out(val(u < ks[0].u ? ks[0] : ks[n - 1]))
    i = n - 1
    if (x < ks[0].u) x += 1
  } else {
    i = ks.findIndex(k => k.u > u) - 1
  }
  const k0 = at(i - 1); const k1 = at(i); const k2 = at(i + 1); const k3 = at(i + 2)
  const span = Math.max(k2.u - k1.u, 1e-9)
  const f = Math.min(1, Math.max(0, (x - k1.u) / span))
  // tangents (per unit of the segment): Catmull-Rom over uneven spacing; none at a one-shot's ends (it eases)
  const ends = !loop
  const first = ends && i === 0; const last = ends && i + 1 === n - 1
  // (quaternions on one side of the sphere, as the segment's first)
  const align = (q: number[]): number[] => (q[0] * k1.v.q[0] + q[1] * k1.v.q[1] + q[2] * k1.v.q[2] + q[3] * k1.v.q[3] < 0 ? q.map(c => -c) : q)
  const q0 = align(k0.v.q); const q1 = k1.v.q; const q2 = align(k2.v.q); const q3 = align(k3.v.q)
  const tangent = (a: number[], b: number[], ua: number, ub: number, none: boolean): number[] => none ? a.map(() => 0) : a.map((c, j) => (b[j] - c) / Math.max(ub - ua, 1e-9) * span)
  const h00 = 2 * f ** 3 - 3 * f ** 2 + 1; const h10 = f ** 3 - 2 * f ** 2 + f; const h01 = -2 * f ** 3 + 3 * f ** 2; const h11 = f ** 3 - f ** 2
  const hermite = (p0: number[], p1: number[], p2: number[], p3: number[]): number[] => {
    const m1 = tangent(p0, p2, k0.u, k2.u, first)
    const m2 = tangent(p1, p3, k1.u, k3.u, last)
    return p1.map((c, j) => h00 * c + h10 * m1[j] + h01 * p2[j] + h11 * m2[j])
  }
  return out({ q: hermite(q0, q1, q2, q3), p: hermite(k0.v.p, k1.v.p, k2.v.p, k3.v.p) })
}

/** The times a keyed track is baked at: every frame, and the clip's end. */
function frames (duration: number): number[] {
  const n = Math.max(1, Math.round(duration * KEY_FPS))
  return Array.from({ length: n + 1 }, (_, i) => Math.min(duration, i / KEY_FPS))
}

function trackValue (track: THREE.KeyframeTrack | undefined, t: number, size: number, fallback: number[]): number[] {
  if (track === undefined) return fallback
  const interpolant = (track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant()
  return Array.from(interpolant.evaluate(t) as ArrayLike<number>).slice(0, size)
}

/** The clip with its lift: the Hips raised `dy` straight up throughout (its position track, or a constant one at rest).
 * `up`: one world unit up in the hips' parent's frame (retarget.ts restUpOf): a tilted parent (a horse's root) isn't
 * raised along its own Y. */
export function applyLift (clip: THREE.AnimationClip, hips: string, dy: number, restPosition: THREE.Vector3, up: THREE.Vector3 = new THREE.Vector3(0, 1, 0)): THREE.AnimationClip {
  if (dy === 0) return clip
  const name = `${hips}.position`
  const tracks = clip.tracks.filter(t => t.name !== name)
  const was = clip.tracks.find(t => t.name === name)
  if (was !== undefined) {
    const copy = was.clone()
    for (let i = 0; i < copy.values.length; i += 3) { copy.values[i] += dy * up.x; copy.values[i + 1] += dy * up.y; copy.values[i + 2] += dy * up.z }
    tracks.push(copy)
  } else {
    const v = [restPosition.x + dy * up.x, restPosition.y + dy * up.y, restPosition.z + dy * up.z]
    tracks.push(new THREE.VectorKeyframeTrack(name, [0, clip.duration], [...v, ...v]))
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}

/** The clip with its bone keys: each keyed bone's turn is the clip's then the key's, in the bone's own frame
 * (q_clip * q_key), and a key's move adds to its position (the Hips; scaled by `moveScale`: the export's game units).
 * `rest` gives a bone's rest local transform where the clip has no track for it. */
export function applyBoneKeys (clip: THREE.AnimationClip, bones: Record<string, ClipKey[]> | undefined, loop: boolean,
  rest: (bone: string) => { q: THREE.Quaternion, p: THREE.Vector3 } | null, moveScale = 1): THREE.AnimationClip {
  const keyed = Object.entries(bones ?? {}).filter(([, ks]) => ks.length > 0)
  if (keyed.length === 0) return clip
  let tracks = [...clip.tracks]
  const times = frames(clip.duration)
  for (const [bone, keys] of keyed) {
    const r = rest(bone)
    if (r === null) continue
    const qTrack = tracks.find(t => t.name === `${bone}.quaternion`)
    const pTrack = tracks.find(t => t.name === `${bone}.position`)
    const qs: number[] = []; const ps: number[] = []
    const moves = keys.some(k => k.p !== undefined)
    for (const t of times) {
      const u = clip.duration > 0 ? t / clip.duration : 0
      const { q, p } = sampleKeys(keys, u, loop)
      const base = new THREE.Quaternion().fromArray(trackValue(qTrack, t, 4, r.q.toArray()))
      qs.push(...base.multiply(q).toArray())
      if (moves) {
        const bp = new THREE.Vector3().fromArray(trackValue(pTrack, t, 3, r.p.toArray()))
        ps.push(...bp.addScaledVector(p, moveScale).toArray())
      }
    }
    tracks = tracks.filter(t => t !== qTrack && (!moves || t !== pTrack))
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, qs))
    if (moves) tracks.push(new THREE.VectorKeyframeTrack(`${bone}.position`, times, ps))
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}

/** A prop's local transform over a clip: its placement (or rest) then its key's move and turn about its own origin,
 * `place` · [p_key·moveScale, q_key]. Tracks named `${node}.position` / `.quaternion`, baked on the frames. */
export function propTracks (node: string, duration: number, keys: ClipKey[] | undefined, loop: boolean,
  place: { position: THREE.Vector3, quaternion: THREE.Quaternion }, placeScale: number, moveScale = 1): THREE.KeyframeTrack[] {
  const times = keys !== undefined && keys.length > 0 ? frames(duration) : [0, duration]
  const ps: number[] = []; const qs: number[] = []
  for (const t of times) {
    const { q, p } = sampleKeys(keys ?? [], duration > 0 ? t / duration : 0, loop)
    // place · offset: the offset's move is in the prop's placed frame (turned by its placement, sized by its scale)
    const pos = p.clone().multiplyScalar(placeScale * moveScale).applyQuaternion(place.quaternion).add(place.position)
    ps.push(...pos.toArray())
    qs.push(...place.quaternion.clone().multiply(q).toArray())
  }
  return [new THREE.VectorKeyframeTrack(`${node}.position`, times, ps), new THREE.QuaternionKeyframeTrack(`${node}.quaternion`, times, qs)]
}

/** The ground: per frame of `clip` on `root` (a posable copy), the lowest point of `body`'s skin. Leaves the bones as
 * they were. */
export function lowestPoints (root: THREE.Object3D, body: THREE.SkinnedMesh, clip: THREE.AnimationClip, rate = 15, step = 3): number[] {
  const saved: Array<[THREE.Object3D, THREE.Vector3, THREE.Quaternion, THREE.Vector3]> = []
  root.traverse(o => { if ((o as THREE.Bone).isBone === true) saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]) })
  const mixer = new THREE.AnimationMixer(root)
  const action = mixer.clipAction(clip)
  action.play()
  const pos = body.geometry.attributes.position
  const v = new THREE.Vector3()
  const out: number[] = []
  for (let t = 0; t <= clip.duration + 1e-6; t += 1 / rate) {
    mixer.setTime(t)
    root.updateMatrixWorld(true)
    let y = Infinity
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i)
      body.applyBoneTransform(i, v)
      v.applyMatrix4(body.matrixWorld)
      if (v.y < y) y = v.y
    }
    out.push(y)
  }
  action.stop()
  mixer.uncacheRoot(root)
  for (const [o, p, q, s] of saved) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s) }
  root.updateMatrixWorld(true)
  return out
}
