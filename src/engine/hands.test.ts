import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { Adjustment, Character, ClipRef, Gear, Handle, HandPoseRef, Slot } from '../model/types.ts'
import { applyHands, DEFAULT_FIST, EASE, handAt, handLayers, handleRef, poseOfRef } from './hands.ts'

// ---- fixtures: v2 characters as the migration makes them --------------------------------------------------------

function character (patch: Partial<Character> = {}): Character {
  return {
    schema: 2, id: 'c1', name: 'Test', createdAt: 0, updatedAt: 0, version: 1, revision: 0, files: { rigged: 'rigged.glb' }, status: 'rigged',
    source: { file: 'source/original.glb', originalName: 'test.glb', bytes: 1, kind: 'mesh', scale: 1, warnings: [] },
    skeleton: { template: 'human', fingerLevel: 'full', overrides: {} },
    skin: { locked: false },
    hands: { poses: [] },
    gear: [], clips: [], look: { layers: [] },
    ...patch,
  }
}

const carry = (hand: 'Left' | 'Right', pose?: Handle['pose']): Handle => ({ id: 'carry', name: 'Carried', kind: 'carry', hand, ...(pose === undefined ? {} : { pose }) })

function gear (id: string, bone: string, handles: Handle[], patch: Partial<Gear> = {}): Gear {
  return { id, name: id, status: 'ready', attach: { kind: 'bone', bone, place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } }, handles, ...patch }
}

const slot = (adjustments: Adjustment[] = []): Slot => ({ id: 's1', name: 'Attack', clip: { id: 'raw' }, speed: 1, loop: false, inPlace: false, adjustments })

const bow = (pose?: Handle['pose']): Gear => gear('bow', 'LeftHand', [carry('Left'), {
  id: 'draw', name: 'Draw', kind: 'pull', hand: 'Right', pull: { bone: 'RightHand', grip: [0, 0, 0], rest: [0, 0, 0] }, ...(pose === undefined ? {} : { pose }),
}], { name: 'GearBow' })

describe('handLayers', () => {
  it('closes a hand on what it carries, with the default fist unless its handle says', () => {
    const c = character({ gear: [gear('axe', 'RightHand', [carry('Right')], { name: 'GearAxe' })] })
    expect(handLayers(c, null, 'Right')).toEqual([{ source: 'carry', ref: 'default', reason: 'carries GearAxe', gear: 'axe', handle: 'carry' }])
    expect(handLayers(c, null, 'Left')).toEqual([])
  })

  it('leaves the clip\'s own hand for a carry pose of clip, hidden gear and gear not ready', () => {
    expect(handLayers(character({ gear: [gear('prop', 'RightHand', [carry('Right', 'clip')])] }), null, 'Right')).toEqual([])
    expect(handLayers(character({ gear: [gear('axe', 'RightHand', [carry('Right')], { hidden: true })] }), null, 'Right')).toEqual([])
    expect(handLayers(character({ gear: [gear('axe', 'RightHand', [carry('Right')], { status: 'importing' })] }), null, 'Right')).toEqual([])
  })

  it('stacks carry, hold, pull and slot from the bottom', () => {
    const c = character({
      gear: [gear('spear', 'RightHand', [carry('Right')]), bow({ fist: 'pinch' })],
      hands: { poses: [], hold: { Right: { fist: 'mixamo-2hand_Idle' } } },
    })
    const s = slot([
      { id: 'open', kind: 'handPose', enabled: true, hand: 'Right', pose: 'clip', windows: [[0.9, 1]] },
      { id: 'hold', kind: 'handleHold', enabled: true, gear: 'bow', handle: 'draw', windows: [[0.5, 0.8]] },
    ])
    const layers = handLayers(c, s, 'Right')
    expect(layers.map(l => l.source)).toEqual(['carry', 'hold', 'pull', 'slot'])
    expect(layers[2]).toMatchObject({ ref: { fist: 'pinch' }, windows: [[0.5, 0.8]], reason: 'drawing GearBow · Draw', adjustment: 'hold' })
    expect(layers[3]).toMatchObject({ ref: 'clip', windows: [[0.9, 1]], reason: 'this slot: open' })
  })

  it('adds no pull layer without a pose, without a hold in the slot, or for hidden gear', () => {
    const held = slot([{ id: 'hold', kind: 'handleHold', enabled: true, gear: 'bow', handle: 'draw', windows: [[0.5, 0.8]] }])
    expect(handLayers(character({ gear: [bow()] }), held, 'Right')).toEqual([])
    expect(handLayers(character({ gear: [bow({ fist: 'pinch' })] }), slot(), 'Right')).toEqual([])
    expect(handLayers(character({ gear: [bow({ fist: 'pinch' })] }), slot([{ ...held.adjustments[0], enabled: false }]), 'Right')).toEqual([])
    expect(handLayers(character({ gear: [{ ...bow({ fist: 'pinch' }), hidden: true }] }), held, 'Right')).toEqual([])
  })

  it('takes pulls and carries from bone gear only', () => {
    const held = slot([{ id: 'hold', kind: 'handleHold', enabled: true, gear: 'bow', handle: 'draw', windows: [[0.5, 0.8]] }])
    const worn: Gear = { ...bow({ fist: 'pinch' }), attach: { kind: 'skin', policy: 'cape', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } }
    expect(handLayers(character({ gear: [worn] }), held, 'Right')).toEqual([])
    const pinned = gear('pouch', 'RightHand', [carry('Right')], { attach: { kind: 'spot', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } })
    expect(handLayers(character({ gear: [pinned] }), null, 'Right')).toEqual([])
  })

  it('keeps a carry handle\'s slot pose only while that gear is in the hand', () => {
    const open: Adjustment = { id: 'let-go', kind: 'handPose', enabled: true, hand: 'Left', pose: 'clip', windows: [[0.6, 1]], gear: 'bow' }
    expect(handLayers(character({ gear: [bow()] }), slot([open]), 'Left').map(l => l.source)).toEqual(['carry', 'slot'])
    expect(handLayers(character({ gear: [{ ...bow(), hidden: true }] }), slot([open]), 'Left')).toEqual([])
  })

  it('reproduces v1 grip scripts: a held hand wins over its carry in every clip, its open windows show the clip', () => {
    // (axe-thrower: grips on both hands, a weapon on each; v1 left the carries out)
    const c = character({
      gear: [gear('l', 'LeftHand', [carry('Left')]), gear('r', 'RightHand', [carry('Right')])],
      hands: { poses: [], hold: { Left: 'default', Right: 'default' } },
    })
    for (const side of ['Left', 'Right'] as const) {
      const top = handAt(handLayers(c, slot(), side), 0.5).layer
      expect(top?.source).toBe('hold')
      expect(top?.ref).toBe('default')
    }
    const s = slot([{ id: 'o', kind: 'handPose', enabled: true, hand: 'Right', pose: 'clip', windows: [[0.4, 0.6]] }])
    expect(handAt(handLayers(c, s, 'Right'), 0.5).layer?.ref).toBe('clip')
    expect(handAt(handLayers(c, s, 'Right'), 0.1).layer?.source).toBe('hold')
  })
})

describe('handleRef', () => {
  const grip = (pose?: Handle['pose']): Handle => ({ id: 'grip', name: 'Off hand', kind: 'grip', hand: 'Left', place: { position: [0, 0, 0.3], rotation: [0, 0, 0, 1] }, ...(pose === undefined ? {} : { pose }) })
  const spear = (carryPose?: Handle['pose'], gripPose?: Handle['pose']): Gear => gear('spear', 'RightHand', [carry('Right', carryPose), grip(gripPose)], { name: 'GearSpear' })
  const whole = (hand: 'Left' | 'Right', pose: HandPoseRef, patch: Partial<Extract<Adjustment, { kind: 'handPose' }>> = {}): Adjustment =>
    ({ id: `whole-${hand}`, kind: 'handPose', enabled: true, hand, pose, ...patch })

  it('falls back to the default fist', () => {
    const c = character({ gear: [spear()] })
    expect(handleRef(c, null, 'Right', 'spear', 'carry')).toBe('default')
    expect(handleRef(c, slot(), 'Left', 'spear', 'grip')).toBe('default')
    expect(handleRef(c, slot(), 'Left', 'gone', 'grip')).toBe('default')
  })

  it('takes a grip\'s own pose over the hand\'s hold, and the hold when the grip has none', () => {
    const hold = { poses: [], hold: { Left: { fist: 'mixamo-2hand_Idle' } } }
    expect(handleRef(character({ gear: [spear(undefined, { pose: 'wrap' })], hands: hold }), slot(), 'Left', 'spear', 'grip')).toEqual({ pose: 'wrap' })
    expect(handleRef(character({ gear: [spear()], hands: hold }), slot(), 'Left', 'spear', 'grip')).toEqual({ fist: 'mixamo-2hand_Idle' })
    expect(handleRef(character({ gear: [spear()], hands: hold }), slot(), 'Left', 'gone', 'grip')).toEqual({ fist: 'mixamo-2hand_Idle' })
  })

  it('takes a carry\'s own pose, but a hold wins over it as it does when the clip plays', () => {
    expect(handleRef(character({ gear: [spear({ fist: 'pinch' })] }), slot(), 'Right', 'spear', 'carry')).toEqual({ fist: 'pinch' })
    expect(handleRef(character({ gear: [spear('clip')] }), slot(), 'Right', 'spear', 'carry')).toBe('clip')
    const held = character({ gear: [spear({ fist: 'pinch' })], hands: { poses: [], hold: { Right: { fist: 'mixamo-Holding_Turn_Right' } } } })
    expect(handleRef(held, slot(), 'Right', 'spear', 'carry')).toEqual({ fist: 'mixamo-Holding_Turn_Right' })
  })

  it('takes the slot\'s pose for that hand over the whole clip first, not one with windows, disabled or for the other hand', () => {
    const c = character({ gear: [spear({ fist: 'pinch' }, { pose: 'wrap' })], hands: { poses: [], hold: { Left: 'default', Right: 'default' } } })
    expect(handleRef(c, slot([whole('Left', 'clip')]), 'Left', 'spear', 'grip')).toBe('clip')
    expect(handleRef(c, slot([whole('Right', { fist: 'mixamo-Walk_With_Rifle_3' })]), 'Right', 'spear', 'carry')).toEqual({ fist: 'mixamo-Walk_With_Rifle_3' })
    expect(handleRef(c, slot([whole('Left', 'clip', { windows: [[0, 0.5]] })]), 'Left', 'spear', 'grip')).toEqual({ pose: 'wrap' })
    expect(handleRef(c, slot([whole('Left', 'clip', { enabled: false })]), 'Left', 'spear', 'grip')).toEqual({ pose: 'wrap' })
    expect(handleRef(c, slot([whole('Right', 'clip')]), 'Left', 'spear', 'grip')).toEqual({ pose: 'wrap' })
    expect(handleRef(c, null, 'Left', 'spear', 'grip')).toEqual({ pose: 'wrap' })
  })

  it('keeps a carry handle\'s slot pose only while that gear is in the hand', () => {
    const open = whole('Right', 'clip', { gear: 'spear' })
    expect(handleRef(character({ gear: [spear()] }), slot([open]), 'Right', 'spear', 'carry')).toBe('clip')
    expect(handleRef(character({ gear: [{ ...spear(), hidden: true }] }), slot([open]), 'Right', 'spear', 'carry')).toBe('default')
  })

  it('agrees with the hand layers on what a carrying hand holds through the whole clip', () => {
    const cases: Array<[Gear, Character['hands'], Adjustment[]]> = [
      [spear(), { poses: [] }, []],
      [spear({ fist: 'pinch' }), { poses: [] }, []],
      [spear('clip'), { poses: [] }, []],
      [spear({ fist: 'pinch' }), { poses: [], hold: { Right: { pose: 'p1' } } }, []],
      [spear('clip'), { poses: [], hold: { Right: { pose: 'p1' } } }, []],
      [spear({ fist: 'pinch' }), { poses: [], hold: { Right: 'default' } }, [whole('Right', 'clip')]],
      [spear(), { poses: [] }, [whole('Right', { fist: 'pinch' }, { gear: 'spear' })]],
    ]
    for (const [g, hands, adjustments] of cases) {
      const c = character({ gear: [g], hands })
      const s = slot(adjustments)
      // (no layer: the clip's own hand)
      expect(handleRef(c, s, 'Right', 'spear', 'carry')).toEqual(handAt(handLayers(c, s, 'Right'), 0.5).layer?.ref ?? 'clip')
    }
  })
})

describe('handAt', () => {
  const c = character({ gear: [gear('axe', 'RightHand', [carry('Right')])] })
  const layers = handLayers(c, slot([{ id: 'o', kind: 'handPose', enabled: true, hand: 'Right', pose: 'clip', windows: [[0.5, 0.7]] }]), 'Right')

  it('picks the topmost active layer', () => {
    expect(handAt(layers, 0.6)).toEqual({ layer: layers[1], weight: 1 })
    expect(handAt(layers, 0.2)).toEqual({ layer: layers[0], weight: 1 })
    expect(handAt([], 0.2)).toEqual({ layer: null, weight: 0 })
  })

  it('eases a window in before it and lets it go quickly after', () => {
    const before = handAt(layers, 0.5 - EASE / 2)
    expect(before.layer).toBe(layers[1])
    expect(before.weight).toBeGreaterThan(0)
    expect(before.weight).toBeLessThan(1)
    expect(handAt(layers, 0.5 - EASE * 1.01).layer).toBe(layers[0])
    expect(handAt(layers, 0.7 + EASE / 2).layer).toBe(layers[0])
  })
})

// ---- a hand on a posable copy, and fist clips --------------------------------------------------------------------

const FINGER_BONES = ['Index', 'Middle'].flatMap(f => [1, 2, 3].map(i => `RightHand${f}${i}`))

function hand (): THREE.Object3D {
  const root = new THREE.Group()
  const wrist = new THREE.Bone(); wrist.name = 'RightHand'; root.add(wrist)
  for (const [f, z] of [['Index', 0.01], ['Middle', -0.01]] as const) {
    let parent: THREE.Object3D = wrist
    for (const [i, x] of [[1, 0.05], [2, 0.03], [3, 0.02]] as const) {
      const b = new THREE.Bone(); b.name = `RightHand${f}${i}`; b.position.set(x, 0, i === 1 ? z : 0)
      parent.add(b); parent = b
    }
  }
  root.updateMatrixWorld(true)
  return root
}

const about = (axis: THREE.Vector3, angle: number): THREE.Quaternion => new THREE.Quaternion().setFromAxisAngle(axis, angle)
const Z = new THREE.Vector3(0, 0, 1); const X = new THREE.Vector3(1, 0, 0)

/** A clip that closes every finger joint by `angle` halfway through (its most closed moment). */
function fistClip (angle: number): THREE.AnimationClip {
  const q = about(Z, angle).toArray()
  return new THREE.AnimationClip('fist', 1, FINGER_BONES.map(n => new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, [0, 0.5, 1], [0, 0, 0, 1, ...q, 0, 0, 0, 1])))
}

function source (clips: Record<string, THREE.AnimationClip>): { asked: string[], get: (ref: ClipRef | string) => Promise<THREE.AnimationClip> } {
  const asked: string[] = []
  return {
    asked,
    get: async ref => {
      const id = typeof ref === 'string' ? ref : ref.id
      asked.push(id)
      if (clips[id] === undefined) throw new Error(`no clip ${id}`)
      return clips[id]
    },
  }
}

const turnAt = (clip: THREE.AnimationClip, name: string, t: number): THREE.Quaternion => {
  const track = clip.tracks.find(x => x.name === name)!
  return new THREE.Quaternion().fromArray(Array.from((track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant().evaluate(t) as ArrayLike<number>))
}
const angleOf = (a: THREE.Quaternion, b: THREE.Quaternion): number => a.angleTo(b)

/** The clip a slot plays: its fingers turned 0.3 about X throughout (its own hand). */
const own = about(X, 0.3)
const played = (): THREE.AnimationClip => new THREE.AnimationClip('Attack', 1, FINGER_BONES.map(n => new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, [0, 1], [...own.toArray(), ...own.toArray()])))

describe('poseOfRef', () => {
  it('gives the clip\'s own hand for clip, the default fist for a missing pose, a fist clip\'s most closed moment', async () => {
    const clips = source({ [DEFAULT_FIST]: fistClip(1), pinch: fistClip(0.5) })
    const c = character()
    expect(await poseOfRef(hand(), 'Right', 'clip', c, clips)).toBe('clip')
    const missing = await poseOfRef(hand(), 'Right', { pose: 'gone' }, c, clips)
    expect(clips.asked).toEqual([DEFAULT_FIST])
    expect(angleOf((missing as Map<string, THREE.Quaternion>).get('RightHandIndex2')!, about(Z, 1))).toBeLessThan(1e-3)
    const pinch = await poseOfRef(hand(), 'Right', { fist: 'pinch' }, c, clips)
    expect(angleOf((pinch as Map<string, THREE.Quaternion>).get('RightHandMiddle1')!, about(Z, 0.5))).toBeLessThan(1e-3)
  })
})

describe('applyHands', () => {
  const clips = source({ [DEFAULT_FIST]: fistClip(1), pinch: fistClip(0.5) })

  it('holds a whole-clip layer still on two keys', async () => {
    const c = character({ hands: { poses: [], hold: { Right: 'default' } } })
    const { clip } = await applyHands(hand(), played(), c, slot(), clips)
    const track = clip.tracks.find(t => t.name === 'RightHandIndex2.quaternion')!
    expect(Array.from(track.times)).toEqual([0, 1])
    expect(angleOf(turnAt(clip, 'RightHandIndex2.quaternion', 0.5), about(Z, 1))).toBeLessThan(1e-3)
  })

  it('opens to the clip\'s own hand in a slot\'s window over the fist below', async () => {
    const c = character({ gear: [gear('spear', 'RightHand', [carry('Right')])] })
    const s = slot([{ id: 'o', kind: 'handPose', enabled: true, hand: 'Right', pose: 'clip', windows: [[0.4, 0.6]] }])
    const { clip, report } = await applyHands(hand(), played(), c, s, clips)
    expect(angleOf(turnAt(clip, 'RightHandIndex1.quaternion', 0.5), own)).toBeLessThan(1e-4)
    expect(angleOf(turnAt(clip, 'RightHandIndex1.quaternion', 0.1), about(Z, 1))).toBeLessThan(1e-3)
    expect(report.Right).toEqual([{ source: 'carry', reason: 'carries spear' }, { source: 'slot', reason: 'this slot: open', windows: [[0.4, 0.6]] }])
  })

  it('poses a pulling hand only while the slot holds the pull, over its own carry', async () => {
    const c = character({ gear: [gear('spear', 'RightHand', [carry('Right')]), bow({ fist: 'pinch' })] })
    const s = slot([{ id: 'h', kind: 'handleHold', enabled: true, gear: 'bow', handle: 'draw', windows: [[0.5, 1]] }])
    const { clip } = await applyHands(hand(), played(), c, s, clips)
    expect(angleOf(turnAt(clip, 'RightHandMiddle2.quaternion', 0.2), about(Z, 1))).toBeLessThan(1e-3)
    expect(angleOf(turnAt(clip, 'RightHandMiddle2.quaternion', 0.8), about(Z, 0.5))).toBeLessThan(1e-3)
  })

  it('leaves a clip without layers as it is', async () => {
    const clip = played()
    expect((await applyHands(hand(), clip, character(), slot(), clips)).clip).toBe(clip)
  })
})
