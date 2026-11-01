import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { type PaintPick, WeightPainter } from './weightpaint.ts'

function materialBoundary (): { meshes: THREE.SkinnedMesh[], hit: PaintPick } {
  const root = new THREE.Group()
  const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.z = -.5; root.add(hips)
  const head = new THREE.Bone(); head.name = 'Head'; head.position.y = 1; hips.add(head)
  const meshes = [[-.3, .3, 0, 1, 0], [-.06, 0, .4, .6, .008], [0, .06, .4, .6, .008]].map(([left, right, bottom, top, z], q) => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([left, bottom, z, right, bottom, z, left, top, z, right, top, z], 3))
    g.setIndex([0, 1, 3, 0, 3, 2])
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(Array.from({ length: 4 }, () => [q === 0 ? 1 : 0, 0, 0, 0]).flat(), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: 4 }, () => [1, 0, 0, 0]).flat(), 4))
    const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial()); root.add(mesh); return mesh
  })
  root.updateMatrixWorld(true)
  for (const mesh of meshes) mesh.bind(new THREE.Skeleton([hips, head]))
  return { meshes, hit: { part: 2, face: [0, 1, 3], point: new THREE.Vector3(.03, .5, .008), normal: new THREE.Vector3(0, 0, 1),
    distance: 1, points: new Map([0, 1, 2, 3].map(p => [p, 1])) } }
}

const buffers = (meshes: THREE.SkinnedMesh[]): number[][][] => meshes.map(m => ['position', 'skinIndex', 'skinWeight'].map(k => Array.from(m.geometry.attributes[k].array)))

describe('material boundaries in a layer stroke', () => {
  it('continues a stroke across a shared material boundary while excluding the body beneath it', () => {
    const { meshes } = materialBoundary(); const painter = new WeightPainter(meshes); painter.mirror = false
    const radius = .04
    const right = painter.pick(new THREE.Ray(new THREE.Vector3(.01, .5, 1), new THREE.Vector3(0, 0, -1)), radius)!
    expect(right.part).toBe(2)
    const held = { part: right.part, sheet: new Set([...right.points.keys(), ...right.face.map(p => painter.parts[right.part].point[p])]) }
    const left = painter.pick(new THREE.Ray(new THREE.Vector3(-.01, .5, 1), new THREE.Vector3(0, 0, -1)), radius, held)!
    expect(left.part).toBe(1)
    expect(painter.pick(new THREE.Ray(new THREE.Vector3(-.15, .5, 1), new THREE.Vector3(0, 0, -1)), radius, held)).toBeNull()
  })

  it.each(['follow', 'lift'] as const)('keeps shared vertices together for %s and undoes the whole stack exactly', tool => {
    const { meshes, hit } = materialBoundary(); const original = buffers(meshes)
    const painter = new WeightPainter(meshes); painter.mirror = false
    painter.begin({ bounded: true, preserveSurface: true }); painter.paintLayers(tool, hit, .2, .3, .02); painter.end()
    for (const [left, right] of [[1, 0], [3, 2]]) {
      expect(painter.weights(1, left)).toEqual(painter.weights(2, right))
      for (let k = 0; k < 3; k++) expect(meshes[1].geometry.attributes.position.getComponent(left, k)).toBe(meshes[2].geometry.attributes.position.getComponent(right, k))
    }
    expect(buffers([meshes[0]])).toEqual([original[0]])
    expect(painter.editedCount).toBeGreaterThan(0)
    expect(painter.stepBack()).toBe(true)
    expect(buffers(meshes)).toEqual(original)
  })

  it('pins shared vertices when their other material primitive is read-only', () => {
    const { meshes, hit } = materialBoundary(); const original = buffers(meshes)
    const painter = new WeightPainter(meshes); painter.mirror = false
    painter.begin({ bounded: true }); painter.paintLayers('follow', hit, .2, .3, 0, new Set([meshes[2]])); painter.end()
    expect(buffers([meshes[0], meshes[1]])).toEqual(original.slice(0, 2))
    for (const p of [0, 2]) expect(painter.weights(2, p)).toEqual(new Map([[0, 1]]))
    for (const p of [1, 3]) expect(painter.weights(2, p).get(1)).toBeCloseTo(.3)
  })

  it('exports actual float weights without quantizing the guard-approved result', () => {
    const { meshes, hit } = materialBoundary(); const painter = new WeightPainter(meshes); painter.mirror = false
    painter.begin({ bounded: true }); painter.paintLayers('follow', hit, .2, .123456789); painter.end()
    const edits = painter.edits(); expect(edits.length).toBeGreaterThan(0)
    for (const edit of edits) {
      const bones = meshes[edit.mesh].skeleton.bones
      for (const [name, weight] of edit.weights) expect(weight).toBe(painter.weights(edit.mesh, edit.vertex).get(bones.findIndex(b => b.name === name)))
    }
    expect(edits.some(e => e.weights.some(([, w]) => w !== Math.round(w * 1e5) / 1e5))).toBe(true)
  })
})
