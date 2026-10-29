// A slot's source built from pieces (src/engine/pieces.ts, docs/motion-plan.md §11.4): cross-fades, the root motion
// carried on at each seam (the Hips neither jump back nor turn round), a held pose held, a slot piece being that slot's
// bake, a slot playing itself refused.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { Character, ClipRef, Piece, Slot } from '../model/types.ts'
import { makeCharacter } from '../model/fixtures.ts'
import { bakeSlot, type BakeContext } from './bake.ts'
import { composePieces, twist } from './pieces.ts'
import { captureRest } from './retarget.ts'

function rig (): THREE.Group {
  const root = new THREE.Group()
  const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0); root.add(hips)
  const spine = new THREE.Bone(); spine.name = 'Spine'; spine.position.set(0, 0.2, 0); hips.add(spine)
  root.updateMatrixWorld(true)
  return root
}
const root = rig()
const rest = captureRest(root, o => (o as THREE.Bone).isBone === true)
const Y = new THREE.Vector3(0, 1, 0); const X = new THREE.Vector3(1, 0, 0)
const about = (axis: THREE.Vector3, a: number): number[] => new THREE.Quaternion().setFromAxisAngle(axis, a).toArray()

/** A clip of `seconds` (30 frames a second): the Hips walking `speed` m/s along their own +Z while turning from `yaw0`
 * to `yaw1` about Y, the Spine bent `bend` rad about X. */
function walk (seconds: number, o: { speed?: number, yaw0?: number, yaw1?: number, bend?: number } = {}): THREE.AnimationClip {
  const n = Math.round(seconds * 30)
  const times: number[] = []; const p: number[] = []; const hq: number[] = []; const sq: number[] = []
  const at = new THREE.Vector3(0, 1, 0)
  for (let i = 0; i <= n; i++) {
    const t = i / 30
    const yaw = (o.yaw0 ?? 0) + ((o.yaw1 ?? o.yaw0 ?? 0) - (o.yaw0 ?? 0)) * (i / n)
    if (i > 0) at.add(new THREE.Vector3(0, 0, (o.speed ?? 1) / 30).applyAxisAngle(Y, yaw))
    times.push(t); p.push(at.x, at.y, at.z); hq.push(...about(Y, yaw)); sq.push(...about(X, o.bend ?? 0))
  }
  return new THREE.AnimationClip('walk', seconds, [
    new THREE.VectorKeyframeTrack('Hips.position', times, p), new THREE.QuaternionKeyframeTrack('Hips.quaternion', times, hq),
    new THREE.QuaternionKeyframeTrack('Spine.quaternion', times, sq),
  ])
}
const value = (clip: THREE.AnimationClip, name: string, t: number): number[] =>
  Array.from((clip.tracks.find(x => x.name === name)! as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant().evaluate(t) as ArrayLike<number>)
const piece = (id: string, to: number, blend?: number): Piece => ({ id, kind: 'clip', clip: { id }, from: 0, to, ...(blend !== undefined ? { blend } : {}) })

/** The largest step of the Hips' position and turn from one frame to the next. */
function steps (clip: THREE.AnimationClip): { move: number, turn: number } {
  const p = clip.tracks.find(t => t.name === 'Hips.position')!; const q = clip.tracks.find(t => t.name === 'Hips.quaternion')!
  let move = 0; let turn = 0
  for (let i = 1; i < p.times.length; i++) {
    const a = new THREE.Vector3().fromArray(p.values, (i - 1) * 3); const b = new THREE.Vector3().fromArray(p.values, i * 3)
    move = Math.max(move, a.distanceTo(b) / (p.times[i] - p.times[i - 1]))
    turn = Math.max(turn, new THREE.Quaternion().fromArray(q.values, (i - 1) * 4).angleTo(new THREE.Quaternion().fromArray(q.values, i * 4)))
  }
  return { move, turn }
}

describe('composing pieces', () => {
  it('lasts the pieces less their blends and plays each from its range', () => {
    // (b's second half second to its second and a half, blended in over half a second: 1 + 1 - 0.5 s)
    const c = composePieces([piece('a', 1), { ...piece('b', 1.5, 0.5), from: 0.5 }], [walk(1), walk(2, { bend: 1 })], rest)
    expect(c.duration).toBeCloseTo(1.5, 12)
    expect(value(c, 'Spine.quaternion', 1.4)).toEqual(about(X, 1).map(x => expect.closeTo(x, 6)))
    expect(value(c, 'Hips.position', 1.5)[2]).toBeCloseTo(1 + 1 - 0.5, 4)
  })

  // (frame steps compared within float32's grain: clips store their values as float32)
  it('carries the walk on at a seam: the Hips go on from where they were, no jump back', () => {
    const c = composePieces([piece('a', 1), piece('b', 1)], [walk(1), walk(1)], rest)
    expect(value(c, 'Hips.position', 2)[2]).toBeCloseTo(2, 6)
    // (a frame's step at the seam no longer than any other's: 1 m/s)
    expect(steps(c).move).toBeLessThan(1 + 1e-4)
  })

  it('turns the next piece to face where the clip faces: after a 90° turn it walks the new way, the facing continuous', () => {
    const c = composePieces([piece('a', 1), piece('b', 1)], [walk(1, { yaw1: Math.PI / 2 }), walk(1)], rest)
    const end = value(c, 'Hips.position', 2); const seam = value(c, 'Hips.position', 1)
    // (the second walks along +X now, from where the first ended)
    expect(end[0] - seam[0]).toBeCloseTo(1, 6)
    expect(end[2] - seam[2]).toBeCloseTo(0, 6)
    // (its height its own; its turn a frame's at most)
    expect(end[1]).toBeCloseTo(1, 9)
    expect(steps(c).turn).toBeLessThan(Math.PI / 2 / 30 + 1e-4)
    expect(steps(c).move).toBeLessThan(1 + 1e-4)
  })

  it('cross-fades over a blend: halfway through it, halfway between the two', () => {
    const c = composePieces([piece('a', 1), piece('b', 1, 0.5)], [walk(1), walk(1, { bend: 1 })], rest)
    const mid = new THREE.Quaternion().fromArray(value(c, 'Spine.quaternion', 0.75))
    expect(mid.angleTo(new THREE.Quaternion())).toBeCloseTo(0.5, 3)
    expect(new THREE.Quaternion().fromArray(value(c, 'Spine.quaternion', 1.2)).angleTo(new THREE.Quaternion().fromArray(about(X, 1)))).toBeLessThan(1e-3)
    expect(steps(c).move).toBeLessThan(1 + 1e-4)
  })

  it('holds the pose where the piece before ends, and a hold first holds where the next starts', () => {
    const end = composePieces([piece('a', 1), { id: 'h', kind: 'hold', from: 0, to: 0.5 }], [walk(1, { bend: 0.7 }), null], rest)
    for (const t of [1, 1.2, 1.5]) expect(value(end, 'Hips.position', t)[2]).toBeCloseTo(1, 6)
    const start = composePieces([{ id: 'h', kind: 'hold', from: -0.5, to: 0 }, piece('a', 1)], [null, walk(1)], rest)
    for (const t of [0, 0.25, 0.5]) expect(value(start, 'Hips.position', t)[2]).toBeCloseTo(0, 6)
    expect(value(start, 'Hips.position', 1.5)[2]).toBeCloseTo(1, 6)
  })

  it('takes the twist of a turn about an axis', () => {
    const q = new THREE.Quaternion().setFromAxisAngle(Y, 0.4).multiply(new THREE.Quaternion().setFromAxisAngle(X, 0.3))
    expect(twist(q, Y).angleTo(new THREE.Quaternion().setFromAxisAngle(Y, 0.4))).toBeLessThan(0.05)
  })
})

describe('the bake of a slot built from pieces', () => {
  const library: Record<string, THREE.AnimationClip> = { a: walk(1), b: walk(1, { bend: 1 }) }
  const ctx = (): BakeContext => ({ rest, posable: rig(), clips: { get: async (ref: ClipRef | string) => library[typeof ref === 'string' ? ref : ref.id] } })
  const slot = (o: Partial<Slot>): Slot => ({ id: 's', name: 'S', clip: { id: 'a' }, speed: 1, loop: false, inPlace: false, adjustments: [], ...o })
  const character = (clips: Slot[]): Character => makeCharacter({ clips, skeleton: { template: 'human', fingerLevel: 'none', overrides: {} } })

  it('plays another slot as that slot plays: its speed and its keys', async () => {
    const other = slot({ id: 'o', name: 'Other', clip: { id: 'b' }, speed: 2, bones: { Hips: [{ u: 0, q: [0, 0, 0, 1], p: [0, 0.5, 0] }, { u: 1, q: [0, 0, 0, 1], p: [0, 0.5, 0] }] } })
    const combo = slot({ id: 'c', name: 'Combo', pieces: [piece('a', 1), { id: 'p', kind: 'slot', slot: 'o', from: 0, to: 0.5 }] })
    const c = character([other, combo])
    const baked = await bakeSlot(c, combo, ctx())
    const alone = await bakeSlot(c, other, ctx())
    expect(baked.raw.duration).toBeCloseTo(1.5, 9)
    // (the other's keys are in: the Hips half a metre up there; its speed: its 0.5 s is all of it)
    expect(value(baked.clip, 'Hips.position', 1.25)[1]).toBeCloseTo(value(alone.clip, 'Hips.position', 0.25)[1], 6)
    expect(value(baked.clip, 'Hips.position', 1.25)[1]).toBeCloseTo(1.5, 6)
  })

  it('refuses a slot that plays itself through its pieces', async () => {
    const a = slot({ id: 'a1', name: 'A', pieces: [piece('a', 1), { id: 'p', kind: 'slot', slot: 'b1', from: 0, to: 1 }] })
    const b = slot({ id: 'b1', name: 'B', pieces: [piece('b', 1), { id: 'p', kind: 'slot', slot: 'a1', from: 0, to: 1 }] })
    await expect(bakeSlot(character([a, b]), a, ctx())).rejects.toThrow(/plays itself/)
  })
})
