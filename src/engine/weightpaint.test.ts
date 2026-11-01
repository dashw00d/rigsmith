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

describe('bounded brush strokes', () => {
  it('undo restores raw bone slots and tiny weights without sorting or truncating the original skin', () => {
    const mesh = strip(); const si = mesh.geometry.attributes.skinIndex; const sw = mesh.geometry.attributes.skinWeight
    si.setXYZW(2, 1, 0, 1, 2); sw.setXYZW(2, .4, .00003, .59994, .00003)
    const original = { index: Array.from(si.array), weight: Array.from(sw.array) }
    const p = new WeightPainter([mesh]); p.mirror = false
    p.begin({ bounded: true }); p.add(0, new Map([[2, 1]]), 0, .5); p.end()
    expect(p.stepBack()).toBe(true)
    expect(Array.from(si.array)).toEqual(original.index)
    expect(Array.from(sw.array)).toEqual(original.weight)
  })

  it('omits empty gestures from Undo and restores marked areas', () => {
    const p = new WeightPainter([strip()]); p.mirror = false
    p.begin({ bounded: true }); p.add(0, new Map([[2, 1]]), 1, .5); p.end()
    p.begin({ bounded: true }); p.end()
    p.begin({ bounded: true }); p.mark(0, new Map([[1, .8]])); p.end()
    expect(p.area[0].get(1)).toBe(.8)
    expect(p.stepBack()).toBe(true)
    expect(p.area[0].size).toBe(0)
    expect(weight(p, 2, 1)).toBeCloseTo(.5)
    expect(p.stepBack()).toBe(true)
    expect(weight(p, 2, 1)).toBe(0)
    expect(p.stepBack()).toBe(false)
  })

  it('applies Strength once through overlapping dabs and undo restores the exact dirty state', () => {
    const p = new WeightPainter([strip()]); p.mirror = false
    p.begin({ bounded: true })
    for (let i = 0; i < 100; i++) p.add(0, new Map([[2, 1]]), 1, .4)
    expect(weight(p, 2, 1)).toBeCloseTo(.4)
    expect(p.editedCount).toBe(1)
    p.begin({ bounded: true }); p.add(0, new Map([[0, 1]]), 2, .6)
    expect(p.editedCount).toBe(2)
    expect(p.stepBack()).toBe(true)
    expect(p.editedCount).toBe(1)
    expect(weight(p, 2, 1)).toBeCloseTo(.4)
    expect(weight(p, 0, 2)).toBe(0)
    expect(p.stepBack()).toBe(true)
    expect(p.editedCount).toBe(0)
    expect(p.edits()).toEqual([])
  })

  it('uses the strongest falloff reached rather than accumulating the brush edge', () => {
    const p = new WeightPainter([strip()]); p.mirror = false
    p.begin({ bounded: true })
    for (const f of [.1, .2, .6, .9, 1, .5, .1]) p.add(0, new Map([[2, f]]), 1, .5)
    expect(weight(p, 2, 1)).toBeCloseTo(.5)
    p.begin({ bounded: true }); p.add(0, new Map([[2, 1]]), 1, .5)
    expect(weight(p, 2, 1)).toBeCloseTo(.75) // a new stroke intentionally builds on the last
  })

  it('does not overwrite a strong mirrored dab with a weaker one on the other side', () => {
    const p = new WeightPainter([strip()])
    p.begin({ bounded: true })
    p.add(0, new Map([[2, 1]]), 1, .8)
    p.add(0, new Map([[0, .2]]), 2, .8)
    expect(weight(p, 2, 1)).toBeCloseTo(.8)
    expect(weight(p, 0, 2)).toBeCloseTo(.8)
  })
})

describe('posed brush BVH', () => {
  it('refits after skinning without changing saved vertex or triangle indices', () => {
    const mesh = strip(); const before = Array.from(mesh.geometry.index!.array)
    const p = new WeightPainter([mesh])
    const ray = new THREE.Ray(new THREE.Vector3(.25, .1, 2), new THREE.Vector3(0, 0, -1))
    const a = p.raycast(ray)
    expect(a.length).toBeGreaterThan(0)
    expect(a[0].point.z).toBeCloseTo(0)
    mesh.skeleton.bones[0].position.z = .5; mesh.updateMatrixWorld(true)
    const b = p.raycast(ray)
    expect(b[0].point.z).toBeCloseTo(.5)
    expect(b[0].face).toEqual(a[0].face)
    expect(Array.from(mesh.geometry.index!.array)).toEqual(before)
  })
})

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

describe('mirror pairs', () => {
  it('a creature\'s strokes land on its own pair of the bone', async () => {
    const { swapSide } = await import('./templates.ts')
    const mesh = strip()
    for (const [i, bone] of mesh.skeleton.bones.entries()) bone.name = ['hips', 'arm_l', 'arm_r'][i]
    const p = new WeightPainter([mesh], swapSide)
    p.begin()
    p.add(0, new Map([[2, 1]]), 1, 0.5)
    expect(weight(p, 0, 2)).toBeCloseTo(0.5)
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
    // Even when a tiny brush reaches no vertices, its triangle remains a valid stroke anchor.
    const anchor = new Set([1, 2, 4])
    expect(painter.continuesStroke(0, new THREE.Vector3(.1, .1, 0), [1, 2, 4], anchor, .001)).toBe(true)
    expect(painter.continuesStroke(0, new THREE.Vector3(.1, .1, .01), [7, 8, 10], anchor, .001)).toBe(false)
  })

  it('tells the sheets of a mesh apart, so a stroke can keep to the one it began on', () => {
    const mesh = strip()
    const g = mesh.geometry
    const positions = Array.from(g.attributes.position.array)
    g.setAttribute('position', new THREE.Float32BufferAttribute([...positions, ...positions.map((x, i) => i % 3 === 2 ? .01 : x)], 3))
    g.setIndex([...Array.from(g.index!.array), ...Array.from(g.index!.array).map(i => i + 6)])
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(48).fill(0), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: 12 }, () => [1, 0, 0, 0]).flat(), 4))
    const painter = new WeightPainter([mesh])
    const front = painter.surface(0, 0)
    expect([1, 2, 3, 4, 5].map(v => painter.surface(0, v))).toEqual([front, front, front, front, front])
    const back = painter.surface(0, 6)
    expect(back).not.toBe(front)
    expect([7, 8, 9, 10, 11].map(v => painter.surface(0, v))).toEqual([back, back, back, back, back])
  })

  it('looks past a nearby fold even when it joins the painted sheet far away', () => {
    const mesh = strip(); const g = mesh.geometry
    const front = Array.from(g.attributes.position.array)
    const back = front.map((x, i) => i % 3 === 2 ? .01 : x)
    // The folds join at the far end; a component label alone calls them one surface.
    g.setAttribute('position', new THREE.Float32BufferAttribute([...front, ...back], 3))
    g.setIndex([...g.index!.array, ...Array.from(g.index!.array).map(v => v + 6), 5, 11, 8])
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(48).fill(0), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: 12 }, () => [1, 0, 0, 0]).flat(), 4))
    const p = new WeightPainter([mesh])
    expect(p.surface(0, 0)).toBe(p.surface(0, 6))
    expect(p.continuesStroke(0, new THREE.Vector3(-.8, .1, .01), [6, 7, 9], new Set([0, 1, 3]), .05)).toBe(false)
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
  it('limits a rest-pose stroke that would flip the cloth later in the test clip, without seeking the live rig', () => {
    const mesh = coat(); const p = new WeightPainter([mesh]); p.mirror = false
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI * .7)
    const clip = new THREE.AnimationClip('Leg bend', 1, [new THREE.QuaternionKeyframeTrack('LeftUpLeg.quaternion', [0, 1], [0, 0, 0, 1, ...turn.toArray()])])
    const bones = mesh.skeleton.bones.map(b => b.quaternion.toArray())
    p.begin({ bounded: true, preserveSurface: true, animation: { root: mesh, clip } })
    p.followUnder(0, new Map([[4, 1]]), 1)
    p.end()
    expect(p.limitedCount).toBeGreaterThan(0)
    expect(mesh.skeleton.bones.map(b => b.quaternion.toArray())).toEqual(bones)
    const mixer = new THREE.AnimationMixer(mesh); const action = mixer.clipAction(clip)
    action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play()
    for (const time of [0, .1, .2, .3, .5, .8, 1]) {
      mixer.setTime(time); mesh.updateMatrixWorld(true)
      const [a, b, c] = [4, 5, 6].map(v => mesh.getVertexPosition(v, new THREE.Vector3()))
      expect(b.sub(a).cross(c.sub(a)).z).toBeGreaterThan(.015 - 1e-6)
    }
    mixer.stopAllAction()
    expect(p.stepBack()).toBe(true)
    expect(weight(p, 4, 0)).toBe(1)
  })

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

describe('Follow through layers', () => {
  // a cape sheet (Hips) a little out from the coat sheet, both over the trousers (LeftUpLeg)
  function layered (): { mesh: THREE.SkinnedMesh, cape: number[] } {
    const mesh = coat()
    const g = mesh.geometry
    const pos = Array.from(g.attributes.position.array as Float32Array)
    const n = pos.length / 3
    const sheet = pos.slice(12, 24).map((x, i) => i % 3 === 2 ? x + 0.04 : x)
    g.setAttribute('position', new THREE.Float32BufferAttribute([...pos, ...sheet], 3))
    g.setIndex([...Array.from(g.index!.array), n, n + 1, n + 2, n + 1, n + 3, n + 2])
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([...Array.from(g.attributes.skinIndex.array), ...new Array(16).fill(0)], 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute([...Array.from(g.attributes.skinWeight.array), ...Array.from({ length: 4 }, () => [1, 0, 0, 0]).flat()], 4))
    return { mesh, cape: [n, n + 1, n + 2, n + 3] }
  }

  it('does not rebind a hidden layer at zero Strength', () => {
    const { mesh, cape } = layered()
    const p = new WeightPainter([mesh]); p.mirror = false
    p.begin(); p.add(0, new Map([4, 5, 6, 7].map(v => [v, 1])), 2, 1); p.saved()
    const before = Array.from(mesh.geometry.attributes.skinWeight.array)
    const indices = Array.from(mesh.geometry.attributes.skinIndex.array)
    const sheet = new Map(cape.map(v => [v, 1]))
    p.begin({ bounded: true })
    p.followUnder(0, p.column(0, new THREE.Vector3(.1, .8, .19), .03, sheet), 0, new Set(sheet.keys()))
    expect(Array.from(mesh.geometry.attributes.skinWeight.array)).toEqual(before)
    expect(Array.from(mesh.geometry.attributes.skinIndex.array)).toEqual(indices)
    expect(p.editedCount).toBe(0)
  })

  it('respects the brush edge on every layer instead of copying an outer layer wholesale', () => {
    const { mesh, cape } = layered()
    const p = new WeightPainter([mesh]); p.mirror = false
    p.begin(); p.add(0, new Map([4, 5, 6, 7].map(v => [v, 1])), 2, 1); p.saved()
    const sheet = new Map(cape.map(v => [v, .01]))
    p.begin({ bounded: true })
    p.followUnder(0, p.column(0, new THREE.Vector3(.1, .8, .19), .03, sheet), .2, new Set(sheet.keys()))
    for (const v of [4, 5, 6, 7]) {
      expect(weight(p, v, 2)).toBeCloseTo(.998, 5)
      expect(weight(p, v, 1)).toBeCloseTo(.002, 5)
    }
  })

  it('gives a cape and the coat under it the same skin, and leaves the skin it reaches through alone', () => {
    const { mesh, cape } = layered()
    const p = new WeightPainter([mesh]); p.mirror = false
    p.begin()
    p.followUnder(0, new Map([...cape, 4, 5, 6, 7, 0, 1, 2, 3].map(v => [v, 1])), 1, new Set(cape))
    // the coat takes the trousers' thigh, and the cape what the coat takes: not the coat's old Hips
    expect(weight(p, 4, 1)).toBeCloseTo(1)
    expect(weight(p, cape[0], 1)).toBeCloseTo(1)
    expect(weight(p, cape[2], 1)).toBeCloseTo(1)
    // the trousers reached through keep theirs
    expect(weight(p, 0, 1)).toBe(1)
    expect(weight(p, 2, 1)).toBe(1)
  })

  it('takes the layers in toward the nearest bone, wherever the camera is', () => {
    const { mesh, cape } = layered()
    const p = new WeightPainter([mesh]); p.mirror = false
    // brushed on the cape's top corner over the thigh: the coat and trousers corner behind it, in toward the leg bone;
    // not the cape's other corners or the hem below
    const at = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position as THREE.BufferAttribute, cape[2])
    const column = p.column(0, at, 0.03)
    expect(column.has(p.parts[0].point[cape[2]])).toBe(true)
    expect(column.has(p.parts[0].point[6])).toBe(true)   // the coat
    expect(column.has(p.parts[0].point[2])).toBe(true)   // the trousers
    for (const v of [8, 9, 10, 11, cape[0], cape[1]]) expect(column.has(p.parts[0].point[v])).toBe(false)
  })

  it('keeps reaching the same layers with the same falloff when a pose reverses their depth order', () => {
    const { mesh, cape } = layered()
    const p = new WeightPainter([mesh]); p.mirror = false
    const sheet = new Map(cape.map(v => [v, 0.6]))
    const at = new THREE.Vector3(.1, .8, .19)
    const before = p.column(0, at, .03, sheet)
    const pos = mesh.geometry.attributes.position
    // A leg has come out through both cloth layers; the coat now also protrudes through the cape.
    for (const v of [0, 1, 2, 3]) pos.setZ(v, .24)
    for (const v of [4, 5, 6, 7]) pos.setZ(v, .21)
    const after = p.column(0, at, .03, sheet)
    expect(after).toEqual(before)
    for (const v of [0, 1, 2, 3, 4, 5, 6, 7, ...cape]) expect(after.get(v)).toBeCloseTo(.6)
    for (const v of [8, 9, 10, 11]) expect(after.has(v)).toBe(false)
  })

  it('moves all layers toward the shared target by the requested strength, reaching it together at full strength', () => {
    const { mesh, cape } = layered()
    const p = new WeightPainter([mesh]); p.mirror = false
    p.begin()
    p.add(0, new Map([4, 5, 6, 7].map(v => [v, 1])), 2, 1) // the inner coat starts on a different bone
    const sheet = new Map(cape.map(v => [v, .6]))
    const column = p.column(0, new THREE.Vector3(.1, .8, .19), .03, sheet)
    p.followUnder(0, column, .25, new Set(sheet.keys()))
    for (let i = 0; i < 4; i++) {
      expect(weight(p, 4 + i, 1)).toBeCloseTo(.15)
      expect(weight(p, 4 + i, 2)).toBeCloseTo(.85)
      expect(weight(p, cape[i], 1)).toBeCloseTo(.15)
      expect(weight(p, cape[i], 0)).toBeCloseTo(.85)
      expect(weight(p, i, 1)).toBe(1) // the covered trousers are donors, never painted
    }
    const full = new Map(cape.map(v => [v, 1])); p.begin({ bounded: true })
    p.followUnder(0, p.column(0, new THREE.Vector3(.1, .8, .19), .03, full), 1, new Set(full.keys()))
    for (let i = 0; i < 4; i++) {
      expect(p.weights(0, 4 + i)).toEqual(p.weights(0, cape[i]))
      expect(weight(p, 4 + i, 1)).toBeCloseTo(1)
    }
  })
})

describe('Follow between the legs', () => {
  it('hangs cloth between the legs from the hips, not from both legs', () => {
    // one quad between the legs, nothing under it: its nearest bones are both thighs
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.02, 0.6, 0.1, 0.02, 0.6, 0.1, -0.02, 0.7, 0.1, 0.02, 0.7, 0.1], 3))
    g.setIndex([0, 1, 2, 1, 3, 2])
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(16).fill(0), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: 4 }, () => [1, 0, 0, 0]).flat(), 4))
    const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0)
    const left = new THREE.Bone(); left.name = 'LeftUpLeg'; left.position.set(0.1, -0.1, 0); hips.add(left)
    const lknee = new THREE.Bone(); lknee.name = 'LeftLeg'; lknee.position.set(0, -0.5, 0); left.add(lknee)
    const right = new THREE.Bone(); right.name = 'RightUpLeg'; right.position.set(-0.1, -0.1, 0); hips.add(right)
    const rknee = new THREE.Bone(); rknee.name = 'RightLeg'; rknee.position.set(0, -0.5, 0); right.add(rknee)
    const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial())
    mesh.add(hips); mesh.updateMatrixWorld(true)
    mesh.bind(new THREE.Skeleton([hips, left, lknee, right, rknee]))
    const p = new WeightPainter([mesh]); p.mirror = false
    p.begin()
    p.followUnder(0, new Map([[0, 1], [1, 1], [2, 1], [3, 1]]), 1)
    // the two thighs' shared pull is the hips': no point is pulled by both legs at once
    for (const v of [0, 1, 2, 3]) expect(Math.min(weight(p, v, 1), weight(p, v, 3))).toBe(0)
    expect(weight(p, 0, 0)).toBeGreaterThan(0.5)
  })
})

describe('the Cloth brush', () => {
  it('weights clothing over the legs by where it hangs, every layer the same, its own side leaning', () => {
    // points at rest: a coat and a cape over it at the left thigh (same x and y, different depth), one by the knee
    const at = [[0.1, 0.6, 0.1], [0.1, 0.6, 0.14], [0.1, 0.35, 0.1], [-0.1, 0.6, 0.1], [0, .35, .14]]
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(at.flat(), 3))
    g.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4])
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(at.length * 4).fill(0), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: at.length }, () => [1, 0, 0, 0]).flat(), 4))
    const bone = (name: string, x: number, y: number, parent?: THREE.Bone): THREE.Bone => {
      const b = new THREE.Bone(); b.name = name; b.position.set(x, y, 0); parent?.add(b); return b
    }
    const hips = bone('Hips', 0, 1); const spine = bone('Spine', 0, 0.2, hips)
    const lup = bone('LeftUpLeg', 0.1, -0.1, hips); const lleg = bone('LeftLeg', 0, -0.45, lup); const lfoot = bone('LeftFoot', 0, -0.4, lleg)
    const rup = bone('RightUpLeg', -0.1, -0.1, hips); const rleg = bone('RightLeg', 0, -0.45, rup); const rfoot = bone('RightFoot', 0, -0.4, rleg)
    const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial())
    mesh.add(hips); mesh.updateMatrixWorld(true)
    mesh.bind(new THREE.Skeleton([hips, spine, lup, lleg, lfoot, rup, rleg, rfoot]))
    const p = new WeightPainter([mesh]); p.mirror = false
    p.begin()
    expect(p.cloth(0, new Map([[0, 1], [1, 1], [2, 1], [3, 1], [4, 1]]), 1)).toBe(5)
    const w = (v: number): number[] => [0, 1, 2, 3, 4, 5, 6, 7].map(b => p.weights(0, v).get(b) ?? 0)
    // the coat and the cape over it the same
    w(0).forEach((x, b) => expect(w(1)[b]).toBeCloseTo(x))
    // the left thigh's more than the right's on the left; the hips share; the shin below the knee
    expect(w(0)[2]).toBeGreaterThan(w(0)[5])
    expect(w(0)[0]).toBeGreaterThan(0)
    expect(w(2)[3]).toBeGreaterThan(0)
    // the right side mirrors it
    expect(w(3)[5]).toBeCloseTo(w(0)[2])
    // The centre hangs from the hips instead of being crushed between two independently moving legs.
    expect(w(4)[0]).toBeCloseTo(1)
  })
})

describe('the Cloth brush through layers', () => {
  it('leaves the trousers the column reaches alone', () => {
    // coat() is a coat sheet (Hips) over a trouser sheet (LeftUpLeg); the stroke is on the coat
    const mesh = coat()
    const hips = mesh.skeleton.bones[0]
    const spine = new THREE.Bone(); spine.name = 'Spine'; spine.position.set(0, 0.2, 0); hips.add(spine)
    const rup = new THREE.Bone(); rup.name = 'RightUpLeg'; rup.position.set(-0.1, -0.1, 0); hips.add(rup)
    const rleg = new THREE.Bone(); rleg.name = 'RightLeg'; rleg.position.set(0, -0.5, 0); rup.add(rleg)
    const rfoot = new THREE.Bone(); rfoot.name = 'RightFoot'; rfoot.position.set(0, -0.4, 0); rleg.add(rfoot)
    mesh.updateMatrixWorld(true)
    mesh.bind(new THREE.Skeleton([...mesh.skeleton.bones, spine, rup, rleg, rfoot]))
    const p = new WeightPainter([mesh]); p.mirror = false
    p.begin()
    p.cloth(0, new Map([4, 5, 6, 7, 0, 1, 2, 3].map(v => [v, 1])), 1, new Set([4, 5, 6, 7]))
    // the trousers keep their thigh, whole
    for (const v of [0, 1, 2, 3]) expect(weight(p, v, 1)).toBe(1)
    // the coat took the cloth weights: its thigh and, below the knee, its shin
    expect(weight(p, 4, 1)).toBeGreaterThan(0.3)
    expect(weight(p, 4, 2)).toBeGreaterThan(0)
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
