// @vitest-environment node
// gear.origin (src/model/origin.ts): the piece's origin moved, everything kept in its frame carried over, so the
// piece's world pose is the same (1e-9) at rest, at every key, held by another bone at a place, and its handles and
// pulls where they were; an undo restores the character exactly.
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { applyCommand, applyCommands, CommandError } from './commands.ts'
import { restoreEntities, stableJson, undoRecord } from './entities.ts'
import { makeCharacter, makeGear, makeSlot } from './fixtures.ts'
import { eulerQuat, rebasedKey, rotate } from './origin.ts'
import type { Character, ClipKey, Gear, Placement, Vec3 } from './types.ts'

const matrixOf = (p: Placement): THREE.Matrix4 => {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...p.rotation.map(d => THREE.MathUtils.degToRad(d)) as [number, number, number]))
  return new THREE.Matrix4().compose(new THREE.Vector3(...p.position), q, new THREE.Vector3(p.scale, p.scale, p.scale))
}
const T = (v: readonly number[]): THREE.Matrix4 => new THREE.Matrix4().makeTranslation(v[0], v[1], v[2])
const keyMatrix = (k: ClipKey): THREE.Matrix4 => new THREE.Matrix4().compose(new THREE.Vector3(...(k.p ?? [0, 0, 0])), new THREE.Quaternion(...k.q).normalize(), new THREE.Vector3(1, 1, 1))
/** The model file's own space in rest space: the placement, then the origin undone. */
const fileFrame = (g: Gear, key?: ClipKey): THREE.Matrix4 => {
  const m = matrixOf(g.attach.place)
  if (key !== undefined) m.multiply(keyMatrix(key))
  return m.multiply(T((g.origin ?? [0, 0, 0]).map(x => -x)))
}
const apart = (a: THREE.Matrix4, b: THREE.Matrix4): number => Math.max(...a.elements.map((x, i) => Math.abs(x - b.elements[i])))
const turn = (axis: Vec3, deg: number): [number, number, number, number] => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis).normalize(), THREE.MathUtils.degToRad(deg)).toArray() as [number, number, number, number]

const spear = (): Gear => makeGear({
  id: 'spear', name: 'Spear',
  attach: { kind: 'bone', bone: 'RightHand', place: { position: [0.31, 0.92, 0.05], rotation: [-19, 8, 2.7], scale: 1.3 } },
  handles: [
    { id: 'carry', name: 'Carried', kind: 'carry', hand: 'Right', place: { position: [0.01, -0.4, 0.02], rotation: turn([0, 0, 1], 20) } },
    { id: 'front', name: 'Front', kind: 'grip', hand: 'Left', place: { position: [0, -0.1, 0], rotation: [0, 0, 0, 1] } },
    { id: 'draw', name: 'Draw', kind: 'pull', hand: 'Left', pull: { bone: 'LeftHand', grip: [0.02, 0.05, 0], rest: [0.1, -0.7, 0] } },
  ],
})
const keys: ClipKey[] = [
  { u: 0, q: [0, 0, 0, 1] },
  { u: 0.4, q: turn([1, 0.3, 0], 60), p: [0, 0.05, 0.1] },
  { u: 0.8, q: turn([0, 1, 0], -35), p: [0.02, 0, 0], ease: 'linear' },
]
const held: Placement = { position: [-0.2, 1.1, 0.3], rotation: [30, -45, 10], scale: 1.3 }

function base (): Character {
  return makeCharacter({
    gear: [spear()],
    clips: [
      makeSlot({ id: 'atk', name: 'Attack', gear: { spear: { keys, heldBy: [{ u: 0.5, bone: 'LeftHand', place: held }, { u: 0.9, bone: 'RightHand', placed: true }] } } }),
      makeSlot({ id: 'lead', name: 'Thrust', gear: { spear: { keys } }, ik: { hands: [], lead: ['spear'] } }),
    ],
  })
}

describe('gear.origin', () => {
  it('turns as three turns a placement', () => {
    for (const deg of [[0, 0, 0], [-19, 8, 2.7], [170, -80, 45], [90, 90, 90]] as Vec3[]) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...deg.map(d => THREE.MathUtils.degToRad(d)) as Vec3))
      expect(eulerQuat(deg).map((x, i) => Math.abs(x - q.toArray()[i])).every(x => x < 1e-15)).toBe(true)
      const v = new THREE.Vector3(0.3, -1.2, 2).applyQuaternion(q)
      expect(rotate(eulerQuat(deg), [0.3, -1.2, 2]).map((x, i) => Math.abs(x - v.toArray()[i])).every(x => x < 1e-14)).toBe(true)
    }
  })

  it('moves nothing: the piece at rest and at every key, its handles, its pulls, its holder', () => {
    const was = base()
    const o: Vec3 = [0.05, -0.62, 0.11]
    const r = applyCommand(was, { type: 'gear.origin', id: 'spear', origin: o })
    const before = was.gear[0]; const after = r.character.gear[0]
    expect(after.origin).toEqual(o)
    expect(apart(fileFrame(before), fileFrame(after))).toBeLessThan(1e-9)
    expect(after.attach.place.rotation).toEqual(before.attach.place.rotation)
    expect(after.attach.place.scale).toBe(before.attach.place.scale)
    // (every key: placement · key · origin undone)
    const k0 = was.clips[0].gear!.spear.keys!; const k1 = r.character.clips[0].gear!.spear.keys!
    for (let i = 0; i < k0.length; i++) expect(apart(fileFrame(before, k0[i]), fileFrame(after, k1[i]))).toBeLessThan(1e-9)
    expect(k1.map(k => [k.u, k.q, k.ease])).toEqual(k0.map(k => [k.u, k.q, k.ease]))
    // (a handle's wrist and a pull's rest point, in rest space)
    for (const [i, h] of before.handles.entries()) {
      const a = after.handles[i]
      if (h.place !== undefined) {
        const w0 = matrixOf(before.attach.place).multiply(new THREE.Matrix4().compose(new THREE.Vector3(...h.place.position), new THREE.Quaternion(...h.place.rotation), new THREE.Vector3(1, 1, 1)))
        const w1 = matrixOf(after.attach.place).multiply(new THREE.Matrix4().compose(new THREE.Vector3(...a.place!.position), new THREE.Quaternion(...a.place!.rotation), new THREE.Vector3(1, 1, 1)))
        expect(apart(w0, w1)).toBeLessThan(1e-9)
      }
      if (h.pull !== undefined) {
        const p0 = new THREE.Vector3(...h.pull.rest).applyMatrix4(matrixOf(before.attach.place))
        const p1 = new THREE.Vector3(...a.pull!.rest).applyMatrix4(matrixOf(after.attach.place))
        expect(p0.distanceTo(p1)).toBeLessThan(1e-9)
        expect(a.pull!.grip).toEqual(h.pull.grip)
      }
    }
    // (held by the left hand at a place: rigid there, sized by Gear)
    const h0 = was.clips[0].gear!.spear.heldBy![0].place!; const h1 = r.character.clips[0].gear!.spear.heldBy![0].place!
    const rigid = (p: Placement): THREE.Matrix4 => matrixOf({ ...p, scale: 1 }).multiply(new THREE.Matrix4().makeScale(1.3, 1.3, 1.3))
    expect(apart(rigid(h0).multiply(T([0, 0, 0])), rigid(h1).multiply(T(o.map(x => -x))))).toBeLessThan(1e-9)
    expect(r.character.clips[0].gear!.spear.heldBy![1]).toEqual({ u: 0.9, bone: 'RightHand', placed: true })
  })

  it('moves it again from where it is, and back to the file\'s own', () => {
    const one = applyCommand(base(), { type: 'gear.origin', id: 'spear', origin: [0.05, -0.62, 0.11] }).character
    const two = applyCommand(one, { type: 'gear.origin', id: 'spear', origin: [0, 0.3, 0] }).character
    expect(apart(fileFrame(base().gear[0]), fileFrame(two.gear[0]))).toBeLessThan(1e-9)
    const back = applyCommand(two, { type: 'gear.origin', id: 'spear', origin: null }).character
    expect(back.gear[0].origin).toBeUndefined()
    const b0 = base().gear[0].attach.place.position
    back.gear[0].attach.place.position.forEach((x, i) => expect(Math.abs(x - b0[i])).toBeLessThan(1e-12))
  })

  it('takes a leading piece\'s keys as given, keeps them when not', () => {
    const given: ClipKey[] = [{ u: 0.2, q: [0, 0, 0, 1], p: [0.1, 0, 0] }]
    const r = applyCommand(base(), { type: 'gear.origin', id: 'spear', origin: [0, -0.5, 0], lead: { lead: given } })
    expect(r.character.clips[1].gear!.spear.keys).toEqual(given)
    const kept = applyCommand(base(), { type: 'gear.origin', id: 'spear', origin: [0, -0.5, 0] })
    expect(kept.character.clips[1].gear!.spear.keys).toEqual(keys)
    expect(kept.changes.some(x => x.includes('Thrust') && x.includes('kept'))).toBe(true)
  })

  it('is undone exactly', () => {
    const was = base()
    const after = applyCommands(was, [{ type: 'gear.origin', id: 'spear', origin: [0.05, -0.62, 0.11] }]).character
    expect(stableJson(restoreEntities(after, undoRecord(was, after)))).toBe(stableJson(was))
  })

  it('changes nothing at the same origin; refuses a piece in the old catalog frame', () => {
    expect(applyCommand(base(), { type: 'gear.origin', id: 'spear', origin: null }).changes).toEqual([])
    const legacy = makeCharacter({ gear: [makeGear({ attach: { kind: 'bone', bone: 'RightHand', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, legacyFrame: 'grip' } })] })
    expect(() => applyCommand(legacy, { type: 'gear.origin', id: 'g1', origin: [0, 1, 0] })).toThrow(CommandError)
  })

  it('carries a key without a move', () => {
    expect(rebasedKey({ u: 0, q: [0, 0, 0, 1] }, [1, 2, 3])).toEqual({ u: 0, q: [0, 0, 0, 1] })
    const k = rebasedKey({ u: 0, q: turn([0, 0, 1], 90) }, [1, 0, 0])
    expect(k.p!.map(x => Math.round(x * 1e9) / 1e9)).toEqual([-1, 1, 0])
  })

  it('is forgotten with a new model', () => {
    const one = applyCommand(base(), { type: 'gear.origin', id: 'spear', origin: [0, -0.5, 0] }).character
    const r = applyCommand(one, { type: 'gear.update', id: 'spear', patch: { model: 'garments/spear/model.2.glb' } })
    expect(r.character.gear[0].origin).toBeUndefined()
  })
})
