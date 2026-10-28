import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { CharacterView } from '../../src/engine/CharacterView.ts'
import type { Garment } from '../../server/workspace.ts'
import { gearSkin, pullSkin } from './gearskin.ts'

// A 2 x 2 body sheet at z = 0: Hips at x = 0, LeftUpLeg at x = 2, each vertex weighted to LeftUpLeg by x / 2.
function body (): CharacterView {
  const positions: number[] = []; const skinIndex: number[] = []; const skinWeight: number[] = []
  for (let y = 0; y <= 2; y++) for (let x = 0; x <= 2; x++) { positions.push(x, y, 0); skinIndex.push(0, 1, 0, 0); skinWeight.push(1 - x / 2, x / 2, 0, 0) }
  const index: number[] = []
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) { const v = y * 3 + x; index.push(v, v + 1, v + 3, v + 1, v + 4, v + 3) }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(index)
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4))
  const hips = new THREE.Bone(); hips.name = 'Hips'
  const leg = new THREE.Bone(); leg.name = 'LeftUpLeg'; leg.position.set(2, 0, 0); hips.add(leg)
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial())
  mesh.add(hips)
  const root = new THREE.Group(); root.add(mesh); root.updateMatrixWorld(true)
  mesh.bind(new THREE.Skeleton([hips, leg]))
  return new CharacterView(root)
}

/** A small triangle just in front of the sheet at (x, y). */
function patch (x: number, y: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([x, y, 0.05, x + 0.05, y, 0.05, x, y + 0.05, 0.05], 3))
  g.setIndex([0, 1, 2])
  return g
}

const garment = (over: Partial<Garment>): Garment => ({
  id: 't', name: 'Test', status: 'ready', mode: 'clothing', policy: 'body', bone: 'Hips', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1, hideBody: false, ...over,
})
// the export's joints: another order than the body's skeleton (root first, the leg before the hips)
const JOINTS = ['root', 'LeftUpLeg', 'Hips']
const bonesOf = (s: { indices: Uint16Array, weights: Float32Array }, v: number): Record<string, number> => {
  const out: Record<string, number> = {}
  for (let k = 0; k < 4; k++) if (s.weights[v * 4 + k] > 1e-6) out[JOINTS[s.indices[v * 4 + k]]] = (out[JOINTS[s.indices[v * 4 + k]]] ?? 0) + s.weights[v * 4 + k]
  return out
}

describe('game export: clothing and parts skinned as the viewer skins them', () => {
  it('weights clothing like the skin under it, by bone name on the export skeleton', () => {
    const { skins, lead } = gearSkin(body(), garment({}), [patch(0, 1), patch(1.95, 1)], [], [], JOINTS)
    expect(bonesOf(skins[0], 0).Hips).toBeGreaterThan(0.95)
    expect(bonesOf(skins[1], 0).LeftUpLeg).toBeGreaterThan(0.95)
    expect(lead).toBe('Hips')
  })

  it('lays painted weights over only while the garment counts them', () => {
    const edits = [{ mesh: 1, vertex: 2, weights: [['Hips', 3], ['LeftUpLeg', 1]] as Array<[string, number]> }]
    const painted = gearSkin(body(), garment({ painted: 1 }), [patch(0, 1), patch(1.95, 1)], edits, [], JOINTS)
    expect(painted.painted).toBe(1)
    expect(bonesOf(painted.skins[1], 2)).toEqual({ Hips: 0.75, LeftUpLeg: 0.25 })
    expect(bonesOf(gearSkin(body(), garment({}), [patch(0, 1), patch(1.95, 1)], edits, [], JOINTS).skins[1], 2).LeftUpLeg).toBeGreaterThan(0.95)
  })

  it('gives every vertex of a part its spot\'s weights; a mechanism rides the spot\'s leading bone', () => {
    const g = garment({ mode: 'part', anchor: [1.5, 1, 0] })
    const { skins, spot } = gearSkin(body(), g, [patch(0, 0), patch(1.9, 1.9)], [], [], JOINTS)
    expect(spot).toEqual([['LeftUpLeg', 0.75], ['Hips', 0.25]])
    for (const s of skins) for (let v = 0; v < 3; v++) expect(bonesOf(s, v)).toEqual({ LeftUpLeg: 0.75, Hips: 0.25 })
    const turning = gearSkin(body(), { ...g, animation: 'Turn' }, [patch(0, 0)], [], ['Turn'], JOINTS)
    expect(turning.mechanism).toBe('Turn')
    expect(bonesOf(turning.skins[0], 1)).toEqual({ LeftUpLeg: 1 })
    // (an animation its model lacks: a plain part, as the viewer has it)
    expect(gearSkin(body(), { ...g, animation: 'Gone' }, [patch(0, 0)], [], [], JOINTS).mechanism).toBeUndefined()
  })

  it('refuses a weight on a bone the export lacks', () => {
    expect(() => gearSkin(body(), garment({}), [patch(1.95, 1)], [], [], ['root', 'Hips'])).toThrow('LeftUpLeg')
  })
})

describe('game export: a prop\'s pulls rigged as the viewer rigs them', () => {
  // a string: a thin straight tube along z, vertices only at its ends
  const string = (): THREE.BufferGeometry => new THREE.CylinderGeometry(0.002, 0.002, 0.7, 6, 1).rotateX(Math.PI / 2)
  const bow = (painted = 0): Garment => garment({
    mode: 'rigid', name: 'Bow', bone: 'LeftHand', painted,
    pulls: [{ id: 'p', name: 'Draw', bone: 'RightHand', grip: [0, 0, 0], rest: [0, 0, 0.1] }],
  })
  // the export's joints: the bone the prop rides at 7, the pull's bone at 9
  const joints = [7, 9]

  it('splits the strand at the pull and weights the ring there to the pull\'s joint, the rest to the ride bone', () => {
    const g0 = string()
    const before = g0.attributes.position.count
    const { geometries, skins } = pullSkin(bow(), [g0], [], joints)
    const pos = geometries[0].attributes.position
    expect(pos.count).toBeGreaterThan(before)
    for (let v = 0; v < pos.count; v++) {
      const ring = Math.abs(pos.getZ(v) - 0.1) < 1e-4
      expect(skins[0].indices[v * 4]).toBe(ring ? 9 : 7)
      expect(skins[0].weights[v * 4]).toBe(1)
    }
  })

  it('lays painted weights over by the pull bone\'s name, only while the prop counts them', () => {
    const edits = [{ mesh: 0, vertex: 0, weights: [['PropRoot', 1], ['Prop_Bow_Draw', 3]] as Array<[string, number]> }]
    const painted = pullSkin(bow(1), [string()], edits, joints)
    expect(painted.painted).toBe(1)
    expect(Array.from(painted.skins[0].indices.slice(0, 2))).toEqual([9, 7])
    expect(Array.from(painted.skins[0].weights.slice(0, 2))).toEqual([0.75, 0.25])
    expect(pullSkin(bow(0), [string()], edits, joints).skins[0].indices[0]).toBe(7)
  })
})
