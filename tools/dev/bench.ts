// Rig benchmark: two rigs of the same meshes (e.g. Mixamo's and ours) driven by the same clips
// through the same retargeter, scored on deformation quality rather than on agreement with either.
//
// node tools/dev/bench.ts <rigsA dir> <rigsB dir> [--clips id,id] [--frames 12] [--only name,name] [--json out.json]
//
// Metrics (lower is better):
//   stretch   mean |log(edge length / rest length)| over all edges and frames, and its p99
//   rigid     RMS residual after a best rigid fit of "mid-bone" vertex groups (parts that should not
//             bend: the middle of each long bone, the head, the feet), % of height
//   volume    mean |V / V_rest - 1| of the enclosed mesh volume
//   bleed     % of skin weight on bones 3+ steps away (in the skeleton) from the vertex's body part
//   center    joint distance from the limb cross-section's center, as a fraction of the limb radius
// Groups and body parts come from rig A (Mixamo), which can only favor A.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { canonical, captureRest, retarget } from '../../src/engine/retarget.ts'

const g = globalThis as Record<string, unknown>
g.self ??= globalThis
g.createImageBitmap ??= async () => { throw new Error('no images') }
console.error = () => {}

const CLIPS = ['mixamo-Walking_19', 'mixamo-Dying', 'mixamo-Standing_Draw_Arrow', 'mixamo-Carrying', 'mixamo-Digging', 'mixamo-Combo_Punch', 'mixamo-Flying_Kick',
  'mixamo-Air_Squat', 'mixamo-Push_Up', 'mixamo-Backflip_2', 'mixamo-Climbing_6', 'mixamo-Pick_Up_Item_2', 'mixamo-Spell_Cast', 'mixamo-Crouched_Sneaking_Left',
  'mixamo-Arm_Stretching', 'mixamo-Great_Sword_Jump_Attack', 'mixamo-Dive_Roll', 'mixamo-Breakdance_1990']
const LIBRARY = path.resolve(import.meta.dirname, '../../workspace/library/clips')

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const [dirA, dirB] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
const clipIds = flag('--clips')?.split(',') ?? CLIPS
const framesPerClip = Number(flag('--frames') ?? 12)
const only = flag('--only')?.split(',')

async function load (file: string): Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }> {
  const data = readFileSync(file)
  return await new Promise((resolve, reject) => { new GLTFLoader().parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '', r => { resolve(r as never) }, reject) })
}
const isBone = (o: THREE.Object3D): boolean => (o as THREE.Bone).isBone === true

interface MeshData { positions: Float32Array, index: Uint32Array, skin: Array<Array<[string, number]>>, meshes: THREE.SkinnedMesh[] }

/** Rest positions, triangles, and per-vertex (canonical bone, weight) lists over all skinned meshes. */
function meshData (root: THREE.Object3D): MeshData {
  root.updateMatrixWorld(true)
  const meshes: THREE.SkinnedMesh[] = []
  root.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh) })
  const pos: number[] = []
  const idx: number[] = []
  const skin: Array<Array<[string, number]>> = []
  const v = new THREE.Vector3()
  for (const m of meshes) {
    const base = pos.length / 3
    const p = m.geometry.attributes.position
    const si = m.geometry.attributes.skinIndex
    const sw = m.geometry.attributes.skinWeight
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld)
      pos.push(v.x, v.y, v.z)
      const list: Array<[string, number]> = []
      for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > 0) list.push([canonical(m.skeleton.bones[si.getComponent(i, k)].name), w]) }
      skin.push(list)
    }
    const index = m.geometry.index
    if (index !== null) for (let i = 0; i < index.count; i++) idx.push(base + index.getX(i))
    else for (let i = 0; i < p.count; i++) idx.push(base + i)
  }
  return { positions: Float32Array.from(pos), index: Uint32Array.from(idx), skin, meshes }
}

function posed (meshes: THREE.SkinnedMesh[], out: Float32Array): void {
  const v = new THREE.Vector3()
  let o = 0
  for (const m of meshes) {
    m.skeleton.update()
    const n = m.geometry.attributes.position.count
    for (let i = 0; i < n; i++) { m.getVertexPosition(i, v); v.applyMatrix4(m.matrixWorld); out[o++] = v.x; out[o++] = v.y; out[o++] = v.z }
  }
}

/** Enclosed volume measured about the mesh's own centroid, so rigid motion never changes it (Tripo
 * meshes have holes, and an open mesh's divergence volume about a fixed origin changes when it moves). */
function volume (p: Float32Array, index: Uint32Array): number {
  let cx = 0; let cy = 0; let cz = 0
  const n = p.length / 3
  for (let i = 0; i < p.length; i += 3) { cx += p[i] / n; cy += p[i + 1] / n; cz += p[i + 2] / n }
  let vol = 0
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3; const b = index[t + 1] * 3; const c = index[t + 2] * 3
    const ax = p[a] - cx; const ay = p[a + 1] - cy; const az = p[a + 2] - cz
    const bx = p[b] - cx; const by = p[b + 1] - cy; const bz = p[b + 2] - cz
    const qx = p[c] - cx; const qy = p[c + 1] - cy; const qz = p[c + 2] - cz
    vol += ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx)
  }
  return vol / 6
}

function edges (index: Uint32Array, positions: Float32Array): Uint32Array {
  // Unique by position so UV-seam duplicates don't double count.
  const key = (i: number): string => `${Math.round(positions[i * 3] * 1e5)},${Math.round(positions[i * 3 + 1] * 1e5)},${Math.round(positions[i * 3 + 2] * 1e5)}`
  const seen = new Set<string>()
  const out: number[] = []
  for (let t = 0; t < index.length; t += 3) {
    for (const [a, b] of [[index[t], index[t + 1]], [index[t + 1], index[t + 2]], [index[t + 2], index[t]]]) {
      const ka = key(a); const kb = key(b)
      const k = ka < kb ? ka + '|' + kb : kb + '|' + ka
      if (ka === kb || seen.has(k)) continue
      seen.add(k)
      out.push(a, b)
    }
  }
  return Uint32Array.from(out)
}

/** RMS residual of the best rigid transform taking rest points to posed points (Kabsch via Horn's quaternion). */
function rigidResidual (rest: Float32Array, now: Float32Array, ids: number[]): number {
  const n = ids.length
  const ca = [0, 0, 0]; const cb = [0, 0, 0]
  for (const i of ids) for (let k = 0; k < 3; k++) { ca[k] += rest[i * 3 + k] / n; cb[k] += now[i * 3 + k] / n }
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (const i of ids) {
    const a = [rest[i * 3] - ca[0], rest[i * 3 + 1] - ca[1], rest[i * 3 + 2] - ca[2]]
    const b = [now[i * 3] - cb[0], now[i * 3 + 1] - cb[1], now[i * 3 + 2] - cb[2]]
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += a[r] * b[c]
  }
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ]
  // Largest eigenvector by power iteration on N + cI.
  let q = [1, 0, 0, 0]
  const shift = Math.abs(xx) + Math.abs(yy) + Math.abs(zz) + Math.abs(xy) + Math.abs(xz) + Math.abs(yx) + Math.abs(yz) + Math.abs(zx) + Math.abs(zy) + 1e-12
  for (let it = 0; it < 200; it++) {
    const nq = [0, 0, 0, 0]
    for (let r = 0; r < 4; r++) { nq[r] = shift * q[r]; for (let c = 0; c < 4; c++) nq[r] += N[r][c] * q[c] }
    const len = Math.hypot(...nq)
    q = nq.map(x => x / len)
  }
  const rot = new THREE.Quaternion(q[1], q[2], q[3], q[0])
  let err = 0
  const v = new THREE.Vector3()
  for (const i of ids) {
    v.set(rest[i * 3] - ca[0], rest[i * 3 + 1] - ca[1], rest[i * 3 + 2] - ca[2]).applyQuaternion(rot)
    err += (now[i * 3] - cb[0] - v.x) ** 2 + (now[i * 3 + 1] - cb[1] - v.y) ** 2 + (now[i * 3 + 2] - cb[2] - v.z) ** 2
  }
  return Math.sqrt(err / n)
}

const PARENT: Record<string, string> = {}
{
  const chain = (names: string[], parent: string): void => { let p = parent; for (const n of names) { PARENT[n] = p; p = n } }
  chain(['Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'HeadTop_End'], 'Hips')
  for (const s of ['Left', 'Right']) {
    chain([`${s}Shoulder`, `${s}Arm`, `${s}ForeArm`, `${s}Hand`], 'Spine2')
    for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) chain([1, 2, 3, 4].map(i => `${s}Hand${f}${i}`), `${s}Hand`)
    chain([`${s}UpLeg`, `${s}Leg`, `${s}Foot`, `${s}ToeBase`, `${s}Toe_End`], 'Hips')
  }
}
function ancestors (b: string): string[] { const out = [b]; while (PARENT[out[out.length - 1]] !== undefined) out.push(PARENT[out[out.length - 1]]); return out }
function hops (a: string, b: string): number {
  const fold = (x: string): string => x.replace(/Hand(Thumb|Index|Middle|Ring|Pinky)\d/, 'Hand')
  const pa = ancestors(fold(a)); const pb = ancestors(fold(b))
  for (let i = 0; i < pa.length; i++) { const j = pb.indexOf(pa[i]); if (j >= 0) return i + j }
  return 99
}

const CHILD: Record<string, string> = { Head: 'HeadTop_End', LeftArm: 'LeftForeArm', LeftForeArm: 'LeftHand', LeftUpLeg: 'LeftLeg', LeftLeg: 'LeftFoot', RightArm: 'RightForeArm', RightForeArm: 'RightHand', RightUpLeg: 'RightLeg', RightLeg: 'RightFoot', LeftFoot: 'LeftToeBase', RightFoot: 'RightToeBase', Spine1: 'Spine2' }
const CENTER_JOINTS: Array<[string, string, string]> = [] // joint, parent joint, child joint
for (const s of ['Left', 'Right']) CENTER_JOINTS.push([`${s}Arm`, `${s}Shoulder`, `${s}ForeArm`], [`${s}ForeArm`, `${s}Arm`, `${s}Hand`], [`${s}Hand`, `${s}ForeArm`, `${s}HandIndex1`], [`${s}UpLeg`, 'Hips', `${s}Leg`], [`${s}Leg`, `${s}UpLeg`, `${s}Foot`], [`${s}Foot`, `${s}Leg`, `${s}ToeBase`])

function jointWorld (root: THREE.Object3D): Map<string, THREE.Vector3> {
  root.updateMatrixWorld(true)
  const out = new Map<string, THREE.Vector3>()
  root.traverse(o => { if (isBone(o) && !out.has(canonical(o.name))) out.set(canonical(o.name), o.getWorldPosition(new THREE.Vector3())) })
  return out
}

/** Joint offset from the center of the limb cross-section through it, relative to the section's radius. */
function centering (joints: Map<string, THREE.Vector3>, positions: Float32Array, H: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [name, parentName, childName] of CENTER_JOINTS) {
    const j = joints.get(name); const p = joints.get(parentName); const c = joints.get(childName)
    if (j === undefined || p === undefined || c === undefined) continue
    const axis = c.clone().sub(j).normalize().add(j.clone().sub(p).normalize()).normalize()
    const pts: THREE.Vector3[] = []
    const v = new THREE.Vector3()
    for (let i = 0; i < positions.length; i += 3) {
      v.set(positions[i], positions[i + 1], positions[i + 2]).sub(j)
      const along = v.dot(axis)
      if (Math.abs(along) > 0.006 * H) continue
      const radial = v.addScaledVector(axis, -along)
      if (radial.length() < 0.12 * H) pts.push(radial.clone())
    }
    if (pts.length < 6) continue
    // Section around the joint: keep the connected-ish cluster nearest the joint (drop other limbs).
    pts.sort((a, b) => a.length() - b.length())
    const near = pts.slice(0, Math.max(6, Math.ceil(pts.length * 0.7)))
    const center = near.reduce((s, q) => s.add(q), new THREE.Vector3()).divideScalar(near.length)
    const radius = near.reduce((s, q) => s + q.distanceTo(center), 0) / near.length
    out[name] = center.length() / Math.max(radius, 1e-6)
  }
  return out
}

interface Score { stretch: number, stretch99: number, rigid: number, rigidG: number, volume: number, bleed: number, bleedG: number, center: number, frames: number, detail?: Record<string, Record<string, number>> }

/** Replace a rig's skin with optimizer output (<dir>/<name>.opt.bin + <dir>/<name>.json bone names). */
function overrideSkin (root: THREE.Object3D, prefix: string): void {
  const meta = JSON.parse(readFileSync(prefix + '.json', 'utf8')) as { boneNames: string[] }
  const raw = readFileSync(prefix + '.opt.bin')
  const rows = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  let v = 0
  root.traverse(o => {
    const m = o as THREE.SkinnedMesh
    if (m.isSkinnedMesh !== true) return
    const local = new Map(m.skeleton.bones.map((b, i) => [canonical(b.name), i]))
    const si = m.geometry.attributes.skinIndex; const sw = m.geometry.attributes.skinWeight
    for (let i = 0; i < si.count; i++, v++) {
      for (let k = 0; k < 4; k++) {
        si.setComponent(i, k, local.get(meta.boneNames[rows.getUint32(v * 32 + k * 4, true)]) ?? 0)
        sw.setComponent(i, k, rows.getFloat32(v * 32 + 16 + k * 4, true))
      }
    }
    si.needsUpdate = true; sw.needsUpdate = true
  })
}

async function score (file: string, groupsFrom: { positions: Float32Array, skin: Array<Array<[string, number]>>, joints: Map<string, THREE.Vector3> } | null, clips: Array<{ scene: THREE.Group, animations: THREE.AnimationClip[] }>, skinFrom?: string): Promise<{ score: Score, data: MeshData, joints: Map<string, THREE.Vector3> }> {
  const gltf = await load(file)
  if (skinFrom !== undefined) overrideSkin(gltf.scene, skinFrom)
  const data = meshData(gltf.scene)
  const joints = jointWorld(gltf.scene)
  const P = data.positions
  let minY = Infinity; let maxY = -Infinity
  for (let i = 1; i < P.length; i += 3) { minY = Math.min(minY, P[i]); maxY = Math.max(maxY, P[i]) }
  const H = maxY - minY
  const E = edges(data.index, P)
  const rest = Float32Array.from(P)
  const restLen = new Float32Array(E.length / 2)
  for (let e = 0; e < E.length; e += 2) restLen[e / 2] = Math.hypot(P[E[e] * 3] - P[E[e + 1] * 3], P[E[e] * 3 + 1] - P[E[e + 1] * 3 + 1], P[E[e] * 3 + 2] - P[E[e + 1] * 3 + 2])
  const V0 = volume(P, data.index)

  // Body part per vertex and rigid groups, taken from the reference rig (matched by rest position).
  const ref = groupsFrom ?? { positions: P, skin: data.skin, joints }
  const key = (p: Float32Array, i: number): string => `${Math.round(p[i * 3] * 2000)},${Math.round(p[i * 3 + 1] * 2000)},${Math.round(p[i * 3 + 2] * 2000)}`
  const refIndex = new Map<string, number>()
  for (let i = 0; i < ref.positions.length / 3; i++) refIndex.set(key(ref.positions, i), i)
  const part: Array<string | null> = []
  const groups = new Map<string, number[]>()
  for (let i = 0; i < P.length / 3; i++) {
    const r = refIndex.get(key(P, i))
    if (r === undefined) { part.push(null); continue }
    const [bone, w] = ref.skin[r].reduce((best, x) => (x[1] > best[1] ? x : best), ['', 0])
    part.push(bone)
    const child = CHILD[bone]
    const a = ref.joints.get(bone); const b = child === undefined ? undefined : ref.joints.get(child)
    if (w < 0.9 || a === undefined || b === undefined) continue
    const ab = b.clone().sub(a)
    const t = new THREE.Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).sub(a).dot(ab) / ab.lengthSq()
    const mid = bone === 'Head' ? t > 0.15 : t > 0.3 && t < 0.7
    if (!mid) continue
    if (!groups.has(bone)) groups.set(bone, [])
    groups.get(bone)!.push(i)
  }
  // Geometric rigid groups (no weights involved): the middle of each long bone, the top of the head,
  // the feet, using joints averaged over both rigs.
  const avg = (n: string): THREE.Vector3 | undefined => { const a = ref.joints.get(n); const b = joints.get(n); return a === undefined || b === undefined ? undefined : a.clone().add(b).multiplyScalar(0.5) }
  const SEGMENTS: Array<[string, string]> = []
  for (const sd of ['Left', 'Right']) SEGMENTS.push([`${sd}Arm`, `${sd}ForeArm`], [`${sd}ForeArm`, `${sd}Hand`], [`${sd}UpLeg`, `${sd}Leg`], [`${sd}Leg`, `${sd}Foot`])
  const segs = SEGMENTS.map(([a, b]) => ({ name: a, a: avg(a), b: avg(b) })).filter(x => x.a !== undefined && x.b !== undefined) as Array<{ name: string, a: THREE.Vector3, b: THREE.Vector3 }>
  const spine = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head'].map(avg)
  const geoGroups = new Map<string, number[]>()
  const pt = new THREE.Vector3()
  const segDist = (a: THREE.Vector3, b: THREE.Vector3): { t: number, d: number } => {
    const ab = b.clone().sub(a); const t = pt.clone().sub(a).dot(ab) / ab.lengthSq()
    return { t, d: pt.clone().sub(a.clone().addScaledVector(ab, Math.min(1, Math.max(0, t)))).length() }
  }
  const head = avg('Head'); const top = avg('HeadTop_End')
  const geoLabel: Array<string | null> = []
  const SPINE_NAMES = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head']
  for (let i = 0; i < P.length / 3; i++) {
    pt.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2])
    let best = { name: '', t: 0, d: Infinity }
    for (const sg of segs) { const r = segDist(sg.a, sg.b); if (r.d < best.d) best = { name: sg.name, t: r.t, d: r.d } }
    let spineD = Infinity; let spineName = ''
    for (let k = 0; k + 1 < spine.length; k++) {
      if (spine[k] === undefined || spine[k + 1] === undefined) continue
      const d = segDist(spine[k]!, spine[k + 1]!).d
      if (d < spineD) { spineD = d; spineName = SPINE_NAMES[k] }
    }
    if (head !== undefined && pt.y > head.y) spineName = 'Head'
    geoLabel.push(best.d < spineD ? best.name : spineName)
    if (best.d < spineD && best.d < 0.08 * H && best.t > 0.35 && best.t < 0.65) {
      if (!geoGroups.has(best.name)) geoGroups.set(best.name, [])
      geoGroups.get(best.name)!.push(i)
    } else if (head !== undefined && top !== undefined && pt.y > head.y + 0.35 * (top.y - head.y) && Math.hypot(pt.x - head.x, pt.z - head.z) < 0.1 * H) {
      if (!geoGroups.has('Head')) geoGroups.set('Head', [])
      geoGroups.get('Head')!.push(i)
    }
  }
  let bleedGMass = 0; let massG = 0
  const bleedGTo: Record<string, number> = {}
  // Only unambiguous body parts: geometry agrees with the reference label, and so does the
  // reference's own mirror image (Mixamo's weights are lopsided in places).
  const mirrorName = (n: string): string => n.startsWith('Left') ? 'Right' + n.slice(4) : n.startsWith('Right') ? 'Left' + n.slice(5) : n
  let cxm = 0
  for (let i = 0; i < P.length; i += 3) cxm += P[i] / (P.length / 3)
  const mkey = (x: number, y: number, z: number): string => `${Math.round(x / (0.004 * H))},${Math.round(y / (0.004 * H))},${Math.round(z / (0.004 * H))}`
  const byPos = new Map<string, number>()
  for (let i = 0; i < P.length / 3; i++) byPos.set(mkey(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]), i)
  const symmetric = (i: number): boolean => {
    const j = byPos.get(mkey(2 * cxm - P[i * 3], P[i * 3 + 1], P[i * 3 + 2]))
    return j !== undefined && part[j] !== null && part[i] !== null && mirrorName(part[i]!) === part[j]
  }
  for (let i = 0; i < data.skin.length; i++) {
    const p = part[i]
    if (p === null || geoLabel[i] !== p || !symmetric(i)) continue
    for (const [b, w] of data.skin[i]) { massG += w; if (hops(p, b) >= 3) { bleedGMass += w; bleedGTo[`${p}<-${b}`] = (bleedGTo[`${p}<-${b}`] ?? 0) + w } }
  }
  let bleedMass = 0; let mass = 0
  const bleedBy: Record<string, number> = {}
  const bleedTo: Record<string, number> = {}
  for (let i = 0; i < data.skin.length; i++) {
    const p = part[i]
    if (p === null) continue
    for (const [b, w] of data.skin[i]) {
      mass += w
      if (hops(p, b) >= 3) { bleedMass += w; bleedBy[p] = (bleedBy[p] ?? 0) + w; bleedTo[`${p}<-${b}`] = (bleedTo[`${p}<-${b}`] ?? 0) + w }
    }
  }
  const rigidBy: Record<string, number> = {}

  const target = captureRest(gltf.scene, isBone)
  const now = new Float32Array(P.length)
  let stretch = 0; let stretchN = 0; const big: number[] = []
  let rigid = 0; let rigidN = 0; let rigidG = 0; let rigidGN = 0; let vol = 0; let frames = 0
  for (const clip of clips) {
    const source = captureRest(clip.scene, isBone)
    let baked = retarget(clip.scene, source, clip.animations[0], target, { fps: 30, inPlace: true })
    const only = flag('--bones')
    if (only !== undefined) {
      const re = new RegExp(only)
      baked = new THREE.AnimationClip(baked.name, baked.duration, baked.tracks.filter(t => t.name.endsWith('.quaternion') && re.test(canonical(t.name.split('.')[0]))))
    }
    const mixer = new THREE.AnimationMixer(gltf.scene)
    mixer.clipAction(baked).play()
    for (let f = 1; f <= framesPerClip; f++) {
      mixer.setTime(baked.duration * f / (framesPerClip + 1))
      gltf.scene.updateMatrixWorld(true)
      posed(data.meshes, now)
      frames++
      let sum = 0
      const ratios: number[] = []
      for (let e = 0; e < E.length; e += 2) {
        const l = Math.hypot(now[E[e] * 3] - now[E[e + 1] * 3], now[E[e] * 3 + 1] - now[E[e + 1] * 3 + 1], now[E[e] * 3 + 2] - now[E[e + 1] * 3 + 2])
        const r = Math.abs(Math.log(Math.max(l, 1e-9) / Math.max(restLen[e / 2], 1e-9)))
        sum += r; ratios.push(r)
      }
      stretch += sum; stretchN += ratios.length
      ratios.sort((a, b) => a - b)
      big.push(ratios[Math.floor(ratios.length * 0.99)])
      for (const [bone, ids] of groups) { if (ids.length >= 8) { const r = rigidResidual(rest, now, ids) / H; rigid += r; rigidN++; rigidBy[bone] = (rigidBy[bone] ?? 0) + r * 100 / (clips.length * framesPerClip) } }
      for (const ids of geoGroups.values()) { if (ids.length >= 8) { rigidG += rigidResidual(rest, now, ids) / H; rigidGN++ } }
      vol += Math.abs(volume(now, data.index) / V0 - 1)
    }
    mixer.stopAllAction()
  }
  big.sort((a, b) => a - b)
  const c = Object.values(centering(joints, P, H))
  return {
    score: {
      stretch: stretch / stretchN,
      stretch99: big[Math.floor(big.length / 2)],
      rigid: rigid / Math.max(rigidN, 1) * 100,
      rigidG: rigidG / Math.max(rigidGN, 1) * 100,
      volume: vol / frames * 100,
      bleed: bleedMass / Math.max(mass, 1e-9) * 100,
      bleedG: bleedGMass / Math.max(massG, 1e-9) * 100,
      center: c.reduce((s, x) => s + x, 0) / Math.max(c.length, 1),
      frames,
      detail: { rigidBy, bleedBy, bleedTo, bleedGTo },
    },
    data,
    joints,
  }
}

const clips = await Promise.all(clipIds.map(async id => await load(path.join(LIBRARY, `${id}.glb`))))
const names = readdirSync(dirA).filter(f => f.endsWith('.glb')).map(f => f.slice(0, -4)).filter(n => only === undefined || only.includes(n))
const rows: Array<{ name: string, a: Score, b: Score }> = []
const KEYS: Array<[keyof Score, string, number]> = [['stretch', 'stretch', 1000], ['stretch99', 'str p99', 100], ['rigid', 'rigid%H', 1], ['rigidG', 'rigidGeo', 1], ['volume', 'vol%', 1], ['bleed', 'bleed%', 1], ['bleedG', 'bleedGeo', 1], ['center', 'center', 1]]
console.log(`${'character'.padEnd(15)}` + KEYS.map(([, label]) => `${label.padStart(9)} A/B      `).join(''))
for (const name of names) {
  const a = await score(path.join(dirA, `${name}.glb`), null, clips)
  const ref = { positions: a.data.positions, skin: a.data.skin, joints: a.joints }
  const weightsDir = flag('--weights')
  const b = await score(path.join(dirB, `${name}.glb`), ref, clips, weightsDir === undefined ? undefined : path.join(weightsDir, name))
  rows.push({ name, a: a.score, b: b.score })
  console.log(name.padEnd(15) + KEYS.map(([k, , s]) => `${(a.score[k] * s).toFixed(2).padStart(7)} /${(b.score[k] * s).toFixed(2).padStart(6)} ${b.score[k] < a.score[k] ? '✓' : '✗'}  `).join(''))
}
const mean = (k: keyof Score, side: 'a' | 'b'): number => rows.reduce((s, r) => s + r[side][k], 0) / rows.length
console.log('mean'.padEnd(15) + KEYS.map(([k, , s]) => `${(mean(k, 'a') * s).toFixed(2).padStart(7)} /${(mean(k, 'b') * s).toFixed(2).padStart(6)} ${mean(k, 'b') < mean(k, 'a') ? '✓' : '✗'}  `).join(''))
console.log('wins B'.padEnd(15) + KEYS.map(([k]) => `${String(rows.filter(r => r.b[k] < r.a[k]).length).padStart(7)}/${rows.length}         `).join(''))
if (args.includes('--detail')) {
  for (const r of rows) {
    console.log(`\n${r.name} rigid by group (%H, A / B):`, Object.keys(r.b.detail!.rigidBy).map(k => `${k} ${(r.a.detail!.rigidBy[k] ?? 0).toFixed(2)}/${r.b.detail!.rigidBy[k].toFixed(2)}`).join('  '))
    const top = Object.entries(r.b.detail!.bleedGTo).sort((x, y) => y[1] - x[1]).slice(0, 10)
    console.log(`${r.name} B bleed (weight mass, part<-bone):`, top.map(([k, v]) => `${k} ${v.toFixed(1)}`).join('  '))
  }
}
const out = flag('--json')
if (out !== undefined) writeFileSync(out, JSON.stringify(rows, null, 1))
