// Compare the deformation of two rigs of the same mesh under the same retargeted clip.
// node tools/dev/hand_eval.ts <reference.glb> <ours.glb> <clip.glb> [frames]
// Reports per-region vertex error (% of height) after removing each region's mean offset,
// so it measures orientation/shape differences rather than where the region sits.
import * as THREE from 'three'
import { loadGlbFile as load } from '../../src/engine/headless.ts'
import { canonical, captureRest, retarget } from '../../src/engine/retarget.ts'

const isBone = (o: THREE.Object3D): boolean => (o as THREE.Bone).isBone === true

function meshes (root: THREE.Object3D): THREE.SkinnedMesh[] {
  const out: THREE.SkinnedMesh[] = []
  root.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) out.push(o as THREE.SkinnedMesh) })
  return out
}

/** World positions of every vertex (skinned), concatenated over meshes. */
function positions (root: THREE.Object3D): Float32Array {
  root.updateMatrixWorld(true)
  const list: number[] = []
  const v = new THREE.Vector3()
  for (const m of meshes(root)) {
    m.skeleton.update()
    const n = m.geometry.attributes.position.count
    for (let i = 0; i < n; i++) { m.getVertexPosition(i, v); v.applyMatrix4(m.matrixWorld); list.push(v.x, v.y, v.z) }
  }
  return Float32Array.from(list)
}

/** Dominant bone (canonical name, fingers folded into the hand) per vertex. */
function dominant (root: THREE.Object3D): string[] {
  const out: string[] = []
  for (const m of meshes(root)) {
    const si = m.geometry.attributes.skinIndex
    const sw = m.geometry.attributes.skinWeight
    for (let i = 0; i < si.count; i++) {
      let best = 0
      let bi = 0
      for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > best) { best = w; bi = si.getComponent(i, k) } }
      let name = canonical(m.skeleton.bones[bi].name)
      if (/Hand(Thumb|Index|Middle|Ring|Pinky)/.test(name)) name = name.startsWith('Left') ? 'LeftFingers' : 'RightFingers'
      out.push(name)
    }
  }
  return out
}

const [refPath, oursPath, clipPath, framesArg] = process.argv.slice(2)
const frames = Number(framesArg ?? 12)
const ref = await load(refPath)
const ours = await load(oursPath)
const clip = await load(clipPath)
const clipRest = captureRest(clip.scene, isBone)

const refRest = positions(ref.scene)
const oursRest = positions(ours.scene)
// Vertex correspondence by rest position (exporters may order vertices differently).
const key = (p: Float32Array, i: number): string => `${Math.round(p[i * 3] * 2000)},${Math.round(p[i * 3 + 1] * 2000)},${Math.round(p[i * 3 + 2] * 2000)}`
const lookup = new Map<string, number>()
for (let i = 0; i < oursRest.length / 3; i++) lookup.set(key(oursRest, i), i)
const pairs: Array<[number, number]> = []
for (let i = 0; i < refRest.length / 3; i++) { const j = lookup.get(key(refRest, i)); if (j !== undefined) pairs.push([i, j]) }
let minY = Infinity; let maxY = -Infinity
for (let i = 1; i < refRest.length; i += 3) { minY = Math.min(minY, refRest[i]); maxY = Math.max(maxY, refRest[i]) }
const H = maxY - minY
const region = dominant(ref.scene)
console.log(`matched ${pairs.length}/${refRest.length / 3} vertices, height ${H.toFixed(3)}`)

const animate = (root: THREE.Group): ((t: number) => Float32Array) => {
  const rest = captureRest(root, isBone)
  const baked = retarget(clip.scene, clipRest, clip.animations[0], rest, { fps: 30 })
  const mixer = new THREE.AnimationMixer(root)
  mixer.clipAction(baked).play()
  return t => { mixer.setTime(t); return positions(root) }
}
const playRef = animate(ref.scene)
const playOurs = animate(ours.scene)
const duration = clip.animations[0].duration
const sums = new Map<string, { err: number, n: number, worst: number }>()
for (let f = 0; f < frames; f++) {
  const t = duration * f / Math.max(frames - 1, 1)
  const a = playRef(t)
  const b = playOurs(t)
  // Per-region mean offset, removed so the error measures shape and orientation.
  const offsets = new Map<string, THREE.Vector3>()
  const counts = new Map<string, number>()
  for (const [i, j] of pairs) {
    const r = region[i]
    const o = offsets.get(r) ?? new THREE.Vector3()
    o.x += b[j * 3] - a[i * 3]; o.y += b[j * 3 + 1] - a[i * 3 + 1]; o.z += b[j * 3 + 2] - a[i * 3 + 2]
    offsets.set(r, o); counts.set(r, (counts.get(r) ?? 0) + 1)
  }
  for (const [r, o] of offsets) o.divideScalar(counts.get(r)!)
  const frameErr = new Map<string, { err: number, n: number }>()
  for (const [i, j] of pairs) {
    const r = region[i]
    const o = offsets.get(r)!
    const d = Math.hypot(b[j * 3] - a[i * 3] - o.x, b[j * 3 + 1] - a[i * 3 + 1] - o.y, b[j * 3 + 2] - a[i * 3 + 2] - o.z) / H
    const e = frameErr.get(r) ?? { err: 0, n: 0 }
    e.err += d; e.n += 1; frameErr.set(r, e)
  }
  for (const [r, e] of frameErr) {
    const s = sums.get(r) ?? { err: 0, n: 0, worst: 0 }
    s.err += e.err; s.n += e.n; s.worst = Math.max(s.worst, e.err / e.n); sums.set(r, s)
  }
}
const rows = [...sums].sort((x, y) => y[1].err / y[1].n - x[1].err / x[1].n)
for (const [r, s] of rows) console.log(`${r.padEnd(16)} mean ${(s.err / s.n * 100).toFixed(2)}%H   worst frame ${(s.worst * 100).toFixed(2)}%H   (${s.n / frames} verts)`)
