import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { WeightPainter } from './weightpaint.ts'

// One mesh of sheets in front of a spine (a bone behind them, so "in" is -z): the body's skin, and a cape over it
// with its lining. Each sheet an n x n grid facing +z or -z; every vertex all Hips.
function scene (sheets: Array<{ z: number, half: number, y: [number, number], facing: 1 | -1 }>, n = 3): { mesh: THREE.SkinnedMesh, start: number[] } {
  const position: number[] = []; const index: number[] = []; const start: number[] = []
  for (const s of sheets) {
    const base = position.length / 3
    start.push(base)
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) position.push(-s.half + 2 * s.half * i / (n - 1), s.y[0] + (s.y[1] - s.y[0]) * j / (n - 1), s.z)
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = base + j * n + i; const b = a + 1; const c = a + n; const d = c + 1
      if (s.facing === 1) index.push(a, b, d, a, d, c); else index.push(a, d, b, a, c, d)
    }
  }
  const count = position.length / 3
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3))
  g.setIndex(index)
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(count * 4).fill(0), 4))
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: count }, () => [1, 0, 0, 0]).flat(), 4))
  const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.set(0, 0, -0.5)
  const head = new THREE.Bone(); head.name = 'Head'; head.position.set(0, 1, 0); hips.add(head)
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial())
  mesh.add(hips)
  mesh.updateMatrixWorld(true)
  mesh.bind(new THREE.Skeleton([hips, head]))
  return { mesh, start }
}

const z = (m: THREE.SkinnedMesh, v: number): number => m.geometry.attributes.position.getZ(v)
const all = (from: number, n = 9): Map<number, number> => new Map(Array.from({ length: n }, (_, i) => [from + i, 1]))

describe('Lift', () => {
  it('keeps a capped bounded lift independent of weaker dabs earlier in the stroke', () => {
    const run = (falloffs: number[]): number[] => {
      const { mesh, start } = scene([
        { z: 0, half: .3, y: [0, 1], facing: 1 },
        { z: .005, half: .05, y: [.4, .6], facing: 1 },
      ])
      const center = start[1] + 4
      mesh.geometry.attributes.skinIndex.setXYZW(center, 0, 1, 0, 0)
      mesh.geometry.attributes.skinWeight.setXYZW(center, .5, .5, 0, 0)
      mesh.skeleton.bones[1].rotation.y = 2.8; mesh.updateMatrixWorld(true)
      const p = new WeightPainter([mesh]); p.mirror = false
      const clip = new THREE.AnimationClip('Bend', 1, [new THREE.QuaternionKeyframeTrack('Head.quaternion', [0, 1],
        [0, 0, 0, 1, ...mesh.skeleton.bones[1].quaternion.toArray()])])
      p.begin({ bounded: true, preserveSurface: true, animation: { root: mesh, clip } })
      const sheet = new Set(all(start[1]).keys())
      for (const f of falloffs) p.lift(0, new Map([...sheet].map(q => [q, f])), .02, .5, sheet)
      p.end(); expect(p.limitedCount).toBeGreaterThan(0)
      return Array.from(mesh.geometry.attributes.position.array)
    }
    expect(run([.4, 1])).toEqual(run([1]))
  })

  it('limits a bent-pose lift whose inverse skinning would tear the standing cloth', () => {
    const { mesh, start } = scene([
      { z: 0, half: .3, y: [0, 1], facing: 1 },
      { z: .005, half: .05, y: [.4, .6], facing: 1 },
    ])
    const center = start[1] + 4
    mesh.geometry.attributes.skinIndex.setXYZW(center, 0, 1, 0, 0)
    mesh.geometry.attributes.skinWeight.setXYZW(center, .5, .5, 0, 0)
    const before = Array.from(mesh.geometry.attributes.position.array)
    const p = new WeightPainter([mesh]); p.mirror = false
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 2.8)
    const clip = new THREE.AnimationClip('Bend', 1, [new THREE.QuaternionKeyframeTrack('Head.quaternion', [0, 1], [0, 0, 0, 1, ...turn.toArray()])])
    const mixer = new THREE.AnimationMixer(mesh); const action = mixer.clipAction(clip)
    action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play(); mixer.setTime(1); mesh.updateMatrixWorld(true)
    const sheet = all(start[1])
    p.begin({ bounded: true, preserveSurface: true, animation: { root: mesh, clip } })
    p.lift(0, new Map([...sheet, ...all(start[0])]), .02, .5, new Set(sheet.keys()))
    expect(p.limitedCount).toBeGreaterThan(0)
    // The standing shape must retain its surface, rather than amplifying a small posed lift into a long spike.
    const pos = mesh.geometry.attributes.position
    for (let i = 0; i < mesh.geometry.index!.count; i += 3) {
      const vs = [0, 1, 2].map(k => mesh.geometry.index!.getX(i + k))
      if (!vs.some(v => v >= start[1])) continue
      for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
        const was = new THREE.Vector3().fromArray(before, vs[a] * 3).distanceTo(new THREE.Vector3().fromArray(before, vs[b] * 3))
        const now = new THREE.Vector3().fromBufferAttribute(pos, vs[a]).distanceTo(new THREE.Vector3().fromBufferAttribute(pos, vs[b]))
        expect(now).toBeLessThanOrEqual(was * 2 + 1e-6)
      }
    }
    p.end(); mixer.stopAllAction()
    expect(p.stepBack()).toBe(true)
    expect(Array.from(pos.array)).toEqual(before)
  })

  it('leaves cloth alone when the limb moved sideways clear of it, even though its infinite surface plane is close', () => {
    const { mesh, start } = scene([
      { z: 0, half: .05, y: [.4, .6], facing: 1 },
      { z: .005, half: .03, y: [.45, .55], facing: 1 },
    ])
    const p = new WeightPainter([mesh]); p.mirror = false
    const pos = mesh.geometry.attributes.position
    for (let i = 0; i < 9; i++) { pos.setX(i, pos.getX(i) + .2); pos.setZ(i, .03) }
    const cloth = all(start[1]); p.begin({ bounded: true })
    expect(p.lift(0, new Map([...cloth, ...all(start[0])]), .02, .5, new Set(cloth.keys()))).toBe(0)
    expect(p.shapeEdits()).toEqual([])
    expect(z(mesh, start[1] + 4)).toBeCloseTo(.005, 6)
  })

  it('does not inflate a bounded stroke when the same point receives repeated dabs', () => {
    const { mesh, start } = scene([
      { z: 0, half: .3, y: [0, 1], facing: 1 },
      { z: .005, half: .05, y: [.4, .6], facing: 1 },
    ])
    const p = new WeightPainter([mesh]); p.mirror = false
    const sheet = all(start[1]); const column = new Map([...sheet, ...all(start[0])])
    p.begin({ bounded: true })
    for (let i = 0; i < 40; i++) p.lift(0, column, .02, .5, new Set(sheet.keys()))
    expect(z(mesh, start[1] + 4)).toBeCloseTo(.0125, 5)
    expect(p.stepBack()).toBe(true)
    expect(p.editedCount).toBe(0)
    expect(p.shapeEdits()).toEqual([])
  })

  it('pushes a cape off the body under it to the gap, its lining going with it', () => {
    const { mesh, start } = scene([
      { z: 0, half: 0.3, y: [0, 1], facing: 1 },          // the body
      { z: 0.003, half: 0.05, y: [0.4, 0.6], facing: -1 }, // the lining
      { z: 0.005, half: 0.05, y: [0.4, 0.6], facing: 1 },  // the cape
    ])
    const p = new WeightPainter([mesh]); p.mirror = false
    p.begin()
    for (let i = 0; i < 40; i++) p.lift(0, all(start[2]), 0.02, 0.5)
    for (let i = 0; i < 9; i++) expect(z(mesh, start[2] + i)).toBeCloseTo(0.02, 3)
    // the lining moved out by as much (it stays 2 mm inside the cape)
    for (let i = 0; i < 9; i++) expect(z(mesh, start[2] + i) - z(mesh, start[1] + i)).toBeCloseTo(0.002, 3)
    // the body stays
    expect(z(mesh, start[0] + 4)).toBe(0)
    const edits = p.shapeEdits()
    expect(edits.find(e => e.vertex === start[2] + 4)?.from[2]).toBeCloseTo(0.005)
    expect(edits.find(e => e.vertex === start[2] + 4)?.to[2]).toBeCloseTo(0.02, 3)
    // one undo step puts it all back
    expect(p.stepBack()).toBe(true)
    expect(z(mesh, start[2] + 4)).toBeCloseTo(0.005)
    expect(z(mesh, start[1] + 4)).toBeCloseTo(0.003)
  })

  it('lifts a cape and the coat under it out together, keeping the spacing they began with', () => {
    const { mesh, start } = scene([
      { z: 0, half: 0.3, y: [0, 1], facing: 1 },          // the body
      { z: 0.004, half: 0.08, y: [0.35, 0.65], facing: 1 }, // the coat
      { z: 0.008, half: 0.05, y: [0.4, 0.6], facing: 1 },   // the cape over it
    ])
    const p = new WeightPainter([mesh]); p.mirror = false
    p.begin()
    // the brush's column: the cape and the coat under it (and the body, which has nothing under it)
    const column = new Map([...all(start[2]), ...all(start[1]), ...all(start[0])])
    for (let i = 0; i < 40; i++) p.lift(0, column, 0.02, 0.5)
    // the coat is the gap off the body, and the cape still 4 mm over the coat: out together, not into each other
    expect(z(mesh, start[1] + 4)).toBeCloseTo(0.02, 3)
    expect(z(mesh, start[2] + 4) - z(mesh, start[1] + 4)).toBeCloseTo(0.004, 3)
    // the body stays
    expect(z(mesh, start[0] + 4)).toBe(0)
  })

  it('leaves the skin under a coat alone, though the coat beyond the brush is over it', () => {
    const { mesh, start } = scene([
      { z: 0, half: 0.3, y: [0, 0.9], facing: 1 },          // the legs' skin
      { z: 0.004, half: 0.08, y: [0.35, 0.65], facing: 1 }, // the coat over it
    ])
    const p = new WeightPainter([mesh]); p.mirror = false
    p.begin()
    // brushed on one corner of the coat; the column reaches the skin under the coat, most of the coat is outside it
    const column = new Map([[start[1], 1], ...all(start[0])])
    for (let i = 0; i < 10; i++) p.lift(0, column, 0.02, 0.5, new Set([start[1]]))
    for (let i = 0; i < 9; i++) expect(z(mesh, start[0] + i)).toBe(0)
    expect(z(mesh, start[1])).toBeGreaterThan(0.004)
  })

  it('tells skin from cloth at rest: legs posed out over the coat are not lifted, the coat goes out past them', () => {
    const { mesh, start } = scene([
      { z: 0, half: 0.3, y: [0, 0.9], facing: 1 },          // the legs' skin
      { z: 0.004, half: 0.08, y: [0.35, 0.65], facing: 1 }, // the coat over it, at rest
    ])
    const p = new WeightPainter([mesh]); p.mirror = false
    // the squat: the legs come out over the coat (the posed skin moved out past it; the rest shape is as it was)
    const pos = mesh.geometry.attributes.position
    for (let i = 0; i < 9; i++) pos.setZ(start[0] + i, 0.008)
    p.begin()
    const coat = all(start[1])
    for (let i = 0; i < 20; i++) p.lift(0, new Map([...coat, ...all(start[0])]), 0.01, 0.5, new Set(coat.keys()))
    for (let i = 0; i < 9; i++) expect(z(mesh, start[0] + i)).toBeCloseTo(0.008, 6)
    expect(z(mesh, start[1] + 4)).toBeGreaterThan(0.008)
  })

  it('lifts a cape the body already shows through out past it', () => {
    const { mesh, start } = scene([
      { z: 0.008, half: 0.3, y: [0, 1], facing: 1 },      // the body, through the cape
      { z: 0.005, half: 0.05, y: [0.4, 0.6], facing: 1 },  // the cape
    ])
    const p = new WeightPainter([mesh]); p.mirror = false
    p.begin()
    p.lift(0, all(start[1]), 0.01, 2)
    expect(z(mesh, start[1] + 4)).toBeCloseTo(0.018, 3)
    for (let i = 0; i < 20; i++) p.lift(0, all(start[1]), 0.01, 0.5)
    expect(z(mesh, start[1] + 4)).toBeCloseTo(0.018, 3)
  })

  it('leaves skin already clear of what is under it', () => {
    const { mesh, start } = scene([
      { z: 0, half: 0.3, y: [0, 1], facing: 1 },
      { z: 0.05, half: 0.05, y: [0.4, 0.6], facing: 1 },
    ])
    const p = new WeightPainter([mesh]); p.mirror = false
    p.begin()
    expect(p.lift(0, all(start[1]), 0.02, 1)).toBe(0)
    expect(p.shapeEdits()).toEqual([])
  })

  it('restores the spacing of compressed layers even when the inner layer moved outwards', () => {
    const { mesh, start } = scene([
      { z: 0, half: 0.3, y: [0, 1], facing: 1 },
      { z: 0.004, half: 0.08, y: [0.35, 0.65], facing: 1 },
      { z: 0.008, half: 0.05, y: [0.4, 0.6], facing: 1 },
    ])
    const p = new WeightPainter([mesh]); p.mirror = false
    const pos = mesh.geometry.attributes.position
    // The pose pushes the coat out and draws the cape in, almost closing their original 4 mm gap.
    for (let i = 0; i < 9; i++) { pos.setZ(start[1] + i, 0.006); pos.setZ(start[2] + i, 0.007) }
    const coat = all(start[1]); const cape = all(start[2])
    p.begin()
    for (let i = 0; i < 40; i++) p.lift(0, new Map([...coat, ...cape, ...all(start[0])]), 0.02, 0.5, new Set(cape.keys()))
    expect(z(mesh, start[1] + 4)).toBeCloseTo(0.02, 4)
    expect(z(mesh, start[2] + 4) - z(mesh, start[1] + 4)).toBeCloseTo(0.004, 4)
    expect(z(mesh, start[0] + 4)).toBe(0)
  })

  it('does not smooth a lift into the body at a cloth attachment', () => {
    const { mesh, start } = scene([
      { z: 0, half: 0.05, y: [0.4, 0.6], facing: 1 },
      { z: 0.005, half: 0.05, y: [0.4, 0.6], facing: 1 },
    ])
    // Generated clothing and body can belong to one connected mesh.
    mesh.geometry.setIndex([...mesh.geometry.index!.array, 0, 9, 10])
    const p = new WeightPainter([mesh]); p.mirror = false
    const cape = all(start[1]); p.begin()
    p.lift(0, new Map([...cape, ...all(start[0])]), 0.02, 1, new Set(cape.keys()))
    for (let i = 0; i < 9; i++) expect(z(mesh, start[0] + i)).toBe(0)
  })

  it('keeps clearance local instead of inflating an already clear patch elsewhere in the brush', () => {
    const { mesh, start } = scene([
      { z: 0, half: 0.3, y: [0, 1], facing: 1 },
      { z: 0.005, half: 0.05, y: [0.2, 0.4], facing: 1 },
      { z: 0.03, half: 0.05, y: [0.6, 0.8], facing: 1 },
    ])
    const p = new WeightPainter([mesh]); p.mirror = false
    const sheet = new Map([...all(start[1]), ...all(start[2])]); p.begin()
    for (let i = 0; i < 20; i++) p.lift(0, new Map([...sheet, ...all(start[0])]), 0.02, 0.5, new Set(sheet.keys()))
    expect(z(mesh, start[1] + 4)).toBeCloseTo(0.02, 4)
    for (let i = 0; i < 9; i++) expect(z(mesh, start[2] + i)).toBeCloseTo(0.03, 6)
    // Repeated dabs keep the reference spacing and converge to the same result.
    const before = Array.from(mesh.geometry.attributes.position.array)
    for (let i = 0; i < 20; i++) p.lift(0, new Map([...sheet, ...all(start[0])]), 0.02, 0.5, new Set(sheet.keys()))
    before.forEach((v, i) => expect(mesh.geometry.attributes.position.array[i]).toBeCloseTo(v, 6))
  })

  it('measures the gap along the posed body surface and preserves thickness through a rotated rig', () => {
    const { mesh, start } = scene([
      { z: 0, half: 0.3, y: [0, 1], facing: 1 },
      { z: 0.003, half: 0.05, y: [0.4, 0.6], facing: -1 },
      { z: 0.005, half: 0.05, y: [0.4, 0.6], facing: 1 },
    ])
    const p = new WeightPainter([mesh]); p.mirror = false
    mesh.skeleton.bones[0].rotation.set(.9, .35, -.2)
    mesh.updateMatrixWorld(true); mesh.skeleton.update()
    const sheet = all(start[2]); const column = new Map([...sheet, ...all(start[1]), ...all(start[0])])
    p.begin()
    for (let i = 0; i < 30; i++) p.lift(0, column, .02, .5, new Set(sheet.keys()))
    expect(z(mesh, start[1] + 4)).toBeCloseTo(.02, 4)
    expect(z(mesh, start[2] + 4)).toBeCloseTo(.022, 4)
    for (let i = 0; i < 9; i++) expect(z(mesh, start[0] + i)).toBe(0)
    expect(p.stepBack()).toBe(true)
    expect(z(mesh, start[1] + 4)).toBeCloseTo(.003, 6)
    expect(z(mesh, start[2] + 4)).toBeCloseTo(.005, 6)
  })

  it('uses world units for the requested gap on a scaled mesh', () => {
    const { mesh, start } = scene([
      { z: 0, half: 0.3, y: [0, 1], facing: 1 },
      { z: 0.005, half: 0.05, y: [0.4, 0.6], facing: 1 },
    ])
    const p = new WeightPainter([mesh]); p.mirror = false
    mesh.scale.setScalar(2); mesh.updateMatrixWorld(true); mesh.skeleton.update()
    const sheet = all(start[1]); p.begin()
    for (let i = 0; i < 30; i++) p.lift(0, new Map([...sheet, ...all(start[0])]), .02, .5, new Set(sheet.keys()))
    const cloth = mesh.getVertexPosition(start[1] + 4, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld)
    const body = mesh.getVertexPosition(start[0] + 4, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld)
    expect(cloth.z - body.z).toBeCloseTo(.02, 4)
  })
})
