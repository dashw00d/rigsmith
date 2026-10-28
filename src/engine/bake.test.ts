import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { Adjustment, Character, ClipRef, Gear, Mount, Slot } from '../model/types.ts'
import { bakeRide, bakeSlot, gearTracks, pullPlans, type BakeContext } from './bake.ts'
import { captureRest } from './retarget.ts'

// ---- a character: a procedural skeleton with a skin (soles and a head), a spear on the right hand ----------------

const FINGERS = ['Index', 'Middle'].flatMap(f => [1, 2, 3].map(i => `RightHand${f}${i}`))

function rig (): THREE.Group {
  const root = new THREE.Group()
  const bone = (name: string, parent: THREE.Object3D, x: number, y: number, z = 0): THREE.Bone => {
    const b = new THREE.Bone(); b.name = name; b.position.set(x, y, z); parent.add(b); return b
  }
  const hips = bone('Hips', root, 0, 1)
  const spine = bone('Spine', hips, 0, 0.2)
  const hand = bone('RightHand', bone('RightArm', spine, -0.2, 0.3), -0.3, 0)
  for (const [f, z] of [['Index', 0.01], ['Middle', -0.01]] as const) {
    let parent: THREE.Object3D = hand
    for (const [i, x] of [[1, -0.05], [2, -0.03], [3, -0.02]] as const) parent = bone(`RightHand${f}${i}`, parent, x, 0, i === 1 ? z : 0)
  }
  for (const side of ['Left', 'Right']) bone(`${side}Foot`, bone(`${side}Leg`, bone(`${side}UpLeg`, hips, side === 'Left' ? 0.1 : -0.1, 0), 0, -0.45), 0, -0.45)
  const spear = new THREE.Group(); spear.name = 'Spear_place'; hand.add(spear)
  root.updateMatrixWorld(true)
  const bones: THREE.Bone[] = []
  root.traverse(o => { if ((o as THREE.Bone).isBone === true) bones.push(o as THREE.Bone) })
  // (a sole under each foot, rigid on it, and the top of the head on the spine: 1.8 tall)
  const positions: number[] = []; const skin: number[] = []
  for (const side of ['Left', 'Right']) {
    const foot = bones.findIndex(b => b.name === `${side}Foot`)
    for (const dx of [-0.03, 0, 0.03]) for (const z of [-0.05, 0, 0.05, 0.1]) { positions.push((side === 'Left' ? 0.1 : -0.1) + dx, 0, z); skin.push(foot) }
  }
  const top = bones.findIndex(b => b.name === 'Spine')
  for (const x of [-0.05, 0, 0.05]) { positions.push(x, 1.8, 0); skin.push(top) }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skin.flatMap(i => [i, 0, 0, 0]), 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skin.flatMap(() => [1, 0, 0, 0]), 4))
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial())
  root.add(mesh)
  root.updateMatrixWorld(true)
  mesh.bind(new THREE.Skeleton(bones))
  return root
}

const about = (axis: THREE.Vector3, angle: number): THREE.Quaternion => new THREE.Quaternion().setFromAxisAngle(axis, angle)
const X = new THREE.Vector3(1, 0, 0); const Z = new THREE.Vector3(0, 0, 1)
const q4 = (q: THREE.Quaternion): [number, number, number, number] => q.toArray() as [number, number, number, number]

const still = (name: string, v: number[]): THREE.KeyframeTrack =>
  v.length === 3 ? new THREE.VectorKeyframeTrack(name, [0, 1], [...v, ...v]) : new THREE.QuaternionKeyframeTrack(name, [0, 1], [...v, ...v])

/** The library: a slot's clip (its fingers turning 0 -> 1 rad about X), a fist, a sunk clip, two walks, an idle. */
const LIBRARY: Record<string, THREE.AnimationClip> = {
  raw: new THREE.AnimationClip('raw', 1, [
    still('Hips.position', [0, 1, 0]), still('Spine.quaternion', [0, 0, 0, 1]),
    ...FINGERS.map(n => new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, [0, 1], [0, 0, 0, 1, ...q4(about(X, 1))])),
  ]),
  fist: new THREE.AnimationClip('fist', 1, FINGERS.map(n => new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, [0, 0.5, 1], [0, 0, 0, 1, ...q4(about(Z, 1)), 0, 0, 0, 1]))),
  sunk: new THREE.AnimationClip('sunk', 1, [still('Hips.position', [0, 0.9, 0])]),
  slow: new THREE.AnimationClip('slow', 1, [new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 1, 0, 0, 1, 0.5])]),
  fast: new THREE.AnimationClip('fast', 1, [new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 1, 0, 0, 1, 1])]),
  idle: new THREE.AnimationClip('idle', 1, [still('Hips.position', [0, 1, 0])]),
}

function context (): BakeContext {
  const root = rig()
  return {
    rest: captureRest(root, o => (o as THREE.Bone).isBone === true),
    posable: root,
    clips: { get: async (ref: ClipRef | string) => LIBRARY[typeof ref === 'string' ? ref : ref.id] },
  }
}

const spear: Gear = {
  id: 'spear', name: 'Spear', status: 'ready', handles: [{ id: 'carry', name: 'Carried', kind: 'carry', hand: 'Right', pose: 'clip' }],
  attach: { kind: 'bone', bone: 'RightHand', place: { position: [0.2, 0, 0], rotation: [0, 0, 0], scale: 2 } },
}
const bow: Gear = {
  id: 'bow', name: 'Bow', status: 'ready', attach: { kind: 'bone', bone: 'Spine', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } },
  handles: [{ id: 'draw', name: 'Draw', kind: 'pull', hand: 'Right', pull: { bone: 'RightHand', grip: [0, 0, 0], rest: [0, 0, 0] } }],
}

function character (clips: Slot[] = [], patch: Partial<Character> = {}): Character {
  return {
    schema: 2, id: 'c1', name: 'Test', createdAt: 0, updatedAt: 0, version: 1, revision: 0, files: { rigged: 'rigged.glb' }, status: 'rigged',
    source: { file: 'source/original.glb', originalName: 'test.glb', bytes: 1, kind: 'mesh', scale: 1, warnings: [], stats: { vertices: 30, triangles: 0, height: 1.8, meshes: 1, bones: 16 } },
    skeleton: { template: 'human', fingerLevel: 'full', overrides: {} },
    skin: { locked: false },
    hands: { poses: [], hold: { Right: { fist: 'fist' } } },
    gear: [spear, bow], clips, look: { layers: [] },
    ...patch,
  }
}

const slot = (adjustments: Adjustment[], patch: Partial<Slot> = {}): Slot =>
  ({ id: 'attack', name: 'Attack', clip: { id: 'raw' }, speed: 2, loop: false, inPlace: false, adjustments, ...patch })

/** Every kind of adjustment once: the blow at 3/4 of the sped clip, landing at half of the cut; the hand open in the
 * first 30 % of the final clip; a lift; a turn on the spine; the spear moved. */
const ATTACK: Adjustment[] = [
  { id: 'keys', kind: 'keys', enabled: true, bones: { Spine: [{ u: 0, q: q4(about(X, 0.2)) }] }, gear: { spear: [{ u: 0, q: [0, 0, 0, 1], p: [0.1, 0, 0] }] } },
  { id: 'ground', kind: 'ground', enabled: true, lift: 0.1 },
  { id: 'open', kind: 'handPose', enabled: true, hand: 'Right', pose: 'clip', windows: [[0, 0.3]] },
  { id: 'blow', kind: 'blowTiming', enabled: true, at: 0.5, blowU: 0.75 },
  { id: 'draw', kind: 'handleHold', enabled: true, gear: 'bow', handle: 'draw', windows: [[0.5, 0.8]] },
]

const at = (clip: THREE.AnimationClip, name: string, t: number): number[] => {
  const track = clip.tracks.find(x => x.name === name)
  if (track === undefined) throw new Error(`no track ${name}`)
  return Array.from((track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant().evaluate(t) as ArrayLike<number>)
}
const turn = (clip: THREE.AnimationClip, name: string, t: number): THREE.Quaternion => new THREE.Quaternion().fromArray(at(clip, name, t))

describe('bakeSlot', () => {
  it('runs speed, blow timing, hands, ground, keys and gear tracks in that order', async () => {
    const s = slot(ATTACK)
    const baked = await bakeSlot(character([s]), s, context())
    const { clip } = baked
    expect(clip.name).toBe('Attack')
    // (the blow found on the sped clip: half a second long before the cut)
    expect(clip.duration).toBeCloseTo(0.25)
    expect(baked.cut?.uncut).toBeCloseTo(0.5)
    expect(baked.cut?.start).toBeCloseTo(0.25)
    expect(baked.cut?.blow).toBeCloseTo(0.375)
    expect(baked.report.blow).toMatchObject({ kind: 'blow', clip: 'Attack' })
    // (the window is a phase of the cut clip: at 10 % the clip's own hand, 0.5 + 0.05 rad of the raw turn)
    expect(turn(clip, 'RightHandIndex2.quaternion', 0.025).angleTo(about(X, 0.55))).toBeLessThan(1e-3)
    expect(turn(clip, 'RightHandIndex2.quaternion', 0.225).angleTo(about(Z, 1))).toBeLessThan(1e-3)
    expect(baked.hands.Right.map(l => l.source)).toEqual(['hold', 'slot'])
    expect(at(clip, 'Hips.position', 0.1)[1]).toBeCloseTo(1.1)
    expect(baked.lift).toBeCloseTo(0.1)
    expect(turn(clip, 'Spine.quaternion', 0.1).angleTo(about(X, 0.2))).toBeLessThan(1e-4)
    expect(turn(baked.unkeyed, 'Spine.quaternion', 0.1).angleTo(new THREE.Quaternion())).toBeLessThan(1e-4)
    expect(at(baked.unkeyed, 'Hips.position', 0.1)[1]).toBeCloseTo(1.1)
    // (the spear's key moves it in its placed, scaled frame)
    expect(at(clip, 'Spear_place.position', 0.1)[0]).toBeCloseTo(0.4)
    expect(baked.gearKeys).toEqual({ spear: [{ u: 0, q: [0, 0, 0, 1], p: [0.1, 0, 0] }] })
    expect(baked.pulls).toEqual([{ gear: 'bow', handle: 'draw', bone: 'RightHand', windows: [[0.5, 0.8]] }])
    expect(baked.raw).toBe(LIBRARY.raw)
  })

  it('plays the clip alone with skip all: speed 1, no hands, no adjustments, gear at its place', async () => {
    const s = slot(ATTACK)
    const baked = await bakeSlot(character([s]), s, context(), { skip: 'all' })
    expect(baked.clip.duration).toBeCloseTo(1)
    expect(baked.cut).toBeUndefined()
    expect(baked.lift).toBe(0)
    expect(at(baked.clip, 'Hips.position', 0.5)[1]).toBeCloseTo(1)
    expect(turn(baked.clip, 'RightHandIndex2.quaternion', 0.5).angleTo(about(X, 0.5))).toBeLessThan(1e-3)
    expect(baked.hands).toEqual({ Left: [], Right: [] })
    expect(baked.gearKeys).toEqual({})
    expect(baked.pulls).toEqual([])
    expect(at(baked.clip, 'Spear_place.position', 0.5)[0]).toBeCloseTo(0.2)
  })

  it('leaves out the kinds it is told to', async () => {
    const s = slot(ATTACK)
    const c = character([s])
    const slow = await bakeSlot(c, s, context(), { skip: ['speed'] })
    expect(slow.cut?.uncut).toBeCloseTo(1)
    expect(slow.clip.duration).toBeCloseTo(0.5)
    const open = await bakeSlot(c, s, context(), { skip: ['hands'] })
    expect(turn(open.clip, 'RightHandIndex2.quaternion', 0.225).angleTo(about(X, 0.95))).toBeLessThan(1e-3)
    expect(open.hands).toEqual({ Left: [], Right: [] })
    const plain = await bakeSlot(c, s, context(), { skip: ['blowTiming', 'keys', 'handleHold'] })
    expect(plain.cut).toBeUndefined()
    expect(plain.clip.duration).toBeCloseTo(0.5)
    expect(turn(plain.clip, 'Spine.quaternion', 0.1).angleTo(new THREE.Quaternion())).toBeLessThan(1e-4)
    expect(plain.gearKeys).toEqual({})
    expect(plain.pulls).toEqual([])
    expect(at(plain.clip, 'Spear_place.position', 0.1)[0]).toBeCloseTo(0.2)
    const off = await bakeSlot(c, { ...s, adjustments: ATTACK.map(a => ({ ...a, enabled: false })) }, context())
    expect(off.cut).toBeUndefined()
    expect(off.lift).toBe(0)
  })

  it('stands a clip on its flat feet with autoGround, on top of its lift', async () => {
    const s = slot([{ id: 'ground', kind: 'ground', enabled: true, lift: 0.05 }], { clip: { id: 'sunk' }, speed: 1 })
    const baked = await bakeSlot(character([s]), s, context(), { autoGround: true })
    expect(baked.lift).toBeCloseTo(0.1, 3)
    expect((baked.report.autoGround as { lift: number }).lift).toBeCloseTo(0.05, 3)
    expect(at(baked.clip, 'Hips.position', 0.5)[1]).toBeCloseTo(1, 3)
  })

  it('paces a slot like another (its planted foot as fast)', async () => {
    const walk: Slot = { id: 'walk', name: 'Walk', clip: { id: 'fast' }, speed: 1, loop: true, inPlace: false, adjustments: [] }
    const carry: Slot = { id: 'carry', name: 'Carry', clip: { id: 'slow' }, speed: 1, loop: true, inPlace: false, adjustments: [{ id: 'pace', kind: 'pace', enabled: true, like: 'walk' }] }
    const baked = await bakeSlot(character([walk, carry]), carry, context())
    expect(baked.clip.duration).toBeCloseTo(0.5, 2)
    expect(baked.report.pace).toMatchObject({ kind: 'pace', like: 'Walk' })
    expect((baked.report.pace as { retimed: number }).retimed).toBeCloseTo(2, 1)
  })
})

describe('pullPlans', () => {
  it('lists the enabled holds of pull handles that exist', () => {
    const s = slot([
      { id: 'a', kind: 'handleHold', enabled: true, gear: 'bow', handle: 'draw', windows: [[0.1, 0.2]] },
      { id: 'b', kind: 'handleHold', enabled: false, gear: 'bow', handle: 'draw', windows: [[0.5, 0.6]] },
      { id: 'c', kind: 'handleHold', enabled: true, gear: 'spear', handle: 'carry', windows: [[0.5, 0.6]] },
      { id: 'd', kind: 'handleHold', enabled: true, gear: 'gone', handle: 'draw', windows: [[0.5, 0.6]] },
    ])
    expect(pullPlans(character([s]), s)).toEqual([{ gear: 'bow', handle: 'draw', bone: 'RightHand', windows: [[0.1, 0.2]] }])
  })

  it('skips pulls on gear that is not on a bone', () => {
    const s = slot([{ id: 'a', kind: 'handleHold', enabled: true, gear: 'bow', handle: 'draw', windows: [[0.1, 0.2]] }])
    const worn: Gear = { ...bow, attach: { kind: 'skin', policy: 'cape', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } }
    expect(pullPlans(character([s], { gear: [spear, worn] }), s)).toEqual([])
    const pinned: Gear = { ...bow, attach: { kind: 'spot', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } }
    expect(pullPlans(character([s], { gear: [spear, pinned] }), s)).toEqual([])
  })
})

describe('gearTracks', () => {
  it('places each piece, its keys on top, in the units given', () => {
    const rest = { position: new THREE.Vector3(1, 0, 0), quaternion: new THREE.Quaternion() }
    const tracks = gearTracks(1, { spear: [{ u: 0, q: [0, 0, 0, 1], p: [0, 1, 0] }] }, false, [
      { gear: spear, node: 'Prop_Spear', rest, placeScale: 2, moveScale: 3 },
      { gear: bow, node: 'Prop_Bow', rest, placeScale: 1, moveScale: 1 },
    ])
    expect(tracks.map(t => t.name)).toEqual(['Prop_Spear.position', 'Prop_Spear.quaternion', 'Prop_Bow.position', 'Prop_Bow.quaternion'])
    expect(Array.from(tracks[0].values.slice(0, 3))).toEqual([1, 6, 0])
    expect(Array.from(tracks[2].times)).toEqual([0, 1])
  })
})

describe('bakeRide', () => {
  it('seats the rider, fits him to the horse by whole cycles and repeats his windows and gear keys', async () => {
    const s = slot([
      { id: 'draw', kind: 'handleHold', enabled: true, gear: 'bow', handle: 'draw', windows: [[0.2, 0.4]] },
      { id: 'keys', kind: 'keys', enabled: true, gear: { spear: [{ u: 0.5, q: [0, 0, 0, 1] }] } },
    ], { loop: true })
    const ctx = context()
    const rider = await bakeSlot(character([s]), s, ctx)
    expect(rider.clip.duration).toBeCloseTo(0.5)
    const horse = character([{ id: 'idle', name: 'Idle', clip: { id: 'idle' }, speed: 1, loop: true, inPlace: false, adjustments: [] }], { id: 'horse', gear: [], hands: { poses: [] } })
    const legs = q4(about(X, -1))
    const mount: Mount = { character: 'horse', bone: 'Spine', position: [0, 0, 0], rotation: [0, 0, 0], freeze: ['Hips', 'LeftUpLeg'], pose: { LeftUpLeg: legs }, hips: [0, 0.5, 0] }
    const ride = await bakeRide(rider, { c: horse, ctx: context(), slotName: 'Attack' }, mount, { loop: true, attack: false, rest: ctx.rest })
    expect(ride.cycles).toBe(2)
    expect(ride.report.horse).toBe('Idle')
    expect(ride.horse?.duration).toBeCloseTo(1)
    expect(ride.rider.clip.duration).toBeCloseTo(1)
    expect(ride.rider.pulls[0].windows).toEqual([[0.1, 0.2], [0.6, 0.7]])
    expect(ride.rider.gearKeys.spear.map(k => k.u)).toEqual([0.25, 0.75])
    expect(at(ride.rider.clip, 'Hips.position', 0.7)).toEqual([0, 0.5, 0])
    // (float32 tracks: an angle from acos of a dot near 1 makes their rounding about 2e-4 rad)
    expect(turn(ride.rider.clip, 'LeftUpLeg.quaternion', 0.7).angleTo(about(X, -1))).toBeLessThan(1e-3)
    expect(turn(ride.rider.unkeyed, 'LeftUpLeg.quaternion', 0.7).angleTo(about(X, -1))).toBeLessThan(1e-3)
  })

  it('leaves the horse still when it has no such slot and no Idle', async () => {
    const s = slot([], { loop: true })
    const ctx = context()
    const rider = await bakeSlot(character([s]), s, ctx)
    const mount: Mount = { character: 'horse', bone: 'Spine', position: [0, 0, 0], rotation: [0, 0, 0], freeze: ['Hips'], pose: {} }
    const ride = await bakeRide(rider, { c: character([], { id: 'horse' }), ctx: context(), slotName: 'Attack' }, mount, { loop: true, attack: false, rest: ctx.rest })
    expect(ride.horse).toBeNull()
    expect(ride.cycles).toBe(1)
    expect(at(ride.rider.clip, 'Hips.position', 0.2)).toEqual([0, 1, 0])
  })
})
