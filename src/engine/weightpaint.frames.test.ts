import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { WeightPainter } from './weightpaint.ts'

function framedSheets (zs: number[], distinct: boolean, reflected = false): { root: THREE.Group, meshes: THREE.SkinnedMesh[] } {
  const root = new THREE.Group()
  const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.z = -.5
  const head = new THREE.Bone(); head.name = 'Head'; head.position.y = 1; hips.add(head); root.add(hips)
  root.updateMatrixWorld(true)
  const skeleton = new THREE.Skeleton([hips, head]); skeleton.calculateInverses()
  const frames = [
    new THREE.Matrix4().compose(new THREE.Vector3(-3, 1, -.4), new THREE.Quaternion(), new THREE.Vector3(.6, 2, 3)),
    new THREE.Matrix4().compose(new THREE.Vector3(4, -2, .8), new THREE.Quaternion(), new THREE.Vector3(2, .5, 1.5)),
    new THREE.Matrix4().compose(new THREE.Vector3(-2, 4, -.6), new THREE.Quaternion(), new THREE.Vector3(.75, 3, .5)),
  ]
  const meshes = zs.map((z, part) => {
    const frame = distinct ? frames[part] : new THREE.Matrix4()
    if (reflected) frame.premultiply(new THREE.Matrix4().makeScale(-1, 1, 1))
    const inverse = frame.clone().invert(); const positions: number[] = []; const triangles: number[] = []
    const half = part === 0 ? .3 : .05; const bottom = part === 0 ? 0 : .4; const top = part === 0 ? 1 : .6
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
      new THREE.Vector3(-half + half * x, bottom + (top - bottom) * y / 2, z).applyMatrix4(inverse).toArray(positions, positions.length)
    }
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
      const a = y * 3 + x
      if (frame.determinant() < 0) triangles.push(a, a + 4, a + 1, a, a + 3, a + 4)
      else triangles.push(a, a + 1, a + 4, a, a + 4, a + 3)
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); g.setIndex(triangles)
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(36).fill(0), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: 9 }, () => [1, 0, 0, 0]).flat(), 4))
    const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial()); frame.decompose(mesh.position, mesh.quaternion, mesh.scale)
    root.add(mesh); root.updateMatrixWorld(true); mesh.bind(skeleton)
    return mesh
  })
  root.updateMatrixWorld(true)
  return { root, meshes }
}

const all = (): Map<number, number> => new Map(Array.from({ length: 9 }, (_, p) => [p, 1]))
const worldZ = (mesh: THREE.SkinnedMesh, p = 4): number => mesh.getVertexPosition(p, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld).z

describe('brush contacts between original bind frames', () => {
  it.each([false, true])('Follow finds the same covered body with distinct bind frames=%s', distinct => {
    const { meshes } = framedSheets([0, .005], distinct)
    for (let p = 0; p < 9; p++) meshes[0].geometry.attributes.skinIndex.setX(p, 1)
    const painter = new WeightPainter(meshes); painter.mirror = false; painter.begin({ bounded: true })
    painter.followUnder(1, all(), 1, new Set(all().keys())); painter.end()
    for (let p = 0; p < 9; p++) {
      expect(painter.weights(1, p).get(1)).toBeCloseTo(1)
      expect(painter.weights(0, p)).toEqual(new Map([[1, 1]]))
    }
    expect(painter.stepBack()).toBe(true)
    expect(painter.weights(1, 4)).toEqual(new Map([[0, 1]]))
  })

  it.each([false, true])('Lift reaches the same body gap and layer spacing with distinct bind frames=%s', distinct => {
    const { meshes } = framedSheets([0, .003, .005], distinct)
    const painter = new WeightPainter(meshes); painter.mirror = false; painter.begin({ bounded: true })
    painter.lift(2, all(), .02, 1, new Set(all().keys()))
    painter.lift(1, all(), .02, 1, new Set(all().keys())); painter.end()
    expect(worldZ(meshes[0])).toBeCloseTo(0, 6)
    expect(worldZ(meshes[1])).toBeCloseTo(.02, 6)
    expect(worldZ(meshes[2])).toBeCloseTo(.022, 6)
    expect(painter.stepBack()).toBe(true)
    expect(worldZ(meshes[1])).toBeCloseTo(.003, 6)
    expect(worldZ(meshes[2])).toBeCloseTo(.005, 6)
  })

  it('does not touch an already-clear stack in distinct bind frames', () => {
    const { meshes } = framedSheets([0, .003, .005], true)
    const before = meshes.map(mesh => Array.from(mesh.geometry.attributes.position.array))
    const painter = new WeightPainter(meshes); painter.mirror = false; painter.begin({ bounded: true })
    expect(painter.lift(2, all(), .002, .5, new Set(all().keys()))).toBe(0)
    expect(painter.lift(1, all(), .002, .5, new Set(all().keys()))).toBe(0)
    painter.end()
    expect(meshes.map(mesh => Array.from(mesh.geometry.attributes.position.array))).toEqual(before)
    expect(painter.stepBack()).toBe(false)
  })

  it.each([
    { scale: [2, .5, 3], reflected: false },
    { scale: [-2, .5, 3], reflected: false },
    { scale: [1, 1, 1], reflected: true },
    { scale: [-2, .5, .1], reflected: true },
  ])('preserves world-space layer spacing with stage $scale and reflected bind=$reflected', ({ scale, reflected }) => {
    const { root, meshes } = framedSheets([0, .003, .005], true, reflected)
    root.scale.fromArray(scale); root.updateMatrixWorld(true)
    const painter = new WeightPainter(meshes); painter.mirror = false; painter.begin({ bounded: true })
    painter.lift(2, all(), .02, 1, new Set(all().keys()))
    painter.lift(1, all(), .02, 1, new Set(all().keys())); painter.end()
    expect(worldZ(meshes[0])).toBeCloseTo(0, 6)
    expect(worldZ(meshes[1])).toBeCloseTo(.02, 6)
    expect(worldZ(meshes[2]) - worldZ(meshes[1])).toBeCloseTo(.002 * scale[2], 6)
    expect(painter.stepBack()).toBe(true)
    expect(worldZ(meshes[1])).toBeCloseTo(.003 * scale[2], 6)
    expect(worldZ(meshes[2])).toBeCloseTo(.005 * scale[2], 6)
  })
})
