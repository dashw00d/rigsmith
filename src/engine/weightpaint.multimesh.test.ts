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

function raw (meshes: THREE.SkinnedMesh[]): number[][][] {
  return meshes.map(mesh => ['position', 'skinIndex', 'skinWeight'].map(name => Array.from(mesh.geometry.attributes[name].array)))
}

describe('brushes across separate skinned primitives', () => {
  it('blends Follow and its inherited falloff on every cloth mesh, mapping bone names across skin slot orders', () => {
    const s = stack('LeftUpLeg', 'Head'); const beforeBody = raw([s.meshes[0]])
    const p = new WeightPainter(s.meshes); p.mirror = false
    p.begin({ bounded: true }); p.paintLayers('follow', hit(s, .6), .2, .25); p.end()
    for (let q = 0; q < 9; q++) {
      expect(weights(p, 1, q).get('Head')).toBeCloseTo(.85)
      expect(weights(p, 1, q).get('LeftUpLeg')).toBeCloseTo(.15)
      expect(weights(p, 2, q).get('Hips')).toBeCloseTo(.85)
      expect(weights(p, 2, q).get('LeftUpLeg')).toBeCloseTo(.15)
    }
    expect(raw([s.meshes[0]])).toEqual(beforeBody)
    expect(new Set(p.edits().map(e => e.mesh))).toEqual(new Set([1, 2]))
  })

  it('shares Cloth targets across meshes while blending each layer from its own source', () => {
    const full = stack(); const target = new WeightPainter(full.meshes); target.mirror = false
    target.begin({ bounded: true }); target.paintLayers('cloth', hit(full), .2, 1); target.end()
    const s = stack('LeftUpLeg', 'Head'); const body = raw([s.meshes[0]])
    const p = new WeightPainter(s.meshes); p.mirror = false
    p.begin({ bounded: true }); p.paintLayers('cloth', hit(s, .2), .2, .4); p.end()
    for (const part of [1, 2]) for (let q = 0; q < 9; q++) {
      const to = weights(target, 2, q); const after = weights(p, part, q); const source = part === 1 ? 'Head' : 'Hips'
      for (const name of new Set([...to.keys(), ...after.keys(), source])) {
        expect(after.get(name) ?? 0).toBeCloseTo((name === source ? .92 : 0) + .08 * (to.get(name) ?? 0), 5)
      }
      expect(weights(target, 1, q)).toEqual(to)
    }
    expect(raw([s.meshes[0]])).toEqual(body)
  })

  it('respects an editable mesh restriction while retaining other primitives as Follow donors', () => {
    const s = stack(); const unchanged = raw(s.meshes.slice(0, 2))
    const p = new WeightPainter(s.meshes); p.mirror = false
    p.begin({ bounded: true }); p.paintLayers('follow', hit(s), .2, 1, 0, new Set([s.meshes[2]])); p.end()
    expect(raw(s.meshes.slice(0, 2))).toEqual(unchanged)
    for (let q = 0; q < 9; q++) expect(weights(p, 2, q).get('LeftUpLeg')).toBeCloseTo(1)
    expect(new Set(p.edits().map(e => e.mesh))).toEqual(new Set([2]))
  })

  it.each(['follow', 'cloth', 'lift'] as const)('undo restores every primitive exactly after one %s stroke', tool => {
    const s = stack('LeftUpLeg', 'Head'); const before = raw(s.meshes)
    const p = new WeightPainter(s.meshes); p.mirror = false
    p.begin({ bounded: true }); p.paintLayers(tool, hit(s), .2, .5, .02); p.end()
    expect(p.editedCount).toBeGreaterThan(0)
    expect(p.stepBack()).toBe(true)
    expect(raw(s.meshes)).toEqual(before)
    expect(p.editedCount).toBe(0)
    expect(p.stepBack()).toBe(false)
  })

  it('keeps each mirrored mesh source at weak Strength instead of replacing its opposite-side paint', () => {
    const s = stack()
    for (const part of [1, 2]) for (const q of [0, 3, 6]) setWeight(s.meshes[part], q, 'RightUpLeg')
    const p = new WeightPainter(s.meshes)
    p.begin({ bounded: true }); p.paintLayers('follow', hit(s, 1, [2, 5, 8]), .2, .1); p.end()
    for (const part of [1, 2]) for (const q of [0, 3, 6]) expect(weights(p, part, q).get('RightUpLeg') ?? 0).toBeGreaterThanOrEqual(.9 - 1e-6)
    for (const part of [1, 2]) for (const q of [2, 5, 8]) expect(weights(p, part, q).get('Hips') ?? 0).toBeGreaterThanOrEqual(.9 - 1e-6)
  })

  it('guards a short crossing against an uneditable inner mesh in an intermediate animation pose', () => {
    const s = stack('Head'); const inner = raw([s.meshes[1]])
    const p = new WeightPainter(s.meshes); p.mirror = false
    const clip = new THREE.AnimationClip('Brief bend', 1, [
      new THREE.NumberKeyframeTrack('Head.position[z]', [0, .34, .35, .36, 1], [0, 0, -.0068, 0, 0]),
    ])
    p.begin({ bounded: true, preserveSurface: true, animation: { root: s.root, clip } })
    p.paintLayers('follow', hit(s), .2, 1, 0, new Set([s.meshes[2]])); p.end()
    expect(p.limitedCount).toBeGreaterThan(0)
    expect(p.editedCount).toBeGreaterThan(0)
    expect(raw([s.meshes[1]])).toEqual(inner)
    const mixer = new THREE.AnimationMixer(s.root); mixer.clipAction(clip).play(); mixer.setTime(.35); s.root.updateMatrixWorld(true)
    for (let q = 0; q < 9; q++) {
      const a = s.meshes[1].getVertexPosition(q, new THREE.Vector3()).applyMatrix4(s.meshes[1].matrixWorld)
      const b = s.meshes[2].getVertexPosition(q, new THREE.Vector3()).applyMatrix4(s.meshes[2].matrixWorld)
      expect(b.z - a.z).toBeGreaterThanOrEqual(.001 - 1e-7)
    }
    mixer.stopAllAction()
  })

  it('lifts separate cloth meshes together and preserves the original gap between them', () => {
    const s = stack(); const body = raw([s.meshes[0]])
    const p = new WeightPainter(s.meshes); p.mirror = false
    p.begin({ bounded: true, preserveSurface: true }); p.paintLayers('lift', hit(s), .2, 1, .02); p.end()
    for (let q = 0; q < 9; q++) {
      const inner = s.meshes[1].geometry.attributes.position.getZ(q)
      const outer = s.meshes[2].geometry.attributes.position.getZ(q)
      expect(inner).toBeCloseTo(.02, 5)
      expect(outer - inner).toBeCloseTo(.004, 5)
    }
    expect(raw([s.meshes[0]])).toEqual(body)
    expect(new Set(p.shapeEdits().map(e => e.mesh))).toEqual(new Set([1, 2]))
  })

  it('leaves every primitive and Undo unchanged for an already clear Lift stroke', () => {
    const s = stack(); const before = raw(s.meshes)
    const p = new WeightPainter(s.meshes); p.mirror = false
    p.begin({ bounded: true, preserveSurface: true }); p.paintLayers('lift', hit(s), .2, .5, .002); p.end()
    expect(raw(s.meshes)).toEqual(before)
    expect(p.editedCount).toBe(0)
    expect(p.stepBack()).toBe(false)
  })
})
