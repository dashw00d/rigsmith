import { describe, expect, it } from 'vitest'
import { makeCharacter, makeGear, makeSlot } from '../../model/fixtures.ts'
import type { Handle, HandPose } from '../../model/types.ts'
import { handLayers } from '../../engine/hands.ts'
import { fingerKeys, layerLinks, layerText, listText, nextName, poseUses, refKey, refOf, sourceText } from './text.ts'

const pose = (id: string, name: string, from?: HandPose['from']): HandPose => ({ id, name, side: 'Right', joints: {}, ...(from === undefined ? {} : { from }) })
const carry = (hand: 'Left' | 'Right', p?: Handle['pose']): Handle => ({ id: 'carry', name: 'Carried', kind: 'carry', hand, ...(p === undefined ? {} : { pose: p }) })
const onHand = (bone: string): { kind: 'bone', bone: string, place: { position: [number, number, number], rotation: [number, number, number], scale: number } } =>
  ({ kind: 'bone', bone, place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } })

// A bow in the left hand drawn by the right, a pinch pose, a slot that draws it and opens the left hand at the end.
function archer () {
  const bow = makeGear({
    id: 'bow', name: 'GearBow', attach: onHand('LeftHand'),
    handles: [carry('Left'), { id: 'draw', name: 'Draw', kind: 'pull', hand: 'Right', pull: { bone: 'RightHand', grip: [0, 0, 0], rest: [0, 0, 0] }, pose: { pose: 'pinch' } }],
  })
  const shot = makeSlot({
    id: 'shot', name: 'Shoot',
    adjustments: [
      { id: 'hold', kind: 'handleHold', enabled: true, gear: 'bow', handle: 'draw', windows: [[0.2, 0.6]] },
      { id: 'let', kind: 'handPose', enabled: true, hand: 'Left', pose: 'clip', windows: [[0.9, 1]], gear: 'bow' },
    ],
  })
  return makeCharacter({
    gear: [bow], clips: [shot],
    hands: { poses: [pose('pinch', 'Pinch', { clip: 'shot', at: 0.4 })], hold: { Right: { pose: 'pinch' } } },
  })
}

describe('the picker keys', () => {
  it('round-trips every kind of reference', () => {
    for (const ref of ['default', 'clip', { pose: 'abc' }, { fist: 'mixamo-2hand_Idle' }] as const) expect(refOf(refKey(ref))).toEqual(ref)
    expect(refKey(undefined)).toBe('')
    expect(refOf('')).toBeUndefined()
    expect(refOf('pose:')).toBeUndefined()
    expect(refOf('nonsense')).toBeUndefined()
  })
})

describe('layer rows', () => {
  it('says why each layer is there, its pose, and when', () => {
    const c = archer()
    const right = handLayers(c, c.clips[0], 'Right')
    expect(right.map(l => layerText(c, l))).toEqual([
      { reason: 'Held in every clip', pose: 'Pinch', when: null },
      { reason: 'Drawing GearBow · Draw', pose: 'Pinch', when: '20–60%' },
    ])
    const left = handLayers(c, c.clips[0], 'Left')
    expect(left.map(l => layerText(c, l))).toEqual([
      { reason: 'Carries GearBow', pose: 'default fist', when: null },
      { reason: 'This slot: open, carrying GearBow', pose: null, when: '90–100%' },
    ])
  })

  it('links each layer to where it is changed', () => {
    const c = archer()
    const [hold, pull] = handLayers(c, c.clips[0], 'Right')
    const [held, open] = handLayers(c, c.clips[0], 'Left')
    expect(layerLinks(hold, 'shot')).toEqual([])
    expect(layerLinks(held, 'shot').map(l => l.to)).toEqual([{ step: 'gear', gear: 'bow', handle: 'carry' }])
    expect(layerLinks(pull, 'shot').map(l => l.to)).toEqual([{ step: 'gear', gear: 'bow', handle: 'draw' }, { step: 'motion', slot: 'shot', adjustment: 'hold' }])
    expect(layerLinks(open, 'shot').map(l => l.to)).toEqual([{ step: 'motion', slot: 'shot', adjustment: 'let' }])
    // (a library clip playing has no slot to change it in)
    expect(layerLinks(open, null)).toEqual([])
  })

  it('names the fingers a slot keys on top of every layer', () => {
    const k = { u: 0, q: [0, 0, 0, 1] as [number, number, number, number] }
    const slot = makeSlot({ bones: { RightHandPinky2: [k], RightHandIndex1: [k], RightHandIndex3: [k], LeftHandThumb1: [], Spine: [k] } })
    expect(fingerKeys(slot, 'Right')).toEqual({ adjustment: 'keys', fingers: ['Index', 'Pinky'] })
    // (a finger with no keys left, and keys switched off, turn nothing)
    expect(fingerKeys(slot, 'Left')).toBeNull()
    expect(fingerKeys({ ...slot, muted: ['bone:RightHandIndex1', 'bone:RightHandIndex3'] }, 'Right')).toEqual({ adjustment: 'keys', fingers: ['Pinky'] })
    slot.muted = ['bones']
    expect(fingerKeys(slot, 'Right')).toBeNull()
    expect(fingerKeys(null, 'Right')).toBeNull()
  })

  it('says when a layer applies as Motion shows a window: in frames while the clip plays, else as parts of it', () => {
    const c = archer()
    const [, pull] = handLayers(c, c.clips[0], 'Right')
    expect(layerText(c, pull).when).toBe('20–60%')
    expect(layerText(c, pull, undefined, 30).when).toBe('frames 6–18')
    // (a slot's pose with no windows is on the whole clip)
    c.clips[0].adjustments.push({ id: 'all', kind: 'handPose', enabled: true, hand: 'Right', pose: 'clip' })
    const whole = handLayers(c, c.clips[0], 'Right').find(l => l.adjustment === 'all')
    expect(whole === undefined ? null : layerText(c, whole, undefined, 30).when).toBe('the whole clip')
  })
})

describe('poses', () => {
  it('names a new pose after the first free number', () => {
    expect(nextName([], 'Grip')).toBe('Grip')
    expect(nextName([pose('a', 'Grip'), pose('b', 'Grip 2')], 'Grip')).toBe('Grip 3')
  })

  it('says where a pose came from', () => {
    const c = archer()
    expect(sourceText(c, c.hands.poses[0])).toBe('from Shoot at 0.40 s')
    expect(sourceText(c, pose('x', 'X', { clip: 'mixamo-Golf_Post-Swing_2', at: 0.8 }))).toBe('the Golf club fist')
    expect(sourceText(c, pose('x', 'X', { clip: 'mixamo-Kick', at: 1.25 }))).toBe('from Kick at 1.25 s')
    expect(sourceText(c, pose('x', 'X'))).toBe('made by hand')
  })

  it('lists what closes a hand into a pose', () => {
    const c = archer()
    c.clips[0].adjustments.push({ id: 'p', kind: 'handPose', enabled: true, hand: 'Right', pose: { pose: 'pinch' } })
    expect(poseUses(c, 'pinch')).toEqual(['GearBow · Draw', 'Shoot (right hand)', 'the right hand in every clip'])
    expect(poseUses(c, 'other')).toEqual([])
    expect(listText(poseUses(c, 'pinch'))).toBe('GearBow · Draw, Shoot (right hand) and the right hand in every clip')
    expect(listText(['one'])).toBe('one')
  })
})
