// @vitest-environment node
// The pose tools (src/model/posetools.ts) and the onion skins on a real rig: the workspace archer (a Mixamo-named
// skeleton from the human template) and its own clips, baked the one way. Without the workspace it says so and checks
// nothing.
import { existsSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { bakeSlot, boneRest, type BakeContext, type BakedSlot } from './bake.ts'
import { applyBoneKeys } from './keys.ts'
import { framePhase, keySampler, onionTimes, OnionSkins, poseAt, restFrames } from './onion.ts'
import type { CharacterView } from './CharacterView.ts'
import type { Stage } from './Stage.ts'
import {
  angle, blendSeam, copyPose, jumping, matchEnds, mirrorPose, pastePose, reflect, seamJump, SEAM_EPS, type PoseContext, type Tracks,
} from '../model/posetools.ts'
import type { KeyTrack } from '../model/command-types.ts'
import type { Character, ClipKey, Quat, Slot } from '../model/types.ts'
import { body, character, nodeClipSource, settings, WORKSPACE } from '../../tools/lib/node3d.ts'

const ID = 'archer-b8157d'
const here = existsSync(path.join(WORKSPACE, 'characters', ID, 'character.json'))
const deg = Math.PI / 180

async function setup (): Promise<{ c: Character, view: CharacterView, ctx: BakeContext }> {
  const view = await body(ID)
  const c = character(ID)
  return { c, view, ctx: { rest: view.rest!, posable: view.root, clips: nodeClipSource(view.rest!, WORKSPACE), fps: 30, sharedPoses: settings().handPoses } }
}

function contextOf (baked: BakedSlot, loop: boolean): PoseContext {
  return { loop, time: baked.time, frame: framePhase(baked.clip.duration), sample: keySampler }
}

/** The slot's bones as these writes leave them. */
function withWrites (slot: Slot, writes: KeyTrack[]): Slot {
  const bones: Record<string, ClipKey[]> = { ...slot.bones }
  for (const w of writes) if ('bone' in w) bones[w.bone] = w.keys
  return { ...slot, bones }
}

/** Every bone's world turn and place with `clip` at `t` on the view's bones (left posed: callers pose again). */
function worldAt (view: CharacterView, clip: THREE.AnimationClip, t: number): Map<string, { q: THREE.Quaternion, p: THREE.Vector3 }> {
  const rest = view.rest!
  const pose = poseAt(clip, t, rest, { moves: ['Hips'] })
  for (const [name, b] of rest.bones) {
    const v = pose[name]
    b.node.quaternion.fromArray(v.q)
    b.node.position.copy(v.p !== undefined ? new THREE.Vector3(...v.p) : b.localPosition)
  }
  view.root.updateMatrixWorld(true)
  return new Map([...rest.bones].map(([n, b]) => [n, { q: b.node.getWorldQuaternion(new THREE.Quaternion()), p: b.node.getWorldPosition(new THREE.Vector3()) }]))
}

/** A bone's world turn from its rest (W · R⁻¹). */
function fromRest (view: CharacterView, world: Map<string, { q: THREE.Quaternion }>, bone: string): Quat {
  return world.get(bone)!.q.clone().multiply(view.rest!.bones.get(bone)!.worldQuaternion.clone().invert()).toArray() as Quat
}

describe.skipIf(!here)('the pose tools on the workspace archer', () => {
  it('pastes a left-arm raise mirrored as the matching right-arm raise, in world terms', async () => {
    const { view } = await setup()
    const rest = view.rest!
    const frames = restFrames(rest)
    // (the rest pose, held a second; the left arm raised 70° out to the side and 20° forward)
    const still = new THREE.AnimationClip('still', 1, [])
    const raise = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0.3, 0.2, 1).normalize(), 70 * deg)
    const ctx: PoseContext = { loop: false, time: { toPlayed: u => u, toSource: v => v, range: [0, 1] }, frame: 1 / 30, sample: keySampler }
    const rw = rest.bones.get('LeftArm')!
    // (a world turn W·R⁻¹ = raise: the key in the bone's own frame)
    const parentW = rest.bones.get(rw.parent!)!.worldQuaternion
    const k = rw.localQuaternion.clone().invert().multiply(parentW.clone().invert()).multiply(raise).multiply(parentW).multiply(rw.localQuaternion)
    const tracks: Tracks = { LeftArm: [{ u: 0, q: [0, 0, 0, 1] }, { u: 0.5, q: k.toArray() as Quat }, { u: 1, q: [0, 0, 0, 1] }] }
    const keyed = applyBoneKeys(still, tracks as Record<string, ClipKey[]>, false, boneRest(rest))
    const copied = copyPose(poseAt(keyed, 0.5, rest), ['LeftArm', 'LeftForeArm', 'LeftHand'])
    const writes = pastePose(tracks, mirrorPose(copied, frames), 0.5, poseAt(still, 0.5, rest), ctx, { frames })
    expect(writes.map(w => ('bone' in w ? w.bone : '')).sort()).toEqual(['RightArm'])
    const all = { ...tracks, ...Object.fromEntries(writes.map(w => ['bone' in w ? w.bone : '', w.keys])) }
    const world = worldAt(view, applyBoneKeys(still, all as Record<string, ClipKey[]>, false, boneRest(rest)), 0.5)
    const left = fromRest(view, world, 'LeftArm'); const right = fromRest(view, world, 'RightArm')
    const miss = angle(right, reflect(left))
    console.log(`mirrored arm raise: world turn from rest off its mirror by ${miss.toExponential(2)} rad; left raised ${(angle(left, [0, 0, 0, 1]) / deg).toFixed(2)}°`)
    expect(angle(left, [0, 0, 0, 1])).toBeCloseTo(70 * deg, 4)
    expect(miss).toBeLessThan(1e-4)
    // (and the hands land mirrored, as far as the rig itself is symmetric)
    const lh = world.get('LeftHand')!.p; const rh = world.get('RightHand')!.p
    const off = new THREE.Vector3(-lh.x, lh.y, lh.z).distanceTo(rh)
    const restOff = new THREE.Vector3(-rest.bones.get('LeftHand')!.worldPosition.x, rest.bones.get('LeftHand')!.worldPosition.y, rest.bones.get('LeftHand')!.worldPosition.z).distanceTo(rest.bones.get('RightHand')!.worldPosition)
    console.log(`hands: right hand ${(off * 1000).toFixed(2)} mm from the left's mirror (at rest ${(restOff * 1000).toFixed(2)} mm)`)
    expect(off).toBeLessThan(restOff + 2e-3)
  }, 60000)

  it('copies a pose to another moment of a real clip, and pastes a whole pose mirrored', async () => {
    const { c, view, ctx } = await setup()
    const rest = view.rest!
    const frames = restFrames(rest)
    const slot = c.clips.find(s => s.name === 'Idle')!
    const baked = await bakeSlot(c, slot, ctx)
    const pc = contextOf(baked, slot.loop)
    const d = baked.clip.duration
    // (on frames, as the playhead is: between them the baked clip's frames are slerped)
    const n = Math.round(1 / pc.frame)
    const onFrame = (v: number): number => Math.round(v * n) / n
    // copied at 20% of the Idle, pasted at 70%: the slot shows it there as it was at 20%
    const bones = ['Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm']
    const copied = copyPose(poseAt(baked.clip, onFrame(0.2) * d, rest, { bones }))
    const u = baked.time.toSource(onFrame(0.7))
    const writes = pastePose(slot.bones ?? {}, copied, u, poseAt(baked.unkeyed, onFrame(0.7) * d, rest), pc, { frames })
    const again = await bakeSlot(c, withWrites(slot, writes), ctx)
    const now = poseAt(again.clip, onFrame(0.7) * d, rest, { bones })
    const worst = Math.max(...bones.map(b => angle(now[b].q, copied[b].q)))
    console.log(`copy 20% -> paste 70% on Idle: ${writes.length} tracks, worst bone off by ${worst.toExponential(2)} rad`)
    expect(worst).toBeLessThan(1e-4)

    // the whole pose at 40% pasted mirrored over itself: every bone's world turn from rest is the other's mirrored
    const t = onFrame(0.4) * d
    const pose = copyPose(poseAt(baked.clip, t, rest, { moves: ['Hips'] }))
    const mirrored = pastePose(slot.bones ?? {}, mirrorPose(pose, frames), baked.time.toSource(onFrame(0.4)), poseAt(baked.unkeyed, t, rest, { moves: ['Hips'] }), pc, { frames })
    const shown = await bakeSlot(c, withWrites(slot, mirrored), ctx)
    const before = worldAt(view, baked.clip, t)
    const after = worldAt(view, shown.clip, t)
    let most = 0
    for (const b of ['LeftHand', 'LeftForeArm', 'LeftFoot', 'Head', 'RightHand', 'RightUpLeg']) {
      const other = b.startsWith('Left') ? 'Right' + b.slice(4) : b.startsWith('Right') ? 'Left' + b.slice(5) : b
      most = Math.max(most, angle(fromRest(view, after, other), reflect(fromRest(view, before, b))))
    }
    console.log(`whole Idle pose pasted mirrored (${mirrored.length} tracks): worst world turn off its mirror ${most.toExponential(2)} rad`)
    expect(most).toBeLessThan(1e-4)
  }, 60000)

  it('closes a loop\'s seam: match ends and blend', async () => {
    const { c, view, ctx } = await setup()
    const rest = view.rest!
    const frames = restFrames(rest)
    for (const name of ['Walk', 'Idle']) {
      const slot = c.clips.find(s => s.name === name)!
      const baked = await bakeSlot(c, slot, ctx)
      const pc = contextOf(baked, true)
      const d = baked.clip.duration
      const seam = (b: BakedSlot): ReturnType<typeof seamJump> => seamJump(poseAt(b.clip, 0, rest), poseAt(b.clip, d, rest))
      const was = seam(baked)
      // (a seam made: the right arm turned 15° on the last frame; the loop's own seam on top)
      const tail = keyed(slot, 'RightArm', baked.time.toSource(1), 15)
      const made = await bakeSlot(c, tail, ctx)
      const open = seam(made)
      const first = poseAt(made.clip, 0, rest, { moves: ['Hips'] })
      const last = poseAt(made.clip, d, rest, { moves: ['Hips'] })
      const bones = jumping(open)
      const matched = await bakeSlot(c, withWrites(tail, matchEnds(tail.bones ?? {}, bones, { first, base: poseAt(made.unkeyed, d, rest, { moves: ['Hips'] }), frames }, pc)), ctx)
      const blended = await bakeSlot(c, withWrites(tail, blendSeam(tail.bones ?? {}, bones, { first, last, frames: 6, rest: frames }, pc)), ctx)
      const m = seam(matched); const bl = seam(blended)
      // (the bones closed; those jumping less than SEAM_EPS were left as they were)
      const closed = (x: ReturnType<typeof seamJump>): number => Math.max(...bones.map(b => x.bones[b]))
      console.log(`${name}: own seam ${(was.worst!.angle / deg).toFixed(3)}° (${was.worst!.bone}); opened to ${(open.worst!.angle / deg).toFixed(2)}° (${open.worst!.bone}), ${bones.length} bones jump; ` +
        `match ends -> ${(closed(m) / deg).toExponential(2)}° on them (${(m.worst!.angle / deg).toExponential(2)}° overall), blend -> ${(closed(bl) / deg).toExponential(2)}° (${(bl.worst!.angle / deg).toExponential(2)}°)`)
      expect(open.worst!.angle).toBeGreaterThan(14 * deg)
      expect(closed(m)).toBeLessThan(1e-3 * deg)
      expect(closed(bl)).toBeLessThan(1e-3 * deg)
      expect(m.worst!.angle).toBeLessThanOrEqual(SEAM_EPS)
      expect(bl.worst!.angle).toBeLessThanOrEqual(SEAM_EPS)
      // (the blend leaves the middle of the clip as it played: but for a hair on the keyed arm, whose tangent at its key
      // mid-clip now reaches toward the blend's first key rather than the last frame's)
      const mid = poseAt(made.clip, 0.5 * d, rest); const midB = poseAt(blended.clip, 0.5 * d, rest)
      const moved = Object.keys(mid).map(b => [b, angle(mid[b].q, midB[b].q)] as const).filter(([, a]) => a > 1e-6)
      expect(moved.map(([b]) => b).filter(b => b !== 'RightArm')).toEqual([])
      expect(Math.max(0, ...moved.map(([, a]) => a))).toBeLessThan(1e-4)
    }
  }, 120000)

  it('draws ghosts where the clip puts the bones, cheaply', async () => {
    const { c, view, ctx } = await setup()
    const slot = c.clips.find(s => s.name === 'Walk')!
    const baked = await bakeSlot(c, slot, ctx)
    const d = baked.clip.duration
    const times = onionTimes(0.5, d, { before: 2, after: 2, step: 3, loop: true })
    expect(times.map(g => +(g.t * 30).toFixed(6))).toEqual([12, 9, 18, 21])
    expect(onionTimes(0.05, d, { before: 2, after: 1, step: 3, loop: false }).length).toBe(1)
    expect(onionTimes(0.5, d, { before: 1, after: 1, step: 1, loop: true, keys: [0.1, 0.3, 0.7, 0.9] }).map(g => g.t)).toEqual([0.3, 0.7])
    expect(onionTimes(0.95, d, { before: 1, after: 1, step: 1, loop: true, keys: [0.1, 0.3, 0.7, 0.9] }).map(g => g.t)).toEqual([0.9, 0.1])

    const scene = new THREE.Scene()
    const onion = new OnionSkins({ scene } as unknown as Stage)
    view.root.updateMatrixWorld(true)
    const start = performance.now()
    onion.show(view, baked.clip, 0.5, { before: 3, after: 3, step: 2, loop: true })
    const first = performance.now() - start
    const t0 = performance.now()
    for (let i = 0; i < 100; i++) onion.show(view, baked.clip, 0.5 + i / 300, { before: 3, after: 3, step: 2, loop: true })
    const each = (performance.now() - t0) / 100
    const t1 = performance.now()
    for (let i = 0; i < 100; i++) onion.show(view, baked.clip, 0.5 + 99 / 300, { before: 3, after: 3, step: 2, loop: true })
    const still = (performance.now() - t1) / 100
    console.log(`onion: 6 ghosts, first ${first.toFixed(2)} ms, each playhead move ${each.toFixed(3)} ms, unchanged ${still.toFixed(4)} ms`)
    expect(each).toBeLessThan(5)

    // the first ghost after: 2 frames on from the last show's moment; its dots where the clip puts the bones
    onion.show(view, baked.clip, 0.5, { before: 3, after: 3, step: 2, loop: true })
    const group = scene.getObjectByName('onion-skins')!
    const dots = group.children.filter((o): o is THREE.Points => (o as THREE.Points).isPoints === true)
    const at = 0.5 + 2 / 30
    const world = worldAt(view, baked.clip, at)
    const bones: THREE.Bone[] = []
    view.root.traverse(o => { if ((o as THREE.Bone).isBone === true) bones.push(o as THREE.Bone) })
    const ghost = dots[3].geometry.attributes.position as THREE.BufferAttribute
    let far = 0
    bones.forEach((b, i) => {
      const name = [...view.rest!.bones].find(([, r]) => r.node === b)?.[0]
      if (name === undefined) return
      far = Math.max(far, new THREE.Vector3().fromBufferAttribute(ghost, i).distanceTo(world.get(name)!.p))
    })
    console.log(`onion: ghost joints within ${(far * 1000).toExponential(2)} mm of the posed bones`)
    expect(far).toBeLessThan(1e-5)
    onion.hide()
    expect(group.visible).toBe(false)
    onion.dispose()
    expect(scene.getObjectByName('onion-skins')).toBeUndefined()
  }, 60000)
})

/** The slot with `bone` turned `degrees` about X at source moment `u` (pinned at the clip's start). */
function keyed (slot: Slot, bone: string, u: number, degrees: number): Slot {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), degrees * deg).toArray() as Quat
  return { ...slot, bones: { ...slot.bones, [bone]: [{ u: 0, q: [0, 0, 0, 1] }, { u: 0.5, q: [0, 0, 0, 1] }, { u, q }] } }
}

