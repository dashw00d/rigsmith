// Compare generated weights with the previous weights on the NEW skeleton.
// Transfer only between matching bind geometry; never undo edited joint placements.
// node tools/skin_opt/validate.ts <candidate.glb> <previous.glb> <human|horse|...> [--exclude id,id]
// --exclude: clips not to score on (the ones the pose optimizer just trained on); the library spread takes other clips
//   in their place, so the set keeps its size (tools/lib/deformation.ts).
// Prints one JSON line: whether they could be compared (else `reason`), whether the reference was kept whole
// (`retained`) or on some surface islands (`hybrid`, `switched` of `islands`), and `why`: what the candidate did
// against the reference on the tests, in words for the rig report. The kept weights are written into the candidate.
// --layers: the Layers step's check. Besides stretch it counts layer crossings (layers.ts: a coat's points behind the
// thigh they covered at rest), and the skin that keeps the coat over the legs wins over one with less stretch. Only
// there: weighed in every comparison, it picked regional heat and the whole-body optimizer for fewer crossings, and
// they tore the healer's chest and satchel strap (2026-11-01).
import { parseArgs } from 'node:util'
import * as THREE from 'three'
import { load, entrySource, isBone } from '../lib/node3d.ts'
import { deformationTests } from '../lib/deformation.ts'
import { captureRest, retarget } from '../../src/engine/retarget.ts'
import { writeWeights, type WeightEdit } from '../../server/weights.ts'
import { explainRetain, selectIslands, surfaceIslands } from './selection.ts'
import { crossed, findLayerPairs } from './layers.ts'
import { skinMeshes, transferSkin } from '../lib/skintransfer.ts'

const { positionals, values } = parseArgs({ allowPositionals: true, options: { exclude: { type: 'string' }, layers: { type: 'boolean' } } })
const [candidate, previous, template = 'human'] = positionals
const sets = deformationTests(true, (values.exclude ?? '').split(',').filter(id => id !== ''))
const tests = sets[template] ?? []
const root = (await load(candidate)).scene
const oldRoot = (await load(previous)).scene
root.updateMatrixWorld(true); oldRoot.updateMatrixWorld(true)
const now = skinMeshes(root)
let edits: WeightEdit[] = []
const point = new THREE.Vector3()
let transferReason = 'Geometry or bone set changed'
let projected = 0
function transferable (): boolean {
  try {
    const transfer = transferSkin(root, oldRoot)
    edits = transfer.edits; projected = transfer.projected
    return true
  } catch (error) {
    transferReason = (error as Error).message
    return false
  }
}
if (tests.length === 0) {
  console.log(JSON.stringify({ compared: false, retained: false, reason: `No deformation checks for ${template}` }))
} else if (!transferable()) {
  console.log(JSON.stringify({ compared: false, retained: false, reason: transferReason }))
} else {
  const rest = captureRest(root, isBone)
  const clips: THREE.AnimationClip[] = []
  for (const test of tests) {
    const src = await entrySource({clipId:test.id,url:test.url})
    clips.push(retarget(src.scene, captureRest(src.scene,isBone),src.clip,rest,{fps:30,inPlace:true}))
  }
  const positions: number[] = []; const triangles: number[] = []
  const offsets: number[] = []
  const data = now.map(m => {
    const p = m.geometry.attributes.position
    const offset = positions.length / 3; offsets.push(offset)
    for (let v = 0; v < p.count; v++) positions.push(...point.fromBufferAttribute(p, v).applyMatrix4(m.matrixWorld).toArray())
    const index = m.geometry.index
    const indices = index === null ? Array.from({ length: p.count }, (_, i) => i) : Array.from(index.array)
    for (const i of indices) triangles.push(i + offset)
    const edges = new Map<string, [number, number]>()
    for (let i = 0; i < indices.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const a = Math.min(indices[i+k], indices[i+(k+1)%3]) + offset
        const b = Math.max(indices[i+k], indices[i+(k+1)%3]) + offset
        edges.set(`${a},${b}`, [a, b])
      }
    }
    const distance = (p: ArrayLike<number>, a: number, b: number): number => Math.hypot(p[a*3]-p[b*3], p[a*3+1]-p[b*3+1], p[a*3+2]-p[b*3+2])
    return { m, offset, distance, edges: [...edges.values()].map(([a,b]) => ({ a, b, length: distance(positions,a,b) })).filter(e => e.length > 1e-6) }
  })
  const islands = surfaceIslands(positions, triangles)
  // The layers at rest, from the candidate's main bones (the same pairs score both skins).
  const boneNames: string[] = []
  const boneIndex = new Map<string, number>()
  for (const m of now) for (const b of m.skeleton.bones) if (!boneIndex.has(b.name)) { boneIndex.set(b.name, boneNames.length); boneNames.push(b.name) }
  const boneParents = boneNames.map(name => {
    const bone = now.flatMap(m => m.skeleton.bones).find(b => b.name === name)
    const parent = bone?.parent as THREE.Bone | null | undefined
    return parent?.isBone === true ? boneIndex.get(parent.name) ?? -1 : -1
  })
  const mainBone = new Int32Array(positions.length / 3)
  now.forEach((m, mi) => {
    const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight
    for (let v = 0; v < m.geometry.attributes.position.count; v++) {
      let best = 0
      for (let k = 1; k < 4; k++) if (sw.getComponent(v, k) > sw.getComponent(v, best)) best = k
      mainBone[offsets[mi] + v] = boneIndex.get(m.skeleton.bones[si.getComponent(v, best)]?.name ?? '') ?? 0
    }
  })
  const layerPairs = values.layers === true ? findLayerPairs(positions, triangles, mainBone, boneNames, boneParents) : { point: new Int32Array(0), tri: new Int32Array(0), bary: new Float64Array(0), gap: new Float64Array(0) }
  let low = Infinity, high = -Infinity
  for (let i = 1; i < positions.length; i += 3) { low = Math.min(low, positions[i]); high = Math.max(high, positions[i]) }
  const height = Math.max(high - low, 1e-9)
  const counts = new Float64Array(islands.count)
  for (const d of data) for (const e of d.edges) counts[islands.labels[e.a]] += 8
  const edgeCount = counts.reduce((s,x) => s+x, 0)
  if (edgeCount === 0) throw new Error('No surface edges to validate')
  function score (): { strain: number[][], severe: number[][], layers: number[][] } {
    const severe: number[][] = []
    const layers: number[][] = []
    const strain = clips.map(clip => {
      const mixer = new THREE.AnimationMixer(root); mixer.clipAction(clip).play()
      const squared = new Array<number>(islands.count).fill(0)
      const extreme = new Array<number>(islands.count).fill(0); severe.push(extreme)
      const through = new Array<number>(islands.count).fill(0); layers.push(through)
      const posed = new Float64Array(positions.length)
      try {
        for (let f = 0; f < 8; f++) {
          mixer.setTime(clip.duration*(f+.5)/8); root.updateMatrixWorld(true)
          for (const d of data) {
            d.m.skeleton.update()
            for (let v = 0; v < d.m.geometry.attributes.position.count; v++) d.m.getVertexPosition(v, point).applyMatrix4(d.m.matrixWorld).toArray(posed, (v+d.offset)*3)
            for (const e of d.edges) {
              const log = Math.log(Math.max(d.distance(posed,e.a,e.b)/e.length,1e-9))
              squared[islands.labels[e.a]] += log*log
              if (Math.abs(log) > Math.LN2) extreme[islands.labels[e.a]]++
            }
          }
          for (let k = 0; k < layerPairs.point.length; k++) if (crossed(posed, layerPairs, k, height)) through[islands.labels[layerPairs.point[k]]]++
        }
      } finally { mixer.stopAllAction(); mixer.uncacheRoot(root) }
      return squared
    })
    return { strain, severe, layers }
  }
  const generatedScores = score()
  const generatedParts = generatedScores.strain
  const boneIndices = now.map(m => new Map(m.skeleton.bones.map((b,i) => [b.name,i])))
  for (const e of edits) {
    const m = now[e.mesh]; const si = m.geometry.attributes.skinIndex; const sw = m.geometry.attributes.skinWeight
    for (let k = 0; k < 4; k++) {
      si.setComponent(e.vertex, k, e.weights[k] ? boneIndices[e.mesh].get(e.weights[k][0])! : 0)
      sw.setComponent(e.vertex, k, e.weights[k]?.[1] ?? 0)
    }
  }
  const previousScores = score()
  const previousParts = previousScores.strain
  const total = (rows: number[][]): number[] => rows.map(r => Math.sqrt(r.reduce((s,x) => s+x,0)/edgeCount))
  const generated = total(generatedParts); const prior = total(previousParts)
  const average = (a: number[]): number => a.reduce((s,x) => s+x,0)/a.length
  // Retain the whole-model guard, then improve independent islands only when
  // every test agrees. Cross-mesh material seams share an island too.
  const extremeCounts = (rows: number[][]): number[] => rows.map(r => r.reduce((s,x) => s+x, 0))
  const verdict = explainRetain(generated, prior, extremeCounts(generatedScores.severe), extremeCounts(previousScores.severe), tests.map(t => t.name),
    values.layers === true ? { generated: extremeCounts(generatedScores.layers), reference: extremeCounts(previousScores.layers) } : undefined)
  const preferPrior = verdict.retain
  const selection = values.layers === true
    ? selectIslands([...generatedParts, ...generatedScores.severe, ...generatedScores.layers], [...previousParts, ...previousScores.severe, ...previousScores.layers], preferPrior)
    : selectIslands([...generatedParts, ...generatedScores.severe], [...previousParts, ...previousScores.severe], preferPrior)
  // (islands that took the other skin than the whole-model winner)
  const switched = selection.filter(s => s !== preferPrior).length
  const chosen = edits.filter(e => selection[islands.labels[offsets[e.mesh]+e.vertex]])
  if (chosen.length > 0) await writeWeights(candidate, chosen)
  const selected = total(generatedParts.map((r,i) => r.map((x,c) => selection[c] ? previousParts[i][c] : x)))
  const retained = chosen.length === edits.length
  const hybrid = chosen.length > 0 && !retained
  console.log(JSON.stringify({ compared: true, projected, retained, hybrid, why: verdict.why, switched, islands: islands.count, retainedVertices: chosen.length, generated: average(generated), previous: average(prior), selected: average(selected), layerPairs: layerPairs.point.length, layersCrossed: { generated: extremeCounts(generatedScores.layers).reduce((s, x) => s + x, 0), previous: extremeCounts(previousScores.layers).reduce((s, x) => s + x, 0) }, clips: tests.map((t,i) => ({ name:t.name, generated:generated[i], previous:prior[i], selected:selected[i] })) }))
}
