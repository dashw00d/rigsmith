// Where a clip's floor is: from its flat feet. The soles at rest (the bottom of each foot or hoof) are grouped into feet,
// each split into its heel half and its toe half (along the foot); through the clip a foot is flat when both halves
// touch down at one height (no heel up, no toe dug in, however the ankle is turned): planted. The clip's lift puts the lowest flat contact of its feet on the floor (each sole as it is at rest, where the
// feet stand on it). A clip that never plants a flat foot (a death, a sit) falls back to its lowest point.
import * as THREE from 'three'

export interface GroundFit {
  /** Raise the whole body by this much (the character's units) through the clip. */
  lift: number
  /** How it was found: flat feet, or the clip's lowest point. */
  method: 'flat feet' | 'lowest point'
  /** Frames a foot was found flat in. */
  flatFrames: number
}

/** The soles at rest: the skin within `band` of the lowest point, grouped into feet by where they stand. */
function soles (body: THREE.SkinnedMesh, height: number, band = 0.04): Array<{ index: number[], rest: number[], heel: boolean[], low: number }> {
  const pos = body.geometry.attributes.position
  const v = new THREE.Vector3()
  const pts: Array<{ i: number, p: THREE.Vector3 }> = []
  body.updateMatrixWorld(true)
  let low = Infinity
  const all: THREE.Vector3[] = []
  for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(body.matrixWorld); all.push(v.clone()); if (v.y < low) low = v.y }
  for (let i = 0; i < all.length; i++) if (all[i].y < low + band * height) pts.push({ i, p: all[i] })
  // (a few hundred points are plenty)
  const step = Math.max(1, Math.floor(pts.length / 600))
  const keep = pts.filter((_, k) => k % step === 0)
  // feet: points joined when within a twentieth of the height across the ground
  const parent = keep.map((_, k) => k)
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a] } return a }
  const near = 0.05 * height
  for (let a = 0; a < keep.length; a++) {
    for (let b = a + 1; b < keep.length; b++) {
      if (Math.hypot(keep[a].p.x - keep[b].p.x, keep[a].p.z - keep[b].p.z) < near) parent[find(a)] = find(b)
    }
  }
  const groups = new Map<number, Array<{ i: number, p: THREE.Vector3 }>>()
  keep.forEach((x, k) => { const r = find(k); (groups.get(r) ?? groups.set(r, []).get(r)!).push(x) })
  return [...groups.values()].filter(g => g.length >= 6).map(g => {
    // along the foot: its longest way across the ground (the halves either side of its middle)
    const cx = g.reduce((a, x) => a + x.p.x, 0) / g.length; const cz = g.reduce((a, x) => a + x.p.z, 0) / g.length
    let sxx = 0; let szz = 0; let sxz = 0
    for (const x of g) { const dx = x.p.x - cx; const dz = x.p.z - cz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz }
    const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz)
    const ax = Math.cos(angle); const az = Math.sin(angle)
    return { index: g.map(x => x.i), rest: g.map(x => x.p.y), heel: g.map(x => (x.p.x - cx) * ax + (x.p.z - cz) * az < 0), low: Math.min(...g.map(x => x.p.y)) }
  })
}

/** The lift that sets `clip`'s feet on the floor, played on `root` (a posable copy holding `body`; left as it was). */
export function groundFit (root: THREE.Object3D, body: THREE.SkinnedMesh, clip: THREE.AnimationClip, height: number, rate = 30): GroundFit {
  const saved: Array<[THREE.Object3D, THREE.Vector3, THREE.Quaternion, THREE.Vector3]> = []
  root.traverse(o => { if ((o as THREE.Bone).isBone === true) saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]) })
  const restore = (): void => { for (const [o, p, q, s] of saved) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s) } root.updateMatrixWorld(true) }
  // (the soles as the skin lies at rest)
  const skeleton = body.skeleton
  skeleton.pose()
  root.updateMatrixWorld(true)
  const feet = soles(body, height)
  const restLow = Math.min(...feet.flatMap(f => f.rest), Infinity)
  const mixer = new THREE.AnimationMixer(root)
  const action = mixer.clipAction(clip)
  action.setLoop(THREE.LoopOnce, 1)
  action.clampWhenFinished = true
  action.play()
  const v = new THREE.Vector3()
  const flat: number[] = []
  let lowest = Infinity
  let flatFrames = 0
  const pos = body.geometry.attributes.position
  for (let t = 0; t <= clip.duration + 1e-6; t += 1 / rate) {
    mixer.setTime(t)
    root.updateMatrixWorld(true)
    for (const f of feet) {
      let heel = Infinity; let toe = Infinity
      f.index.forEach((i, k) => {
        v.fromBufferAttribute(pos, i); body.applyBoneTransform(i, v); v.applyMatrix4(body.matrixWorld)
        if (v.y < lowest) lowest = v.y
        if (f.heel[k]) heel = Math.min(heel, v.y); else toe = Math.min(toe, v.y)
      })
      // flat: heel and toe down at one height (a raised heel or a dug-in toe parts them)
      if (Number.isFinite(heel) && Number.isFinite(toe) && Math.abs(heel - toe) < 0.012 * height) { flat.push(0.5 * (heel + toe) - f.low); flatFrames++ }
    }
  }
  action.stop()
  mixer.uncacheRoot(root)
  restore()
  if (flat.length >= 3) {
    // (the lowest flat contacts: planted; a flat foot lifted in the air sits above them)
    flat.sort((a, b) => a - b)
    const planted = flat[Math.floor(flat.length * 0.1)]
    return { lift: -planted, method: 'flat feet', flatFrames }
  }
  return { lift: Number.isFinite(lowest) ? restLow - lowest : 0, method: 'lowest point', flatFrames }
}
