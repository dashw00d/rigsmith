// @vitest-environment node
// A piece's origin moved (gear.origin, src/model/origin.ts) on the workspace's real rigs: every piece some clip keys,
// leads or hands on, and the raider's two (modelled in place, their origins at his feet), their origin put at the middle
// of their mesh. Baked by the one bake on a body wearing its gear as the viewer does, the piece's model (its node, its
// origin undone) is where it was: at rest, on every frame of a clip that only holds it (held by another bone at a place,
// where it was at a switch, its placement again), and at every frame a key of it lands on; between keys that turn it,
// it now turns about its new origin (the point of moving it): how far that moves it is measured and said. A leading
// piece's keys are carried by its path (geartracks.ts leadKeysMoved). Without the workspace it says so and checks nothing.
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { bakeSlot, type BakeContext } from '../../src/engine/bake.ts'
import { CharacterView } from '../../src/engine/CharacterView.ts'
import { boneFrame, originMatrix } from '../../src/engine/garments.ts'
import { leadKeysMoved } from '../../src/engine/geartracks.ts'
import { gearNode } from '../../src/engine/geom.ts'
import { loadGlbFile } from '../../src/engine/headless.ts'
import { frameTimes } from '../../src/engine/keys.ts'
import { applyCommand } from '../../src/model/commands.ts'
import { heightOf, slotByName } from '../../src/model/select.ts'
import type { Character, ClipKey, Gear, HeldBy, Slot, Vec3 } from '../../src/model/types.ts'
import { character, nodeClipSource, settings, WORKSPACE } from '../../tools/lib/node3d.ts'

const CHARACTERS = path.join(WORKSPACE, 'characters')
const ids = existsSync(CHARACTERS) ? readdirSync(CHARACTERS).filter(id => existsSync(path.join(CHARACTERS, id, 'character.json'))).sort() : []
const RAIDER = 'raider-54c0ff'
const SPEARMAN = 'spearman-da04d7'

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

/** The piece's model in the world: its node, its origin undone. */
const modelFrame = (root: THREE.Object3D, g: Gear): THREE.Matrix4 => root.getObjectByName(gearNode(g))!.matrixWorld.clone().multiply(originMatrix(g))
const apart = (a: THREE.Matrix4, b: THREE.Matrix4): number => Math.max(...a.elements.map((x, i) => Math.abs(x - b.elements[i])))

/** The middle of a piece's model (its file's own space). */
async function middleOf (c: Character, g: Gear): Promise<Vec3> {
  const { scene } = await loadGlbFile(path.join(CHARACTERS, c.id, g.model!))
  scene.updateMatrixWorld(true)
  return new THREE.Box3().setFromObject(scene).getCenter(new THREE.Vector3()).toArray() as Vec3
}

/** The slots that play something of the piece: a track, a hand on it, a lead. */
const playing = (c: Character, g: Gear): Slot[] => c.clips.filter(s => s.gear?.[g.id] !== undefined || (s.ik?.hands ?? []).some(h => h.gear === g.id) || s.ik?.lead?.includes(g.id) === true)

interface Measure { rest: number, frames: number, atKeys: number, between: number, n: number }

/** Bake every slot playing `g` on `c` and on `after`, and compare the piece's model frame by frame. */
async function compare (c: Character, after: Character, g: Gear, slots: Slot[]): Promise<Measure> {
  const a = await wearing(c); const b = await wearing(after)
  const g1 = after.gear.find(x => x.id === g.id)!
  const m: Measure = { rest: apart(modelFrame(a.view.root, g), modelFrame(b.view.root, g1)), frames: 0, atKeys: 0, between: 0, n: 0 }
  for (const slot of slots) {
    const ba = await bakeSlot(c, slot, a.ctx)
    const bb = await bakeSlot(after, slotByName(after, slot.name)!, b.ctx)
    const keyed = (ba.gearKeys[g.id] ?? []).map(k => k.u)
    const turns = (ba.gearKeys[g.id] ?? []).length > 1
    // (on the frames the bake gave the piece: three tweens between them, a move and a turn each on its own, so in
    // between them it is as near as its frames are)
    const own = [...(ba.clip.tracks.find(x => x.name === `${gearNode(g)}.position`)?.times ?? [])]
    expect([...(bb.clip.tracks.find(x => x.name === `${gearNode(g1)}.position`)?.times ?? [])]).toEqual(own)
    // (a piece its clip doesn't move has two keys: it rides its bone on every frame of the clip)
    const times = own.length > 2 ? own : frameTimes(ba.clip.duration)
    for (const t of times) {
      poseAt(a.view.root, ba.clip, t); poseAt(b.view.root, bb.clip, t)
      const d = apart(modelFrame(a.view.root, g), modelFrame(b.view.root, g1))
      const onKey = keyed.some(u => Math.abs(u * ba.clip.duration - t) < 1e-6)
      m.n++
      if (!turns || onKey) m.atKeys = Math.max(m.atKeys, d)
      else m.between = Math.max(m.between, d)
      m.frames = Math.max(m.frames, d)
    }
  }
  return m
}

/** `c` with g's origin at `origin`, its leading clips' keys carried by their paths. */
async function moved (c: Character, g: Gear, origin: Vec3): Promise<Character> {
  const lead: Record<string, ClipKey[]> = {}
  const { ctx } = await wearing(c)
  const o = origin.map((x, i) => x - (g.origin ?? [0, 0, 0])[i]) as Vec3
  for (const s of c.clips) {
    const keys = s.gear?.[g.id]?.keys
    if (s.ik?.lead?.includes(g.id) !== true || keys === undefined) continue
    const b = await bakeSlot(c, s, ctx, { skip: ['keys'] })
    lead[s.id] = leadKeysMoved(g, keys, o, b.unkeyed, u => b.time.toPlayed(u), ctx)
  }
  return applyCommand(c, { type: 'gear.origin', id: g.id, origin, lead }).character
}

describe.skipIf(ids.length === 0)('a piece\'s origin moved on the workspace rigs', () => {
  it('moves no piece some clip keys, leads or holds: at rest, at its keys; between turning keys it turns about the new origin', async () => {
    const lines: string[] = []
    for (const id of ids) {
      const c = character(id)
      for (const g of c.gear) {
        if (g.attach.kind !== 'bone' || g.model === undefined || g.status !== 'ready') continue
        const slots = playing(c, g)
        if (slots.length === 0) continue
        const after = await moved(c, g, await middleOf(c, g))
        const m = await compare(c, after, g, slots)
        lines.push(`${id} ${g.name} (${slots.map(s => s.name).join(', ')}): rest ${m.rest.toExponential(1)}, at keys ${m.atKeys.toExponential(1)}, between ${m.between.toExponential(1)} over ${m.n} frames`)
        expect(m.rest, `${id} ${g.name}: at rest`).toBeLessThan(1e-6)
        expect(m.atKeys, `${id} ${g.name}: at its keys`).toBeLessThan(1e-6)
        // (between keys that turn it, about its new origin: a hair, keys being a frame or few apart)
        expect(m.between / heightOf(c), `${id} ${g.name}: between its keys`).toBeLessThan(2e-3)
      }
    }
    console.log(lines.join('\n'))
  }, 600_000)

  it('moves nothing of a piece held by another bone, where it was at a switch, and placed again', async () => {
    const c0 = character(SPEARMAN)
    const spear = c0.gear.find(g => g.name === 'Weapons_RightHand')!
    const atk = slotByName(c0, 'Attack')!
    const heldBy: HeldBy[] = [{ u: 0.2, bone: 'LeftHand', place: { position: [0.1, 1.2, 0.2], rotation: [20, 40, -10], scale: 1 } }, { u: 0.5, bone: 'LeftHand' }, { u: 0.8, bone: 'RightHand', placed: true }]
    const held: Slot = { ...atk, gear: { [spear.id]: { heldBy } } }
    const c: Character = { ...c0, clips: c0.clips.map(s => (s.id === atk.id ? held : s)) }
    const after = await moved(c, spear, await middleOf(c, spear))
    const m = await compare(c, after, spear, [held])
    console.log(`spearman Attack held by: rest ${m.rest.toExponential(1)}, every frame ${m.frames.toExponential(1)} over ${m.n} frames`)
    expect(m.frames).toBeLessThan(1e-6)
  }, 120_000)

  it.skipIf(!ids.includes(RAIDER))('moves nothing of the raider\'s pieces in any of his clips', async () => {
    const c = character(RAIDER)
    let after = c
    for (const g of c.gear) after = await moved(after, after.gear.find(x => x.id === g.id)!, await middleOf(c, g))
    const spear = c.gear.find(g => g.attach.kind === 'bone')!
    const m = await compare(c, after, spear, c.clips)
    console.log(`raider ${spear.name}, origin ${JSON.stringify(after.gear.find(x => x.id === spear.id)!.origin)}: rest ${m.rest.toExponential(1)}, every frame ${m.frames.toExponential(1)} over ${m.n} frames`)
    expect(m.frames).toBeLessThan(1e-6)
  }, 300_000)
})
