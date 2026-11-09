// @vitest-environment node
// Posture, layers and match feet (docs/motion-plan.md §12) on a real rig: the workspace archer and its own clips, baked
// as the export bakes them. Without the workspace it says so and checks nothing.
import { existsSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { bakeSlot, type BakeContext } from './bake.ts'
import { footsteps, loopsRound } from '../app/motion/events/footsteps.ts'
import { gaitAt, matchFeet, repeated, type Falls } from '../model/footmatch.ts'
import { heightOf } from '../model/select.ts'
import type { Adjustment, Character, Slot } from '../model/types.ts'
import { body, character, nodeClipSource, settings, WORKSPACE } from '../../tools/lib/node3d.ts'

const ID = 'archer-b8157d'
const here = existsSync(path.join(WORKSPACE, 'characters', ID, 'character.json'))

async function setup (): Promise<{ c: Character, ctx: BakeContext }> {
  const view = await body(ID)
  return { c: character(ID), ctx: { rest: view.rest!, posable: view.root, clips: nodeClipSource(view.rest!, WORKSPACE), fps: 30, sharedPoses: settings().handPoses } }
}

/** A bone's world place through a clip at `t` (on the posable copy, put back after). */
function placeAt (root: THREE.Object3D, clip: THREE.AnimationClip, bone: string, t: number): THREE.Vector3 {
  const mixer = new THREE.AnimationMixer(root)
  mixer.clipAction(clip).play()
  mixer.setTime(t)
  root.updateMatrixWorld(true)
  const out = root.getObjectByName(bone)!.getWorldPosition(new THREE.Vector3())
  mixer.stopAllAction(); mixer.uncacheRoot(root)
  return out
}

describe.skipIf(!here)('posture, layers and match feet on the workspace archer', () => {
  it('leans the walk forward: the head ahead of the hips by about the lean', async () => {
    const { c, ctx } = await setup()
    const walk = c.clips.find(s => s.name === 'Walk')!
    const lean: Adjustment = { id: 'lean', enabled: true, kind: 'posture', part: 'lean', amount: 15 }
    const plain = await bakeSlot(c, walk, ctx)
    const leant = await bakeSlot(c, { ...walk, adjustments: [...walk.adjustments, lean] }, ctx)
    const t = plain.clip.duration * 0.3
    // (the neck, on top of the spine's three bones that share the lean, tipped forward by all of it)
    const tip = (clip: THREE.AnimationClip): number => {
      const v = placeAt(ctx.posable, clip, 'Head', t).sub(placeAt(ctx.posable, clip, 'Neck', t))
      return Math.atan2(v.z, v.y) * 180 / Math.PI
    }
    console.log(`posture: the neck tipped ${tip(plain.clip).toFixed(1)}° -> ${tip(leant.clip).toFixed(1)}° forward`)
    expect(tip(leant.clip) - tip(plain.clip)).toBeGreaterThan(12)
    expect(tip(leant.clip) - tip(plain.clip)).toBeLessThan(18)
    expect(leant.report.lean).toMatchObject({ bones: ['Spine', 'Spine1', 'Spine2'] })
  }, 120000)

  it('lays its Attack on the walk\'s upper body: the arms the attack\'s, the feet the walk\'s', async () => {
    const { c, ctx } = await setup()
    const walk = c.clips.find(s => s.name === 'Walk')!
    const attack = c.clips.find(s => s.name === 'Attack')!
    const layer: Adjustment = { id: 'l', enabled: true, kind: 'layer', play: { kind: 'slot', slot: attack.id }, mask: ['torso', 'head', 'leftArm', 'rightArm'] }
    const plain = await bakeSlot(c, walk, ctx)
    const both = await bakeSlot(c, { ...walk, adjustments: [...walk.adjustments, layer] }, ctx)
    const atk = await bakeSlot(c, attack, ctx, { gearNodes: false })
    const t = Math.min(plain.clip.duration, atk.clip.duration) * 0.5
    const q = (clip: THREE.AnimationClip, bone: string): THREE.Quaternion => {
      const track = clip.tracks.find(x => x.name === `${bone}.quaternion`)!
      return new THREE.Quaternion().fromArray(Array.from((track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant().evaluate(t) as ArrayLike<number>))
    }
    const arm = q(both.clip, 'RightForeArm').angleTo(q(atk.clip, 'RightForeArm'))
    const leg = q(both.clip, 'LeftUpLeg').angleTo(q(plain.clip, 'LeftUpLeg'))
    console.log(`layer: right forearm ${(arm * 180 / Math.PI).toFixed(2)}° from the attack's, left thigh ${(leg * 180 / Math.PI).toFixed(2)}° from the walk's (report ${JSON.stringify(both.report.l)})`)
    expect(arm).toBeLessThan(0.02)
    expect(leg).toBeLessThan(0.02)
  }, 120000)

  it('matches the run\'s feet to the walk handing over', async () => {
    const { c, ctx } = await setup()
    const clipOf = async (name: string): Promise<THREE.AnimationClip> => {
      const s: Slot = c.clips.find(x => x.name === name)!
      return await ctx.clips.get(s.clip, { inPlace: s.inPlace, fps: 30 })
    }
    const falls = (clip: THREE.AnimationClip): Falls => {
      const out: Falls = {}
      for (const f of footsteps(ctx.posable, clip, false, heightOf(c))) (out[f.name] ??= []).push(f.t * clip.duration)
      return out
    }
    const walk = await clipOf('Walk'); const run = await clipOf('Run')
    const before = falls(walk); const after = falls(run)
    const at = walk.duration * 0.9
    const h = heightOf(c)
    expect(loopsRound(ctx.posable, walk, h) && loopsRound(ctx.posable, run, h)).toBe(true)
    const m = matchFeet(before, at, after, run.duration, run.duration / 2, 0, { beforePeriod: walk.duration, period: run.duration })
    console.log(`match feet: walk falls ${JSON.stringify(before)}, run falls ${JSON.stringify(after)} -> ${JSON.stringify(m)}`)
    expect(typeof m).toBe('object')
    if (typeof m === 'string') return
    // (the run there is in the same gait phase as the walk handing over, and the piece fits in the run)
    const there = gaitAt(repeated(after, run.duration, -run.duration, 2 * run.duration), m.from)!
    const was = gaitAt(repeated(before, walk.duration, 0, 2 * walk.duration), at)!
    expect(there.foot).toBe(was.foot)
    expect(there.phase).toBeCloseTo(was.phase, 2)
    expect(m.from + run.duration / 2).toBeLessThanOrEqual(run.duration + 1e-6)
  }, 120000)
})
