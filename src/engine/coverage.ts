import * as THREE from 'three'
import type { BodySurface } from './garments.ts'
import type { CharacterView } from './CharacterView.ts'
import { HIDE_SHARE } from './regions.ts'

export interface CoveragePiece { id: string, hits: ArrayLike<number>, share?: number }
export interface RegionState { region: number, state: 'hidden' | 'partial' | 'bare', pct: number, by: string[] }

/** Percentage is the largest single piece's share, not a union of overlapping pieces. */
export function regionStates (pieces: readonly CoveragePiece[], vertices: ArrayLike<number>): RegionState[] {
  return Array.from({ length: vertices.length }, (_, region) => {
    const size = vertices[region]
    let max = 0; let hidden = false
    const by: string[] = []
    if (size > 0) for (const piece of pieces) {
      const fraction = Math.max(0, Math.min(1, (piece.hits[region] ?? 0) / size))
      if (fraction <= 0) continue
      by.push(piece.id)
      max = Math.max(max, fraction)
      if (fraction >= (piece.share ?? HIDE_SHARE)) hidden = true
    }
    return { region, state: hidden ? 'hidden' : max > 0 ? 'partial' : 'bare', pct: max * 100, by }
  })
}

/** Without a region manifest, label by the rest-pose bone closest to each region's centroid. */
export function regionNames (body: BodySurface, view: CharacterView): string[] {
  const count = body.regions.count
  const sums = Array.from({ length: count }, () => new THREE.Vector3())
  for (let i = 0; i < body.regions.of.length; i++) {
    const r = body.regions.of[i]
    if (r >= 0) sums[r].add(new THREE.Vector3().fromArray(body.positions, i * 3))
  }
  const bones = body.mesh.skeleton.bones.map(b => ({ name: b.name, position: view.rest?.bones.get(b.name)?.worldPosition ?? b.getWorldPosition(new THREE.Vector3()) }))
  return sums.map((sum, r) => {
    sum.divideScalar(Math.max(1, body.regions.vertices[r]))
    let nearest: string | null = null; let distance = Infinity
    for (const bone of bones) {
      const d = sum.distanceToSquared(bone.position)
      if (d < distance) { distance = d; nearest = bone.name }
    }
    return nearest === null ? `Region ${r}` : `${nearest} · ${r}`
  })
}
