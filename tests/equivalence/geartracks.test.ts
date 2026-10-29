// @vitest-environment node
// Held-by and shown on the workspace's real rigs (src/engine/geartracks.ts, docs/motion-plan.md §9 C2): the spearman's
// spear handed from the right hand to the left mid-Attack and back to its placement, the knight's sword put on his back
// and hidden, baked by the one bake on a body wearing its gear as the viewer does (garments.ts boneFrame). At each switch
// the piece is where it was (1e-5), then rides its new holder; hidden, its node's size is 0; ridden, the holds repeat
// over the cycles. Without the workspace it says so and checks nothing.
import { existsSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { bakeRide, bakeSlot, type BakeContext } from '../../src/engine/bake.ts'
import { CharacterView } from '../../src/engine/CharacterView.ts'
import { boneFrame } from '../../src/engine/garments.ts'
import { gearNode } from '../../src/engine/geom.ts'
import { loadGlbFile } from '../../src/engine/headless.ts'
import { slotByName } from '../../src/model/select.ts'
import type { Character, Gear, Slot } from '../../src/model/types.ts'
import { character, nodeClipSource, settings, WORKSPACE } from '../../tools/lib/node3d.ts'

const CHARACTERS = path.join(WORKSPACE, 'characters')
const SPEARMAN = 'spearman-da04d7'
const KNIGHT = 'knight-3076bf'
const have = existsSync(path.join(CHARACTERS, SPEARMAN, 'character.json')) && existsSync(path.join(CHARACTERS, KNIGHT, 'character.json'))

async function wearing (c: Character): Promise<{ ctx: BakeContext, view: CharacterView }> {
  const { scene } = await loadGlbFile(path.join(CHARACTERS, c.id, c.files.rigged!))
  const view = new CharacterView(scene)
  for (const g of c.gear) if (g.attach.kind === 'bone' && g.attach.legacyFrame === undefined) boneFrame(view, g, g.attach.bone, g.attach.place)
  view.root.updateMatrixWorld(true)
  return { view, ctx: { rest: view.rest!, posable: view.root, clips: nodeClipSource(view.rest!, WORKSPACE), fps: 30, sharedPoses: settings().handPoses } }
}

/** Every track of the clip evaluated at `t` on the objects it names. */
function poseAt (root: THREE.Object3D, clip: THREE.AnimationClip, t: number): void {
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.')
    const o = root.getObjectByName(track.name.slice(0, dot))
    if (o === undefined) continue
    const v = (track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant().evaluate(t) as ArrayLike<number>
    const prop = track.name.slice(dot + 1)
    if (prop === 'quaternion') o.quaternion.set(v[0], v[1], v[2], v[3]).normalize()
    else (o as unknown as Record<string, THREE.Vector3>)[prop].set(v[0], v[1], v[2])
  }
  root.updateMatrixWorld(true)
}

const apart = (a: THREE.Matrix4, b: THREE.Matrix4): number => Math.max(...a.elements.map((x, i) => Math.abs(x - b.elements[i])))
const gearNamed = (c: Character, name: string): Gear => c.gear.find(g => g.name === name)!
const withTrack = (c: Character, slot: Slot, gear: string, track: NonNullable<Slot['gear']>[string]): { c: Character, slot: Slot } => {
  const s = { ...slot, gear: { ...slot.gear, [gear]: { ...slot.gear?.[gear], ...track } } }
  return { c: { ...c, clips: c.clips.map(x => (x.id === s.id ? s : x)) }, slot: s }
}

describe.skipIf(!have)('held by and shown on the workspace rigs', () => {
  it('hands the spearman\'s spear to his left hand without a pop, and back to its placement', async () => {
    const c0 = character(SPEARMAN)
    const spear = gearNamed(c0, 'Weapons_RightHand')
    const { c, slot } = withTrack(c0, slotByName(c0, 'Attack')!, spear.id, { heldBy: [{ u: 0.3, bone: 'LeftHand' }, { u: 0.7, bone: 'RightHand', placed: true }] })
    const { ctx, view } = await wearing(c)
    const b = await bakeSlot(c, slot, ctx)
    const holds = b.gearHolds![spear.id].holds
    expect(holds.map(h => [h.bone, h.how])).toEqual([['RightHand', 'gear'], ['LeftHand', 'free'], ['RightHand', 'placed']])
    const node = view.root.getObjectByName(gearNode(spear))!
    const right = view.root.getObjectByName('RightHand')!; const left = view.root.getObjectByName('LeftHand')!
    const d = b.clip.duration
    const ts = holds[1].t * d
    // where the right hand had it at the switch, from a frame before it
    poseAt(view.root, b.clip, 0)
    const inRight = right.matrixWorld.clone().invert().multiply(node.matrixWorld)
    poseAt(view.root, b.clip, ts)
    const pop = apart(node.matrixWorld, right.matrixWorld.clone().multiply(inRight))
    expect(pop, 'world pose at the switch').toBeLessThan(1e-5)
    // then rigid in the left hand, frame by frame up to the hand back
    const frames = b.clip.tracks.find(t => t.name === `${gearNode(spear)}.position`)!.times.filter(t => t > ts + 1e-3 && t < holds[2].t * d - 1e-3)
    poseAt(view.root, b.clip, frames[0])
    const inLeft = left.matrixWorld.clone().invert().multiply(node.matrixWorld)
    let worst = 0
    for (const t of frames) { poseAt(view.root, b.clip, t); worst = Math.max(worst, apart(left.matrixWorld.clone().invert().multiply(node.matrixWorld), inLeft)) }
    expect(worst, 'rigid in the left hand').toBeLessThan(1e-5)
    // and back where Gear places it
    poseAt(view.root, b.clip, d)
    expect(apart(right.matrixWorld.clone().invert().multiply(node.matrixWorld), inRight), 'placed again').toBeLessThan(1e-5)
    console.log(`spearman Attack: switch at ${ts.toFixed(4)} s, pop ${pop.toExponential(1)}, in the left hand ${worst.toExponential(1)} over ${frames.length} frames`)
  }, 60_000)

  it('puts the knight\'s sword on his back and hides it, ridden as on his horse', async () => {
    const c0 = character(KNIGHT)
    const sword = gearNamed(c0, 'Weapons_RightHand')
    const idle0 = slotByName(c0, 'Idle')!
    const { c, slot } = withTrack(c0, idle0, sword.id, { heldBy: [{ u: 0.4, bone: 'Spine2' }], shown: [{ u: 0.6, shown: false }] })
    const { ctx, view } = await wearing(c)
    const b = await bakeSlot(c, slot, ctx)
    const node = view.root.getObjectByName(gearNode(sword))!
    const spine = view.root.getObjectByName('Spine2')!
    const d = b.clip.duration
    const h = b.gearHolds![sword.id]
    poseAt(view.root, b.clip, h.holds[1].t * d + 0.2)
    const onBack = spine.matrixWorld.clone().invert().multiply(node.matrixWorld)
    poseAt(view.root, b.clip, h.holds[1].t * d + 0.5)
    expect(apart(spine.matrixWorld.clone().invert().multiply(node.matrixWorld), onBack)).toBeLessThan(1e-5)
    const scale = b.clip.tracks.find(t => t.name === `${gearNode(sword)}.scale`)!
    const size = (t: number): number => ((scale as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant().evaluate(t) as unknown as number[])[0]
    expect(size(0)).toBeCloseTo(sword.attach.place.scale, 6)
    expect(size(0.7 * d)).toBe(0)
    // ridden: his clip fitted to the horse's by whole cycles, the holds again in each
    const horse = character(c.mount!.character)
    const { ctx: hctx } = await wearing(horse)
    const r = await bakeRide(b, { c: horse, ctx: hctx, slotName: 'Idle' }, c.mount!, { loop: true, attack: false, rest: ctx.rest })
    const again = r.rider.gearHolds![sword.id]
    expect(again.holds.length).toBe(2 * r.cycles)
    expect(again.shown.length).toBe(2 * r.cycles)
    expect(r.rider.clip.tracks.some(t => t.name === `${gearNode(sword)}.scale`)).toBe(true)
  }, 60_000)
})
