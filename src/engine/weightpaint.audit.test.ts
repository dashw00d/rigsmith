import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { WeightPainter } from './weightpaint.ts'

function rig (positions: number[][]): { meshes: THREE.SkinnedMesh[], root: THREE.Group, head: THREE.Bone } {
  const root = new THREE.Group(); const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.z = -.5; root.add(hips)
  const head = new THREE.Bone(); head.name = 'Head'; head.position.y = 1; hips.add(head)
  const meshes = positions.map(vertices => {
    const g = new THREE.BufferGeometry(); const count = vertices.length / 3
    g.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
    g.setIndex(count === 3 ? [0, 1, 2] : [0, 1, 3, 0, 3, 2])
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(count * 4).fill(0), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: count }, () => [1, 0, 0, 0]).flat(), 4))
    const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial()); root.add(mesh); return mesh
  })
  root.updateMatrixWorld(true)
  for (const mesh of meshes) mesh.bind(new THREE.Skeleton([hips, head]))
  return { meshes, root, head }
}

describe('audited brush invariants', () => {
  it('omits a net-zero gesture and restores the original dirty state', () => {
    const { meshes } = rig([[0, 0, 0, 1, 0, 0, 0, 1, 0]])
    const p = new WeightPainter(meshes); p.mirror = false
    p.begin(); p.add(0, new Map([[1, 1]]), 1, .5); p.remove(0, new Map([[1, 1]]), 1, 1); p.end()
    expect(p.editedCount).toBe(0); expect(p.edits()).toEqual([]); expect(p.stepBack()).toBe(false)
  })

  it('recomputes capped maximum coverage from the stroke source rather than accumulating capped live weights', () => {
    const run = (falloffs: number[]): number => {
      const { meshes, root, head } = rig([[0, 0, 0, 1, 0, 0, 0, 1, 0]])
      head.position.x = -.9; root.updateMatrixWorld(true)
      const p = new WeightPainter(meshes); p.mirror = false
      p.begin({ bounded: true, preserveSurface: true })
      for (const f of falloffs) p.add(0, new Map([[1, f]]), 1, 1)
      p.end(); expect(p.limitedCount).toBeGreaterThan(0)
      const weight = p.weights(0, 1).get(1) ?? 0
      expect(p.stepBack()).toBe(true); expect(p.weights(0, 1)).toEqual(new Map([[0, 1]]))
      return weight
    }
    const direct = run([1])
    for (const falloffs of [[.4, 1], [1, .4], [.1, .4, 1], [.8, 1]]) expect(run(falloffs)).toBe(direct)
  })

  it('does not mirror into an independent coincident sheet when the selected sheet already has its own twins', () => {
    const triangle = [-1, 0, 0, 1, 0, 0, 0, 1, 0]
    const { meshes } = rig([triangle, triangle])
    for (let p = 0; p < 3; p++) meshes[1].geometry.attributes.skinIndex.setX(p, 1)
    const before = Array.from(meshes[1].geometry.attributes.skinWeight.array)
    const painter = new WeightPainter(meshes); painter.begin({ bounded: true })
    painter.add(0, new Map([[1, 1]]), 0, .25); painter.end()
    for (let p = 0; p < 3; p++) expect(painter.weights(1, p)).toEqual(new Map([[1, 1]]))
    expect(Array.from(meshes[1].geometry.attributes.skinWeight.array)).toEqual(before)
    expect(painter.edits()).toEqual([]); expect(painter.stepBack()).toBe(false)
  })

  it.each(['follow', 'lift'] as const)('keeps constructor read-only restrictions for direct and layered %s calls', tool => {
    const sheet = (z: number): number[] => [-.05, .4, z, .05, .4, z, -.05, .6, z, .05, .6, z]
    const { meshes } = rig([sheet(0), sheet(.008)])
    for (let p = 0; p < 4; p++) meshes[0].geometry.attributes.skinIndex.setX(p, 1)
    const painter = new WeightPainter(meshes, undefined, new Set([meshes[0]])); painter.mirror = false
    const before = meshes.map(m => ['position', 'skinIndex', 'skinWeight'].map(a => Array.from(m.geometry.attributes[a].array)))
    const points = new Map([0, 1, 2, 3].map(p => [p, 1]))
    painter.begin({ bounded: true, preserveSurface: true })
    if (tool === 'follow') painter.followUnder(1, points, 1)
    else expect(painter.lift(1, points, .02, 1, new Set(points.keys()))).toBe(0)
    const hit = { part: 1, point: new THREE.Vector3(0, .5, .008), normal: new THREE.Vector3(0, 0, 1),
      face: [0, 1, 3] as [number, number, number], distance: 1, points }
    expect(painter.paintLayers(tool, hit, .2, 1, .02)).toBe(0)
    expect(painter.paintLayers(tool, hit, .2, 1, .02, new Set(meshes))).toBe(0)
    painter.end()
    expect(meshes.map(m => ['position', 'skinIndex', 'skinWeight'].map(a => Array.from(m.geometry.attributes[a].array)))).toEqual(before)
    expect(painter.edits()).toEqual([]); expect(painter.shapeEdits()).toEqual([]); expect(painter.stepBack()).toBe(false)
  })
})
