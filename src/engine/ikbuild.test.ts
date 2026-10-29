// @vitest-environment node
// The bake's build (src/engine/ikbuild.ts) on a workspace character: the spearman's left hand put on a grip of his spear
// by slot.ik stays on it through his Attack (by IK, within his joints' ranges), only over its windows when it has
// them; a foot the build sank is lifted back unless the floor is off; and the export's body (no gear nodes: it hangs
// its gear after baking) builds exactly what the viewer's copy (gear on it) builds. Reads the workspace (its character
// and the library its clips play from); without it, says so and checks nothing.
import { existsSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { applyCommand } from '../model/commands.ts'
import { slotByName } from '../model/select.ts'
import type { Character, Quat, Slot, Vec3 } from '../model/types.ts'
import { body, character, nodeClipSource, nodeRom, settings, WORKSPACE } from '../../tools/lib/node3d.ts'
import { bakeSlot, type BakeContext, type BakedSlot } from './bake.ts'
import { frameTimes, handleMisses, handOn, type GearRig } from './clipedit.ts'
import { boneFrame } from './garments.ts'
import { gearNode } from './geom.ts'
import { ikRig, withGearNodes } from './ikbuild.ts'
import { garmentMatrix } from './placement.ts'

const ID = 'spearman-da04d7'
const here = existsSync(path.join(WORKSPACE, 'characters', ID, 'character.json'))

async function contextOf (c: Character, nodes: boolean): Promise<BakeContext> {
  const view = await body(c.id)
  // (the viewer's copy: a node for each bone piece hung as the gear area hangs it, garments.ts boneFrame (the bone's rest
  // frame undone, then the placement); the export's body has none)
  if (nodes) {
    for (const g of c.gear) if (g.attach.kind === 'bone') boneFrame(view, g, g.attach.bone, g.attach.place)
    view.root.updateMatrixWorld(true)
  }
  return { rest: view.rest!, posable: view.root, clips: nodeClipSource(view.rest!), fps: 30, sharedPoses: settings().handPoses, rom: nodeRom }
}

/** The spearman with a grip on his spear where his left hand is at rest, and his Attack holding it there by `ik`. */
async function held (ik: Slot['ik']): Promise<{ c: Character, slot: Slot }> {
  let c = character(ID)
  const spear = c.gear.find(g => g.attach.kind === 'bone' && g.attach.bone === 'RightHand')!
  const ctx = await contextOf(c, true)
  const node = ctx.posable.getObjectByName(gearNode(spear))!
  const hand = ctx.posable.getObjectByName('LeftHand')!
  const right = ctx.posable.getObjectByName('RightHand')!
  // (where the left hand is on the frame of the Attack it comes nearest the right: its grip there, on the spear)
  const clip = (await bakeSlot(c, slotByName(c, 'Attack')!, ctx)).clip
  const mixer = new THREE.AnimationMixer(ctx.posable)
  const action = mixer.clipAction(clip); action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play()
  let best = { d: Infinity, t: 0 }
  for (let t = 0; t <= clip.duration; t += 1 / 30) {
    mixer.setTime(t); ctx.posable.updateMatrixWorld(true)
    const d = hand.getWorldPosition(new THREE.Vector3()).distanceTo(right.getWorldPosition(new THREE.Vector3()))
    if (d < best.d) best = { d, t }
  }
  mixer.setTime(best.t); ctx.posable.updateMatrixWorld(true)
  const inv = node.matrixWorld.clone().invert()
  const nq = new THREE.Quaternion(); node.matrixWorld.decompose(new THREE.Vector3(), nq, new THREE.Vector3())
  const place = { position: hand.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv).toArray() as Vec3, rotation: nq.invert().multiply(hand.getWorldQuaternion(new THREE.Quaternion())).toArray() as Quat }
  mixer.stopAllAction(); mixer.uncacheRoot(ctx.posable)
  c = applyCommand(c, { type: 'gear.handle.add', gear: spear.id, handle: { id: 'gripL', name: 'Left grip', kind: 'grip', hand: 'Left', place } }).character
  const atk = slotByName(c, 'Attack')!
  c = applyCommand(c, { type: 'slot.ik', slot: atk.id, patch: { hands: (ik?.hands ?? []).map(h => ({ ...h, gear: spear.id })), ...(ik?.floor !== undefined ? { floor: ik.floor } : {}) } }).character
  return { c, slot: slotByName(c, 'Attack')! }
}

const worst = (xs: number[]): number => Math.max(0, ...xs)

/** Per frame of `clip`: how far each held hand is off its handle, and whether the handle is within the arm's reach (its
 * shoulder joint nearer it than 95 % of the arm's length). */
function reachable (clip: THREE.AnimationClip, root: THREE.Object3D, rig: GearRig): Array<{ miss: number, reach: boolean }> {
  const mixer = new THREE.AnimationMixer(root)
  const action = mixer.clipAction(clip); action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play()
  const at = (n: string): THREE.Vector3 => root.getObjectByName(n)!.getWorldPosition(new THREE.Vector3())
  const out: Array<{ miss: number, reach: boolean }> = []
  for (const t of frameTimes(clip.duration)) {
    mixer.setTime(t); root.updateMatrixWorld(true)
    for (const a of rig.attachments) {
      const handle = rig.handles[a.gear]!.find(h => h.id === a.handle)!
      const goal = handOn(root.getObjectByName(rig.node(a.gear))!.matrixWorld, handle).at
      const length = at(`${a.hand}Arm`).distanceTo(at(`${a.hand}ForeArm`)) + at(`${a.hand}ForeArm`).distanceTo(at(`${a.hand}Hand`))
      out.push({ miss: at(`${a.hand}Hand`).distanceTo(goal), reach: at(`${a.hand}Arm`).distanceTo(goal) < 0.95 * length })
    }
  }
  mixer.stopAllAction(); mixer.uncacheRoot(root)
  return out
}

describe.skipIf(!here)('ikBuild on the spearman', () => {
  it('keeps the left hand on its grip all through, the same on the export body as on the viewer copy', async () => {
    const { c, slot } = await held({ hands: [{ hand: 'Left', gear: '', handle: 'gripL' }] })
    const viewer = await contextOf(c, true)
    const exported = await contextOf(c, false)
    const plain = await bakeSlot(c, { ...slot, ik: undefined }, viewer)
    // (as the export bakes: its own gear bones play the gear keys, so no gear node tracks)
    const a = await bakeSlot(c, slot, viewer, { gearNodes: false })
    const b = await bakeSlot(c, slot, exported, { gearNodes: false })
    expect(b.gearKeys).toEqual(a.gearKeys)
    // (the export's body is left as it was: no nodes hung on it)
    expect(exported.posable.getObjectByName(gearNode(c.gear.find(g => g.id === slot.ik!.hands[0].gear)!))).toBeUndefined()
    expect(b.clip.tracks.map(t => t.name).sort()).toEqual(a.clip.tracks.map(t => t.name).sort())
    let diff = 0
    for (const t of a.clip.tracks) {
      const u = b.clip.tracks.find(x => x.name === t.name)!
      expect(u.values.length).toBe(t.values.length)
      for (let i = 0; i < t.values.length; i++) diff = Math.max(diff, Math.abs(u.values[i] - t.values[i]))
    }
    expect(diff).toBe(0)
    const made = await withGearNodes(c, viewer.posable, async () => await ikRig(c, slot, viewer))
    expect(made?.limits).not.toBeNull()
    const misses = await withGearNodes(c, viewer.posable, () => reachable(a.clip, viewer.posable, made!.rig))
    const before = await withGearNodes(c, viewer.posable, () => handleMisses(plain.clip, viewer.posable, made!.rig))
    // (on the grip within a few centimetres where the arm reaches it; the clip alone takes the hand well away from it)
    // (on the grip wherever the arm can reach it; where it can't (the spear thrust out past it), as near as the arm goes;
    // the clip alone takes the hand well away from it)
    const reached = misses.filter(m => m.reach)
    console.log(`ik: ${reached.length} of ${misses.length} frames in reach, worst miss there ${worst(reached.map(m => m.miss)).toFixed(4)} m; the clip alone off it by ${worst(before).toFixed(3)} m; viewer and export differ by ${diff}`)
    expect(reached.length).toBeGreaterThan(0)
    expect(worst(reached.map(m => m.miss))).toBeLessThan(0.01)
    expect(worst(before)).toBeGreaterThan(0.1)
    expect(a.report.ik).toBeDefined()
  }, 120_000)

  it('holds only over its windows', async () => {
    const { c, slot } = await held({ hands: [{ hand: 'Left', gear: '', handle: 'gripL', windows: [[0.3, 0.6]] }] })
    const ctx = await contextOf(c, true)
    const plain: BakedSlot = await bakeSlot(c, { ...slot, ik: undefined }, ctx)
    const built = await bakeSlot(c, slot, ctx)
    const arm = (clip: THREE.AnimationClip, time: number): number[] => {
      const t = clip.tracks.find(x => x.name === 'LeftForeArm.quaternion')!
      return Array.from((t as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant().evaluate(time) as ArrayLike<number>)
    }
    const track = built.clip.tracks.find(x => x.name === 'LeftForeArm.quaternion')!
    const frames = track.times.length
    // (the window is source time: where the clip plays it)
    const [from, to] = [built.time.toPlayed(0.3), built.time.toPlayed(0.6)]
    const pad = 1.5 / frames
    let outside = 0; let inside = 0
    for (let i = 0; i < frames; i++) {
      const v = track.times[i] / built.clip.duration
      const a = arm(built.clip, track.times[i]); const b = arm(plain.clip, track.times[i])
      const d = Math.min(Math.max(...a.map((x, k) => Math.abs(x - b[k]))), Math.max(...a.map((x, k) => Math.abs(x + b[k]))))
      if (v < from - pad || v > to + pad) outside = Math.max(outside, d)
      else if (v > from + pad && v < to - pad) inside = Math.max(inside, d)
    }
    expect(outside).toBeLessThan(1e-3)
    expect(inside).toBeGreaterThan(1e-3)
  }, 120_000)

  it('lifts back a foot the keys sank, unless the floor is off', async () => {
    const sink = (s: Slot): Slot => ({ ...s, bones: { Hips: [{ u: 0, q: [0, 0, 0, 1], p: [0, -0.25, 0] }, { u: 1, q: [0, 0, 0, 1], p: [0, -0.25, 0] }] } })
    const on = await held({ hands: [{ hand: 'Left', gear: '', handle: 'gripL' }] })
    const off = await held({ hands: [{ hand: 'Left', gear: '', handle: 'gripL' }], floor: false })
    const ctx = await contextOf(on.c, true)
    const lifted = await bakeSlot(on.c, sink(on.slot), ctx)
    const sunk = await bakeSlot(off.c, sink(off.slot), ctx)
    const leg = (b: BakedSlot): Float32Array | number[] => b.clip.tracks.find(t => t.name === 'LeftUpLeg.quaternion')!.values as Float32Array
    const a = leg(lifted); const b = leg(sunk)
    let d = 0
    for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]))
    expect(d).toBeGreaterThan(1e-3)
  }, 120_000)
})
