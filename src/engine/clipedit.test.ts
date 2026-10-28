// @vitest-environment node
// The editor's clip: a library clip retargeted onto a character and taken back (the retarget undone) is the clip it
// was (skipped without the local library and a rigged character); a live drag's solve of its frame is the build's once
// it is let go (on a person: skipped without the Y Bot and the pose model).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { captureRest, retarget } from './retarget.ts'
import {
  bonePoseAt, bonesOf, buildEdit, carrierGrip, editNameOf, frameAt, frameSolve, fromHere, gripName, handleMisses, handOn, handPoseSource, keyFor, legsOf, letGoFrames,
  mergeWindows, parseWindows, reachGoals, saveIntoSlotCommands, saveToSlotCommands, toHere, unretarget, windowsText, withoutGearKeys, type EditBody, type GearRig,
} from './clipedit.ts'
import { handleRef } from './hands.ts'
import { makeCharacter, makeGear, makeSlot } from '../model/fixtures.ts'
import { frameTimes } from './keys.ts'
import { BODY, createBodySolver, FOLLOW, PoseModel, seedOf, type BodySolveOptions, type BodySolver, type BodyState, type HandGoal, type PoseModelData } from './posespace.ts'
import type { Adjustment, Character, ClipKey, Gear, Handle, Quat, Slot } from '../model/types.ts'

const g = globalThis as Record<string, unknown>
g.self ??= globalThis
g.createImageBitmap ??= async () => { throw new Error('no images in tests') }

const ROOT = path.resolve(__dirname, '../..')
const CLIP = path.join(ROOT, 'workspace/library/clips/mixamo-Jumping_Jacks.glb')
const chars = path.join(ROOT, 'workspace/characters')
const rigged = existsSync(chars) ? readdirSync(chars).map(d => path.join(chars, d, 'rigged.glb')).find(f => existsSync(f) && !/horse|pony/.test(f)) : undefined
const have = existsSync(CLIP) && rigged !== undefined

async function load (file: string): Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }> {
  const data = readFileSync(file)
  return await new Promise((resolve, reject) => { new GLTFLoader().parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '', r => { resolve(r) }, reject) })
}
const isBone = (o: THREE.Object3D): boolean => (o as THREE.Bone).isBone === true

describe('gear grip frames', () => {
  it('reconstructs the carrying hand from fixed rest transforms, including prop scale', () => {
    const place = new THREE.Matrix4().compose(new THREE.Vector3(.2, .8, -.1), new THREE.Quaternion().setFromEuler(new THREE.Euler(.2, .7, -.3)), new THREE.Vector3(2, 2, 2))
    const rest = new THREE.Matrix4().compose(new THREE.Vector3(.1, .7, .2), new THREE.Quaternion().setFromEuler(new THREE.Euler(-.4, .1, .2)), new THREE.Vector3(1, 1, 1))
    const goal = handOn(place, { place: carrierGrip(place, rest) })
    expect(goal.at.distanceTo(new THREE.Vector3().setFromMatrixPosition(rest))).toBeLessThan(1e-8)
    expect(goal.turn.angleTo(new THREE.Quaternion().setFromRotationMatrix(rest))).toBeLessThan(1e-7)
  })

  it('reports moving gear leaving a fixed hand and restores the sampled scene', () => {
    const root = new THREE.Group()
    const left = new THREE.Bone(); left.name = 'LeftHand'
    const right = new THREE.Bone(); right.name = 'RightHand'
    const prop = new THREE.Group(); prop.name = 'spear_place'
    right.add(prop); root.add(left, right); root.updateMatrixWorld(true)
    const rig: GearRig = {
      node: () => prop.name, paths: {}, attachments: [{ hand: 'Left', gear: 'spear', handle: 'left' }], carriers: { spear: 'RightHand' }, fingers: {},
      handles: { spear: [{ id: 'left', name: 'Left grip', place: { position: [0, 0, 0], rotation: [0, 0, 0, 1] } }] },
    }
    const clip = new THREE.AnimationClip('drift', 1, [new THREE.VectorKeyframeTrack('RightHand.position', [0, 1], [0, 0, 0, .1, 0, 0])])
    expect(Math.max(...handleMisses(clip, root, rig))).toBeCloseTo(.1, 6)
    expect(right.position.length()).toBe(0)
  })
})

describe.skipIf(!have)('taking an edited clip back to the library', () => {
  it('gives back the clip it was retargeted from', async () => {
    const src = await load(CLIP)
    const target = await load(rigged!)
    const sRest = captureRest(src.scene, isBone)
    const tRest = captureRest(target.scene, isBone)
    const onTarget = retarget(src.scene, sRest, src.animations[0], tRest, { fps: 30 })
    const back = unretarget(onTarget, target.scene, tRest, sRest, src.animations[0])
    // the source as it plays, against what came back, frame by frame: every bone's local turn, and the hips
    const mixer = new THREE.AnimationMixer(src.scene)
    mixer.clipAction(src.animations[0]).play()
    let worst = 0; let hipsWorst = 0
    const per = new Map<string, number>()
    back.rotations.forEach((frame, f) => {
      mixer.setTime(Math.min(f / back.fps, src.animations[0].duration))
      back.bones.forEach((name, b) => {
        const node = sRest.bones.get(name)!.node
        const q = new THREE.Quaternion().fromArray(frame[b])
        const a = THREE.MathUtils.radToDeg(q.angleTo(node.quaternion))
        per.set(name, Math.max(per.get(name) ?? 0, a))
        worst = Math.max(worst, a)
      })
      const hips = sRest.bones.get('Hips')!.node
      hipsWorst = Math.max(hipsWorst, new THREE.Vector3().fromArray(back.hips[f]).distanceTo(hips.position))
    })
    if (worst >= 0.5) console.log([...per].filter(([, a]) => a > 0.5).map(([n, a]) => `${n} ${a.toFixed(1)}`).join(', '), 'in target:', [...per.keys()].filter(n => !tRest.bones.has(n)).join(','))
    expect(worst).toBeLessThan(0.5)
    expect(hipsWorst).toBeLessThan(0.005)
  })
})

describe('a creature\'s hips under a turning root bone', () => {
  it('keeps the root\'s turn out of the hips\' position', () => {
    const make = (): THREE.Group => {
      const scene = new THREE.Group()
      const root = new THREE.Bone(); root.name = 'root'
      const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0.5)
      const spine = new THREE.Bone(); spine.name = 'Spine'; spine.position.set(0, 0.3, 0)
      scene.add(root); root.add(hips); hips.add(spine)
      return scene
    }
    const src = make(); const tgt = make()
    const sRest = captureRest(src, isBone, n => n)
    const tRest = captureRest(tgt, isBone, n => n)
    const turned = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4)
    const clip = new THREE.AnimationClip('turn', 1, [
      new THREE.QuaternionKeyframeTrack('root.quaternion', [0, 1], [0, 0, 0, 1, ...turned.toArray()]),
    ])
    const back = unretarget(clip, tgt, tRest, sRest)
    const worst = Math.max(...back.hips.map(h => new THREE.Vector3().fromArray(h).distanceTo(new THREE.Vector3(0, 1, 0.5))))
    expect(worst).toBeLessThan(1e-4)
  })
})

describe('gear moved in the hand', () => {
  it('shifts it in its own placed frame on the keyed frames, tweened, whatever holds it staying put', async () => {
    const { buildEdit } = await import('./clipedit.ts')
    const { HUMAN_RIG } = await import('./PoseEditor.ts')
    const root = new THREE.Group()
    const hips = new THREE.Bone(); hips.name = 'Hips'
    const hand = new THREE.Bone(); hand.name = 'RightHand'; hand.position.set(0.3, 0, 0)
    const prop = new THREE.Group(); prop.name = 'Bow_place'; prop.position.set(0, 0.1, 0); prop.scale.setScalar(2)
    hips.add(hand); hand.add(prop); root.add(hips); root.updateMatrixWorld(true)
    const base = new THREE.AnimationClip('Die', 1, [
      new THREE.VectorKeyframeTrack('Bow_place.position', [0, 1], [0, 0.1, 0, 0, 0.1, 0]),
      new THREE.QuaternionKeyframeTrack('Bow_place.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    ])
    const rig: GearRig = {
      node: id => (id === 'bow' ? 'Bow_place' : `${id}_place`), attachments: [], carriers: { bow: 'RightHand' }, fingers: {}, handles: {},
      // (let go of on the last frame: half a meter down in its own frame, a quarter turn)
      paths: { bow: { locked: false, keys: [{ u: 0, q: [0, 0, 0, 1], p: [0, 0, 0] }, { u: 1, q: [0, 0, Math.SQRT1_2, Math.SQRT1_2], p: [0, -0.5, 0] }] } },
    }
    const clip = buildEdit(base, {}, false, () => null, root, HUMAN_RIG, -10, null, rig, 1, null)
    const pos = clip.tracks.find(t => t.name === 'Bow_place.position')!
    const at = (i: number): number[] => Array.from(pos.values.slice(i * 3, i * 3 + 3))
    // first frame: where its placement holds it; last: moved by the key in its placed frame (its scale 2: one meter)
    expect(at(0)[1]).toBeCloseTo(0.1, 6)
    expect(at(pos.times.length - 1)[1]).toBeCloseTo(0.1 - 1, 6)
    // halfway: tweened
    expect(at(Math.floor(pos.times.length / 2))[1]).toBeGreaterThan(0.1 - 1)
    expect(at(Math.floor(pos.times.length / 2))[1]).toBeLessThan(0.1)
    // the hand holding it never moved
    expect(clip.tracks.some(t => t.name.startsWith('RightHand.'))).toBe(false)
  })
})

describe('windows typed as text', () => {
  it('reads them as they are shown, in percent, with a dash or a hyphen', () => {
    expect(parseWindows('50–80%')).toEqual([[0.5, 0.8]])
    expect(parseWindows('50-80%')).toEqual([[0.5, 0.8]])
    expect(parseWindows('50%–80%, 90 - 100 %')).toEqual([[0.5, 0.8], [0.9, 1]])
    expect(parseWindows('45.7–80%')).toEqual([[0.457, 0.8]])
    // (percent and phases mixed, part by part)
    expect(parseWindows('20–50%, 0.8-1')).toEqual([[0.2, 0.5], [0.8, 1]])
    // (no %: phases, so 50-80 is a typo, said)
    expect(parseWindows('50-80')).toBeNull()
    expect(parseWindows('50–120%')).toBeNull()
    expect(parseWindows('50%')).toBeNull()
  })

  it('reads parts of a clip, merged and sorted, and says when a part can\'t be read', () => {
    expect(parseWindows('0.2-0.5, 0.8-1')).toEqual([[0.2, 0.5], [0.8, 1]])
    expect(parseWindows('0.8 - 1; .2–.5')).toEqual([[0.2, 0.5], [0.8, 1]])
    expect(parseWindows('0.1-0.4, 0.3-0.6')).toEqual([[0.1, 0.6]])
    expect(parseWindows('0.5 to 0.2')).toEqual([[0.2, 0.5]])
    expect(parseWindows('')).toEqual([])
    expect(parseWindows('never')).toEqual([])
    expect(parseWindows('0.2-0.5, oops')).toBeNull()
    expect(parseWindows('0.2-1.5')).toBeNull()
    expect(parseWindows('0.5')).toBeNull()
  })

  it('shows them as everywhere, in percent, and reads that back as it was', () => {
    expect(windowsText([[0.2, 0.5], [0.8, 1]])).toBe('20–50%, 80–100%')
    expect(windowsText([[0, 0.457]])).toBe('0–45.7%')
    expect(windowsText([[1 / 3, 2 / 3]])).toBe('33.3–66.7%')
    expect(windowsText(undefined)).toBe('')
    expect(windowsText([])).toBe('')
    for (const w of [[[0.2, 0.5], [0.8, 1]], [[0.001, 0.457]], [[0.1, 0.999]]] as Array<Array<[number, number]>>) expect(parseWindows(windowsText(w))).toEqual(w)
  })

  it('opens from the frame shown to the end, and lets go there', () => {
    expect(fromHere([[0.1, 0.2]], 0.6)).toEqual([[0.1, 0.2], [0.6, 1]])
    expect(fromHere([[0.5, 0.7]], 0.6)).toEqual([[0.5, 1]])
    expect(toHere([[0.1, 0.4], [0.6, 1]], 0.7)).toEqual([[0.1, 0.4], [0.6, 0.7]])
    expect(toHere([[0.6, 1]], 0.5)).toEqual([])
  })

  it('merges windows that touch, drops empty ones and keeps them in the clip', () => {
    expect(mergeWindows([[0.5, 0.6], [0.2, 0.5], [0.9, 0.9], [-1, 0.1]])).toEqual([[0, 0.1], [0.2, 0.6]])
  })
})

describe('names', () => {
  it('offers "<clip> edit" once, never "edit edit"', () => {
    expect(editNameOf('Attack')).toBe('Attack edit')
    expect(editNameOf('Attack edit')).toBe('Attack edit')
    expect(editNameOf('Attack edit 2')).toBe('Attack edit 2')
    expect(editNameOf('Attack (editing)')).toBe('Attack edit')
    expect(editNameOf('Attack edit (naturalized)')).toBe('Attack edit')
    expect(editNameOf('  ')).toBe('Clip edit')
  })

  it('names a new grip handle after its hand, numbered when taken', () => {
    expect(gripName('Left', ['Carried'])).toBe('Left grip')
    expect(gripName('Left', ['Left grip', 'Left grip 2'])).toBe('Left grip 3')
  })
})

describe('saving an edit to its slot', () => {
  const adjustments: Adjustment[] = [
    { id: 'g', kind: 'ground', enabled: true, lift: 0.02 },
    { id: 'b', kind: 'blowTiming', enabled: true, at: 0.45 },
    { id: 'p', kind: 'pace', enabled: false, like: 'walk' },
    { id: 'h', kind: 'handPose', enabled: true, hand: 'Left', pose: 'clip', windows: [[0.5, 1]], gear: 'bow' },
    { id: 'hh', kind: 'handleHold', enabled: true, gear: 'bow', handle: 'draw', windows: [[0.2, 0.6]] },
    { id: 'k', kind: 'keys', enabled: true, bones: { Spine: [{ u: 0.5, q: [0, 0, 0, 1] }] } },
  ]
  const slot: Slot = { id: 's1', name: 'Attack', clip: { id: 'mixamo-Slash' }, speed: 1.4, loop: false, inPlace: true, adjustments }
  const keys = { bow: [{ u: 0, q: [0, 0, 0, 1] as [number, number, number, number], p: [0, 0, 0] as [number, number, number] }] }
  let n = 0
  const newId = (): string => `new${++n}`

  it('as it plays: one fill at speed 1, baked kinds gone, ground and windows kept, gear keys from the edit', () => {
    const [cmd] = saveToSlotCommands(slot, 'plays', { id: 'custom-Attack_Edit' }, { loop: false, gearKeys: keys, newId })
    expect(cmd).toMatchObject({ type: 'slot.fill', id: 's1', clip: { id: 'custom-Attack_Edit' }, speed: 1, loop: false, inPlace: true, keepAdjustments: false })
    const kept = (cmd as { adjustments: Adjustment[] }).adjustments
    // (the disabled pace played no part: it stays as it was)
    expect(kept.map(a => a.id)).toEqual(['g', 'p', 'h', 'hh', 'k'])
    expect(kept.find(a => a.id === 'k')).toEqual({ id: 'k', kind: 'keys', enabled: true, gear: keys })
  })

  it('as it plays, no gear moved: the keys on bones are baked and go', () => {
    const [cmd] = saveToSlotCommands(slot, 'plays', { id: 'x' }, { loop: true, gearKeys: {}, newId })
    expect((cmd as { adjustments: Adjustment[] }).adjustments.map(a => a.kind)).toEqual(['ground', 'pace', 'handPose', 'handleHold'])
  })

  it('the clip alone: speed and adjustments kept, gear the edit moved keyed on top', () => {
    const [cmd] = saveToSlotCommands(slot, 'alone', { id: 'x' }, { loop: false, gearKeys: keys, newId })
    expect(cmd).toMatchObject({ type: 'slot.fill', id: 's1', speed: 1.4, keepAdjustments: true })
    expect((cmd as { adjustments: Adjustment[] }).adjustments).toEqual([{ id: expect.stringMatching(/^new/) as unknown as string, kind: 'keys', enabled: true, gear: keys }])
  })

  it('copies what it keeps (the slot may be live state)', () => {
    const [cmd] = saveToSlotCommands(slot, 'plays', { id: 'x' }, { loop: false, gearKeys: {}, newId })
    const ground = (cmd as { adjustments: Adjustment[] }).adjustments[0]
    expect(ground).toEqual(adjustments[0])
    expect(ground).not.toBe(adjustments[0])
  })
})

describe('saving an edit as one of the character\'s slots', () => {
  const adjustments: Adjustment[] = [
    { id: 'g', kind: 'ground', enabled: true, lift: 0.02 },
    { id: 'b', kind: 'blowTiming', enabled: true, at: 0.45 },
    { id: 'h', kind: 'handPose', enabled: true, hand: 'Left', pose: 'clip', windows: [[0.5, 1]], gear: 'bow' },
    { id: 'hh', kind: 'handleHold', enabled: true, gear: 'bow', handle: 'draw', windows: [[0.2, 0.6]] },
  ]
  const idle: Slot = { id: 's1', name: 'Idle', clip: { id: 'mixamo-Idle' }, speed: 1.2, loop: true, inPlace: true, adjustments }
  const run: Slot = { id: 's2', name: 'Run', clip: { id: 'mixamo-Run' }, speed: 1.5, loop: true, inPlace: true, adjustments: [{ id: 'old', kind: 'pace', enabled: true, like: 's1' }] }
  const keys = { bow: [{ u: 0, q: [0, 0, 0, 1] as [number, number, number, number] }] }
  let n = 0
  const newId = (): string => `new${++n}`
  const o = { loop: false, inPlace: false, lift: 0.03, gearKeys: {}, newId }

  it('into the slot it was made on: as saving to it does', () => {
    expect(saveIntoSlotCommands({ slot: idle, name: 'Idle' }, { slot: idle, mode: 'plays' }, { id: 'x' }, o))
      .toEqual(saveToSlotCommands(idle, 'plays', { id: 'x' }, { loop: true, gearKeys: {}, newId }).map(c => ({ ...c, adjustments: expect.any(Array) as unknown })))
  })

  it('over another slot: speed 1, its loop and in place kept, its old adjustments gone, the edit\'s ground, hands and gear keys', () => {
    const [cmd] = saveIntoSlotCommands({ slot: run, name: 'Run' }, { slot: idle, mode: 'plays' }, { id: 'custom-Run' }, { ...o, gearKeys: keys })
    expect(cmd).toMatchObject({ type: 'slot.fill', id: 's2', clip: { id: 'custom-Run' }, speed: 1, loop: true, inPlace: true, keepAdjustments: false })
    const got = (cmd as { adjustments: Adjustment[] }).adjustments
    expect(got.map(a => a.kind)).toEqual(['ground', 'handPose', 'handleHold', 'keys'])
    expect(got[0]).toMatchObject({ lift: 0.03 })
    // (copies with ids of their own: the slot they came from keeps its own)
    expect(got.every(a => /^new/.test(a.id))).toBe(true)
    expect(got[1]).not.toBe(adjustments[2])
  })

  it('a new clip held from a frame, or a library preview: a new slot by the name, the edit\'s loop and in place, no hands copied', () => {
    const [cmd] = saveIntoSlotCommands({ slot: null, name: 'Attack' }, { slot: null, mode: 'held' }, { id: 'custom-Attack' }, { ...o, lift: 0 })
    expect(cmd).toMatchObject({ type: 'slot.fill', name: 'Attack', clip: { id: 'custom-Attack' }, loop: false, inPlace: false, adjustments: [] })
    expect((cmd as { newId?: string }).newId).toMatch(/^new/)
  })

  it('a slot\'s clip alone saved over another: nothing of the slot it was made on comes with it', () => {
    const [cmd] = saveIntoSlotCommands({ slot: run, name: 'Run' }, { slot: idle, mode: 'alone' }, { id: 'x' }, { ...o, lift: 0 })
    expect((cmd as { adjustments: Adjustment[] }).adjustments).toEqual([])
  })
})

describe('an edit opened again from its record', () => {
  it('leaves out the slot\'s keys on the pieces the record\'s paths move again, and nothing else', () => {
    const k = (u: number): { u: number, q: [number, number, number, number] } => ({ u, q: [0, 0, 0, 1] })
    const adjustments: Adjustment[] = [
      { id: 'g', kind: 'ground', enabled: true, lift: 0.02 },
      { id: 'k', kind: 'keys', enabled: true, bones: { Spine: [k(0.5)] }, gear: { spear: [k(0)], shield: [k(0.2)] } },
    ]
    expect(withoutGearKeys(adjustments, ['spear'])).toEqual([adjustments[0], { id: 'k', kind: 'keys', enabled: true, bones: { Spine: [k(0.5)] }, gear: { shield: [k(0.2)] } }])
    // (nothing left on it: it goes)
    expect(withoutGearKeys([{ id: 'k', kind: 'keys', enabled: true, gear: { spear: [k(0)] } }], ['spear'])).toEqual([])
    // (its bones' keys keep it)
    expect(withoutGearKeys([{ id: 'k', kind: 'keys', enabled: true, bones: { Spine: [k(0.5)] }, gear: { spear: [k(0)] } }], ['spear'])).toEqual([{ id: 'k', kind: 'keys', enabled: true, bones: { Spine: [k(0.5)] } }])
    expect(withoutGearKeys(adjustments, [])).toEqual(adjustments)
    // (the slot's own list is left as it was)
    expect((adjustments[1] as { gear?: object }).gear).toEqual({ spear: [k(0)], shield: [k(0.2)] })
  })
})

describe('which setting a hand\'s pose on gear is read from', () => {
  const spear = makeGear({
    id: 'spear', name: 'Spear', attach: { kind: 'bone', bone: 'RightHand', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } },
    handles: [{ id: 'carry', name: 'Carried', kind: 'carry', hand: 'Right' }, { id: 'grip', name: 'Left grip', kind: 'grip', hand: 'Left', place: { position: [0, 0.4, 0], rotation: [0, 0, 0, 1] } }],
  })
  const posed = (g: Gear, handle: string, pose: Handle['pose']): Gear => ({ ...g, handles: g.handles.map(h => (h.id === handle ? { ...h, pose } : h)) })
  const fist = { fist: 'mixamo-Holding_Turn_Right' }

  it('is the one the hands resolver reads (its order is the resolver\'s), and changes nothing', () => {
    const slot = makeSlot()
    const c = makeCharacter({ gear: [spear] })
    // (nothing set: the default fist, read from no setting)
    expect(handPoseSource(c, slot, 'Left', 'spear', 'grip')).toBeNull()
    // a hold in every clip decides for a hand on a grip of no pose of its own...
    const held: Character = makeCharacter({ gear: [spear], hands: { hold: { Left: fist } } })
    expect(handPoseSource(held, slot, 'Left', 'spear', 'grip')).toEqual({ kind: 'hold' })
    // ...the grip's own pose wins over it...
    const gripped: Character = { ...held, gear: [posed(spear, 'grip', 'clip')] }
    expect(handPoseSource(gripped, slot, 'Left', 'spear', 'grip')).toMatchObject({ kind: 'handle', handle: { id: 'grip' } })
    // ...and the slot's own pose over the whole clip over both (a pose in windows, or switched off, doesn't count)
    const own = makeSlot({
      adjustments: [
        { id: 'w', kind: 'handPose', enabled: true, hand: 'Left', pose: 'clip', windows: [[0.2, 0.5]] },
        { id: 'off', kind: 'handPose', enabled: false, hand: 'Left', pose: 'clip' },
        { id: 'a', kind: 'handPose', enabled: true, hand: 'Left', pose: 'default' },
      ],
    })
    expect(handPoseSource(gripped, own, 'Left', 'spear', 'grip')).toEqual({ kind: 'slot', adjustment: 'a' })
    // the carrying hand: its carry handle's pose, unless a hold (which wins over a carry) is set
    const carried: Character = { ...c, gear: [posed(spear, 'carry', fist)] }
    expect(handPoseSource(carried, slot, 'Right', 'spear', 'carry')).toMatchObject({ kind: 'handle', handle: { id: 'carry' } })
    expect(handPoseSource({ ...carried, hands: { poses: [], hold: { Right: 'default' } } }, slot, 'Right', 'spear', 'carry')).toEqual({ kind: 'hold' })
    // (whatever it found, the resolver still answers as before)
    expect(handleRef(gripped, own, 'Left', 'spear', 'grip')).toBe('default')
    expect(handleRef(carried, slot, 'Right', 'spear', 'carry')).toEqual(fist)
    expect(gripped.hands.hold).toEqual({ Left: fist })
  })

  it('reads a grip not made yet (no handle) as having no pose of its own', () => {
    const held: Character = makeCharacter({ gear: [spear], hands: { hold: { Left: fist } } })
    expect(handPoseSource(held, null, 'Left', 'spear', '')).toEqual({ kind: 'hold' })
    expect(handPoseSource(makeCharacter({ gear: [spear] }), null, 'Left', 'spear', '')).toBeNull()
  })
})

/** Two arms off a chest at 1.4 m, out along x, at rest (no turns), a spear's node in the right hand. */
function arms (): { root: THREE.Group, bones: Map<string, THREE.Bone>, spear: THREE.Group } {
  const root = new THREE.Group()
  const bone = (name: string, at: [number, number, number], parent: THREE.Object3D): THREE.Bone => { const b = new THREE.Bone(); b.name = name; b.position.set(...at); parent.add(b); return b }
  const hips = bone('Hips', [0, 1, 0], root)
  const chest = bone('Spine2', [0, 0.4, 0], hips)
  for (const [side, x] of [['Left', 1], ['Right', -1]] as const) {
    const arm = bone(`${side}Arm`, [0.2 * x, 0, 0], chest)
    bone(`${side}Hand`, [0.25 * x, 0, 0], bone(`${side}ForeArm`, [0.3 * x, 0, 0], arm))
  }
  const spear = new THREE.Group(); spear.name = 'Spear_place'
  const bones = new Map<string, THREE.Bone>()
  root.traverse(o => { if ((o as THREE.Bone).isBone === true) bones.set(o.name, o as THREE.Bone) })
  bones.get('RightHand')!.add(spear)
  root.updateMatrixWorld(true)
  return { root, bones, spear }
}

describe('the hands by IK alone (no pose model)', () => {
  it('reaches each arm to its goal, its turn as asked and its fingers closed', () => {
    const { bones } = arms()
    const finger = new THREE.Bone(); finger.name = 'LeftHandIndex1'; bones.get('LeftHand')!.add(finger); bones.set(finger.name, finger)
    const at = new THREE.Vector3(0.3, 1.2, 0.3)
    const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.2, 0))
    const miss = reachGoals(bones, [{ hand: 'Left', at, turn, fingers: { LeftHandIndex1: [0, 0, Math.SQRT1_2, Math.SQRT1_2] } }], { limits: null, nameOf: b => b.name })
    expect(miss).toBeLessThan(1e-4)
    const hand = bones.get('LeftHand')!
    expect(hand.getWorldPosition(new THREE.Vector3()).distanceTo(at)).toBeLessThan(1e-4)
    expect(hand.getWorldQuaternion(new THREE.Quaternion()).angleTo(turn)).toBeLessThan(1e-6)
    expect(finger.quaternion.angleTo(new THREE.Quaternion(0, 0, Math.SQRT1_2, Math.SQRT1_2))).toBeLessThan(1e-6)
    // (the other arm untouched)
    expect(bones.get('RightArm')!.quaternion.angleTo(new THREE.Quaternion())).toBe(0)
  })

  it('builds an edit whose free hand stays on its handle of the gear the other hand carries', async () => {
    const { buildEdit } = await import('./clipedit.ts')
    const { HUMAN_RIG } = await import('./PoseEditor.ts')
    const { root } = arms()
    // (the right arm swings forward over the clip, carrying the spear; the left hand holds it 60 cm along, a little ahead)
    const swing = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6)
    const base = new THREE.AnimationClip('Swing', 1, [new THREE.QuaternionKeyframeTrack('RightArm.quaternion', [0, 1], [0, 0, 0, 1, ...swing.toArray()])])
    const rig: GearRig = {
      node: () => 'Spear_place', paths: {}, attachments: [{ hand: 'Left', gear: 'spear', handle: 'left' }], carriers: { spear: 'RightHand' }, fingers: {},
      handles: { spear: [{ id: 'left', name: 'Left grip', place: { position: [0.6, 0, 0.2], rotation: [0, 0, 0, 1] } }] },
    }
    const clip = buildEdit(base, {}, false, () => null, root, HUMAN_RIG, 0, null, rig, 1.8, null)
    expect(clip.tracks.some(t => t.name === 'LeftArm.quaternion')).toBe(true)
    expect(Math.max(...handleMisses(clip, root, rig))).toBeLessThan(1e-3)
  })
})

describe('a clip\'s pose at a time', () => {
  it('reads every bone\'s local turn and place there, and leaves the bones as they were', () => {
    const { root, bones } = arms()
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.8)
    const clip = new THREE.AnimationClip('Raise', 1, [
      new THREE.QuaternionKeyframeTrack('LeftArm.quaternion', [0, 1], [0, 0, 0, 1, ...turn.toArray()]),
      new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 1, 0, 0, 0.8, 0]),
    ])
    const pose = bonePoseAt(clip, root, 1)
    expect(pose.get('LeftArm')!.q.angleTo(turn)).toBeLessThan(1e-3) // (float32 track: acos near 1 shows its rounding)
    expect(pose.get('Hips')!.p.y).toBeCloseTo(0.8, 6)
    expect(pose.get('RightArm')!.q.angleTo(new THREE.Quaternion())).toBeLessThan(1e-9)
    expect(bones.get('LeftArm')!.quaternion.angleTo(new THREE.Quaternion())).toBe(0)
    expect(bones.get('Hips')!.position.y).toBe(1)
  })
})

// ---- a live drag and its release -----------------------------------------------------------------------------------

const wp = (o: THREE.Object3D): THREE.Vector3 => o.getWorldPosition(new THREE.Vector3())
const wq = (o: THREE.Object3D): THREE.Quaternion => o.getWorldQuaternion(new THREE.Quaternion())

/** Every bone's local turn and place as `root` stands now (its rest, read before anything moves it). */
function restOf (root: THREE.Object3D): (bone: string) => { q: THREE.Quaternion, p: THREE.Vector3 } | null {
  const rest = new Map([...bonesOf(root)].map(([n, b]) => [n, { q: b.quaternion.clone(), p: b.position.clone() }]))
  return n => rest.get(n) ?? null
}

/** `root` put at rest, then posed as `clip` has it at `t` (as the build poses a frame). */
function poseAt (clip: THREE.AnimationClip, root: THREE.Object3D, t: number, rest: (bone: string) => { q: THREE.Quaternion, p: THREE.Vector3 } | null): void {
  for (const b of bonesOf(root).values()) { const r = rest(b.name); if (r !== null) { b.quaternion.copy(r.q); b.position.copy(r.p) } }
  const mixer = new THREE.AnimationMixer(root)
  const a = mixer.clipAction(clip); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.play()
  mixer.setTime(t)
  root.updateMatrixWorld(true)
}

/** A solver that moves nothing: it notes what each frame's solve is handed, and hands the next frame a state numbered
 * by the solves so far. */
function spySolver (): { solver: BodySolver, calls: Array<{ goals: HandGoal[], opts: BodySolveOptions, prev: BodyState | null }> } {
  const calls: Array<{ goals: HandGoal[], opts: BodySolveOptions, prev: BodyState | null }> = []
  const solver: BodySolver = (_bones, goals, opts, prev) => {
    calls.push({ goals: goals.map(g => ({ ...g, at: g.at.clone(), turn: g.turn.clone() })), opts, prev })
    return { state: { yaw: calls.length, lean: 0, forward: 0, drop: 0, warm: Float64Array.of(calls.length) }, miss: 0 }
  }
  return { solver, calls }
}

function sameGoals (a: HandGoal[], b: HandGoal[]): void {
  expect(a.map(g => g.hand)).toEqual(b.map(g => g.hand))
  a.forEach((g, k) => {
    expect(g.at.distanceTo(b[k].at)).toBeLessThan(1e-5)
    expect(g.turn.angleTo(b[k].turn)).toBeLessThan(1e-5)
    expect(g.exact).toBe(b[k].exact)
  })
}

/** What a frame's solve options say besides the seed and the mode (which are a live drag's own). */
const shared = (o: BodySolveOptions): Record<string, unknown> => ({ follow: o.follow, height: o.height, floor: o.floor, soles: o.soles, legs: o.legs.length, soft: o.soft, obstacles: o.obstacles?.length, limits: o.limits })

describe('a live drag solves its frame as the build will once it is let go', () => {
  /** The arms with the spear swung by the right arm, the left hand on a grip of it. */
  const setup = (): { root: THREE.Group, bones: Map<string, THREE.Bone>, rest: ReturnType<typeof restOf>, base: THREE.AnimationClip, gear: GearRig, body: EditBody, frames: number } => {
    const { root, bones } = arms()
    const rest = restOf(root)
    const swing = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6)
    const base = new THREE.AnimationClip('Swing', 1, [new THREE.QuaternionKeyframeTrack('RightArm.quaternion', [0, 1], [0, 0, 0, 1, ...swing.toArray()])])
    const gear: GearRig = {
      node: () => 'Spear_place', paths: {}, attachments: [{ hand: 'Left', gear: 'spear', handle: 'left' }], carriers: { spear: 'RightHand' }, fingers: {},
      handles: { spear: [{ id: 'left', name: 'Left grip', place: { position: [0.6, 0, 0.2], rotation: [0, 0, 0, 1] } }] },
    }
    return { root, bones, rest, base, gear, body: { hips: 'Hips', legs: [], soles: [], floor: 0, height: 1.8, limits: null }, frames: frameTimes(base.duration).length }
  }

  it('follows the frame before as the last build did, on a frame no key lets go on (a hand on its handle dragged)', async () => {
    const { HUMAN_RIG } = await import('./PoseEditor.ts')
    const { root, bones, rest, base, gear, body, frames } = setup()
    const i = 12; const u = i / (frames - 1)
    expect(frameAt(u, frames)).toBe(i)
    const before = spySolver(); const states: Array<BodyState | null> = []
    buildEdit(base, {}, false, rest, root, HUMAN_RIG, 0, null, gear, 1.8, before.solver, { states })
    expect(states).toHaveLength(frames)
    expect(states[0]).toBeNull()
    // the drag, live: the frame as keyed (no keys yet); letting go keys nothing here
    poseAt(base, root, u, rest)
    const live = frameSolve(root, bones, gear, { u, i, loop: false, places: new Map(), letGo: letGoFrames({}, undefined, frames).has(i), quick: true }, body)
    // let go: the build again, seeded on that frame
    const after = spySolver()
    buildEdit(base, {}, false, rest, root, HUMAN_RIG, 0, null, gear, 1.8, after.solver, { seed: { u, pose: seedOf(bones) } })
    const release = after.calls[i]
    expect(live.opts.follow).toBe(FOLLOW.weight)
    expect(shared(live.opts)).toEqual(shared(release.opts))
    // (the frame before's state, as the last build handed it, is what the live solve follows)
    expect(release.prev).toEqual(states[i])
    sameGoals(live.goals, release.goals)
    expect(live.opts.quick).toBe(true)
    expect(release.opts.quick).toBeUndefined()
    expect(release.opts.seed).toBeDefined()
    expect(after.calls.filter(c => c.opts.seed !== undefined)).toHaveLength(1)
  })

  it('does not follow on the frame a key lets go on, live or built (a free bone dragged)', async () => {
    const { HUMAN_RIG } = await import('./PoseEditor.ts')
    const { root, bones, rest, base, gear, body, frames } = setup()
    const i = 12; const u = i / (frames - 1)
    // the drag, live: the chest leant (no hand on gear holds it, so letting go keys it on this frame)
    poseAt(base, root, u, rest)
    const chest = bones.get('Spine2')!
    chest.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.2))
    root.updateMatrixWorld(true)
    const keys: Record<string, ClipKey[]> = { Spine2: [{ u: 0, q: [0, 0, 0, 1] }, keyFor(base, chest, u, u, rest('Spine2')!, false), { u: 1, q: [0, 0, 0, 1] }] }
    expect(letGoFrames(keys, undefined, frames)).toEqual(new Set([i]))
    const live = frameSolve(root, bones, gear, { u, i, loop: false, places: new Map(), letGo: letGoFrames(keys, undefined, frames).has(i), quick: true }, body)
    const after = spySolver()
    buildEdit(base, keys, false, rest, root, HUMAN_RIG, 0, null, gear, 1.8, after.solver, { seed: { u, pose: seedOf(bones) } })
    const release = after.calls[i]
    expect(live.opts.follow).toBeUndefined()
    expect(shared(live.opts)).toEqual(shared(release.opts))
    // (the goals as letting go has them: the leant chest carries the spear, and the left hand's grip with it)
    sameGoals(live.goals, release.goals)
  })

  it('counts a gear drag\'s root hold and a moving key as let go, not the pins at the ends', () => {
    const pin: ClipKey = { u: 0, q: [0, 0, 0, 1] }
    expect(letGoFrames({ Spine: [pin, { u: 1, q: [0, 0, 0, 1] }] }, undefined, 31)).toEqual(new Set())
    expect(letGoFrames({ Hips: [{ u: 0.5, q: [0, 0, 0, 1], p: [0, 0.1, 0] }] }, [{ gear: 'spear', u: 0.2, frames: {} }], 31)).toEqual(new Set([15, 6]))
  })
})

const YBOT = path.join(ROOT, 'workspace/library/mannequin/ybot.glb')
const POSE_MODEL = path.join(ROOT, 'static/templates/rom/human-pose.json')
const haveBody = existsSync(YBOT) && existsSync(POSE_MODEL)

describe.skipIf(!haveBody)('a live drag let go, on a person', () => {
  it('builds the dragged frame where the live solve had it', async () => {
    const { HUMAN_RIG } = await import('./PoseEditor.ts')
    const { loadGlbFile } = await import('./headless.ts')
    const root = (await loadGlbFile(YBOT)).scene
    root.updateMatrixWorld(true)
    const bones = bonesOf(root)
    const rest = restOf(root)
    const legs = legsOf(bones, HUMAN_RIG)
    const soles = legs.map(l => [l.end, l.ball, l.tip].map(b => (b === null ? -Infinity : wp(b).y)))
    const height = 1.8
    const solver = createBodySolver(new PoseModel(JSON.parse(readFileSync(POSE_MODEL, 'utf8')) as PoseModelData), null, { hipsMove: true })
    // a spear in the right hand; the left hand's grip on it a little ahead of and below where the left hand is
    const spear = new THREE.Group(); spear.name = 'Spear_place'
    bones.get('RightHand')!.add(spear)
    root.updateMatrixWorld(true)
    const left = bones.get('LeftHand')!
    const want = new THREE.Matrix4().compose(wp(left).add(new THREE.Vector3(0, -0.08, 0.12)), wq(left), new THREE.Vector3(1, 1, 1))
    const at = new THREE.Vector3(); const turn = new THREE.Quaternion()
    spear.matrixWorld.clone().invert().multiply(want).decompose(at, turn, new THREE.Vector3())
    const gear: GearRig = {
      node: () => 'Spear_place', paths: {}, attachments: [{ hand: 'Left', gear: 'spear', handle: 'left' }], carriers: { spear: 'RightHand' }, fingers: {},
      handles: { spear: [{ id: 'left', name: 'Left grip', place: { position: at.toArray(), rotation: turn.toArray() as Quat } }] },
    }
    // the clip: the spine turning a little and back, every other bone keyed where it rests (a clip as baked keys every
    // bone, so each frame starts from it)
    const spine = bones.get('Spine')!; const hips = bones.get('Hips')!
    const q0 = spine.quaternion.clone(); const q1 = q0.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.15))
    const held = [...bones.values()].filter(b => b !== spine).map(b => new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, [0, 1], [...b.quaternion.toArray(), ...b.quaternion.toArray()]))
    const base = new THREE.AnimationClip('Turn', 1, [
      ...held, new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [...hips.position.toArray(), ...hips.position.toArray()]),
      new THREE.QuaternionKeyframeTrack('Spine.quaternion', [0, 0.5, 1], [...q0.toArray(), ...q1.toArray(), ...q0.toArray()]),
    ])
    const frames = frameTimes(base.duration).length; const i = 15; const u = i / (frames - 1); const t = u * base.duration
    const states: Array<BodyState | null> = []
    const built = buildEdit(base, {}, false, rest, root, HUMAN_RIG, 0, null, gear, height, solver, { states })
    // the drag begins on the frame as built (where its first solve starts), from the frame as keyed
    poseAt(built, root, t, rest)
    const shown = seedOf(bones)
    poseAt(base, root, t, rest)
    // the move: the chest leant forward (letting go keys it on this frame); the live solve, quick
    const chest = bones.get('Spine1')!
    chest.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.15))
    root.updateMatrixWorld(true)
    const keys: Record<string, ClipKey[]> = { Spine1: [{ u: 0, q: [0, 0, 0, 1] }, keyFor(base, chest, u, t, rest('Spine1')!, false), { u: 1, q: [0, 0, 0, 1] }] }
    const body: EditBody = { hips: HUMAN_RIG.hips, legs, soles, floor: 0, height, limits: null }
    const live = frameSolve(root, bones, gear, { u, i, loop: false, places: new Map(), letGo: letGoFrames(keys, undefined, frames).has(i), seed: shown, quick: true }, body)
    const liveMiss = solver(bones, live.goals, live.opts, states[i] ?? null).miss
    root.updateMatrixWorld(true)
    const seen = BODY.map(n => wp(bones.get(n)!))
    // let go: the build, keyed there, that frame's solve starting where the live one left the body
    const after = buildEdit(base, keys, false, rest, root, HUMAN_RIG, 0, null, gear, height, solver, { seed: { u, pose: seedOf(bones) } })
    poseAt(after, root, t, rest)
    const now = BODY.map(n => wp(bones.get(n)!))
    const jump = seen.map((p, k) => p.distanceTo(now[k]))
    const worst = Math.max(...jump)
    console.log(`let go: the frame moved ${(worst * 100).toFixed(2)} cm at worst (${BODY[jump.indexOf(worst)]}); live miss ${(liveMiss * 100).toFixed(2)} cm`)
    expect(liveMiss).toBeLessThan(0.02)
    expect(handleMisses(after, root, gear)[i]).toBeLessThan(0.01)
    expect(worst).toBeLessThan(0.03)
  }, 120_000)
})
