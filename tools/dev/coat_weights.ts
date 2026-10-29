// Coat and cloak weights for a character whose clothing is part of its body mesh.
//
// Automatic weights leave two kinds of cloth that the legs walk through:
//  - a coat or tunic skirt modelled as its own layer over inner trousers, weighted to the hips or spine
//    while the trousers under it follow the thighs: a stepping thigh comes out through it;
//  - a cloak hanging behind/beside the body taken by the arms (the arm test claims cloth under the arm),
//    so it swings with them and cuts through the legs.
// Coat skin takes the weights of the layer under it (looking in toward the leg and hip bones: the first
// surface entered within a small gap), as the app skins worn garments from the body under them; a hem with
// nothing close under it takes the thigh on its side, more of it lower down, so the legs push it. Cloak skin
// far from every arm bone, from the chest down, gives its arm weight to the chest it hangs from.
//
// Measures lower-body surface crossings and cloth stretch over the character's own clips (its slots) before and after.
// --apply writes the changed vertices as painted weights through the running server (PUT /weights, a job; kept for
// re-rigs; "Forget the painting" drops them). It refuses while the character's weights are locked (skin.locked: the
// Skin step unlocks them), and so does the server.
//
// node tools/dev/coat_weights.ts <character-id> [--apply] [--gap 0.06] [--full-at 0.6] [--no-hem] [--no-coat] [--no-cloak] [--report out.json]
import { writeFileSync } from 'node:fs'
import * as THREE from 'three'
import { body, character, entrySource, isBone } from '../lib/node3d.ts'
import { SkinnedSurface } from '../lib/surface.ts'
import { captureRest, retarget } from '../../src/engine/retarget.ts'
import { jointsOf } from '../../src/model/select.ts'
import type { Job, Slot } from '../../src/model/types.ts'

const args = process.argv.slice(2)
const id = args[0]
if (id === undefined || id.startsWith('--')) throw new Error('Pass a character ID')
const option = (name: string, fallback: number): number => { const i = args.indexOf(name); return i < 0 ? fallback : Number(args[i + 1]) }
const apply = args.includes('--apply')
const reportPath = args.includes('--report') ? args[args.indexOf('--report') + 1] : undefined
// The widest gap (fraction of height) between a coat and the layer under it; farther cloth keeps its weights.
const GAP = option('--gap', 0.06)
// outer: the coat takes the weights of the layer under it. inner: the hidden layer under the coat takes the
// coat's weights instead (so it stays inside it), the coat moving as it did.
const MODE = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'outer'
// Hems: skin over the thighs takes at least this much thigh by FULL_AT of the way down to the knee, so the
// legs push it (a hem with nothing of the leg's in it can't be healed into moving).
const FULL_AT = option('--full-at', 0.6)
const NO_HEM = args.includes('--no-hem')
const CLOAK_TO = args.includes('--cloak-to') ? args[args.indexOf('--cloak-to') + 1] : 'Spine2'
const NO_CLOAK = args.includes('--no-cloak'), NO_COAT = args.includes('--no-coat')

const record = character(id)
// (said before minutes of measuring: the server would refuse the painting anyway)
if (apply && record.skin.locked) throw new Error(`${record.name}'s weights are locked${record.skin.lockReason !== undefined ? ` (${record.skin.lockReason})` : ''}: unlock them in the Skin step before --apply`)
// (the joints the rig was built on: what its bones are; else the skeleton as it is now)
const J = record.skin.rigJoints ?? jointsOf(record)
if (record.skeleton.template !== 'human' || J.LeftUpLeg === undefined || J.Spine === undefined) throw new Error('Needs a humanoid skeleton')
/** The character's slots with a clip, by name: what it plays. */
const slots: Slot[] = record.clips
const sourceOf = async (s: Slot): Promise<Awaited<ReturnType<typeof entrySource>>> => await entrySource({ clipId: s.clip.id, url: s.clip.url })
const view = await body(id)
const root = view.root
const surface = new SkinnedSurface(root)
if (surface.parts.length !== 1) throw new Error(`Expected one skinned mesh, found ${surface.parts.length}`)
const mesh = surface.parts[0].mesh
const bones = mesh.skeleton.bones.map(b => b.name)
const bone = (name: string): number => bones.indexOf(name)
const sw = mesh.geometry.attributes.skinWeight as THREE.BufferAttribute
const si = mesh.geometry.attributes.skinIndex as THREE.BufferAttribute
const nv = sw.count
const bind = Float64Array.from(surface.positions)
const P = (v: number): THREE.Vector3 => new THREE.Vector3(bind[v * 3], bind[v * 3 + 1], bind[v * 3 + 2])
const V = (name: string): THREE.Vector3 => new THREE.Vector3(...J[name])

// ---- current weights, dense per vertex ------------------------------------------------------------
const original = { w: Float32Array.from(sw.array as Float32Array), i: Uint16Array.from(si.array as ArrayLike<number>) }
const dense = (v: number): Map<number, number> => {
  const m = new Map<number, number>()
  for (let k = 0; k < 4; k++) { const w = original.w[v * 4 + k]; if (w > 0) m.set(original.i[v * 4 + k], (m.get(original.i[v * 4 + k]) ?? 0) + w) }
  return m
}
const isArm = (n: string): boolean => /(Arm|Hand)/.test(n) && !/Shoulder/.test(n)
const isLeg = (n: string): boolean => /(UpLeg|Leg|Foot|Toe)/.test(n)

// ---- distance to the arms (their bones as segments, fingers included) -----------------------------
const segment = (p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number => {
  const ab = b.clone().sub(a); const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-12), 0, 1)
  return p.distanceTo(a.clone().addScaledVector(ab, t))
}
const armSegments: Array<[THREE.Vector3, THREE.Vector3]> = []
for (const s of ['Left', 'Right']) {
  armSegments.push([V(`${s}Arm`), V(`${s}ForeArm`)], [V(`${s}ForeArm`), V(`${s}Hand`)])
  for (const k of Object.keys(J)) if (k.startsWith(`${s}Hand`) && k !== `${s}Hand`) armSegments.push([V(`${s}Hand`), V(k)])
}
const armDist = Array.from({ length: nv }, (_, v) => Math.min(...armSegments.map(([a, b]) => segment(P(v), a, b))))
// How far the arm's own skin reaches: forearm and hand skin (not the upper arm, which the cloak may hold).
const own = [...Array(nv).keys()].filter(v => [...dense(v)].some(([b, w]) => w > 0.5 && /(ForeArm|Hand)/.test(bones[b]))).map(v => armDist[v]).sort((a, b) => a - b)
const reach = own[Math.floor(own.length * 0.95)] ?? 0.05 * view.height
const ARM_NEAR = reach, ARM_FAR = 1.6 * reach

// ---- the layer under each coat vertex ------------------------------------------------------------
const hipY = (J.LeftUpLeg[1] + J.RightUpLeg[1]) / 2
const kneeY = (J.LeftLeg[1] + J.RightLeg[1]) / 2
const thigh = hipY - kneeY
const bands: Array<[string, number]> = [['Hips', J.Spine[1]], ['Spine', J.Spine1?.[1] ?? Infinity], ['Spine1', J.Spine2?.[1] ?? Infinity], ['Spine2', Infinity]]
const torsoAt = (y: number): number => bone(bands.find(([, top]) => y < top)![0])
const thighDist = (p: THREE.Vector3): number => Math.min(segment(p, V('LeftUpLeg'), V('LeftLeg')), segment(p, V('RightUpLeg'), V('RightLeg')))
// The trousers' radius just above the knee, where the legs are their own.
const trouserDists = [...Array(nv).keys()].filter(v => { const y = bind[v * 3 + 1]; return y > kneeY && y < kneeY + 0.25 * thigh && [...dense(v)].reduce((s, [b, x]) => s + (isLeg(bones[b]) ? x : 0), 0) > 0.9 }).map(v => thighDist(P(v))).sort((a, b) => a - b)
const trouser = trouserDists[Math.floor(trouserDists.length / 2)] ?? 0.06 * view.height
// The bones the lower body hangs on: in toward them is "under".
const axes: Array<[THREE.Vector3, THREE.Vector3]> = [[V('Hips'), V('Spine')]]
for (const side of ['Left', 'Right']) axes.push([V('Hips'), V(`${side}UpLeg`)], [V(`${side}UpLeg`), V(`${side}Leg`)], [V(`${side}Leg`), V(`${side}Foot`)])
const closestOnAxes = (p: THREE.Vector3): THREE.Vector3 => {
  let best = new THREE.Vector3(); let bestD = Infinity
  for (const [a, b] of axes) {
    const ab = b.clone().sub(a); const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-12), 0, 1)
    const q = a.clone().addScaledVector(ab, t); const d = q.distanceToSquared(p)
    if (d < bestD) { bestD = d; best = q }
  }
  return best
}
const nt = surface.index.length / 3
const corner = (f: number, k: number): THREE.Vector3 => P(surface.index[f * 3 + k])
const tris = Array.from({ length: nt }, (_, f) => [corner(f, 0), corner(f, 1), corner(f, 2)])
const normals = tris.map(([a, b, c]) => b.clone().sub(a).cross(c.clone().sub(a)).normalize())
const boxes = tris.map(t => new THREE.Box3().setFromPoints(t))
/** The first surface entered going from p along dir within `far` (front faces only: leaving the cloth's own
 * inner side doesn't count), as triangle and barycentric weights. */
function under (v: number, p: THREE.Vector3, dir: THREE.Vector3, far: number): { f: number, t: number, bary: [number, number, number] } | null {
  const ray = new THREE.Ray(p, dir); const seg = new THREE.Box3().setFromPoints([p, p.clone().addScaledVector(dir, far)])
  const hit = new THREE.Vector3(); let best: { f: number, t: number, bary: [number, number, number] } | null = null
  for (let f = 0; f < nt; f++) {
    if (!boxes[f].intersectsBox(seg) || normals[f].dot(dir) >= 0) continue
    if ([0, 1, 2].some(k => surface.index[f * 3 + k] === v)) continue
    const [a, b, c] = tris[f]
    if (ray.intersectTriangle(a, b, c, true, hit) === null) continue
    const t = hit.distanceTo(p)
    if (t < 1e-4 * view.height || t > far || (best !== null && t >= best.t)) continue
    const bary = THREE.Triangle.getBarycoord(hit, a, b, c, new THREE.Vector3())
    best = { f, t, bary: [bary!.x, bary!.y, bary!.z] }
  }
  return best
}

const next = new Map<number, Map<number, number>>()
let cloak = 0, coat = 0, hem = 0
const legX = Math.abs(J.LeftUpLeg[0] - J.Hips[0])
const gaps: number[] = []
for (let v = 0; v < nv; v++) {
  const p = P(v)
  const w = dense(v)
  let changed = false
  const armShare = (m: Map<number, number>): number => [...m].reduce((s, [b, x]) => s + (isArm(bones[b]) ? x : 0), 0)
  // Coat: outer, the weights of the layer under it; inner, a leg layer under a coat takes the coat's.
  const legShare = [...w].reduce((s, [b, x]) => s + (isLeg(bones[b]) ? x : 0), 0)
  if (!NO_COAT && p.y < J.Spine[1] && p.y > kneeY - 0.25 * thigh && armShare(w) < 0.5 && (MODE === 'outer' || legShare > 0.5)) {
    const c = closestOnAxes(p); const toward = c.clone().sub(p); const d = toward.length()
    const dir = toward.divideScalar(Math.max(d, 1e-12)).multiplyScalar(MODE === 'outer' ? 1 : -1)
    const hit = d > 1e-9 ? under(v, p, dir, MODE === 'outer' ? Math.min(d, GAP * view.height) : GAP * view.height) : null
    if (hit !== null) {
      gaps.push(hit.t)
      const take = 1 - THREE.MathUtils.smoothstep(hit.t, 0.6 * GAP * view.height, GAP * view.height)
      const inner = new Map<number, number>()
      for (let k = 0; k < 3; k++) for (const [b, x] of dense(surface.index[hit.f * 3 + k])) inner.set(b, (inner.get(b) ?? 0) + x * hit.bary[k])
      for (const b of new Set([...w.keys(), ...inner.keys()])) w.set(b, (1 - take) * (w.get(b) ?? 0) + take * (inner.get(b) ?? 0))
      changed = true; coat++
    }
  }
  if (!NO_COAT && !NO_HEM && MODE === 'outer' && p.y < hipY + 0.15 * thigh && p.y > kneeY - 0.25 * thigh) {
    const arms = armShare(w), legs = [...w].reduce((s, [b, x]) => s + (isLeg(bones[b]) ? x : 0), 0)
    const near = 1 - THREE.MathUtils.smoothstep(thighDist(p), 1.5 * trouser, 2.2 * trouser)
    const target = THREE.MathUtils.smoothstep(hipY + 0.15 * thigh - p.y, 0, (0.15 + FULL_AT) * thigh) * near * (1 - arms)
    if (target > legs + 1e-3) {
      const others = 1 - arms - legs
      const scale = others > 1e-6 ? (1 - arms - target) / others : 0
      for (const [b, x] of w) if (!isArm(bones[b]) && !isLeg(bones[b])) w.set(b, x * scale)
      const left = THREE.MathUtils.smoothstep(p.x - J.Hips[0], -0.5 * legX, 0.5 * legX)
      w.set(bone('LeftUpLeg'), (w.get(bone('LeftUpLeg')) ?? 0) + (target - legs) * left)
      w.set(bone('RightUpLeg'), (w.get(bone('RightUpLeg')) ?? 0) + (target - legs) * (1 - left))
      changed = true; hem++
    }
  }
  // Cloak: arm weight off skin the arms don't reach, from the chest down (over the shoulders the
  // cloak lies on the arms and has to go with them).
  const off = THREE.MathUtils.smoothstep(armDist[v], ARM_NEAR, ARM_FAR) * (1 - THREE.MathUtils.smoothstep(p.y, J.Spine[1], J.Spine2?.[1] ?? J.Neck[1]))
  if (off > 0 && !NO_CLOAK) {
    let moved = 0
    for (const [b, x] of w) if (isArm(bones[b])) { moved += x * off; w.set(b, x * (1 - off)) }
    // (a cloak hangs from the shoulders: the chest carries it, not the pelvis under it)
    if (moved > 1e-4) { const t = CLOAK_TO === 'band' ? torsoAt(p.y) : bone(CLOAK_TO); w.set(t, (w.get(t) ?? 0) + moved); changed = true; cloak++ }
  }
  if (changed) next.set(v, w)
}
if (process.env.GAPS !== undefined) {
  const h = [0.005, 0.01, 0.02, 0.03, 0.04, 0.06, 0.08, 0.1].map(x => [x, gaps.filter(g => g <= x * view.height).length])
  console.log('gaps to the layer under (fraction of height: vertices within):', h.map(([x, n]) => `${x}:${n}`).join(' '))
}

// Four strongest, normalized, as the GLB stores them.
const top4 = (w: Map<number, number>): Array<[number, number]> => {
  const top = [...w].filter(([, x]) => x > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4)
  const s = top.reduce((t, [, x]) => t + x, 0)
  return top.map(([b, x]) => [b, x / s])
}
const edits = [...next].map(([v, w]) => ({ v, top: top4(w) }))
  .filter(({ v, top }) => { const before = dense(v); const after = new Map(top); return [...new Set([...before.keys(), ...after.keys()])].some(b => Math.abs((before.get(b) ?? 0) - (after.get(b) ?? 0)) > 0.01) })
console.log(`${id}: arm reach ${(reach * 100).toFixed(1)} cm; ${coat} coat vertices over a layer, ${hem} hem vertices given the thigh, ${cloak} cloak vertices off the arms; ${edits.length} changed by more than 1%`)

const useWeights = (which: 'before' | 'after'): void => {
  (sw.array as Float32Array).set(original.w); (si.array as Uint16Array | Uint32Array).set(original.i)
  if (which === 'after') for (const { v, top } of edits) for (let k = 0; k < 4; k++) { si.setComponent(v, k, top[k]?.[0] ?? 0); sw.setComponent(v, k, top[k]?.[1] ?? 0) }
  sw.needsUpdate = true; si.needsUpdate = true
}

// ---- measuring ------------------------------------------------------------------------------------
// Lower-body crossings between faces apart on the body (not a crease folding on itself); hands left out.
const nf = surface.index.length / 3
const centroid = (f: number): THREE.Vector3 => P(surface.index[f * 3]).add(P(surface.index[f * 3 + 1])).add(P(surface.index[f * 3 + 2])).divideScalar(3)
const faceC = Array.from({ length: nf }, (_, f) => centroid(f))
const faceArm = Array.from({ length: nf }, (_, f) => [0, 1, 2].some(k => armDist[surface.index[f * 3 + k]] < ARM_NEAR))
const lowerY = J.Spine[1]
const pairKey = (a: number, b: number): string => a < b ? `${a},${b}` : `${b},${a}`
// (crossings the mesh already has at rest are its own, not the weights')
const atRest = new Set(surface.crossings(view.height * 1e-6).map(c => pairKey(c.a, c.b)))
const counted = (a: number, b: number): boolean => !atRest.has(pairKey(a, b)) && !faceArm[a] && !faceArm[b] && (faceC[a].y < lowerY || faceC[b].y < lowerY) && faceC[a].distanceTo(faceC[b]) > 0.05 * view.height
const edges = new Set<string>()
for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) { const a = surface.index[f * 3 + k], b = surface.index[f * 3 + (k + 1) % 3]; if (next.has(a) || next.has(b)) edges.add(a < b ? `${a},${b}` : `${b},${a}`) }
const edgeList = [...edges].map(e => e.split(',').map(Number) as [number, number])
const rest = edgeList.map(([a, b]) => P(a).distanceTo(P(b)))

// Parts fixed at rest from the original weights, for saying what crosses what.
const legOf = (v: number): number => [...dense(v)].reduce((s, [b, x]) => s + (isLeg(bones[b]) ? x : 0), 0)
const faceLabel = Array.from({ length: nf }, (_, f) => {
  const vs = [0, 1, 2].map(k => surface.index[f * 3 + k]); const c = faceC[f]
  if (vs.every(v => legOf(v) > 0.9)) return 'legs'
  if (c.y < hipY && thighDist(c) < 2.2 * trouser) return 'tunic'
  if (c.y < J.Spine[1]) return 'lowcloak'
  return 'upper'
})
const where: Array<[string, number, number, number, number]> | undefined = process.env.WHERE !== undefined ? [] : undefined
interface Totals { crossingMm: number, framesWithCrossings: number, frames: number, stretchedEdges: number, worstStretch: number, pairs: Record<string, number> }
async function measure (): Promise<Record<string, Totals>> {
  const out: Record<string, Totals> = {}
  for (const a of slots) {
    const source = await sourceOf(a).catch(() => null)
    if (source === null) continue
    const clip = retarget(source.scene, captureRest(source.scene, isBone), source.clip, view.rest!, { fps: 30, inPlace: true })
    const mixer = new THREE.AnimationMixer(root); const act = mixer.clipAction(clip); act.setLoop(THREE.LoopOnce, 1); act.clampWhenFinished = true; act.play()
    const t: Totals = { crossingMm: 0, framesWithCrossings: 0, frames: 0, stretchedEdges: 0, worstStretch: 1, pairs: {} }
    for (let time = 0; time <= clip.duration + 1e-6; time += 1 / 30) {
      mixer.setTime(time); root.updateMatrixWorld(true)
      let len = 0
      for (const c of surface.crossings(view.height * 1e-6)) {
        if (!counted(c.a, c.b)) continue
        len += c.length
        const k = [faceLabel[c.a], faceLabel[c.b]].sort().join('|'); t.pairs[k] = (t.pairs[k] ?? 0) + c.length * 1000
        if (where !== undefined && k === 'legs|tunic') for (const f of [c.a, c.b]) where.push([faceLabel[f], faceC[f].x, faceC[f].y, faceC[f].z, c.length])
      }
      const X = surface.positions
      edgeList.forEach(([a, b], e) => {
        const d = Math.hypot(X[a * 3] - X[b * 3], X[a * 3 + 1] - X[b * 3 + 1], X[a * 3 + 2] - X[b * 3 + 2])
        const r = rest[e] > 1e-9 ? Math.max(d / rest[e], rest[e] / Math.max(d, 1e-12)) : 1
        if (r > 2) t.stretchedEdges++
        t.worstStretch = Math.max(t.worstStretch, r)
      })
      t.frames++; t.crossingMm += len * 1000; if (len > 0) t.framesWithCrossings++
    }
    mixer.stopAllAction(); mixer.uncacheRoot(root)
    out[a.name] = t
  }
  return out
}

// DUMP=file.json DUMP_CLIP=Walk DUMP_FRAMES=8,24: deformed positions with the new weights, for looking at
if (process.env.DUMP !== undefined) {
  useWeights(process.env.DUMP_WEIGHTS === 'before' ? 'before' : 'after')
  const a = slots.find(x => x.name === (process.env.DUMP_CLIP ?? 'Walk'))
  if (a === undefined) throw new Error(`No slot ${process.env.DUMP_CLIP ?? 'Walk'}`)
  const source = await sourceOf(a)
  const clip = retarget(source.scene, captureRest(source.scene, isBone), source.clip, view.rest!, { fps: 30, inPlace: true })
  const mixer = new THREE.AnimationMixer(root); const act = mixer.clipAction(clip); act.setLoop(THREE.LoopOnce, 1); act.clampWhenFinished = true; act.play()
  const frames: Record<string, number[]> = { bind: Array.from(bind) }
  const hits: Record<string, number[]> = {}
  for (const f of (process.env.DUMP_FRAMES ?? '8,24').split(',').map(Number)) {
    mixer.setTime(f / 30); root.updateMatrixWorld(true)
    hits[String(f)] = surface.crossings(view.height * 1e-6).filter(c => counted(c.a, c.b)).flatMap(c => [c.a, c.b])
    frames[String(f)] = Array.from(surface.positions)
  }
  mixer.stopAllAction(); mixer.uncacheRoot(root)
  writeFileSync(process.env.DUMP, JSON.stringify({ index: surface.index, frames, hits, boneNames: bones, weights: Array.from(sw.array as Float32Array), skinIndex: Array.from(si.array as ArrayLike<number>) }))
  useWeights('before')
}

useWeights('before'); const before = await measure()
if (where !== undefined) { writeFileSync(process.env.WHERE!, JSON.stringify(where)); where.length = 0 }
useWeights('after'); const after = await measure()
useWeights('before')
const row = (n: string, b: Totals, a: Totals): string => `${n.padEnd(14)} crossings ${b.crossingMm.toFixed(0).padStart(7)} -> ${a.crossingMm.toFixed(0).padStart(7)} mm (${b.framesWithCrossings}/${b.frames} -> ${a.framesWithCrossings}/${a.frames} frames) | edges past 2x ${b.stretchedEdges} -> ${a.stretchedEdges}, worst ${b.worstStretch.toFixed(2)} -> ${a.worstStretch.toFixed(2)}`
let sb = 0, sa = 0
const pairs = (t: Totals): string => Object.entries(t.pairs).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, x]) => `${k} ${x.toFixed(0)}`).join(', ')
for (const n of Object.keys(before)) {
  console.log(row(n, before[n], after[n])); sb += before[n].crossingMm; sa += after[n].crossingMm
  if (process.env.PAIRS !== undefined) console.log(`    before: ${pairs(before[n])}\n    after:  ${pairs(after[n])}`)
}
console.log(`TOTAL crossings ${sb.toFixed(0)} -> ${sa.toFixed(0)} mm`)
const sum = (r: Record<string, Totals>, f: (t: Totals) => number): number => Object.values(r).reduce((s, t) => s + f(t), 0)
const part = (r: Record<string, Totals>, k: string): number => sum(r, t => Object.entries(t.pairs).filter(([p]) => p.includes(k)).reduce((s, [, x]) => s + x, 0))
const legsTunic = (r: Record<string, Totals>): number => sum(r, t => t.pairs['legs|tunic'] ?? 0)
console.log(`SUMMARY legs|tunic ${legsTunic(before).toFixed(0)} -> ${legsTunic(after).toFixed(0)} | any lowcloak ${part(before, 'lowcloak').toFixed(0)} -> ${part(after, 'lowcloak').toFixed(0)} | edges past 2x ${sum(before, t => t.stretchedEdges)} -> ${sum(after, t => t.stretchedEdges)}`)
if (reportPath !== undefined) writeFileSync(reportPath, JSON.stringify({ id, gap: GAP, reach, changed: edits.length, before, after }, null, 2))

if (apply) {
  const server = `http://localhost:${process.env.RIGSMITH_PORT ?? 5180}`
  const headers = { 'content-type': 'application/json', 'x-rigsmith': '1', 'x-rigsmith-by': 'coat weights tool', 'x-rigsmith-schema': '3' }
  const payload = { edits: edits.map(({ v, top }) => ({ mesh: 0, vertex: v, weights: top.map(([b, x]) => [bones[b], Math.round(x * 1e5) / 1e5]) })) }
  const res = await fetch(`${server}/api/characters/${id}/weights`, { method: 'PUT', headers, body: JSON.stringify(payload) })
  if (!res.ok) throw new Error(`not applied (${res.status}): ${await res.text()}`)
  // (a job: written into the rig once the character's other file jobs are done)
  let job = await res.json() as Job
  while (job.status === 'queued' || job.status === 'running') {
    await new Promise(resolve => setTimeout(resolve, 500))
    job = (await (await fetch(`${server}/api/jobs`, { headers })).json() as Job[]).find(j => j.id === job.id) ?? { ...job, status: 'failed', error: 'the job is gone (the server restarted?)' }
  }
  console.log(job.status === 'done' ? `applied: ${edits.length} vertices painted` : `not applied: ${job.status}${job.error !== undefined ? `: ${job.error}` : ''}`)
  if (job.status !== 'done') process.exitCode = 1
}
