import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { WeightPainter } from './weightpaint.ts'

function stack (): THREE.SkinnedMesh {
  const g = new THREE.BufferGeometry(); const positions: number[] = []; const triangles: number[] = []
  for (const [z, half, bottom, top] of [[0, .3, 0, 1], [.004, .03, .4, .6], [.008, .03, .4, .6]]) {
    const from = positions.length / 3
    positions.push(-half, bottom, z, half, bottom, z, -half, top, z, half, top, z)
    triangles.push(from, from + 1, from + 3, from, from + 3, from + 2)
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); g.setIndex(triangles)
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(48).fill(0), 4))
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: 12 }, () => [1, 0, 0, 0]).flat(), 4))
  const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.z = -.5
  const head = new THREE.Bone(); head.name = 'Head'; head.position.y = 1; hips.add(head)
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial()); mesh.add(hips); mesh.updateMatrixWorld(true)
  mesh.bind(new THREE.Skeleton([hips, head]))
  return mesh
}

describe('separation between brushed layers', () => {
  it.each([[1, 1, 1], [-1, 1, 1], [-2, .75, 3], [10, 10, 10], [.1, .1, .1]])('catches a brief crossing under mesh scale %s, %s, %s', (x, y, z) => {
    const mesh = stack(); const index = mesh.geometry.attributes.skinIndex
    mesh.scale.set(x, y, z); mesh.updateMatrixWorld(true)
    for (let p = 0; p < 4; p++) index.setX(p, 1) // the covered body moves with Head; both cloth sheets start on Hips
    const painter = new WeightPainter([mesh]); painter.mirror = false
    const clip = new THREE.AnimationClip('Brief bend', 1, [
      new THREE.NumberKeyframeTrack('Head.position[z]', [0, .34, .35, .36, 1], [0, 0, -.0068, 0, 0]),
    ])
    painter.begin({ bounded: true, preserveSurface: true, animation: { root: mesh, clip } })
    painter.followUnder(0, new Map([8, 9, 10, 11].map(p => [p, 1])), 1)
    painter.end()
    expect(painter.limitedCount).toBeGreaterThan(0)
    expect(painter.editedCount).toBeGreaterThan(0)
    const mixer = new THREE.AnimationMixer(mesh); mixer.clipAction(clip).play(); mixer.setTime(.35); mesh.updateMatrixWorld(true)
    for (let p = 0; p < 4; p++) {
      const inner = mesh.getVertexPosition(p + 4, new THREE.Vector3())
      const outer = mesh.getVertexPosition(p + 8, new THREE.Vector3())
      expect(outer.z - inner.z).toBeGreaterThanOrEqual(.001 - 1e-7)
    }
    mixer.stopAllAction()
    expect(painter.stepBack()).toBe(true)
    for (let p = 8; p < 12; p++) expect(painter.weights(0, p)).toEqual(new Map([[0, 1]]))
  })

  it('keeps intact sheets from crossing when their local lift coverage differs', () => {
    // Both sheets translate without changing any triangle area, edge or orientation. Individual face guards alone
    // cannot detect the inner layer passing through the outer one.
    const run = (preserveSurface: boolean): { mesh: THREE.SkinnedMesh, painter: WeightPainter, before: number[] } => {
      const mesh = stack(); const painter = new WeightPainter([mesh]); painter.mirror = false
      const before = Array.from(mesh.geometry.attributes.position.array)
      painter.begin({ bounded: true, preserveSurface })
      const column = new Map(Array.from({ length: 12 }, (_, p) => [p, p < 8 ? 1 : .1]))
      painter.lift(0, column, .02, 1, new Set([8, 9, 10, 11])); painter.end()
      return { mesh, painter, before }
    }
    const unsafe = run(false).mesh.geometry.attributes.position
    expect(unsafe.getZ(4)).toBeGreaterThan(unsafe.getZ(8))
    const { mesh, painter, before } = run(true); const pos = mesh.geometry.attributes.position
    expect(painter.limitedCount).toBeGreaterThan(0)
    expect(painter.shapeEdits().length).toBeGreaterThan(0)
    for (let p = 0; p < 4; p++) {
      expect(pos.getZ(p)).toBe(before[p * 3 + 2])
      expect(pos.getZ(p + 8) - pos.getZ(p + 4)).toBeGreaterThanOrEqual(.001 - 1e-7)
    }
    expect(painter.stepBack()).toBe(true)
    expect(Array.from(pos.array)).toEqual(before)
  })

  it('leaves an already clear stack exactly unchanged', () => {
    const mesh = stack(); const painter = new WeightPainter([mesh]); painter.mirror = false
    const before = Array.from(mesh.geometry.attributes.position.array)
    painter.begin({ bounded: true, preserveSurface: true })
    painter.lift(0, new Map(Array.from({ length: 12 }, (_, p) => [p, 1])), .002, .5, new Set([8, 9, 10, 11]))
    painter.end()
    expect(Array.from(mesh.geometry.attributes.position.array)).toEqual(before)
    expect(painter.editedCount).toBe(0)
    expect(painter.stepBack()).toBe(false)
  })
})
