import { SkinnedMesh, type Mesh, type Raycaster } from 'three'

/** A piece's actual worn meshes and whether they are visible in the current dress. */
export interface PickableGear { id: string, shown: boolean, meshes: readonly Mesh[] }

/** Pick the nearest visible piece, regardless of the order in which pieces were worn. */
export function pickGear (ray: Raycaster, pieces: readonly PickableGear[], body: readonly Mesh[] = []): string | null {
  let nearest = Infinity
  let id: string | null = null
  for (const piece of pieces) {
    if (!piece.shown) continue
    for (const mesh of piece.meshes) {
      if (mesh instanceof SkinnedMesh) mesh.computeBoundingSphere()
      const hit = ray.intersectObject(mesh, false)[0]
      if (hit !== undefined && hit.distance < nearest) { nearest = hit.distance; id = piece.id }
    }
  }
  for (const mesh of body) {
    let visible = true
    for (let node: typeof mesh | null = mesh; node !== null; node = node.parent as typeof mesh | null) {
      if (!node.visible) { visible = false; break }
    }
    if (!visible) continue
    if (mesh instanceof SkinnedMesh) mesh.computeBoundingSphere()
    const hit = ray.intersectObject(mesh, false)[0]
    if (hit !== undefined && hit.distance <= nearest) return null
  }
  return id
}
