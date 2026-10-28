import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { WeightPainter } from './weightpaint.ts'

// A strip across the body: a left point, a middle one, a right one (and a second row, so it has triangles), skinned to
// Hips, LeftArm and RightArm.
function strip (): THREE.SkinnedMesh {
  const xs = [-1, 0, 1]
  const position: number[] = []
  for (const y of [0, 0.5]) for (const x of xs) position.push(x, y, 0)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3))
  g.setIndex([0, 1, 3, 1, 4, 3, 1, 2, 4, 2, 5, 4])
  // every point all Hips to begin with
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(Array.from({ length: 6 }, () => [0, 0, 0, 0]).flat(), 4))
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: 6 }, () => [1, 0, 0, 0]).flat(), 4))
  const hips = new THREE.Bone(); hips.name = 'Hips'
  const left = new THREE.Bone(); left.name = 'LeftArm'; left.position.set(1, 0, 0); hips.add(left)
  const right = new THREE.Bone(); right.name = 'RightArm'; right.position.set(-1, 0, 0); hips.add(right)
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial())
  mesh.add(hips)
  mesh.updateMatrixWorld(true)
  mesh.bind(new THREE.Skeleton([hips, left, right]))
  return mesh
}

const weight = (p: WeightPainter, v: number, bone: number): number => p.weights(0, v).get(bone) ?? 0

describe('mirrored weight painting', () => {
  it('a stroke on one side lands on the other, the bone swapped', () => {
    const p = new WeightPainter([strip()])
    p.begin()
    p.add(0, new Map([[2, 1]]), 1, 0.5)   // the body's left point (+x) takes LeftArm
    expect(weight(p, 2, 1)).toBeCloseTo(0.5)
    expect(weight(p, 0, 2)).toBeCloseTo(0.5)   // its twin (-x) takes RightArm
    expect(weight(p, 0, 1)).toBe(0)
  })

  it('a middle point is evened between its sides', () => {
    const p = new WeightPainter([strip()])
    p.begin()
    p.add(0, new Map([[1, 1]]), 1, 0.5)
    expect(weight(p, 1, 1)).toBeCloseTo(weight(p, 1, 2))
  })

  it('without mirror only the brushed side changes; copying a side makes them match', () => {
    const p = new WeightPainter([strip()])
    p.mirror = false
    p.begin()
    p.add(0, new Map([[2, 1]]), 1, 0.5)
    expect(weight(p, 0, 2)).toBe(0)
    p.copySide(1)
    expect(weight(p, 0, 2)).toBeCloseTo(0.5)
    expect(p.stepBack()).toBe(true)
    expect(weight(p, 0, 2)).toBe(0)
  })
})

describe('mirrorName', () => {
  it('swaps a person\'s and a creature\'s side names, and leaves a middle bone', async () => {
    const { mirrorName } = await import('./weightpaint.ts')
    expect(mirrorName('front_leg_upper_l')).toBe('front_leg_upper_r')
    expect(mirrorName('LeftHand')).toBe('RightHand')
    expect(mirrorName('ear.L')).toBe('ear.R')
    expect(mirrorName('l_eye')).toBe('r_eye')
    expect(mirrorName('spine_01')).toBe('spine_01')
    expect(mirrorName('tail_lower')).toBe('tail_lower')
  })
})

describe('surface weight brushes', () => {
  it('removes the requested share from a rigid weight using the other neighbouring bones', () => {
    const painter = new WeightPainter([strip()]); painter.mirror = false
    painter.begin()
    painter.add(0, new Map([[1, 1], [3, 1]]), 1, .2)
    painter.remove(0, new Map([[0, 1]]), 0, .5)
    expect(weight(painter, 0, 0)).toBeCloseTo(.5)
    expect(weight(painter, 0, 1)).toBeCloseTo(.5)
    painter.stepBack()
    expect(weight(painter, 0, 0)).toBe(1)
  })

  it('stays on the picked surface when another sheet is close behind it', () => {
    const mesh = strip()
    const g = mesh.geometry
    const positions = Array.from(g.attributes.position.array)
    g.setAttribute('position', new THREE.Float32BufferAttribute([...positions, ...positions.map((x, i) => i % 3 === 2 ? .01 : x)], 3))
    g.setIndex([...Array.from(g.index!.array), ...Array.from(g.index!.array).map(i => i + 6)])
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(48).fill(0), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: 12 }, () => [1, 0, 0, 0]).flat(), 4))
    const painter = new WeightPainter([mesh])
    const brush = painter.under(0, new THREE.Vector3(.1, .1, 0), 2, [1, 2, 4])
    expect(brush.size).toBeGreaterThan(2)
    expect([...brush.keys()].every(p => p < 6)).toBe(true)
  })

  it('does not average an entirely marked island with no good boundary to heal from', () => {
    const mesh = strip()
    const painter = new WeightPainter([mesh]); painter.mirror = false
    painter.begin(); painter.add(0, new Map([[2, 1]]), 1, 1)
    const before = Array.from(mesh.geometry.attributes.skinWeight.array)
    painter.mark(0, new Map(Array.from({ length: 6 }, (_, i) => [i, 1])))
    expect(painter.heal()).toBe(0)
    expect(Array.from(mesh.geometry.attributes.skinWeight.array)).toEqual(before)
  })
})

// A coat sheet (Hips) over a trouser sheet (LeftUpLeg) in front of the left thigh, and a hem below the trousers with
// nothing under it. Both sheets face out (+z); the leg's bones run down x = 0.1.
function coat (): THREE.SkinnedMesh {
  const quad = (x0: number, x1: number, y0: number, y1: number, z: number): number[] => [x0, y0, z, x1, y0, z, x0, y1, z, x1, y1, z]
  const position = [...quad(0.05, 0.15, 0.2, 0.8, 0.1), ...quad(0.05, 0.15, 0.2, 0.8, 0.15), ...quad(0.05, 0.15, 0.12, 0.18, 0.15)]
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3))
  g.setIndex([0, 1, 2, 1, 3, 2, 4, 5, 6, 5, 7, 6, 8, 9, 10, 9, 11, 10])
  const bonesOf = [1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(bonesOf.flatMap(b => [b, 0, 0, 0]), 4))
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(bonesOf.flatMap(() => [1, 0, 0, 0]), 4))
  const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0)
  const thigh = new THREE.Bone(); thigh.name = 'LeftUpLeg'; thigh.position.set(0.1, -0.1, 0); hips.add(thigh)
  const shin = new THREE.Bone(); shin.name = 'LeftLeg'; shin.position.set(0, -0.5, 0); thigh.add(shin)
  const foot = new THREE.Bone(); foot.name = 'LeftFoot'; foot.position.set(0, -0.4, 0); shin.add(foot)
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial())
  mesh.add(hips)
  mesh.updateMatrixWorld(true)
  mesh.bind(new THREE.Skeleton([hips, thigh, shin, foot]))
  return mesh
}

describe('the Follow brush', () => {
  it('gives a coat the weights of the skin it covers, and a hem with nothing under it the nearest bone', () => {
    const p = new WeightPainter([coat()]); p.mirror = false
    p.begin()
    p.followUnder(0, new Map([[4, 1], [6, 1], [8, 1], [9, 1]]), 1)
    // over the trousers: the thigh's, as the trousers have it
    expect(weight(p, 4, 1)).toBeCloseTo(1)
    expect(weight(p, 6, 1)).toBeCloseTo(1)
    // the hem, nothing under it: the shin, the bone it hangs by
    expect(weight(p, 8, 2)).toBeGreaterThan(0.5)
    expect(weight(p, 8, 0)).toBe(0)
    // the trousers themselves are untouched, and one undo puts the coat back
    expect(weight(p, 0, 1)).toBe(1)
    expect(p.stepBack()).toBe(true)
    expect(weight(p, 4, 0)).toBe(1)
  })

  it('blends by strength and never looks through the far side of the cloth it is on', () => {
    const p = new WeightPainter([coat()]); p.mirror = false
    p.begin()
    p.followUnder(0, new Map([[5, 1]]), 0.5)
    expect(weight(p, 5, 1)).toBeCloseTo(0.5)
    expect(weight(p, 5, 0)).toBeCloseTo(0.5)
  })
})

describe('the Bone brush', () => {
  it('holds a stroke to the bone leading where it began, and the next stroke picks its own', () => {
    const p = new WeightPainter([coat()]); p.mirror = false
    p.begin()
    p.rigid(0, new Map([[0, 1]]), 1)            // begun on the trousers: the thigh
    p.rigid(0, new Map([[4, 1], [8, 1]]), 1)    // dragged onto the coat and hem: they go to the thigh too
    expect(weight(p, 4, 1)).toBeCloseTo(1)
    expect(weight(p, 8, 1)).toBeCloseTo(1)
    p.begin()
    p.rigid(0, new Map([[5, 1]]), 0.5)          // a new stroke on the coat holds to the hips: nothing to drop
    expect(weight(p, 5, 0)).toBeCloseTo(1)
    expect(p.stepBack()).toBe(true)
    expect(p.stepBack()).toBe(true)
    expect(weight(p, 4, 0)).toBe(1)
  })
})

describe('Follow on a garment', () => {
  it('takes the weights of the body under it, from the body mesh', () => {
    // the coat sheet as its own mesh over the trousers, both bound to the same skeleton
    const body = coat()
    const g = body.geometry
    const sheet = new THREE.BufferGeometry()
    const outer = Array.from(g.attributes.position.array as Float32Array).slice(12, 24)
    sheet.setAttribute('position', new THREE.Float32BufferAttribute(outer, 3))
    sheet.setIndex([0, 1, 2, 1, 3, 2])
    sheet.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(Array.from({ length: 4 }, () => [0, 0, 0, 0]).flat(), 4))
    sheet.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: 4 }, () => [1, 0, 0, 0]).flat(), 4))
    const garment = new THREE.SkinnedMesh(sheet, new THREE.MeshBasicMaterial())
    garment.bind(body.skeleton, body.bindMatrix)
    const p = new WeightPainter([garment, body]); p.mirror = false
    p.begin()
    p.followUnder(0, new Map([[0, 1], [2, 1]]), 1)
    // the trousers under it are the thigh's (bone 1)
    expect(p.weights(0, 0).get(1) ?? 0).toBeCloseTo(1)
    expect(p.weights(0, 2).get(1) ?? 0).toBeCloseTo(1)
    // the body is untouched
    expect(p.weights(1, 0).get(1) ?? 0).toBe(1)
  })
})
