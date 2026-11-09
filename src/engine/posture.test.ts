// Posture and layers (docs/motion-plan.md §12) on a procedural person facing +Z (its left +X), baked the one way:
// a lean turns the spine about the body's left by its degrees, shared over three bones; the arms open mirrored; windows,
// fades and weights scale it; source time holds through the timing. A layer puts another clip's turns on the masked
// bones only, graded up the torso, its hips' height and never their travel, at its content's time, and a layer playing
// another slot plays that slot as it bakes (a cycle refused).
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { Adjustment, Character, ClipRef, Slot } from '../model/types.ts'
import { bakeSlot, type BakeContext } from './bake.ts'
import { captureRest } from './retarget.ts'
import { bodyAxes } from './posture.ts'
import { contentTime, maskShares, partsOf } from './layers.ts'
import { makeCharacter } from '../model/fixtures.ts'

function person (): THREE.Group {
  const root = new THREE.Group()
  const bone = (name: string, parent: THREE.Object3D, x: number, y: number, z = 0): THREE.Bone => {
    const b = new THREE.Bone(); b.name = name; b.position.set(x, y, z); parent.add(b); return b
  }
  const hips = bone('Hips', root, 0, 1)
  const spine2 = bone('Spine2', bone('Spine1', bone('Spine', hips, 0, 0.1), 0, 0.15), 0, 0.15)
  bone('Head', bone('Neck', spine2, 0, 0.15), 0, 0.1)
  for (const [side, x] of [['Left', 1], ['Right', -1]] as const) {
    const arm = bone(`${side}Arm`, bone(`${side}Shoulder`, spine2, 0.05 * x, 0.12), 0.12 * x, 0)
    bone(`${side}Hand`, bone(`${side}ForeArm`, arm, 0.2 * x, -0.2), 0.2 * x, -0.1)
    bone(`${side}Foot`, bone(`${side}Leg`, bone(`${side}UpLeg`, hips, 0.1 * x, 0), 0, -0.45), 0, -0.45)
  }
  root.updateMatrixWorld(true)
  return root
}

const deg = Math.PI / 180
const about = (axis: [number, number, number], angle: number): THREE.Quaternion => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis), angle)
const q4 = (q: THREE.Quaternion): number[] => q.toArray()
const still = (name: string, v: number[], d = 1): THREE.KeyframeTrack =>
  v.length === 3 ? new THREE.VectorKeyframeTrack(name, [0, d], [...v, ...v]) : new THREE.QuaternionKeyframeTrack(name, [0, d], [...v, ...v])

/** walk: legs swinging, the hips travelling forward 1 m and bobbing; wave: the right arm raised, the spine turned and
 * the hips sunk 0.2, still. */
const LIBRARY: Record<string, THREE.AnimationClip> = {
  walk: new THREE.AnimationClip('walk', 2, [
    new THREE.VectorKeyframeTrack('Hips.position', [0, 1, 2], [0, 1, 0, 0, 1.05, 0.5, 0, 1, 1]),
    new THREE.QuaternionKeyframeTrack('LeftUpLeg.quaternion', [0, 2], [...q4(about([1, 0, 0], 0.3)), ...q4(about([1, 0, 0], -0.3))]),
    still('Spine.quaternion', [0, 0, 0, 1], 2),
  ]),
  wave: new THREE.AnimationClip('wave', 1, [
    still('Hips.position', [0, 0.8, 0.3]),
    still('RightArm.quaternion', q4(about([0, 0, 1], -1))),
    still('Spine.quaternion', q4(about([0, 1, 0], 0.6))),
    still('Spine1.quaternion', q4(about([0, 1, 0], 0.6))),
    still('Spine2.quaternion', q4(about([0, 1, 0], 0.6))),
    still('LeftUpLeg.quaternion', q4(about([1, 0, 0], 1))),
  ]),
  /** The right arm turning 0 -> 1 rad over 1 s. */
  swing: new THREE.AnimationClip('swing', 1, [new THREE.QuaternionKeyframeTrack('RightArm.quaternion', [0, 1], [0, 0, 0, 1, ...q4(about([0, 0, 1], -1))])]),
}

function context (): BakeContext {
  const root = person()
  return { rest: captureRest(root, o => (o as THREE.Bone).isBone === true), posable: root, clips: { get: async (ref: ClipRef | string) => LIBRARY[typeof ref === 'string' ? ref : ref.id] } }
}

const slot = (o: Partial<Slot> & { adjustments: Adjustment[] }): Slot => ({ id: 's', name: 'Walk', clip: { id: 'walk' }, speed: 1, loop: true, inPlace: false, ...o })
const character = (clips: Slot[]): Character => makeCharacter({ clips, gear: [] })

/** A track's value at `t` seconds. */
function at (clip: THREE.AnimationClip, name: string, t: number): number[] {
  const track = clip.tracks.find(x => x.name === name)
  if (track === undefined) throw new Error(`no ${name}`)
  return Array.from((track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant().evaluate(t) as ArrayLike<number>)
}
/** A bone's turn at `t` (its rest's, identity here, where the clip has no track of it). */
const quat = (clip: THREE.AnimationClip, bone: string, t: number): THREE.Quaternion =>
  clip.tracks.some(x => x.name === `${bone}.quaternion`) ? new THREE.Quaternion().fromArray(at(clip, `${bone}.quaternion`, t)) : new THREE.Quaternion()
/** The spine's turn from the hips: Spine · Spine1 · Spine2. */
const spineTurn = (clip: THREE.AnimationClip, t: number): THREE.Quaternion => quat(clip, 'Spine', t).multiply(quat(clip, 'Spine1', t)).multiply(quat(clip, 'Spine2', t))
/** Degrees between two turns (by the sine of the half angle: float32 tracks and acos near 1 would read noise). */
const angleTo = (a: THREE.Quaternion, b: THREE.Quaternion): number => {
  const d = a.clone().normalize().invert().multiply(b.clone().normalize())
  return 2 * Math.asin(Math.min(1, Math.hypot(d.x, d.y, d.z))) / deg
}

describe('posture', () => {
  it('finds the body\'s axes from its rest: up, left from the thighs, forward', () => {
    const axes = bodyAxes(context().rest)
    expect(axes.left.toArray().map(x => +x.toFixed(6))).toEqual([1, 0, 0])
    expect(axes.forward.toArray().map(x => +x.toFixed(6))).toEqual([0, 0, 1])
  })

  it('leans the spine forward by its degrees, shared over its three bones, and its weight scales it', async () => {
    const ctx = context()
    const b = await bakeSlot(character([]), slot({ adjustments: [{ id: 'p', enabled: true, kind: 'posture', part: 'lean', amount: 20 }] }), ctx)
    expect(angleTo(spineTurn(b.clip, 1), about([1, 0, 0], 20 * deg))).toBeLessThan(1e-3)
    expect(angleTo(quat(b.clip, 'Spine', 1), about([1, 0, 0], 6 * deg))).toBeLessThan(1e-3)
    // (the head is ahead of the hips now)
    const half = await bakeSlot(character([]), slot({ adjustments: [{ id: 'p', enabled: true, kind: 'posture', part: 'lean', amount: 20, weight: 0.5 }] }), ctx)
    expect(angleTo(spineTurn(half.clip, 1), about([1, 0, 0], 10 * deg))).toBeLessThan(1e-3)
    expect(b.report.p).toMatchObject({ kind: 'posture', bones: ['Spine', 'Spine1', 'Spine2'] })
    // (left out by a skip, as any kind)
    const off = await bakeSlot(character([]), slot({ adjustments: [{ id: 'p', enabled: true, kind: 'posture', part: 'lean', amount: 20 }] }), ctx, { skip: ['posture'] })
    expect(angleTo(spineTurn(off.clip, 1), new THREE.Quaternion())).toBeLessThan(1e-3)
  })

  it('opens the arms mirrored: both hands rise alike', async () => {
    const ctx = context()
    const b = await bakeSlot(character([]), slot({ adjustments: [{ id: 'p', enabled: true, kind: 'posture', part: 'armsOut', amount: 30 }] }), ctx)
    expect(angleTo(quat(b.clip, 'LeftArm', 0.5), about([0, 0, 1], 30 * deg))).toBeLessThan(1e-3)
    expect(angleTo(quat(b.clip, 'RightArm', 0.5), about([0, 0, 1], -30 * deg))).toBeLessThan(1e-3)
  })

  it('plays over its windows in source time, faded in and out, whatever the speed', async () => {
    const ctx = context()
    const p: Adjustment = { id: 'p', enabled: true, kind: 'posture', part: 'nod', amount: 10, windows: [[0.5, 1]], fade: 0.25 }
    for (const speed of [1, 2]) {
      const b = await bakeSlot(character([]), slot({ speed, adjustments: [p] }), ctx)
      const d = b.clip.duration
      const nod = (v: number): number => angleTo(quat(b.clip, 'Neck', v * d).multiply(quat(b.clip, 'Head', v * d)), new THREE.Quaternion())
      expect(nod(0.25)).toBeLessThan(1e-3)
      // (a 0.25 s fade of a 2 s source is an eighth of it: half way up at 0.5625)
      expect(nod(0.5625)).toBeCloseTo(5, 1)
      expect(nod(0.8)).toBeCloseTo(10, 2)
    }
  })
})

describe('layers', () => {
  it('sorts the bones into parts and grades an upper-body mask up the torso', () => {
    const rest = context().rest
    const parts = partsOf(rest)
    expect(['Hips', 'Spine1', 'Head', 'LeftHand', 'RightForeArm', 'LeftFoot'].map(b => parts.get(b))).toEqual(['hips', 'torso', 'head', 'leftArm', 'rightArm', 'leftLeg'])
    const upper = maskShares(rest, ['torso', 'head', 'leftArm', 'rightArm'])
    expect(['Spine', 'Spine1', 'Spine2', 'Neck', 'RightHand'].map(b => +upper.get(b)!.toFixed(4))).toEqual([0.3333, 0.6667, 1, 1, 1])
    expect(upper.has('Hips') || upper.has('LeftUpLeg')).toBe(false)
    const whole = maskShares(rest, ['hips', 'torso'])
    expect(whole.get('Spine')).toBe(1)
  })

  it('reads its content from its window\'s start, holding or looping past the end', () => {
    expect(contentTime({ windows: [[0.5, 1]] }, 0.5, 2, 1)).toBeNull()
    expect(contentTime({ windows: [[0.5, 1]] }, 1.5, 2, 1)).toBeCloseTo(0.5, 9)
    expect(contentTime({ offset: 0.25 }, 1, 2, 1)).toBe(1)
    expect(contentTime({ offset: 0.25, loop: true }, 1, 2, 1)).toBeCloseTo(0.25, 9)
  })

  it('lays a clip on the upper body: its arm, a graded spine, the legs and the hips the walk\'s own', async () => {
    const ctx = context()
    const layer: Adjustment = { id: 'l', enabled: true, kind: 'layer', play: { kind: 'clip', clip: { id: 'wave' } }, mask: ['torso', 'head', 'leftArm', 'rightArm'] }
    const b = await bakeSlot(character([]), slot({ adjustments: [layer] }), ctx)
    expect(angleTo(quat(b.clip, 'RightArm', 1), about([0, 0, 1], -1))).toBeLessThan(1e-3)
    expect(angleTo(quat(b.clip, 'Spine', 1), new THREE.Quaternion().slerp(about([0, 1, 0], 0.6), 1 / 3))).toBeLessThan(1e-3)
    expect(angleTo(quat(b.clip, 'Spine2', 1), about([0, 1, 0], 0.6))).toBeLessThan(1e-3)
    expect(angleTo(quat(b.clip, 'LeftUpLeg', 1), about([1, 0, 0], 0))).toBeLessThan(1e-3)
    expect(at(b.clip, 'Hips.position', 1)).toEqual([0, 1.05, 0.5].map(x => expect.closeTo(x, 6)))
    // (the bones the wave has tracks of among the masked: the right arm and the three spine bones)
    expect(b.report.l).toMatchObject({ kind: 'layer', bones: 4 })
    // (its weight mixes it in part way; off, it isn't there)
    const half = await bakeSlot(character([]), slot({ adjustments: [{ ...layer, weight: 0.5 }] }), ctx)
    expect(angleTo(quat(half.clip, 'RightArm', 1), about([0, 0, 1], -0.5))).toBeLessThan(1e-3)
    const off = await bakeSlot(character([]), slot({ adjustments: [{ ...layer, enabled: false }] }), ctx)
    expect(angleTo(quat(off.clip, 'RightArm', 1), new THREE.Quaternion())).toBeLessThan(1e-3)
  })

  it('with the hips masked, takes their turn and height but never their travel', async () => {
    const ctx = context()
    const b = await bakeSlot(character([]), slot({ adjustments: [{ id: 'l', enabled: true, kind: 'layer', play: { kind: 'clip', clip: { id: 'wave' } }, mask: ['hips', 'leftLeg', 'rightLeg'] }] }), ctx)
    expect(at(b.clip, 'Hips.position', 1)).toEqual([0, 0.8, 0.5].map(x => expect.closeTo(x, 6)))
    expect(angleTo(quat(b.clip, 'LeftUpLeg', 1), about([1, 0, 0], 1))).toBeLessThan(1e-3)
  })

  it('plays another slot as it bakes, from its window\'s start, and refuses a cycle', async () => {
    const ctx = context()
    const swing = slot({ id: 'sw', name: 'Swing', clip: { id: 'swing' }, loop: false, adjustments: [{ id: 'p', enabled: true, kind: 'posture', part: 'shrug', amount: 15 }] })
    const walk = slot({ adjustments: [{ id: 'l', enabled: true, kind: 'layer', play: { kind: 'slot', slot: 'sw' }, mask: ['rightArm'], windows: [[0.5, 1]] }] })
    const c = character([walk, swing])
    const b = await bakeSlot(c, walk, ctx)
    // (1.5 s into the 2 s walk is 0.5 s into the swing; the swing's shrug comes with it)
    expect(angleTo(quat(b.clip, 'RightArm', 1.5), about([0, 0, 1], -0.5))).toBeLessThan(1e-2)
    expect(angleTo(quat(b.clip, 'RightShoulder', 1.5), about([0, 0, 1], -15 * deg))).toBeLessThan(1e-2)
    expect(angleTo(quat(b.clip, 'RightArm', 0.5), new THREE.Quaternion())).toBeLessThan(1e-3)
    const round: Slot = { ...swing, adjustments: [{ id: 'l2', enabled: true, kind: 'layer', play: { kind: 'slot', slot: 's' }, mask: ['torso'] }] }
    await expect(bakeSlot(character([walk, round]), walk, ctx)).rejects.toThrow(/plays itself/)
  })
})
