// @vitest-environment node
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { makeCharacter, makeGear, makeSlot } from '../model/fixtures.ts'
import { IDENTITY } from '../model/timemap.ts'
import type { Character, ClipKey, Gear, Slot } from '../model/types.ts'
import { gearEvents, holdGear, holdsAgain, holdTracks, playedGear, resolveHolds, type HoldTarget } from './geartracks.ts'
import { gearNode } from './geom.ts'
import { placementMatrix } from './placement.ts'
import { captureRest, type RestSkeleton } from './retarget.ts'

// A small body: Hips > Spine2 > RightArm > RightHand, and a LeftHand off the spine. Its clip (one second) turns the
// spine a quarter about Y, swings the arm down and walks the hips along x, so every bone moves against every other.
function body (): { root: THREE.Group, rest: RestSkeleton } {
  const root = new THREE.Group()
  const bone = (name: string, at: [number, number, number], parent: THREE.Object3D): THREE.Bone => {
    const b = new THREE.Bone(); b.name = name; b.position.set(...at); parent.add(b); return b
  }
  const hips = bone('Hips', [0, 1, 0], root)
  const spine = bone('Spine2', [0, 0.5, 0], hips)
  const arm = bone('RightArm', [-0.2, 0, 0], spine)
  bone('RightHand', [-0.5, 0, 0], arm)
  bone('LeftHand', [0.6, 0.1, 0], spine)
  root.updateMatrixWorld(true)
  return { root, rest: captureRest(root, o => (o as THREE.Bone).isBone === true) }
}

const turn = (axis: [number, number, number], deg: number): THREE.Quaternion => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis), THREE.MathUtils.degToRad(deg))

function clipOf (duration = 1): THREE.AnimationClip {
  const times = [0, duration / 2, duration]
  return new THREE.AnimationClip('Attack', duration, [
    new THREE.VectorKeyframeTrack('Hips.position', times, [0, 1, 0, 0.3, 1.05, 0, 0.6, 1, 0.1]),
    new THREE.QuaternionKeyframeTrack('Spine2.quaternion', times, [...turn([0, 1, 0], 0).toArray(), ...turn([0, 1, 0], 45).toArray(), ...turn([0, 1, 0], 90).toArray()]),
    new THREE.QuaternionKeyframeTrack('RightArm.quaternion', times, [...turn([0, 0, 1], 0).toArray(), ...turn([0, 0, 1], 40).toArray(), ...turn([1, 0, 0], 70).toArray()]),
  ])
}

const SWORD: Gear = makeGear({
  id: 'sword', name: 'Sword', from: 'emberhold:knight/Weapons_Back',
  attach: { kind: 'bone', bone: 'Spine2', place: { position: [0.1, 1.6, -0.15], rotation: [0, 0, 45], scale: 1.3 } },
  handles: [{ id: 'grip', name: 'Grip', kind: 'grip', hand: 'Right', place: { position: [0, 0.2, 0], rotation: turn([0, 0, 1], 90).toArray() as [number, number, number, number] } }],
})

/** The viewer's way of wearing it: the bone, its rest frame undone, the place node (garments.ts boneFrame). */
function wear (root: THREE.Group, rest: RestSkeleton, g: Gear): THREE.Object3D {
  const a = g.attach as Extract<Gear['attach'], { kind: 'bone' }>
  const r = rest.bones.get(a.bone)!
  const group = new THREE.Group()
  group.applyMatrix4(new THREE.Matrix4().compose(r.worldPosition, r.worldQuaternion, new THREE.Vector3(1, 1, 1)).invert())
  const node = new THREE.Group()
  node.name = gearNode(g)
  placementMatrix(a.place).decompose(node.position, node.quaternion, node.scale)
  group.add(node)
  root.getObjectByName(a.bone)!.add(group)
  root.updateMatrixWorld(true)
  return node
}

/** Every track of the clip evaluated at `t` on the objects it names. */
function poseAt (root: THREE.Object3D, clip: THREE.AnimationClip, t: number): void {
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.')
    const o = root.getObjectByName(track.name.slice(0, dot))!
    const v = (track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant().evaluate(t) as ArrayLike<number>
    const prop = track.name.slice(dot + 1)
    if (prop === 'quaternion') o.quaternion.set(v[0], v[1], v[2], v[3]).normalize()
    else (o as unknown as Record<string, THREE.Vector3>)[prop].set(v[0], v[1], v[2])
  }
  root.updateMatrixWorld(true)
}

const world = (o: THREE.Object3D): THREE.Matrix4 => o.matrixWorld.clone()
/** The largest difference between two matrices' entries. */
const apart = (a: THREE.Matrix4, b: THREE.Matrix4): number => Math.max(...a.elements.map((x, i) => Math.abs(x - b.elements[i])))

function setup (track: NonNullable<Slot['gear']>[string], o: { gear?: Gear, loop?: boolean, duration?: number } = {}): {
  c: Character, slot: Slot, root: THREE.Group, rest: RestSkeleton, node: THREE.Object3D, clip: THREE.AnimationClip, baked: THREE.AnimationClip,
  holds: ReturnType<typeof holdGear>['holds'], report: Record<string, unknown>,
} {
  const gear = o.gear ?? SWORD
  const slot = makeSlot({ id: 'atk', name: 'Attack', loop: o.loop ?? false, gear: { [gear.id]: track } })
  const c = makeCharacter({ gear: [gear], clips: [slot] })
  const { root, rest } = body()
  const node = wear(root, rest, gear)
  const clip = clipOf(o.duration)
  const report: Record<string, unknown> = {}
  const r = holdGear(c, slot, IDENTITY, clip, { rest, posable: root }, { keys: keysOf(slot), nodes: true, report })
  return { c, slot, root, rest, node, clip, baked: r.clip, holds: r.holds, report }
}

const keysOf = (slot: Slot): Record<string, ClipKey[]> => Object.fromEntries(Object.entries(slot.gear ?? {}).filter(([, t]) => t.keys !== undefined).map(([id, t]) => [id, t.keys!]))

describe('gear tracks: held by', () => {
  it('leaves a slot with no held-by or shown entries alone: the same clip, no holds', () => {
    const slot = makeSlot({ id: 'atk', gear: { sword: { keys: [{ u: 0.5, q: [0, 0, 0, 1] }] } } })
    const c = makeCharacter({ gear: [SWORD], clips: [slot] })
    const { root, rest } = body()
    wear(root, rest, SWORD)
    const clip = clipOf()
    const r = holdGear(c, slot, IDENTITY, clip, { rest, posable: root }, { keys: {}, nodes: true })
    expect(r.clip).toBe(clip)
    expect(r.holds).toEqual({})
  })

  it('changes hands without a pop: the world pose at the switch kept, then carried rigidly by the new holder', () => {
    // (0.41 s: between frames 12 and 13)
    const s = setup({ heldBy: [{ u: 0.41, bone: 'RightHand' }] })
    expect(s.holds.sword.holds.map(h => [h.bone, h.how])).toEqual([['Spine2', 'gear'], ['RightHand', 'free']])
    const spine = s.root.getObjectByName('Spine2')!; const hand = s.root.getObjectByName('RightHand')!
    const r = s.rest.bones.get('Spine2')!
    const onSpine = new THREE.Matrix4().compose(r.worldPosition, r.worldQuaternion, new THREE.Vector3(1, 1, 1)).invert().multiply(placementMatrix(SWORD.attach.place))
    // at the switch: where the spine had it
    poseAt(s.root, s.baked, 0.41)
    const expected = world(spine).multiply(onSpine)
    expect(apart(world(s.node), expected)).toBeLessThan(1e-5)
    const inHand = world(hand).invert().multiply(world(s.node))
    // before it: on the spine, as placed; after it: rigid in the hand
    for (const t of [0, 0.2, 0.4]) {
      poseAt(s.root, s.baked, t)
      expect(apart(world(s.node), world(spine).multiply(onSpine)), `on the spine at ${t}`).toBeLessThan(1e-5)
    }
    for (const t of [0.5, 2 / 3, 0.9, 1]) {
      poseAt(s.root, s.baked, t)
      expect(apart(world(hand).invert().multiply(world(s.node)), inHand), `in the hand at ${t}`).toBeLessThan(1e-5)
    }
    // its size stays the placement's (no scale track: it never hides)
    expect(s.baked.tracks.some(t => t.name.endsWith('.scale'))).toBe(false)
    expect(s.node.scale.x).toBeCloseTo(1.3, 9)
  })

  it('takes a grip handle where the handle says: the hand\'s wrist on the piece at the grip, from the switch on', () => {
    const s = setup({ heldBy: [{ u: 0.5, bone: 'RightHand', handle: 'grip' }] })
    expect(s.holds.sword.holds[1].how).toBe('handle')
    const hand = s.root.getObjectByName('RightHand')!; const spine = s.root.getObjectByName('Spine2')!
    const h = SWORD.handles[0].place!
    for (const t of [0.5, 0.8, 1]) {
      poseAt(s.root, s.baked, t)
      // (clipedit.ts handOn: the wrist at the handle's place in the piece's placed, sized frame)
      const wrist = world(s.node).multiply(new THREE.Matrix4().compose(new THREE.Vector3(...h.position), new THREE.Quaternion(...h.rotation), new THREE.Vector3(1, 1, 1)))
      const at = new THREE.Vector3(); const q = new THREE.Quaternion()
      wrist.decompose(at, q, new THREE.Vector3())
      expect(at.distanceTo(new THREE.Vector3().setFromMatrixPosition(hand.matrixWorld)), `wrist at ${t}`).toBeLessThan(1e-5)
      expect(q.angleTo(hand.getWorldQuaternion(new THREE.Quaternion())), `wrist turn at ${t}`).toBeLessThan(1e-4)
    }
    // just before the switch it is still on the spine (the jump is a step, not a tween over a frame)
    const r = s.rest.bones.get('Spine2')!
    const onSpine = new THREE.Matrix4().compose(r.worldPosition, r.worldQuaternion, new THREE.Vector3(1, 1, 1)).invert().multiply(placementMatrix(SWORD.attach.place))
    poseAt(s.root, s.baked, 0.5 - 1e-4)
    expect(apart(world(s.node), world(spine).multiply(onSpine))).toBeLessThan(1e-5)
  })

  it('goes back to its Gear placement when placed again, so a loop closes', () => {
    const s = setup({ heldBy: [{ u: 0.3, bone: 'RightHand' }, { u: 0.7, bone: 'Spine2', placed: true }] }, { loop: true })
    expect(s.holds.sword.holds.map(h => h.how)).toEqual(['gear', 'free', 'placed'])
    const p = SWORD.attach.place
    const want = new THREE.Vector3(); const wq = new THREE.Quaternion()
    placementMatrix(p).decompose(want, wq, new THREE.Vector3())
    const pos = s.baked.tracks.find(t => t.name === `${gearNode(SWORD)}.position`)!
    const at = (t: number): THREE.Vector3 => new THREE.Vector3().fromArray((pos as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant().evaluate(t) as unknown as number[])
    for (const t of [0, 0.2, 0.75, 1]) expect(at(t).distanceTo(want), `placed at ${t}`).toBeLessThan(1e-6)
    expect(at(0.5).distanceTo(want)).toBeGreaterThan(1e-3)
  })

  it('plays the slot\'s gear keys on top, in the new holder\'s placed frame', () => {
    const key = turn([1, 0, 0], 30).toArray() as [number, number, number, number]
    const s = setup({ heldBy: [{ u: 0.25, bone: 'RightHand' }], keys: [{ u: 0, q: key, p: [0, 0.1, 0] }] })
    const hand = s.root.getObjectByName('RightHand')!
    const k = new THREE.Matrix4().compose(new THREE.Vector3(0, 0.1 * 1.3, 0), new THREE.Quaternion(...key), new THREE.Vector3(1, 1, 1))
    poseAt(s.root, s.baked, 0.6)
    const unkeyed = world(hand).invert().multiply(world(s.node)).multiply(new THREE.Matrix4().makeScale(1 / 1.3, 1 / 1.3, 1 / 1.3)).multiply(k.clone().invert())
    poseAt(s.root, s.baked, 0.9)
    const again = world(hand).invert().multiply(world(s.node)).multiply(new THREE.Matrix4().makeScale(1 / 1.3, 1 / 1.3, 1 / 1.3)).multiply(k.clone().invert())
    expect(apart(unkeyed, again)).toBeLessThan(1e-5)
  })

  it('reads its moments through the slot\'s time map, and leaves out a holder the skeleton lacks', () => {
    const slot = makeSlot({ id: 'atk', gear: { sword: { heldBy: [{ u: 0.2, bone: 'RightHand' }, { u: 0.5, bone: 'Tail' }] } } })
    const map = { toPlayed: (u: number) => u * 0.5 + 0.25 }
    expect(playedGear(slot, map).sword.heldBy.map(x => x.t)).toEqual([0.35, 0.5])
    const { root, rest } = body()
    const report: Record<string, unknown> = {}
    const holds = resolveHolds(makeCharacter({ gear: [SWORD] }), playedGear(slot, map), clipOf(), { rest, posable: root }, report)
    expect(holds.sword.holds.map(h => [h.bone, +h.t.toFixed(6)])).toEqual([['Spine2', 0], ['RightHand', 0.35]])
    expect(JSON.stringify(report)).toContain('Tail: not in the skeleton')
    // (a muted track plays nothing)
    expect(playedGear({ ...slot, muted: ['gear:sword'] }, map)).toEqual({})
  })

  it('leaves the posable\'s bones as they were', () => {
    const { root, rest } = body()
    const before = root.getObjectByName('RightArm')!.quaternion.clone()
    const slot = makeSlot({ id: 'atk', gear: { sword: { heldBy: [{ u: 0.5, bone: 'RightHand' }] } } })
    resolveHolds(makeCharacter({ gear: [SWORD] }), playedGear(slot, IDENTITY), clipOf(), { rest, posable: root })
    expect(root.getObjectByName('RightArm')!.quaternion.equals(before)).toBe(true)
  })
})

describe('gear tracks: shown', () => {
  const scaleAt = (clip: THREE.AnimationClip, node: string, t: number): number =>
    ((clip.tracks.find(x => x.name === `${node}.scale`)! as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant().evaluate(t) as unknown as number[])[0]

  it('hides it over its hidden spans: a stepped scale, the placement\'s size while shown', () => {
    const s = setup({ shown: [{ u: 0.2, shown: false }, { u: 0.6, shown: true }] })
    const n = gearNode(SWORD)
    // (a step at each change: the old size held to a ten-thousandth of a second before it)
    expect([0, 0.19, 0.2001, 0.3, 0.599, 0.6001, 1].map(t => +scaleAt(s.baked, n, t).toFixed(5))).toEqual([1.3, 1.3, 0, 0, 0, 1.3, 1.3])
    // (no held-by: its moves are the keys' as before)
    expect(s.baked.tracks.some(t => t.name === `${n}.position`)).toBe(false)
    expect(s.report.gear).toEqual({ Sword: { hidden: [[0.2, 0.6]] } })
  })

  it('starts hidden from an entry at the start, and stays hidden to the end', () => {
    const s = setup({ shown: [{ u: 0, shown: false }] })
    expect(s.holds.sword.shown).toEqual([{ t: 0, shown: false }])
    expect(scaleAt(s.baked, gearNode(SWORD), 0)).toBe(0)
    expect(scaleAt(s.baked, gearNode(SWORD), 1)).toBe(0)
    // (shown all through: nothing)
    expect(setup({ shown: [{ u: 0.5, shown: true }] }).holds).toEqual({})
  })

  it('keys its size in every clip of a character that hides it somewhere, so a clip that hid it never leaves it hidden', () => {
    const idle = makeSlot({ id: 'idle', name: 'Idle' })
    const atk = makeSlot({ id: 'atk', name: 'Attack', gear: { sword: { shown: [{ u: 0.5, shown: false }] } } })
    const c = makeCharacter({ gear: [SWORD], clips: [idle, atk] })
    const { root, rest } = body()
    wear(root, rest, SWORD)
    const r = holdGear(c, idle, IDENTITY, clipOf(), { rest, posable: root }, { keys: {}, nodes: true })
    const t = r.clip.tracks.find(x => x.name === `${gearNode(SWORD)}.scale`)!
    expect(Array.from(t.values).map(x => +x.toFixed(6))).toEqual([1.3, 1.3, 1.3, 1.3, 1.3, 1.3])
    expect(r.holds).toEqual({})
  })
})

describe('gear tracks: the export and the game', () => {
  it('plays the same holds on a Prop_ bone under the attach bone, in game units', () => {
    const s = setup({ heldBy: [{ u: 0.41, bone: 'RightHand' }], shown: [{ u: 0.8, shown: false }] })
    const r = s.rest.bones.get('Spine2')!
    const R = new THREE.Matrix4().compose(r.worldPosition, r.worldQuaternion, new THREE.Vector3(1, 1, 1))
    const target: HoldTarget = { gear: SWORD, node: 'Prop_Sword', bone: 'Spine2', place: SWORD.attach.place, parent: 'bone', unit: 2, size: 1 }
    const tracks = holdTracks(s.clip, s.holds, {}, false, [target], { rest: s.rest, posable: s.root })
    expect(tracks.map(t => t.name)).toEqual(['Prop_Sword.position', 'Prop_Sword.quaternion', 'Prop_Sword.scale'])
    const view = s.baked.tracks.find(t => t.name === `${gearNode(SWORD)}.position`)!
    const viewQ = s.baked.tracks.find(t => t.name === `${gearNode(SWORD)}.quaternion`)!
    expect(Array.from(tracks[0].times)).toEqual(Array.from(view.times))
    // the viewer's node is R_A · (the bone's), the bone's moves in game units
    for (let i = 0; i < view.times.length; i++) {
      const local = new THREE.Matrix4().compose(new THREE.Vector3().fromArray(tracks[0].values, i * 3).divideScalar(2), new THREE.Quaternion().fromArray(tracks[1].values, i * 4), new THREE.Vector3(1, 1, 1))
      const node = new THREE.Matrix4().compose(new THREE.Vector3().fromArray(view.values, i * 3), new THREE.Quaternion().fromArray(viewQ.values, i * 4), new THREE.Vector3(1, 1, 1))
      expect(apart(R.clone().multiply(local), node)).toBeLessThan(1e-6)
    }
    expect(Array.from(tracks[2].values).slice(-3)).toEqual([0, 0, 0])
  })

  it('tells the game where a piece hides, shows and changes bones, by its mesh name', () => {
    const s = setup({ heldBy: [{ u: 0.3, bone: 'RightHand' }, { u: 0.7, bone: 'Spine2', placed: true }], shown: [{ u: 0.9, shown: false }] })
    const events = gearEvents(s.c, s.holds, () => true)
    expect(events).toEqual([
      { t: 0.3, name: 'detach:Weapons_Back', bone: 'Spine2' }, { t: 0.3, name: 'attach:Weapons_Back', bone: 'RightHand' },
      { t: 0.7, name: 'detach:Weapons_Back', bone: 'RightHand' }, { t: 0.7, name: 'attach:Weapons_Back', bone: 'Spine2' },
      { t: 0.9, name: 'hide:Weapons_Back' },
    ])
    expect(gearEvents(s.c, s.holds, () => false)).toEqual([])
    const hidden = setup({ shown: [{ u: 0, shown: false }, { u: 0.5, shown: true }] })
    expect(gearEvents(hidden.c, hidden.holds, () => true)).toEqual([{ t: 0, name: 'hide:Weapons_Back' }, { t: 0.5, name: 'show:Weapons_Back' }])
  })

  it('repeats the holds over a ride\'s cycles, each cycle starting as the first', () => {
    const s = setup({ heldBy: [{ u: 0.5, bone: 'RightHand' }], shown: [{ u: 0.8, shown: false }] })
    const again = holdsAgain(s.holds, 2)
    expect(again.sword.holds.map(h => [h.bone, h.t])).toEqual([['Spine2', 0], ['RightHand', 0.25], ['Spine2', 0.5], ['RightHand', 0.75]])
    expect(again.sword.shown.map(x => [x.t, x.shown])).toEqual([[0, true], [0.4, false], [0.5, true], [0.9, false]])
    expect(holdsAgain(s.holds, 1)).toBe(s.holds)
  })
})
