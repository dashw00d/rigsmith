// Riding, the same in the viewer and in the game export (tools/game_export.ts): the rider's lower body held in its seated
// pose, his rest space placed on the horse's back, and the two characters' clips of a slot played together as the game
// plays them: a loop fitted by whole cycles (the horse's gait leads), the horse's attack fitted to the rider's (his blow
// is the game's hit), anything else at its own length.
import * as THREE from 'three'
import type { Mount } from '../../server/workspace.ts'
import type { RestSkeleton } from './retarget.ts'
import { retime } from './scripts.ts'

/** The bones a rider holds still by default: his hips and legs. */
export const LOWER_BODY = ['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'LeftToe_End', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase', 'RightToe_End']

/** `clip` with the frozen bones held at the seated pose: each a constant turn (its pose, else its rest), the Hips also
 * a constant position (`hips`, mapped into the clip's units by `toClip`, else its rest). `rest` is in the clip's units. */
export function freezeClip (clip: THREE.AnimationClip, mount: Pick<Mount, 'freeze' | 'pose' | 'hips'>,
  rest: (bone: string) => { q: THREE.Quaternion, p: THREE.Vector3 } | null, toClip: (p: THREE.Vector3) => THREE.Vector3 = p => p): THREE.AnimationClip {
  const frozen = new Set(mount.freeze)
  if (frozen.size === 0) return clip
  const tracks = clip.tracks.filter(t => {
    const dot = t.name.lastIndexOf('.')
    return !frozen.has(t.name.slice(0, dot))
  })
  const d = Math.max(clip.duration, 1e-3)
  for (const bone of frozen) {
    const r = rest(bone)
    if (r === null) continue
    const q = mount.pose[bone] !== undefined ? new THREE.Quaternion(...mount.pose[bone]) : r.q
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, [0, d], [...q.toArray(), ...q.toArray()]))
    const p = bone === 'Hips' && mount.hips !== undefined ? toClip(new THREE.Vector3(...mount.hips)) : r.p
    tracks.push(new THREE.VectorKeyframeTrack(`${bone}.position`, [0, d], [...p.toArray(), ...p.toArray()]))
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}

/** A character as both the app and the tools hold it (src/engine/CharacterView.ts): its bones, rest, skinned meshes
 * (their matrices current, at rest) and height. */
export interface Body { bones: Map<string, THREE.Bone>, rest: RestSkeleton | null, skinned: THREE.SkinnedMesh[], height: number }

/** A new seat, worked out from the two bodies at rest (both in their own files' spaces; the horse faces +Z): the rider
 * in the low point of the horse's back (a saddle's seat, between its pommel and cantle) over its middle, his hip joint a
 * tenth of his height above it, carried by the spine bone nearest; his hips upright as at rest, each thigh out round
 * the horse's barrel and a little forward, the shin down to beside the belly (where a stirrup hangs), the foot flat.
 * `k` his size in the horse's space. The app's "Rides" and the tools' `rig ride` both start from this. */
export function straddle (horse: Body, rider: Body, k: number): Pick<Mount, 'bone' | 'position' | 'freeze' | 'pose' | 'hips'> {
  const hb = horse.rest!.bones
  const spine = [...hb.keys()].filter(b => /spine/i.test(b))
  const pelvis = [...hb.keys()].find(b => /^(hips|pelvis)$/i.test(b))
  const along = [...spine, ...(pelvis !== undefined ? [pelvis] : [])].map(b => hb.get(b)!.worldPosition)
  const zs = along.map(p => p.z).sort((a, b) => a - b)
  const cx = along.reduce((t, p) => t + p.x, 0) / Math.max(1, along.length)
  // the horse's surface at rest, hit by rays (its vertices are too sparse on a low-poly back to read heights from)
  const surface = horse.skinned.map(m => new THREE.Mesh(m.geometry.clone().applyMatrix4(m.matrixWorld), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })))
  for (const m of surface) m.geometry.computeBoundingSphere()
  const ray = new THREE.Raycaster()
  const hit = (from: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 | null => {
    ray.set(from, dir)
    return ray.intersectObjects(surface, false)[0]?.point ?? null
  }
  const hh = horse.height
  const above = horse.rest!.bones.get(pelvis ?? spine[0])!.worldPosition.y + hh * 2
  // the back's top along its length, over the middle of the spine: its lowest point the seat
  const z0 = zs[0]; const z1 = zs[zs.length - 1]
  const lo = z0 + (z1 - z0) * 0.25; const hi = z0 + (z1 - z0) * 0.7
  let seat: THREE.Vector3 | null = null
  for (let i = 0; i <= 40; i++) {
    const p = hit(new THREE.Vector3(cx, above, lo + (hi - lo) * i / 40), new THREE.Vector3(0, -1, 0))
    if (p !== null && (seat === null || p.y < seat.y)) seat = p
  }
  seat ??= new THREE.Vector3(cx, hb.get(spine[0])!.worldPosition.y, (lo + hi) / 2)
  const bone = [...spine, ...(pelvis !== undefined ? [pelvis] : [])].sort((a, b) => Math.abs(hb.get(a)!.worldPosition.z - seat.z) - Math.abs(hb.get(b)!.worldPosition.z - seat.z))[0] ?? [...horse.bones.keys()][0]
  // the barrel's half width beside the seat, down to a third of the horse's height below it
  let half = 0
  for (let i = 1; i <= 12; i++) {
    for (const sx of [1, -1]) {
      const p = hit(new THREE.Vector3(cx + sx * hh * 2, seat.y - 0.33 * hh * i / 12, seat.z), new THREE.Vector3(-sx, 0, 0))
      if (p !== null) half = Math.max(half, Math.abs(p.x - cx))
    }
  }
  // the rider: his hips upright as at rest, a tenth of his height over the seat
  const rb = rider.rest!.bones
  const H = rb.get('Hips')!
  const position = seat.clone().add(new THREE.Vector3(0, 0.09 * rider.height * k, 0)).sub(H.worldPosition.clone().multiplyScalar(k))
  const toRider = (p: THREE.Vector3): THREE.Vector3 => p.clone().sub(position).divideScalar(k)
  const pose: Record<string, [number, number, number, number]> = {}
  const q4 = (q: THREE.Quaternion): [number, number, number, number] => q.toArray().map(v => Math.round(v * 1e6) / 1e6) as [number, number, number, number]
  pose.Hips = q4(H.localQuaternion)
  const freeze = LOWER_BODY.filter(b => rb.has(b))
  for (const side of ['Left', 'Right'] as const) {
    const U = rb.get(`${side}UpLeg`); const K = rb.get(`${side}Leg`); const F = rb.get(`${side}Foot`)
    if (U === undefined || K === undefined || F === undefined) continue
    const a = U.worldPosition.distanceTo(K.worldPosition); const b = K.worldPosition.distanceTo(F.worldPosition)
    const sx = Math.sign(U.worldPosition.x - H.worldPosition.x) || (side === 'Left' ? 1 : -1)
    const wide = toRider(new THREE.Vector3(cx + sx * half, 0, 0)).x
    // the knee out past the barrel and forward, the foot below it a little back, each at its bone's length
    const knee = new THREE.Vector3(wide + sx * 0.03 * rider.height, 0, U.worldPosition.z + 0.35 * a)
    const dk = Math.hypot(knee.x - U.worldPosition.x, knee.z - U.worldPosition.z)
    if (dk > 0.97 * a) { knee.x = U.worldPosition.x + (knee.x - U.worldPosition.x) * 0.97 * a / dk; knee.z = U.worldPosition.z + (knee.z - U.worldPosition.z) * 0.97 * a / dk }
    knee.y = U.worldPosition.y - Math.sqrt(Math.max(0, a * a - (knee.x - U.worldPosition.x) ** 2 - (knee.z - U.worldPosition.z) ** 2))
    const foot = new THREE.Vector3(knee.x - sx * 0.01 * rider.height, 0, knee.z - 0.25 * b)
    foot.y = knee.y - Math.sqrt(Math.max(0, b * b - (foot.x - knee.x) ** 2 - (foot.z - knee.z) ** 2))
    // each bone swung from its rest direction onto its new one: the thigh, then the shin carried with it and bent
    const thighSwing = new THREE.Quaternion().setFromUnitVectors(K.worldPosition.clone().sub(U.worldPosition).normalize(), knee.clone().sub(U.worldPosition).normalize())
    const thighW = thighSwing.clone().multiply(U.worldQuaternion)
    const shinRest = F.worldPosition.clone().sub(K.worldPosition).normalize().applyQuaternion(thighSwing)
    const shinW = new THREE.Quaternion().setFromUnitVectors(shinRest, foot.clone().sub(knee).normalize()).multiply(thighSwing).multiply(K.worldQuaternion)
    pose[`${side}UpLeg`] = q4(H.worldQuaternion.clone().invert().multiply(thighW))
    pose[`${side}Leg`] = q4(thighW.clone().invert().multiply(shinW))
    // (the foot level and pointing ahead, as at rest)
    pose[`${side}Foot`] = q4(shinW.clone().invert().multiply(F.worldQuaternion))
  }
  return { bone, position: position.toArray().map(x => Math.round(x * 1e4) / 1e4) as [number, number, number], freeze, pose, hips: H.localPosition.toArray().map(v => Math.round(v * 1e5) / 1e5) as [number, number, number] }
}

/** The rider's size against the horse in the horse's rest space: from the two units' game heights over the characters'
 * own heights, else the mount's own scale. */
export function riderScale (mount: Pick<Mount, 'scale'>, rider: { game: number | null, own: number }, horse: { game: number | null, own: number }): number {
  if (rider.game !== null && horse.game !== null && rider.own > 0 && horse.own > 0) return (rider.game / rider.own) / (horse.game / horse.own)
  return mount.scale ?? 1
}

/** The rider's rest space in the horse's: his placement, turned, at his size. */
export function seatMatrix (mount: Pick<Mount, 'position' | 'rotation'>, scale: number): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...mount.rotation.map(d => THREE.MathUtils.degToRad(d)) as [number, number, number]))
  return new THREE.Matrix4().compose(new THREE.Vector3(...mount.position), q, new THREE.Vector3(scale, scale, scale))
}

/** The clip played `times` times over (keys shifted a cycle each time; a key a cycle repeats is kept once). */
export function repeat (clip: THREE.AnimationClip, times: number): THREE.AnimationClip {
  if (times === 1) return clip
  const T = clip.duration
  const tracks = clip.tracks.map(t => {
    const size = t.getValueSize()
    const keys: number[] = []; const values: number[] = []
    for (let r = 0; r < times; r++) {
      for (let i = 0; i < t.times.length; i++) {
        const at = t.times[i] + r * T
        if (keys.length > 0 && at <= keys[keys.length - 1] + 1e-6) continue
        keys.push(at)
        for (let j = 0; j < size; j++) values.push(t.values[i * size + j])
      }
    }
    const Track = t.constructor as new (name: string, times: number[], values: number[]) => THREE.KeyframeTrack
    return new Track(t.name, keys, values)
  })
  return new THREE.AnimationClip(clip.name, T * times, tracks)
}

/** A slot's rider and horse clips, fitted to play together (both at their speeds, scripted and keyed already). */
export function fitRide (rider: THREE.AnimationClip, horse: THREE.AnimationClip, loop: boolean, attack: boolean): { rider: THREE.AnimationClip, horse: THREE.AnimationClip, report: Record<string, unknown> } {
  if (loop) {
    let m = 1; let n = 1; let err = Infinity
    for (let mm = 1; mm <= 6; mm++) {
      for (let nn = 1; nn <= 6; nn++) {
        const e = Math.abs(mm * rider.duration - nn * horse.duration) / (nn * horse.duration)
        if (e < err - 1e-9) { err = e; m = mm; n = nn }
      }
    }
    const r = retime(rider, m * rider.duration / (n * horse.duration))
    r.name = rider.name
    return { rider: repeat(r, m), horse: repeat(horse, n), report: { cycles: [m, n], fit: +err.toFixed(3) } }
  }
  if (attack) {
    const h = retime(horse, horse.duration / rider.duration)
    h.name = horse.name
    return { rider, horse: h, report: { fitted: true } }
  }
  return { rider, horse, report: {} }
}
