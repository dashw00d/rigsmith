// @vitest-environment node
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { Character, Slot } from '../../src/model/types.ts'
import { overlayStance, placeCompanionClip, recordSlots, scalePositions, seatClip, wholeCycles } from './unit_export.ts'

const vec = (name: string, values: number[]): THREE.KeyframeTrack => new THREE.VectorKeyframeTrack(name, values.length === 3 ? [0] : [0, 1], values)
const quat = (name: string, q: THREE.Quaternion): THREE.KeyframeTrack => new THREE.QuaternionKeyframeTrack(name, [0], q.toArray())
const track = (clip: THREE.AnimationClip, name: string): number[] => Array.from(clip.tracks.find(t => t.name === name)!.values)
const close = (a: number[], b: number[]): void => { expect(a.length).toBe(b.length); a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 6)) }
const QUARTER = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)

describe('unit export: clips in game units', () => {
  it('replaces only the overlay keyed bone tracks and scales them to the stance clip duration', () => {
    const base = new THREE.AnimationClip('Idle@shield', 2, [vec('Spine.position', [0, 0, 0]), quat('LeftArm.quaternion', new THREE.Quaternion())])
    const overlay = new THREE.AnimationClip('overlay', 1, [vec('Spine.position', [3, 3, 3]), quat('LeftArm.quaternion', QUARTER)])
    const result = overlayStance(base, overlay, ['LeftArm'])
    close(track(result, 'Spine.position'), [0, 0, 0])
    close(track(result, 'LeftArm.quaternion'), QUARTER.toArray())
    expect(result.name).toBe('Idle@shield')
  })
  it('scales every move, and lowers the top bone by the floor first, leaving turns and the clip it was given alone', () => {
    const spine = quat('Spine.quaternion', QUARTER)
    const clip = new THREE.AnimationClip('Walk', 1, [vec('Hips.position', [0, 1, 0, 0.5, 2, 0]), vec('Spine.position', [0, 0.2, 0]), spine])
    const out = scalePositions(clip, 2, 0.5, 'Hips')
    close(track(out, 'Hips.position'), [0, 1, 0, 1, 3, 0])
    close(track(out, 'Spine.position'), [0, 0.4, 0])
    expect(out.tracks.find(t => t.name === 'Spine.quaternion')).toBe(spine)
    expect(out.duration).toBe(1)
    close(track(clip, 'Hips.position'), [0, 1, 0, 0.5, 2, 0])
  })

  it('hangs a rider\'s hips from the seat bone: their moves and turns taken into its frame, nothing else', () => {
    const seat = new THREE.Matrix4().compose(new THREE.Vector3(1, 0, 0), QUARTER, new THREE.Vector3(1, 1, 1))
    const clip = new THREE.AnimationClip('Idle', 1, [vec('Hips.position', [0, 0, 1]), quat('Hips.quaternion', new THREE.Quaternion()), quat('Spine.quaternion', new THREE.Quaternion())])
    const out = seatClip(clip, 'Hips', seat)
    close(track(out, 'Hips.position'), [2, 0, 0])
    close(track(out, 'Hips.quaternion'), QUARTER.toArray())
    close(track(out, 'Spine.quaternion'), [0, 0, 0, 1])
  })

  it('puts a companion\'s clip on its prefixed bones, its top bone placed beside the unit', () => {
    const clip = new THREE.AnimationClip('Walk', 1, [
      vec('pelvis.position', [1, 0.5, 0]), quat('pelvis.quaternion', new THREE.Quaternion()), quat('leg.quaternion', QUARTER), vec('leg.position', [0, -1, 0]),
    ])
    const out = placeCompanionClip(clip, { s: 2, floor: 0.5, top: 'pelvis', prefix: 'Pony_', yaw: QUARTER, at: new THREE.Vector3(1, 0, -1) })
    expect(out.tracks.map(t => t.name)).toEqual(['Pony_pelvis.position', 'Pony_pelvis.quaternion', 'Pony_leg.quaternion', 'Pony_leg.position'])
    // (1, 0.5, 0) scaled and grounded: (2, 0, 0); turned a quarter about +Y: (0, 0, -2); moved: (1, 0, -3)
    close(track(out, 'Pony_pelvis.position'), [1, 0, -3])
    close(track(out, 'Pony_pelvis.quaternion'), QUARTER.toArray())
    close(track(out, 'Pony_leg.quaternion'), QUARTER.toArray())
    close(track(out, 'Pony_leg.position'), [0, -2, 0])
  })

  it('fits two loops by the whole cycles whose lengths agree best', () => {
    expect(wholeCycles(1, 1)).toEqual({ m: 1, n: 1, err: 0 })
    expect(wholeCycles(1, 0.5)).toEqual({ m: 1, n: 2, err: 0 })
    expect(wholeCycles(2, 3)).toEqual({ m: 3, n: 2, err: 0 })
    const near = wholeCycles(1, 1.05)
    expect([near.m, near.n]).toEqual([1, 1])
    expect(near.err).toBeCloseTo(0.05, 9)
  })
})

describe('unit export: the build record', () => {
  it('keeps the slots whole, gear referred to by its name (unknown ids as they are), the character\'s own left alone', () => {
    const c = { gear: [{ id: 'g1', name: 'GearBow', status: 'ready', handles: [], attach: { kind: 'bone', bone: 'LeftHand', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } }] } as unknown as Pick<Character, 'gear'>
    const key = { u: 0, q: [0, 0, 0, 1] as [number, number, number, number] }
    const slot: Slot = {
      id: 's1', name: 'Attack', clip: { id: 'mixamo-Shoot' }, speed: 1.2, loop: false, inPlace: true, note: 'why',
      bones: { Spine: [key] }, gear: { g1: { keys: [key], shown: [{ u: 0.5, shown: false }] }, gone: { keys: [key] } }, muted: ['gear:g1', 'bones'],
      time: { fit: { enabled: true, at: 0.45 } }, events: [{ id: 'e', name: 'hit', u: 0.5 }],
      adjustments: [
        { id: 'a2', enabled: false, kind: 'handleHold', gear: 'g1', handle: 'h1', windows: [[0.2, 0.5]] },
        { id: 'a3', enabled: true, kind: 'handPose', hand: 'Left', pose: 'clip', gear: 'g1' },
        { id: 'a4', enabled: true, kind: 'ground', lift: 0.1 },
      ],
    }
    const before = structuredClone(slot)
    const [out] = recordSlots(c, [slot])
    expect(out).toEqual({
      ...before,
      gear: { GearBow: { keys: [key], shown: [{ u: 0.5, shown: false }] }, gone: { keys: [key] } },
      muted: ['gear:GearBow', 'bones'],
      adjustments: [
        { id: 'a2', enabled: false, kind: 'handleHold', gear: 'GearBow', handle: 'h1', windows: [[0.2, 0.5]] },
        { id: 'a3', enabled: true, kind: 'handPose', hand: 'Left', pose: 'clip', gear: 'GearBow' },
        { id: 'a4', enabled: true, kind: 'ground', lift: 0.1 },
      ],
    })
    expect(slot).toEqual(before)
  })
})
