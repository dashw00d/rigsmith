// Transfer skin attributes in bind space. Vertex numbering is not stable across
// Blender import/export, UV splits, or triangulation repairs.
import * as THREE from 'three'
import type { WeightEdit } from '../../server/weights.ts'

export interface SkinTransfer {
  edits: WeightEdit[]
  /** Source vertices and barycentric coefficients for every target vertex. */
  samples: Array<Array<Array<[number, number]>>>
  projected: number
}

export const skinMeshes = (root: THREE.Object3D): THREE.SkinnedMesh[] => {
  const out: THREE.SkinnedMesh[] = []
  root.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) out.push(o as THREE.SkinnedMesh) })
  return out
}

/** Same material primitives, new vertex addresses and possibly a new skeleton.
 * Small repairs may place a vertex inside an old triangle; interpolate there
 * rather than accepting distant vertices or silently abandoning validation.
 * A new surface outside the narrow bind-space tolerance is rejected. */
export function transferSkin (target: THREE.Object3D, source: THREE.Object3D, requireBones = true): SkinTransfer {
  target.updateMatrixWorld(true); source.updateMatrixWorld(true)
  const now = skinMeshes(target), old = skinMeshes(source)
  if (now.length === 0 || now.length !== old.length) throw new Error('Skinned primitive count changed')
  const edits: WeightEdit[] = [], samples: SkinTransfer['samples'] = []
  let projected = 0
  for (let part = 0; part < now.length; part++) {
    const m = now[part], was = old[part]
    const p = m.geometry.attributes.position, q = was.geometry.attributes.position
    const allowed = new Set(m.skeleton.bones.map(b => b.name))
    const si = was.geometry.attributes.skinIndex, sw = was.geometry.attributes.skinWeight
    const points = Array.from({ length: q.count }, (_, v) => new THREE.Vector3().fromBufferAttribute(q,v).applyMatrix4(was.matrixWorld))
    const box = new THREE.Box3().setFromPoints(points)
    const tolerance = Math.max(box.getSize(new THREE.Vector3()).length() * .001, 1e-7)
    const cells = new Map<string, number[]>()
    const cell = (v: THREE.Vector3): number[] => [v.x,v.y,v.z].map(x => Math.floor(x/tolerance))
    const weights = points.map((point,v) => {
      const out: Array<[string, number]> = []
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(v,k)
        if (!Number.isFinite(w) || w < 0) throw new Error(`Invalid reference weight at mesh ${part}, vertex ${v}`)
        if (w > 0) {
          const name = was.skeleton.bones[si.getComponent(v,k)]?.name
          if (!name || (requireBones && !allowed.has(name))) throw new Error(`Reference bone ${name ?? 'unknown'} is missing from the new skeleton`)
          out.push([name,w])
        }
      }
      if (Math.abs(out.reduce((s,[,w]) => s+w,0)-1) > 1e-4) throw new Error(`Unnormalized reference weights at mesh ${part}, vertex ${v}`)
      const key = cell(point).join(',')
      if (!cells.has(key)) cells.set(key,[])
      cells.get(key)!.push(v)
      return out
    })
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(m.matrixWorld)
    const triangle = new THREE.Triangle(), closest = new THREE.Vector3(), bary = new THREE.Vector3(), normal = new THREE.Vector3()
    const indices = was.geometry.index
    const index = (i: number): number => indices?.getX(i) ?? i
    const count = indices?.count ?? q.count
    const sameAddresses = p.count === q.count && points.every((point,v) => point.distanceToSquared(new THREE.Vector3().fromBufferAttribute(p,v).applyMatrix4(m.matrixWorld)) < 1e-20)
    const partSamples: Array<Array<[number,number]>> = []; samples.push(partSamples)
    for (let v = 0; v < p.count; v++) {
      const point = new THREE.Vector3().fromBufferAttribute(p,v).applyMatrix4(m.matrixWorld)
      if (![point.x,point.y,point.z].every(Number.isFinite)) throw new Error('Nonfinite bind position')
      const c = cell(point)
      let distance = sameAddresses ? 0 : tolerance*tolerance, match: Array<[number,number]> | undefined = sameAddresses ? [[v,1]] : undefined
      for (let x = -1; !sameAddresses && x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
        for (const oldVertex of cells.get([c[0]+x,c[1]+y,c[2]+z].join(',')) ?? []) {
          const d = point.distanceToSquared(points[oldVertex])
          if (d < distance) { distance = d; match = [[oldVertex,1]] }
        }
      }
      if (match === undefined) {
        const normals = m.geometry.attributes.normal
        const facing = normals === undefined ? null : new THREE.Vector3().fromBufferAttribute(normals,v).applyNormalMatrix(normalMatrix)
        // Rare fallback only. Exact/near vertex matches use the spatial hash.
        for (let f = 0; f < count; f += 3) {
          const ids = [index(f),index(f+1),index(f+2)]
          triangle.set(points[ids[0]],points[ids[1]],points[ids[2]])
          if (triangle.getArea() < 1e-16) continue
          triangle.getNormal(normal)
          // Do not jump through a thin shell to its opposite face.
          if (facing !== null && facing.dot(normal) < .5) continue
          triangle.closestPointToPoint(point,closest)
          const d = point.distanceToSquared(closest)
          if (d >= distance || triangle.getBarycoord(closest,bary) === null) continue
          distance = d
          match = ids.map((id,k) => [id,Math.max(0,bary.getComponent(k))] as [number,number]).filter(([,w]) => w > 1e-10)
        }
        if (match !== undefined) projected++
      }
      if (match === undefined) throw new Error(`Bind surface changed at mesh ${part}, vertex ${v}`)
      const blended = new Map<string,number>()
      for (const [vertex,amount] of match) for (const [bone,w] of weights[vertex]) blended.set(bone,(blended.get(bone) ?? 0)+amount*w)
      const top = [...blended].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,4)
      const total = top.reduce((s,[,w]) => s+w,0)
      edits.push({ mesh:part, vertex:v, weights:top.map(([n,w]) => [n,w/total]) })
      partSamples.push(match)
    }
  }
  return { edits, samples, projected }
}

/** Readdress manual painting after a rebuild. New triangle-interior vertices
 * inherit paint only when all contributing vertices were painted. Never extend
 * a sparse brush stroke across an unpainted triangle or discard a painted point. */
export function transferPainting (target: THREE.Object3D, source: THREE.Object3D, painted: WeightEdit[]): WeightEdit[] {
  if (painted.length === 0) return []
  const transfer = transferSkin(target,source,false), old = skinMeshes(source), now = skinMeshes(target)
  const byVertex = new Map<string,WeightEdit>(), covered = new Set<string>()
  // Duplicated UV vertices are the same painted point when a rebuild changes the
  // split. Keep exact addresses first; use a positional alias only if needed.
  const aliases = new Map<string,WeightEdit[]>()
  const pointKey = (part: number, vertex: number): string => {
    const mesh = old[part]
    const p = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position,vertex).applyMatrix4(mesh.matrixWorld)
    return `${part}:${p.toArray().map(x => Math.round(x/1e-8)).join(',')}`
  }
  for (const e of painted) {
    if (!Number.isSafeInteger(e.mesh) || !Number.isSafeInteger(e.vertex) || e.mesh < 0 || e.vertex < 0 || old[e.mesh]?.geometry.attributes.position.count <= e.vertex || old[e.mesh] === undefined) throw new Error('Painted vertex is missing from the previous rig')
    const allowed = new Set(now[e.mesh].skeleton.bones.map(b => b.name))
    if (e.weights.some(([n,w]) => !allowed.has(n) || !Number.isFinite(w) || w < 0) || e.weights.reduce((s,[,w]) => s+w,0) <= 0) throw new Error('Painted bone or weight is invalid for the new skeleton')
    byVertex.set(`${e.mesh}:${e.vertex}`,e)
    const key = pointKey(e.mesh,e.vertex)
    if (!aliases.has(key)) aliases.set(key,[])
    aliases.get(key)!.push(e)
  }
  const out: WeightEdit[] = []
  for (let part = 0; part < transfer.samples.length; part++) {
    const p = old[part].geometry.attributes.position, q = now[part].geometry.attributes.position
    const unchanged = p.count === q.count && transfer.samples[part].every((s,i) => s.length === 1 && s[0][0] === i)
    for (let vertex = 0; vertex < transfer.samples[part].length; vertex++) {
      const samples = transfer.samples[part][vertex]
      const contributors = samples.map(([v,amount]) => {
        const exact = byVertex.get(`${part}:${v}`)
        const candidates = unchanged ? (exact === undefined ? [] : [exact]) : aliases.get(pointKey(part,v)) ?? []
        if (candidates.length === 0) return null
        const canonical = (e: WeightEdit): string => JSON.stringify([...e.weights].sort((a,b) => a[0].localeCompare(b[0])))
        if (candidates.some(e => canonical(e) !== canonical(candidates[0]))) throw new Error('Conflicting painted weights at a rebuilt seam')
        return { amount, weights:candidates[0].weights, edits:candidates }
      })
      if (contributors.some(c => c === null)) continue
      const blended = new Map<string,number>()
      for (const c of contributors) {
        for (const [bone,w] of c!.weights) blended.set(bone,(blended.get(bone) ?? 0)+w*c!.amount)
        for (const e of c!.edits) covered.add(`${e.mesh}:${e.vertex}`)
      }
      // Preserve exact authored values when there is no interpolation.
      const weights = contributors.length === 1 ? contributors[0]!.weights : [...blended].sort((a,b) => b[1]-a[1]).slice(0,4)
      const total = weights.reduce((s,[,w]) => s+w,0)
      out.push({ mesh:part, vertex, weights:contributors.length === 1 ? weights : weights.map(([n,w]) => [n,w/total]) })
    }
  }
  if (covered.size !== byVertex.size) throw new Error(`${byVertex.size-covered.size} painted vertices no longer match the rebuilt surface; the previous rig has been kept`)
  return out
}
