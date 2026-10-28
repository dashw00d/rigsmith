// Clothing and parts skinned for the game exactly as the viewer skins them (src/engine/garments.ts attachGarments):
// clothing takes the body's weights under each vertex (policy, smoothing), then its painted ones; a part takes its
// spot's weights, every vertex alike; a mechanism (a part whose model plays its own animation) rides its spot's
// leading bone, as the viewer carries it (the game gets it still: its animation isn't exported). Bones go by name onto
// the export's joint list, whatever order the body's own skeleton has. A prop with pulls (src/engine/pulls.ts) is split
// and weighted to its root and its pulls as the viewer rigs it (garments.ts rigPulls): pullSkin.
import * as THREE from 'three'
import type { CharacterView } from '../../src/engine/CharacterView.ts'
import { applyEdits, bodySurface, computeWeights, partSpot, partWeights, spotWeights, type GarmentEdit } from '../../src/engine/garments.ts'
import { defaultPullWeights, PROP_ROOT, pullBoneName, splitStrand } from '../../src/engine/pulls.ts'
import type { Garment } from '../../server/workspace.ts'

export interface GearSkin {
  /** Per geometry: four joints (indices into `joints`) and weights per vertex. */
  skins: Array<{ indices: Uint16Array, weights: Float32Array }>
  /** The bone leading it (most weight over its vertices). */
  lead: string
  /** A part's spot weights, by bone name. */
  spot?: Array<[string, number]>
  /** Painted vertices laid over (clothing). */
  painted: number
  /** A part's own animation, carried still on its lead bone. */
  mechanism?: string
}

/**
 * `view`: the body at rest as the viewer holds it; `geometries`: the garment's meshes in character rest space
 * (garmentMatrix applied), in its model's mesh order; `animations`: its model's clip names; `joints`: the export's
 * bone names, which the weights index.
 */
export function gearSkin (view: CharacterView, g: Garment, geometries: THREE.BufferGeometry[], edits: GarmentEdit[], animations: string[], joints: string[]): GearSkin {
  const body = bodySurface(view)
  if (body === null) throw new Error(`${g.name}: the body has no skinned mesh`)
  const names = body.mesh.skeleton.bones.map(b => b.name)
  const toJoint = names.map(n => joints.indexOf(n))
  let spot = g.mode === 'part' ? spotWeights(body, partSpot(g, geometries.map(x => new THREE.Mesh(x)))) : null
  const mechanism = g.mode === 'part' && g.animation !== undefined && animations.includes(g.animation) ? g.animation : undefined
  if (spot !== null && mechanism !== undefined) spot = [[spot[0][0], 1]]
  const laid = g.mode === 'clothing' && (g.painted ?? 0) > 0 ? edits : []
  let painted = 0
  const total = new Float64Array(names.length)
  const skins = geometries.map((geometry, i) => {
    const { indices, weights } = spot !== null ? partWeights(geometry.attributes.position.count, spot) : computeWeights(body, geometry, g.policy, view)
    if (laid.length > 0) painted += applyEdits(indices, weights, laid, i, names)
    for (let k = 0; k < indices.length; k++) {
      total[indices[k]] += weights[k]
      const j = toJoint[indices[k]]
      if (j < 0 && weights[k] > 0) throw new Error(`${g.name}: weighted to ${names[indices[k]]}, not in the export's skeleton`)
      indices[k] = Math.max(j, 0)
    }
    return { indices, weights }
  })
  const lead = names[total.indexOf(Math.max(...total))]
  return { skins, lead, spot: spot?.map(([b, w]) => [names[b], +w.toFixed(4)]), painted, mechanism }
}

/**
 * A rigid prop with pulls, skinned as the viewer rigs it (garments.ts rigPulls): each of `geometries` (its model's
 * meshes in their model space, before its placement, in the model's mesh order) split at every pull's rest point in
 * pull order, weighted to its root (PropRoot) and its pulls (unpainted: right by each pull's rest point; then what was
 * painted, while the garment counts it). `joints`: the export's joint for its root, then for each pull, which the
 * weights index.
 */
export function pullSkin (g: Garment, geometries: THREE.BufferGeometry[], edits: GarmentEdit[], joints: number[]): { geometries: THREE.BufferGeometry[], skins: Array<{ indices: Uint16Array, weights: Float32Array }>, painted: number } {
  const pulls = g.pulls ?? []
  if (joints.length !== pulls.length + 1) throw new Error(`${g.name}: ${pulls.length} pulls, ${joints.length} joints for them and the root`)
  const names = [PROP_ROOT, ...pulls.map(p => pullBoneName(g.name, p))]
  const laid = (g.painted ?? 0) > 0 ? edits : []
  let painted = 0
  const skins: Array<{ indices: Uint16Array, weights: Float32Array }> = []
  const split = geometries.map((geometry, i) => {
    let out = geometry
    for (const p of pulls) out = splitStrand(out, new THREE.Vector3(...p.rest))
    const { indices, weights } = defaultPullWeights(out, pulls)
    if (laid.length > 0) painted += applyEdits(indices, weights, laid, i, names)
    for (let k = 0; k < indices.length; k++) indices[k] = joints[indices[k]]
    skins.push({ indices, weights })
    return out
  })
  return { geometries: split, skins, painted }
}
