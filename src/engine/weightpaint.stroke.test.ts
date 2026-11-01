import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { WeightPainter } from './weightpaint.ts'

function scene (): { meshes: THREE.SkinnedMesh[], head: THREE.Bone } {
  const root = new THREE.Group()
  const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.z = -.5; root.add(hips)
  const head = new THREE.Bone(); head.name = 'Head'; head.position.y = 1; hips.add(head)
  const meshes = [0, .008].map((z, q) => {
    const half = q === 0 ? .3 : .05; const bottom = q === 0 ? 0 : .4; const top = q === 0 ? 1 : .6
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([-half, bottom, z, half, bottom, z, -half, top, z, half, top, z], 3))
    g.setIndex([0, 1, 3, 0, 3, 2])
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(Array.from({ length: 4 }, () => [q === 0 ? 1 : 0, 0, 0, 0]).flat(), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: 4 }, () => [1, 0, 0, 0]).flat(), 4))
    const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial()); root.add(mesh); return mesh
  })
  root.updateMatrixWorld(true)
  for (const mesh of meshes) mesh.bind(new THREE.Skeleton([hips, head]))
  head.position.x = .4; root.updateMatrixWorld(true)
  return { meshes, head }
}

const ray = (): THREE.Ray => new THREE.Ray(new THREE.Vector3(0, .5, 1), new THREE.Vector3(0, 0, -1))
const points = (): Map<number, number> => new Map([0, 1, 2, 3].map(p => [p, 1]))

describe('stable stroke targeting', () => {
  it('guards manual weight proposals against a later fold without changing the live pose', () => {
    const { meshes, head } = scene(); head.position.x = 0; meshes[1].parent!.updateMatrixWorld(true)
    const painter = new WeightPainter(meshes); painter.mirror = false
    const clip = new THREE.AnimationClip('Bend', 1, [new THREE.NumberKeyframeTrack('Head.position[x]', [0, 1], [0, -.4])])
    const original = Array.from(meshes[1].geometry.attributes.skinWeight.array)
    painter.begin({ bounded: true, preserveSurface: true, animation: { root: meshes[1].parent!, clip } })
    painter.add(1, new Map([[1, 1]]), 1, 1); painter.end()
    expect(painter.limitedCount).toBeGreaterThan(0)
    expect(head.position.x).toBe(0)
    head.position.x = -.4; meshes[1].parent!.updateMatrixWorld(true)
    const a = meshes[1].getVertexPosition(0, new THREE.Vector3())
    const b = meshes[1].getVertexPosition(1, new THREE.Vector3())
    const c = meshes[1].getVertexPosition(3, new THREE.Vector3())
    expect(b.sub(a).cross(c.sub(a)).z).toBeGreaterThan(0)
    expect(painter.stepBack()).toBe(true)
    expect(Array.from(meshes[1].geometry.attributes.skinWeight.array)).toEqual(original)
  })

  it('does not follow a common hem edge onto a lining folded back under the outside', () => {
    const { meshes, head } = scene(); head.position.x = 0; meshes[0].parent!.updateMatrixWorld(true)
    const outer = meshes[1]; const lining = new THREE.SkinnedMesh(outer.geometry.clone(), new THREE.MeshBasicMaterial())
    const pos = lining.geometry.attributes.position
    for (const p of [2, 3]) { pos.setZ(p, .004); lining.geometry.attributes.skinIndex.setX(p, 1) }
    lining.geometry.setIndex([0, 3, 1, 0, 2, 3]); outer.parent!.add(lining)
    outer.parent!.updateMatrixWorld(true); lining.bind(new THREE.Skeleton(outer.skeleton.bones, outer.skeleton.boneInverses.map(m => m.clone())))
    const painter = new WeightPainter([...meshes, lining]); painter.mirror = false
    const first = painter.pick(ray(), .2)!
    expect(first.part).toBe(1)
    head.position.z = .02; outer.parent!.updateMatrixWorld(true)
    const held = { part: first.part, sheet: new Set([...first.points.keys(), ...first.face]) }
    const next = painter.pick(ray(), .2, held)!
    expect(next.part).toBe(1)
    expect(next.point.z).toBeCloseTo(.008, 6)
  })

  it('keeps the picked sheet and footprint when a weight edit moves the rendered cloth off the cursor', () => {
    const { meshes } = scene(); const p = new WeightPainter(meshes); p.mirror = false
    p.begin({ bounded: true, stableSurface: true })
    const first = p.pick(ray(), .2)!
    const held = { part: first.part, sheet: new Set([...first.points.keys(), ...first.face]) }
    expect(first.part).toBe(1)
    p.followUnder(1, points(), 1)
    expect(meshes[1].getVertexPosition(0, new THREE.Vector3()).x).toBeGreaterThan(.3)
    const next = p.pick(ray(), .2, held)!
    expect(next.part).toBe(1); expect(next.face).toEqual(first.face)
    expect([...next.points]).toEqual([...first.points])
    p.end()
    expect(p.pick(ray(), .2, held)).toBeNull()
  })

  it('retains live refitting for scripted bounded strokes that do not request stable targeting', () => {
    const { meshes } = scene(); const p = new WeightPainter(meshes); p.mirror = false
    p.begin({ bounded: true }); const first = p.pick(ray(), .2)!
    p.followUnder(1, points(), 1)
    expect(p.pick(ray(), .2, { part: 1, sheet: new Set(first.face) })).toBeNull()
  })

  it('uses current body geometry for Lift even when picking uses a stroke-start snapshot', () => {
    const { meshes, head } = scene(); head.position.x = 0; meshes[0].parent!.updateMatrixWorld(true)
    const p = new WeightPainter(meshes); p.mirror = false
    p.begin({ bounded: true, stableSurface: true }); const hit = p.pick(ray(), .2)!
    const body = meshes[0].geometry.attributes.position
    for (let v = 0; v < body.count; v++) body.setZ(v, .02)
    p.paintLayers('lift', { ...hit, points: points() }, .2, 1, .01)
    for (let v = 0; v < 4; v++) {
      expect(meshes[1].geometry.attributes.position.getZ(v)).toBeCloseTo(.03, 5)
      expect(body.getZ(v)).toBeCloseTo(.02, 6)
    }
  })

  it.each(['end', 'save', 'undo', 'begin'] as const)('clears the snapshot on %s', action => {
    const { meshes } = scene(); const p = new WeightPainter(meshes); p.mirror = false
    p.begin({ bounded: true, stableSurface: true }); p.followUnder(1, points(), 1)
    if (action === 'end') p.end()
    else if (action === 'save') p.saved()
    else if (action === 'undo') { expect(p.stepBack()).toBe(true); meshes[1].skeleton.bones[0].position.x = .4; meshes[1].parent!.updateMatrixWorld(true) }
    else p.begin({ bounded: true })
    expect(p.pick(ray(), .2)).toBeNull()
  })
})
