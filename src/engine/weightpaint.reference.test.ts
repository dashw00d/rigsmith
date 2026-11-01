import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { type ShapeEdit, WeightPainter } from './weightpaint.ts'

// A body, a coat, and a cape. All positions remain in one mesh's bind frame.
function layers (positions?: ArrayLike<number>): THREE.SkinnedMesh {
  const rest: number[] = []; const index: number[] = []
  for (const [z, half, bottom, top] of [[0, .3, 0, 1], [.004, .08, .35, .65], [.008, .05, .4, .6]]) {
    const base = rest.length / 3
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) rest.push(-half + half * x, bottom + (top - bottom) * y / 2, z)
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
      const a = base + y * 3 + x; const b = a + 1; const c = a + 3; const d = c + 1
      index.push(a, b, d, a, d, c)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(Array.from(positions ?? rest), 3))
  geometry.setIndex(index)
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(rest.length / 3 * 4).fill(0), 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: rest.length / 3 }, () => [1, 0, 0, 0]).flat(), 4))
  const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.z = -.5
  const head = new THREE.Bone(); head.name = 'Head'; head.position.y = 1; hips.add(head)
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial())
  mesh.add(hips); mesh.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton([hips, head]))
  return mesh
}

const outer = new Map(Array.from({ length: 9 }, (_, i) => [18 + i, 1]))
const column = new Map(Array.from({ length: 27 }, (_, i) => [i, 1]))
const positions = (mesh: THREE.SkinnedMesh): number[] => Array.from(mesh.geometry.attributes.position.array)

function lift (painter: WeightPainter, points = column, gap = .02): number {
  painter.begin({ bounded: true, preserveSurface: true })
  const moved = painter.lift(0, points, gap, 1, new Set(points.keys()))
  painter.end()
  return moved
}

function savedLift (): { mesh: THREE.SkinnedMesh, painter: WeightPainter, edits: ShapeEdit[] } {
  const mesh = layers(); const painter = new WeightPainter([mesh]); painter.mirror = false
  expect(lift(painter, outer)).toBe(9)
  expect(mesh.geometry.attributes.position.getZ(22)).toBeCloseTo(.024, 6)
  const edits = painter.shapeEdits()
  expect(edits).toHaveLength(9)
  return { mesh, painter, edits }
}

describe('saved Lift reference positions', () => {
  it('keeps the same layer spacing after reopening and continuing a bounded, guarded lift', () => {
    const { mesh, painter, edits } = savedLift()
    const reopened = layers(positions(mesh))
    const restored = new WeightPainter([reopened], undefined, undefined, edits); restored.mirror = false
    // Reference restoration must not put the displayed shape, or the stroke's starting shape, back at its source.
    expect(positions(reopened)).toEqual(positions(mesh))
    expect(Array.from(restored.parts[0].rest)).toEqual(positions(mesh))
    painter.saved()
    expect(lift(painter)).toBe(9)
    expect(lift(restored)).toBe(9)
    expect(positions(reopened)).toEqual(positions(mesh))
    expect(reopened.geometry.attributes.position.getZ(13)).toBeCloseTo(.020, 6)
    expect(reopened.geometry.attributes.position.getZ(22)).toBeCloseTo(.024, 6)
    // Without the sidecar, the saved 20 mm coat/cape gap becomes a new spacing baseline and inflates to 40 mm.
    const unreferencedMesh = layers(edits.reduce((at, edit) => { at.set(edit.to, edit.vertex * 3); return at },
      new Float32Array(positions(layers()))))
    const unreferenced = new WeightPainter([unreferencedMesh]); unreferenced.mirror = false
    lift(unreferenced)
    expect(unreferencedMesh.geometry.attributes.position.getZ(22)).toBeCloseTo(.040, 6)
  })

  it('reports the first source position after reopening and saving more than once', () => {
    const { mesh, edits } = savedLift()
    const reopened = layers(positions(mesh))
    const painter = new WeightPainter([reopened], undefined, undefined, edits); painter.mirror = false
    expect(lift(painter, outer, .03)).toBeGreaterThan(0)
    let center = painter.shapeEdits().find(edit => edit.vertex === 22)!
    expect(center.from[2]).toBeCloseTo(.008, 6)
    expect(center.to[2]).toBeCloseTo(.034, 6)
    painter.saved()
    expect(lift(painter, outer, .04)).toBeGreaterThan(0)
    center = painter.shapeEdits().find(edit => edit.vertex === 22)!
    expect(center.from[2]).toBeCloseTo(.008, 6)
    expect(center.to[2]).toBeCloseTo(.044, 6)
  })

  it.each([
    ['stale destination', (edit: ShapeEdit) => ({ ...edit, to: [edit.to[0], edit.to[1], edit.to[2] + .001] })],
    ['nonfinite source', (edit: ShapeEdit) => ({ ...edit, from: [edit.from[0], edit.from[1], NaN] })],
    ['nonfinite destination', (edit: ShapeEdit) => ({ ...edit, to: [edit.to[0], edit.to[1], Infinity] })],
    ['negative mesh', (edit: ShapeEdit) => ({ ...edit, mesh: -1 })],
    ['missing mesh', (edit: ShapeEdit) => ({ ...edit, mesh: 1 })],
    ['fractional mesh', (edit: ShapeEdit) => ({ ...edit, mesh: .5 })],
    ['negative vertex', (edit: ShapeEdit) => ({ ...edit, vertex: -1 })],
    ['missing vertex', (edit: ShapeEdit) => ({ ...edit, vertex: 27 })],
    ['fractional vertex', (edit: ShapeEdit) => ({ ...edit, vertex: edit.vertex + .5 })],
  ])('ignores a %s reference without changing the loaded shape', (_name, invalid) => {
    const { mesh, edits } = savedLift()
    const reopened = layers(positions(mesh)); const before = positions(reopened)
    const painter = new WeightPainter([reopened], undefined, undefined, edits.map(edit => invalid(edit) as ShapeEdit))
    painter.mirror = false
    expect(positions(reopened)).toEqual(before)
    expect(painter.shapeEdits()).toEqual([])
    expect(() => lift(painter)).not.toThrow()
    expect(reopened.geometry.attributes.position.getZ(22)).toBeCloseTo(.040, 6)
    expect(positions(reopened).every(Number.isFinite)).toBe(true)
  })

  it('finds original mirror twins after a saved lift moved only one side', () => {
    const mesh = layers(); const pos = mesh.geometry.attributes.position
    const edits: ShapeEdit[] = [20, 23, 26].map(vertex => {
      const from: [number, number, number] = [pos.getX(vertex), pos.getY(vertex), pos.getZ(vertex)]
      pos.setZ(vertex, .024)
      return { mesh: 0, vertex, from, to: [pos.getX(vertex), pos.getY(vertex), pos.getZ(vertex)] }
    })
    const before = positions(mesh)
    const unreferenced = new WeightPainter([layers(before)])
    expect(unreferenced.parts[0].twin.has(18)).toBe(false)
    const painter = new WeightPainter([mesh], undefined, undefined, edits)
    expect(painter.parts[0].twin.get(18)).toBe(20)
    expect(painter.parts[0].twin.get(20)).toBe(18)
    expect(positions(mesh)).toEqual(before)
  })
})
