// @vitest-environment node
// Schema 4 bakes what schema 3 baked (docs/motion-plan.md §11.6): for every character of the workspace, every slot
// baked the schema 3 way (./v3/bake.ts, bake.ts frozen as it was before pieces, holds and all) on its schema 3 record
// and the schema 4 way (src/engine/bake.ts) on that record migrated: the same length, the same tracks, every value at
// every frame the same (the largest difference 0: a slot without holds is one piece, its clip whole, and bakes down the
// very path it did); riders ridden on their horse too. And a hold made a held piece bakes as the hold did.
//
// It reads the workspace (its characters' character.v3.json, or character.json while it is still schema 3, and the
// library they play from); without one it says so and checks nothing.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { bakeRide, bakeSlot, type BakeContext } from '../../src/engine/bake.ts'
import { CharacterView } from '../../src/engine/CharacterView.ts'
import { gearNode } from '../../src/engine/geom.ts'
import { loadGlbFile } from '../../src/engine/headless.ts'
import { migrate } from '../../src/model/migrate.ts'
import type { Character } from '../../src/model/types.ts'
import type { V3Character } from '../../src/model/v3.ts'
import { measureCharacter, nodeClipSource, nodeRom, settings, WORKSPACE } from '../../tools/lib/node3d.ts'
import { bakeRide as bakeRideV3, bakeSlot as bakeSlotV3 } from './v3/bake.ts'

const CHARACTERS = path.join(WORKSPACE, 'characters')
const ids = existsSync(CHARACTERS) ? readdirSync(CHARACTERS).filter(id => existsSync(path.join(CHARACTERS, id, 'character.json'))).sort() : []

/** The schema 3 record: the copy migration kept, or the file itself while it is still schema 3. */
function v3Of (id: string): { v3: V3Character, file?: string } | null {
  const kept = path.join(CHARACTERS, id, 'character.v3.json')
  if (existsSync(kept)) return { v3: JSON.parse(readFileSync(kept, 'utf8')) as V3Character, file: kept }
  const raw = JSON.parse(readFileSync(path.join(CHARACTERS, id, 'character.json'), 'utf8')) as { schema?: number }
  return raw.schema === 3 ? { v3: raw as V3Character } : null
}

/** A body as the viewer holds it, with an empty node for every bone gear piece where the gear area hangs one. */
async function contextOf (c: Pick<Character, 'id' | 'files' | 'gear'>): Promise<BakeContext> {
  const { scene } = await loadGlbFile(path.join(CHARACTERS, c.id, c.files.rigged!))
  const view = new CharacterView(scene)
  for (const g of c.gear) {
    if (g.attach.kind !== 'bone' || g.attach.legacyFrame !== undefined) continue
    const bone = view.root.getObjectByName(g.attach.bone)
    if (bone === undefined) continue
    const node = new THREE.Object3D()
    node.name = gearNode(g)
    bone.add(node)
  }
  view.root.updateMatrixWorld(true)
  return { rest: view.rest!, posable: view.root, clips: nodeClipSource(view.rest!, WORKSPACE), fps: 30, sharedPoses: settings().handPoses, rom: nodeRom }
}

/** The largest difference of any value (and time) of two clips, after their lengths and tracks are found the same. */
function difference (was: THREE.AnimationClip, now: THREE.AnimationClip, what: string): number {
  expect(now.duration, `${what}: duration`).toBe(was.duration)
  expect(now.tracks.map(t => t.name).sort(), `${what}: tracks`).toEqual(was.tracks.map(t => t.name).sort())
  let worst = 0
  for (const t of was.tracks) {
    const n = now.tracks.find(x => x.name === t.name)!
    expect(n.times.length, `${what}: ${t.name} frames`).toBe(t.times.length)
    for (let i = 0; i < t.times.length; i++) worst = Math.max(worst, Math.abs(n.times[i] - t.times[i]))
    for (let i = 0; i < t.values.length; i++) worst = Math.max(worst, Math.abs(n.values[i] - t.values[i]))
  }
  return worst
}

describe.skipIf(ids.length === 0)('schema 4 bakes every workspace slot as schema 3 did', () => {
  for (const id of ids) {
    it(id, async () => {
      const found = v3Of(id)
      if (found === null) { console.log(`${id}: no schema 3 record kept`); return }
      const { v3 } = found
      if (v3.files.rigged === undefined) return
      const times = await measureCharacter(id, { file: found.file })
      const v4 = migrate(v3, { clipTimes: times.times }, { strict: true }).character
      const was = v3 as unknown as Character
      const ctx3 = await contextOf(was); const ctx4 = await contextOf(v4)
      const horse = v3.mount === undefined ? null : v3Of(v3.mount.character)
      const horse4 = horse === null ? null : migrate(horse.v3, {}, { strict: true }).character
      const hctx3 = horse === null ? null : await contextOf(horse.v3 as unknown as Character)
      const hctx4 = horse4 === null ? null : await contextOf(horse4)
      const lines: string[] = []
      for (const [i, s3] of v3.clips.entries()) {
        const s4 = v4.clips[i]
        expect(s4.id).toBe(s3.id)
        const a = await bakeSlotV3(was, s3 as never, ctx3)
        const b = await bakeSlot(v4, s4, ctx4)
        let worst = Math.max(difference(a.clip, b.clip, `${id} ${s3.name}`), difference(a.unkeyed, b.unkeyed, `${id} ${s3.name} unkeyed`))
        expect(b.events, `${id} ${s3.name}: events`).toEqual(a.events)
        expect(b.gearKeys, `${id} ${s3.name}: gear keys`).toEqual(a.gearKeys)
        expect(b.pulls, `${id} ${s3.name}: pulls`).toEqual(a.pulls)
        expect(b.cut, `${id} ${s3.name}: cut`).toEqual(a.cut)
        if (v3.mount !== undefined && horse !== null) {
          const o = { loop: s3.loop, attack: a.cut !== undefined, rest: ctx3.rest }
          const r3 = await bakeRideV3(a, { c: horse.v3 as unknown as Character, ctx: hctx3!, slotName: s3.name }, v3.mount, o)
          const r4 = await bakeRide(b, { c: horse4!, ctx: hctx4!, slotName: s4.name }, v4.mount!, { ...o, rest: ctx4.rest })
          expect(r4.cycles).toBe(r3.cycles)
          worst = Math.max(worst, difference(r3.rider.clip, r4.rider.clip, `${id} ${s3.name} ridden`))
          if (r3.horse !== null) worst = Math.max(worst, difference(r3.horse, r4.horse!, `${id} ${s3.name}'s horse`))
        }
        // (a slot without holds is its clip whole: the same path, so the same numbers to the last bit)
        if ((s3.time?.holds ?? []).length === 0) expect(worst, `${id} ${s3.name}: the largest difference`).toBe(0)
        lines.push(`${s3.name} ${worst}`)
      }
      console.log(`${id}: ${lines.join(', ')}`)
    }, 180_000)
  }
})

describe.skipIf(ids.length === 0 || !ids.some(id => id.startsWith('archer-')))('a hold made a held piece', () => {
  it('bakes as the hold did (the archer\'s Attack and Walk, held at a moment)', async () => {
    const id = ids.find(x => x.startsWith('archer-'))!
    const found = v3Of(id)
    if (found === null) return
    // (holds put in his schema 3 record: Walk held half a second at 40 %, with a key in it; Attack, with its blow fit,
    // held at 30 %)
    const v3 = structuredClone(found.v3)
    const walk = v3.clips.find(s => s.name === 'Walk')!
    walk.time = { ...walk.time, holds: [{ id: 'hw', u: 0.4, seconds: 0.5 }] }
    walk.bones = { ...walk.bones, Spine: [{ u: 0.2, q: [0.1, 0, 0, 0.995] }, { u: 0.4, q: [0, 0, 0, 1] }, { u: 0.8, q: [0, 0.1, 0, 0.995] }] }
    const attack = v3.clips.find(s => s.name === 'Attack')!
    attack.time = { ...attack.time, holds: [{ id: 'ha', u: 0.3, seconds: 0.25 }] }
    const ctx = await contextOf(v3 as unknown as Character)
    const seconds = async (s: typeof walk): Promise<number> => (await ctx.clips.get(s.clip, { inPlace: s.inPlace, fps: 30 })).duration
    const v4 = migrate(v3, { clipTimes: { [walk.id]: { seconds: await seconds(walk) }, [attack.id]: { seconds: await seconds(attack) } } }, { strict: true }).character
    for (const name of ['Walk', 'Attack']) {
      const s3 = v3.clips.find(s => s.name === name)!; const s4 = v4.clips.find(s => s.name === name)!
      expect(s4.pieces?.some(p => p.kind === 'hold')).toBe(true)
      const a = await bakeSlotV3(v3 as unknown as Character, s3 as never, ctx)
      const b = await bakeSlot(v4, s4, await contextOf(v4))
      expect(b.clip.duration).toBeCloseTo(a.clip.duration, 9)
      // (the same frames: each of the composite is the clip's at the same second, a hold its pose at the hold)
      const d = difference(a.clip, b.clip, `archer ${name}`)
      expect(d).toBeLessThan(1e-9)
      expect(b.events.map(e => [e.name, e.t])).toEqual(a.events.map(e => [e.name, expect.closeTo(e.t, 6)]))
    }
  }, 180_000)
})
