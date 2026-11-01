import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { type PaintPick, WeightPainter } from './weightpaint.ts'

interface Stack {
  root: THREE.Group
  meshes: [THREE.SkinnedMesh, THREE.SkinnedMesh, THREE.SkinnedMesh]
}

function stack (bodyBone = 'LeftUpLeg', liningBone = 'Hips'): Stack {
  const root = new THREE.Group()
  const bone = (name: string, at: [number, number, number], parent?: THREE.Bone): THREE.Bone => {
    const b = new THREE.Bone(); b.name = name; b.position.fromArray(at)
    if (parent === undefined) root.add(b); else parent.add(b)
    return b
  }
  const hips = bone('Hips', [0, 1, -.5])
  const spine = bone('Spine', [0, .3, 0], hips)
  const head = bone('Head', [0, .3, 0], spine)
  const left = bone('LeftUpLeg', [.08, -.1, 0], hips)
  const leftShin = bone('LeftLeg', [0, -.5, 0], left)
  const leftFoot = bone('LeftFoot', [0, -.4, 0], leftShin)
  const right = bone('RightUpLeg', [-.08, -.1, 0], hips)
  const rightShin = bone('RightLeg', [0, -.5, 0], right)
  const rightFoot = bone('RightFoot', [0, -.4, 0], rightShin)
  const bones = [hips, spine, head, left, leftShin, leftFoot, right, rightShin, rightFoot]
  const meshes = [0, .004, .008].map((z, part) => {
    const g = new THREE.BufferGeometry(); const positions: number[] = []; const triangles: number[] = []
    const half = part === 0 ? .3 : .06; const bottom = part === 0 ? 0 : .4; const top = part === 0 ? 1 : .6
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) positions.push(-half + half * col, bottom + (top - bottom) * row / 2, z)
    for (let row = 0; row < 2; row++) for (let col = 0; col < 2; col++) {
      const a = row * 3 + col; const b = a + 1; const c = a + 3; const d = c + 1
      triangles.push(a, b, d, a, d, c)
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); g.setIndex(triangles)
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(36).fill(0), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: 9 }, () => [1, 0, 0, 0]).flat(), 4))
    const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial()); root.add(mesh)
    return mesh
  }) as unknown as Stack['meshes']
  root.updateMatrixWorld(true)
  // A primitive's JOINTS_0 slots are local to its skin, even when all primitives reference the same bone objects.
  const orders = [bones, [...bones].reverse(), [...bones.slice(3), ...bones.slice(0, 3)]]
  meshes.forEach((mesh, part) => mesh.bind(new THREE.Skeleton(orders[part])))
  for (let p = 0; p < 9; p++) {
    setWeight(meshes[0], p, bodyBone)
    setWeight(meshes[1], p, liningBone)
    setWeight(meshes[2], p, 'Hips')
  }
  return { root, meshes }
}

function setWeight (mesh: THREE.SkinnedMesh, point: number, name: string): void {
  const bone = mesh.skeleton.bones.findIndex(b => b.name === name)
  if (bone < 0) throw new Error(`Missing fixture bone ${name}`)
  mesh.geometry.attributes.skinIndex.setXYZW(point, bone, 0, 0, 0)
  mesh.geometry.attributes.skinWeight.setXYZW(point, 1, 0, 0, 0)
}

function weights (painter: WeightPainter, part: number, point: number): Map<string, number> {
  const bones = painter.parts[part].mesh.skeleton.bones
  return new Map([...painter.weights(part, point)].map(([b, w]) => [bones[b].name, w]))
}

function hit (s: Stack, falloff = 1, points = [0, 1, 2, 3, 4, 5, 6, 7, 8]): PaintPick {
  return { part: 2, point: s.meshes[2].getVertexPosition(4, new THREE.Vector3()).applyMatrix4(s.meshes[2].matrixWorld),
    normal: new THREE.Vector3(0, 0, 1), face: [0, 1, 4], distance: 1, points: new Map(points.map(p => [p, falloff])) }
}

function bindScaleY (s: Stack, scaleY: number): void {
  const outer = s.meshes[2]; const positions = outer.geometry.attributes.position
  for (let p = 0; p < positions.count; p++) positions.setY(p, positions.getY(p) / scaleY)
  outer.scale.y = scaleY; s.root.updateMatrixWorld(true)
  outer.bind(outer.skeleton, outer.matrixWorld)
}

describe('cross-mesh brush edge cases', () => {
  it.each([1, 100])('keeps receiver selection invariant under an equivalent original bind scale of %s', scaleY => {
    const s = stack(); bindScaleY(s, scaleY)
    const painter = new WeightPainter(s.meshes); painter.mirror = false
    const picked = hit(s)
    expect(painter.column(2, picked.point, .2, picked.points, 1).size).toBe(9)
    painter.begin({ bounded: true }); painter.paintLayers('follow', picked, .2, 1); painter.end()
    for (const part of [1, 2]) for (let p = 0; p < 9; p++) {
      expect(weights(painter, part, p)).toEqual(new Map([['LeftUpLeg', 1]]))
    }
  })

  it.each([1, 100])('keeps cross-layer protection invariant under an equivalent original bind scale of %s', scaleY => {
    const s = stack('Head'); bindScaleY(s, scaleY)
    const painter = new WeightPainter(s.meshes); painter.mirror = false
    const clip = new THREE.AnimationClip('Brief bend', 1, [
      new THREE.NumberKeyframeTrack('Head.position[z]', [0, .34, .35, .36, 1], [0, 0, -.0068, 0, 0]),
    ])
    painter.begin({ bounded: true, preserveSurface: true, animation: { root: s.root, clip } })
    painter.paintLayers('follow', hit(s), .2, 1, 0, new Set([s.meshes[2]])); painter.end()
    expect(painter.limitedCount).toBeGreaterThan(0)
    expect(painter.editedCount).toBeGreaterThan(0)
    const mixer = new THREE.AnimationMixer(s.root); mixer.clipAction(clip).play(); mixer.setTime(.35); s.root.updateMatrixWorld(true)
    for (let p = 0; p < 9; p++) {
      const inner = s.meshes[1].getVertexPosition(p, new THREE.Vector3()).applyMatrix4(s.meshes[1].matrixWorld)
      const outer = s.meshes[2].getVertexPosition(p, new THREE.Vector3()).applyMatrix4(s.meshes[2].matrixWorld)
      expect(outer.z - inner.z).toBeGreaterThanOrEqual(.001 - 1e-7)
    }
    mixer.stopAllAction()
    expect(painter.stepBack()).toBe(true)
    for (let p = 0; p < 9; p++) expect(weights(painter, 2, p)).toEqual(new Map([['Hips', 1]]))
  })

  it('mirrors into a separate opposite-side primitive without relying on a shared seam', () => {
    const s = stack()
    // Separate non-touching panels. Neither primitive contains its own mirrored vertices.
    for (const part of [1, 2]) {
      const positions = s.meshes[part].geometry.attributes.position
      for (let p = 0; p < positions.count; p++) {
        positions.setX(p, (part === 1 ? -1 : 1) * (.01 + .025 * (p % 3)))
        positions.setZ(p, .008)
      }
    }
    s.root.updateMatrixWorld(true)
    const painter = new WeightPainter(s.meshes); painter.mirror = true
    painter.begin({ bounded: true }); painter.paintLayers('follow', hit(s), .2, 1); painter.end()
    for (let p = 0; p < 9; p++) {
      expect(weights(painter, 2, p)).toEqual(new Map([['LeftUpLeg', 1]]))
      expect(weights(painter, 1, p)).toEqual(new Map([['RightUpLeg', 1]]))
    }
    expect(new Set(painter.edits().map(e => e.mesh))).toEqual(new Set([1, 2]))
    expect(painter.stepBack()).toBe(true)
    for (const part of [1, 2]) for (let p = 0; p < 9; p++) expect(weights(painter, part, p)).toEqual(new Map([['Hips', 1]]))
  })
})
