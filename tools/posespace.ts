// The pose space: how a body's joints move together, measured on the library's Mixamo captures (what a person does).
// Every second frame of every named clip is a pose (src/engine/posespace.ts: each of 22 body bones' local turn from the
// Y Bot's rest as a rotation vector, the hips' with their heading taken out: 66 numbers); the poses and their mirror
// images are put through PCA (a covariance matrix and a symmetric eigen decomposition, below). Every 10th clip is held
// out of the fit to measure how well the components rebuild poses they have not seen.
//
//   node tools/posespace.ts [--limit N] [--variance 0.985] [--cache] [--no-mirror] [--dry]
//
// Writes static/templates/rom/human-pose.json (the mean, every component and its variance, how many carry the pose, the
// held-out error). --cache keeps the scanned frames in workspace/cache/posespace-frames.f32 (and reads them back: a
// re-fit without the scan). --no-mirror fits the poses alone; --dry writes nothing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { canonical } from '../src/engine/retarget.ts'
import { BODY, DIM, MIRROR, NB, PoseModel, decodeSource, encodeSource, mirrorPose, type PoseModelData } from '../src/engine/posespace.ts'
import { isBone, load, ROOT, WORKSPACE } from './lib/node3d.ts'

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined }
const limit = Number(arg('--limit') ?? Infinity)
const wanted = Number(arg('--variance') ?? 0.985)
const useCache = process.argv.includes('--cache')
const mirrorToo = !process.argv.includes('--no-mirror')
const dry = process.argv.includes('--dry')
const EVERY = 2
const HOLD_OUT = 10

/** Symmetric eigen decomposition by cyclic Jacobi rotations: eigenvalues (descending) and the eigenvectors as rows. */
export function symmetricEigen (matrix: Float64Array, n: number): { values: Float64Array, vectors: Float64Array } {
  const a = Float64Array.from(matrix)
  const v = new Float64Array(n * n)
  for (let i = 0; i < n; i++) v[i * n + i] = 1
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q]
    if (off < 1e-26) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q]
        if (Math.abs(apq) < 1e-300) continue
        const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq)
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1); const s = t * c
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p]; const akq = a[k * n + q]
          a[k * n + p] = c * akp - s * akq; a[k * n + q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k]; const aqk = a[q * n + k]
          a[p * n + k] = c * apk - s * aqk; a[q * n + k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p]; const vkq = v[k * n + q]
          v[k * n + p] = c * vkp - s * vkq; v[k * n + q] = s * vkp + c * vkq
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[j * n + j] - a[i * n + i])
  const values = new Float64Array(n); const vectors = new Float64Array(n * n)
  order.forEach((src, dst) => {
    values[dst] = a[src * n + src]
    // (a sign for each component: its largest entry positive, so a re-fit doesn't flip them)
    let big = 0
    for (let k = 0; k < n; k++) if (Math.abs(v[k * n + src]) > Math.abs(big)) big = v[k * n + src]
    const sign = big < 0 ? -1 : 1
    for (let k = 0; k < n; k++) vectors[dst * n + k] = sign * v[k * n + src]
  })
  return { values, vectors }
}

interface Scan { frames: Float32Array, count: number, clipOf: Uint32Array, clips: number, heldOut: boolean[] }

async function scan (): Promise<Scan> {
  const manifest = JSON.parse(readFileSync(path.join(WORKSPACE, 'library', 'manifest.json'), 'utf8')) as { clips: Array<{ id: string, file: string, source: string, duplicateOf?: string | null }> }
  const pool = manifest.clips.filter(c => c.source === 'mixamo-catalog' && (c.duplicateOf ?? null) === null).slice(0, limit)
  const ybot = (await load(path.join(WORKSPACE, 'library', 'mannequin', 'ybot.glb'))).scene
  ybot.updateMatrixWorld(true)
  const model0 = restOf(ybot)
  let frames = new Float32Array(70000 * DIM); let count = 0
  let clipOf = new Uint32Array(70000)
  const held: boolean[] = []
  const turns: THREE.Quaternion[] = Array.from({ length: NB }, () => new THREE.Quaternion())
  const p = new Float64Array(DIM)
  for (const [k, c] of pool.entries()) {
    const g = await load(path.join(WORKSPACE, 'library', c.file))
    const clip = g.animations[0]
    if (clip === undefined) continue
    held.push(k % HOLD_OUT === HOLD_OUT - 1)
    g.scene.updateMatrixWorld(true)
    const byName = new Map<string, THREE.Object3D>()
    g.scene.traverse(o => { if (isBone(o)) byName.set(canonical(o.name), o) })
    const bones = BODY.map(n => byName.get(n))
    if (bones.some(b => b === undefined)) { held.pop(); continue }
    const parentQ = bones[0]!.parent!.getWorldQuaternion(new THREE.Quaternion())
    const mixer = new THREE.AnimationMixer(g.scene)
    mixer.clipAction(clip).play()
    const n = Math.max(1, Math.round(clip.duration * 30))
    for (let f = 0; f <= n; f += EVERY) {
      mixer.setTime(f / 30)
      for (let i = 0; i < NB; i++) turns[i].copy(bones[i]!.quaternion)
      turns[0].premultiply(parentQ)
      encodeSource(model0, turns, p)
      if (count === frames.length / DIM) {
        const bigger = new Float32Array(frames.length * 2); bigger.set(frames); frames = bigger
        const ids = new Uint32Array(clipOf.length * 2); ids.set(clipOf); clipOf = ids
      }
      frames.set(p, count * DIM)
      clipOf[count] = held.length - 1
      count++
    }
    mixer.stopAllAction()
    mixer.uncacheRoot(g.scene)
    if (k % 400 === 399) process.stderr.write(`${k + 1} / ${pool.length} clips scanned\n`)
  }
  return { frames: frames.subarray(0, count * DIM), count, clipOf: clipOf.subarray(0, count), clips: held.length, heldOut: held }
}

/** A model with only the Y Bot's rest (to encode with). */
function restOf (ybot: THREE.Object3D): PoseModel {
  const byName = new Map<string, THREE.Object3D>()
  ybot.traverse(o => { if (isBone(o)) byName.set(canonical(o.name), o) })
  const rest = BODY.map((n, i) => {
    const b = byName.get(n)!
    return (i === 0 ? b.getWorldQuaternion(new THREE.Quaternion()) : b.quaternion).toArray()
  })
  const comps = Array.from({ length: DIM }, (_, j) => Array.from({ length: DIM }, (__, d) => (d === j ? 1 : 0)))
  return new PoseModel({ version: 1, bones: [...BODY], rest, mean: new Array<number>(DIM).fill(0), components: comps, variances: new Array<number>(DIM).fill(1), k: DIM, explained: 1, clips: 0, frames: 0 })
}

const round = (x: number, d: number): number => Math.round(x * 10 ** d) / 10 ** d

async function main (): Promise<void> {
  const cacheFile = path.join(WORKSPACE, 'cache', 'posespace-frames.f32')
  const metaFile = `${cacheFile}.json`
  let s: Scan
  if (useCache && existsSync(cacheFile) && existsSync(metaFile)) {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as { count: number, clips: number, heldOut: boolean[], clipOf: number[] }
    const buf = readFileSync(cacheFile)
    s = { frames: new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), count: meta.count, clipOf: Uint32Array.from(meta.clipOf), clips: meta.clips, heldOut: meta.heldOut }
    console.log(`read ${s.count} frames of ${s.clips} clips from the cache`)
  } else {
    const t = performance.now()
    s = await scan()
    console.log(`scanned ${s.clips} clips, ${s.count} frames in ${((performance.now() - t) / 1000).toFixed(1)} s`)
    if (useCache) {
      mkdirSync(path.dirname(cacheFile), { recursive: true })
      writeFileSync(cacheFile, Buffer.from(s.frames.buffer, s.frames.byteOffset, s.frames.byteLength))
      writeFileSync(metaFile, JSON.stringify({ count: s.count, clips: s.clips, heldOut: s.heldOut, clipOf: [...s.clipOf] }))
    }
  }
  const ybot = (await load(path.join(WORKSPACE, 'library', 'mannequin', 'ybot.glb'))).scene
  ybot.updateMatrixWorld(true)
  const base = restOf(ybot)

  // the fit: every training frame and its mirror image
  const train: number[] = []; const test: number[] = []
  for (let i = 0; i < s.count; i++) (s.heldOut[s.clipOf[i]] ? test : train).push(i)
  const mean = new Float64Array(DIM)
  const m = new Float64Array(DIM)
  const row = (i: number, out: Float64Array): void => { for (let d = 0; d < DIM; d++) out[d] = s.frames[i * DIM + d] }
  const mirrored = new Float64Array(DIM)
  const each = (fn: (v: Float64Array) => void): void => {
    for (const i of train) { row(i, m); fn(m); if (mirrorToo) { mirrorPose(m, mirrored); fn(mirrored) } }
  }
  let n = 0
  each(v => { for (let d = 0; d < DIM; d++) mean[d] += v[d]; n++ })
  for (let d = 0; d < DIM; d++) mean[d] /= n
  const cov = new Float64Array(DIM * DIM)
  const c = new Float64Array(DIM)
  each(v => {
    for (let d = 0; d < DIM; d++) c[d] = v[d] - mean[d]
    for (let a = 0; a < DIM; a++) { const ca = c[a]; for (let b = a; b < DIM; b++) cov[a * DIM + b] += ca * c[b] }
  })
  for (let a = 0; a < DIM; a++) for (let b = a; b < DIM; b++) { cov[a * DIM + b] /= n; cov[b * DIM + a] = cov[a * DIM + b] }
  const { values, vectors } = symmetricEigen(cov, DIM)
  const total = values.reduce((x, y) => x + y, 0)
  let acc = 0
  const cumulative = Array.from(values, v => { acc += v; return acc / total })
  const kFor = (f: number): number => cumulative.findIndex(x => x >= f) + 1
  const k = kFor(wanted)
  console.log(`train ${train.length} frames (x2 mirrored), held out ${test.length}; components for 95/98/98.5/99/99.5 %: ${[0.95, 0.98, 0.985, 0.99, 0.995].map(kFor).join(' / ')}; chosen k = ${k} (${(cumulative[k - 1] * 100).toFixed(2)} %)`)

  const data: PoseModelData = {
    version: 1,
    bones: [...BODY],
    rest: base.data.rest.map(q => q.map(x => round(x, 7))),
    mean: Array.from(mean, x => round(x, 6)),
    components: Array.from({ length: DIM }, (_, j) => Array.from(vectors.subarray(j * DIM, (j + 1) * DIM), x => round(x, 5))),
    variances: Array.from(values, x => Number(Math.max(x, 0).toPrecision(5))),
    k,
    explained: round(cumulative[k - 1], 5),
    clips: s.clips,
    frames: s.count,
  }
  const model = new PoseModel(data)

  // held out: per bone, the angle between the pose and its reconstruction from the first k components
  const errors = (kk: number): { perBone: number[][], all: number[] } => {
    const perBone: number[][] = Array.from({ length: NB }, () => [])
    const all: number[] = []
    const p = new Float64Array(DIM); const r = new Float64Array(DIM)
    const a = new THREE.Quaternion(); const b = new THREE.Quaternion()
    for (const i of test) {
      row(i, p)
      model.reconstruct(p, r, kk)
      for (let bi = 0; bi < NB; bi++) {
        const qa = new THREE.Quaternion(); const qb = new THREE.Quaternion()
        a.copy(rot(p, bi, qa)); b.copy(rot(r, bi, qb))
        const deg = THREE.MathUtils.radToDeg(a.angleTo(b))
        perBone[bi].push(deg); all.push(deg)
      }
    }
    return { perBone, all }
  }
  const rot = (v: Float64Array, bi: number, into: THREE.Quaternion): THREE.Quaternion => {
    const x = v[bi * 3]; const y = v[bi * 3 + 1]; const z = v[bi * 3 + 2]
    const ang = Math.hypot(x, y, z)
    return ang < 1e-9 ? into.identity() : into.setFromAxisAngle(new THREE.Vector3(x / ang, y / ang, z / ang), ang)
  }
  const pct = (xs: number[], f: number): number => { const t = [...xs].sort((u, w) => u - w); return t[Math.min(t.length - 1, Math.floor(f * (t.length - 1)))] }
  for (const kk of [10, 15, 20, 25, 30, k, 40, 50]) {
    const e = errors(kk)
    console.log(`  held-out at ${String(kk).padStart(2)} components: median ${pct(e.all, 0.5).toFixed(2)} deg, 95th ${pct(e.all, 0.95).toFixed(2)} deg (over all bones)`)
  }
  const e = errors(k)
  const perBone: Record<string, { median: number, p95: number }> = {}
  BODY.forEach((name, i) => { perBone[name] = { median: round(pct(e.perBone[i], 0.5), 2), p95: round(pct(e.perBone[i], 0.95), 2) } })
  data.heldOut = { clips: s.heldOut.filter(Boolean).length, frames: test.length, k, perBone, median: round(pct(e.all, 0.5), 2), p95: round(pct(e.all, 0.95), 2) }
  for (const [name, v] of Object.entries(perBone)) console.log(`    ${name.padEnd(14)} median ${v.median.toFixed(2).padStart(5)}  95th ${v.p95.toFixed(2).padStart(6)}`)

  // sanity: decode(encode) of a frame is the frame
  const q: THREE.Quaternion[] = []
  const pv = new Float64Array(DIM)
  row(train[100], pv)
  decodeSource(model, pv, 0.4, q)
  const back = new Float64Array(DIM)
  const yaw = encodeSource(model, q, back)
  let worst = 0
  for (let d = 0; d < DIM; d++) worst = Math.max(worst, Math.abs(back[d] - pv[d]))
  console.log(`encode(decode(p)) differs from p by at most ${worst.toExponential(2)} (heading ${yaw.toFixed(3)} for 0.4)`)
  void MIRROR

  if (dry) return
  const out = path.join(ROOT, 'static', 'templates', 'rom', 'human-pose.json')
  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(data) + '\n')
  console.log(`-> ${path.relative(ROOT, out)} (${(Buffer.byteLength(JSON.stringify(data)) / 1024).toFixed(0)} KB)`)
}

if (process.argv[1] === import.meta.filename) await main()
