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
})
