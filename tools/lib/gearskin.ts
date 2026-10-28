// Gear skinned for the game exactly as the viewer skins it (src/engine/garments.ts): gear worn on the skin takes the
// body's weights under each vertex (its policy, smoothing), then its painted ones; gear pinned to a spot takes its
// spot's weights, every vertex alike; one with its own animation (a mechanism) rides its spot's leading bone, as the
// viewer carries it (the game gets it still: its animation isn't exported). Bones go by name onto the export's joint
// list, whatever order the body's own skeleton has. Bone gear with pull handles (src/engine/pulls.ts) is split and
// weighted to its root and its pulls as the viewer rigs it: pullSkin.
import * as THREE from 'three'
import type { CharacterView } from '../../src/engine/CharacterView.ts'
import { applyEdits, bodySurface, computeWeights, partSpot, partWeights, spotWeights, type GarmentEdit } from '../../src/engine/garments.ts'
import { defaultPullWeights, PROP_ROOT, splitStrand } from '../../src/engine/pulls.ts'
import type { Gear, Handle } from '../../src/model/types.ts'

export interface GearSkin {
  /** Per geometry: four joints (indices into `joints`) and weights per vertex. */
  skins: Array<{ indices: Uint16Array, weights: Float32Array }>
  /** The bone leading it (most weight over its vertices). */
  lead: string
  /** Spot gear's weights, by bone name. */
  spot?: Array<[string, number]>
  /** Painted vertices laid over (skin gear). */
  painted: number
  /** Spot gear's own animation, carried still on its lead bone. */
  mechanism?: string
}

/** A pull handle with its point. */
export type PullHandle = Handle & { kind: 'pull', pull: NonNullable<Handle['pull']> }

/** A piece's pull handles, in its handle order: the order pullSkin's joints follow. */
export function pullHandles (g: Pick<Gear, 'handles'>): PullHandle[] {
  return g.handles.filter((h): h is PullHandle => h.kind === 'pull' && h.pull !== undefined)
}

/** What a pull's painted weights are keyed by in garments/<id>/weights.json (the piece itself: PROP_ROOT). */
export const pullWeightName = (h: Pick<Handle, 'id'>): string => `pull:${h.id}`

/**
 * Skin or spot gear. `view`: the body at rest as the viewer holds it; `geometries`: the piece's meshes in character
 * rest space (its placement applied), in its model's mesh order; `edits`: its painted weights (counted only while
 * `painted` says so); `animations`: its model's clip names; `joints`: the export's bone names, which the weights index.
 */
export function gearSkin (view: CharacterView, g: Gear, geometries: THREE.BufferGeometry[], edits: GarmentEdit[], animations: string[], joints: string[]): GearSkin {
  const a = g.attach
  if (a.kind === 'bone') throw new Error(`${g.name}: rides ${a.bone}, not skinned`)
  const body = bodySurface(view)
  if (body === null) throw new Error(`${g.name}: the body has no skinned mesh`)
  const names = body.mesh.skeleton.bones.map(b => b.name)
  const toJoint = names.map(n => joints.indexOf(n))
  let spot = a.kind === 'spot' ? spotWeights(body, partSpot({ anchor: a.anchor }, geometries.map(x => new THREE.Mesh(x)))) : null
  const mechanism = a.kind === 'spot' && a.animation !== undefined && animations.includes(a.animation) ? a.animation : undefined
  if (spot !== null && mechanism !== undefined) spot = [[spot[0][0], 1]]
  const laid = a.kind === 'skin' && (g.painted ?? 0) > 0 ? edits : []
  let painted = 0
  const total = new Float64Array(names.length)
  const skins = geometries.map((geometry, i) => {
    const { indices, weights } = a.kind === 'skin' ? computeWeights(body, geometry, a.policy, view) : partWeights(geometry.attributes.position.count, spot!)
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
 * Bone gear with pull handles, skinned as the viewer rigs it (garments.ts rigPulls): each of `geometries` (its model's
 * meshes in their model space, before its placement, in the model's mesh order) split at every pull's rest point in
 * handle order, weighted to its root and its pulls (unpainted: right by each pull's rest point; then what was painted,
 * while the piece counts it, keyed PROP_ROOT and pull:<handle id>). `joints`: the export's joint for its root, then
 * for each pull handle, which the weights index.
 */
export function pullSkin (g: Gear, geometries: THREE.BufferGeometry[], edits: GarmentEdit[], joints: number[]): { geometries: THREE.BufferGeometry[], skins: Array<{ indices: Uint16Array, weights: Float32Array }>, painted: number } {
  const handles = pullHandles(g)
  if (joints.length !== handles.length + 1) throw new Error(`${g.name}: ${handles.length} pulls, ${joints.length} joints for them and the root`)
  const names = [PROP_ROOT, ...handles.map(pullWeightName)]
  // (the pulls as the shared splitting and weighting read them: by their rest points, in handle order)
  const pulls = handles.map(h => ({ id: h.id, name: h.name, ...h.pull }))
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
