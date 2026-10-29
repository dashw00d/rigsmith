// @vitest-environment node
// Schema 3 bakes what schema 2 baked (docs/motion-plan.md §8): for every character of the workspace, every slot baked
// the schema 2 way (./bake_v2.ts, the bake frozen as it was) on its schema 2 record, and the schema 3 way
// (src/engine/bake.ts) on that record migrated (src/model/migrate.ts, its clips measured as tools/migrate.ts measures
// them), agree: the same length, the same tracks, every value at every frame; the gear keys, the pulls' windows and
// the hands' windows at the same phases; and a rider's slots ridden on his horse the same too. Gear nodes are hung on
// the posable copies as the viewer has them, so the gear tracks are compared as well.
//
// It reads the workspace (its characters' character.v2.json, or character.json while it is still schema 2, and the
// library they play from); without one it says so and checks nothing.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { bakeRide, bakeSlot, type BakeContext, type BakedSlot } from '../../src/engine/bake.ts'
import { CharacterView } from '../../src/engine/CharacterView.ts'
import { gearNode } from '../../src/engine/geom.ts'
import { loadGlbFile } from '../../src/engine/headless.ts'
import { migrate } from '../../src/model/migrate.ts'
import type { Character, Window } from '../../src/model/types.ts'
import type { V2Character } from '../../src/model/v2.ts'
import { measureCharacter, nodeClipSource, settings, WORKSPACE } from '../../tools/lib/node3d.ts'
import { bakeRideV2, bakeSlotV2, type BakedSlot as BakedV2 } from './bake_v2.ts'

/** Bone turns and moves (quaternion components, metres) and phases: how near schema 3 must come. */
const VALUE = 1e-6
const PHASE = 1e-9

const CHARACTERS = path.join(WORKSPACE, 'characters')
const ids = existsSync(CHARACTERS) ? readdirSync(CHARACTERS).filter(id => existsSync(path.join(CHARACTERS, id, 'character.json'))).sort() : []

/** The schema 2 record: the copy migration kept, or the file itself while it is still schema 2. */
function v2Of (id: string): { v2: V2Character, file?: string } | null {
  const kept = path.join(CHARACTERS, id, 'character.v2.json')
  if (existsSync(kept)) return { v2: JSON.parse(readFileSync(kept, 'utf8')) as V2Character, file: kept }
  const raw = JSON.parse(readFileSync(path.join(CHARACTERS, id, 'character.json'), 'utf8')) as { schema?: number }
  return raw.schema === 2 ? { v2: raw as V2Character } : null
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
  return { rest: view.rest!, posable: view.root, clips: nodeClipSource(view.rest!, WORKSPACE), fps: 30, sharedPoses: settings().handPoses }
}

function sameClip (was: THREE.AnimationClip, now: THREE.AnimationClip, what: string): number {
  expect(now.duration, `${what}: duration`).toBeCloseTo(was.duration, 9)
  expect(now.tracks.map(t => t.name).sort(), `${what}: tracks`).toEqual(was.tracks.map(t => t.name).sort())
  let worst = 0
  for (const t of was.tracks) {
    const n = now.tracks.find(x => x.name === t.name)!
    expect(n.times.length, `${what}: ${t.name} frames`).toBe(t.times.length)
    for (let i = 0; i < t.times.length; i++) expect(Math.abs(n.times[i] - t.times[i]), `${what}: ${t.name} time ${i}`).toBeLessThan(PHASE)
    for (let i = 0; i < t.values.length; i++) worst = Math.max(worst, Math.abs(n.values[i] - t.values[i]))
  }
  expect(worst, `${what}: the largest difference of a value`).toBeLessThan(VALUE)
  return worst
}

function sameWindows (was: Window[] | undefined, now: Window[] | undefined, what: string): void {
  expect(now?.length, `${what}: windows`).toBe(was?.length)
  for (const [i, w] of (was ?? []).entries()) {
    expect(Math.abs(now![i][0] - w[0]), `${what}: window ${i} start`).toBeLessThan(PHASE)
    expect(Math.abs(now![i][1] - w[1]), `${what}: window ${i} end`).toBeLessThan(PHASE)
  }
}

function sameBake (was: BakedV2, now: BakedSlot, what: string): number {
  const worst = Math.max(sameClip(was.clip, now.clip, what), sameClip(was.unkeyed, now.unkeyed, `${what} (unkeyed)`))
  expect(now.lift, `${what}: lift`).toBeCloseTo(was.lift, 12)
  expect(now.cut === undefined, `${what}: cut`).toBe(was.cut === undefined)
  if (was.cut !== undefined) for (const k of ['start', 'end', 'uncut', 'blow'] as const) expect(now.cut![k], `${what}: cut ${k}`).toBeCloseTo(was.cut[k], 9)
  expect(Object.keys(now.gearKeys).sort(), `${what}: keyed gear`).toEqual(Object.keys(was.gearKeys).sort())
  // (the gear nodes hung on the posable: every placed piece's tracks are among those compared; a character without gear
  // has none in either)
  const placed = (c: THREE.AnimationClip): boolean => c.tracks.some(t => t.name.endsWith('_place.quaternion'))
  expect(placed(now.clip), `${what}: gear tracks`).toBe(placed(was.clip))
  for (const [g, ks] of Object.entries(was.gearKeys)) {
    expect(now.gearKeys[g].length, `${what}: ${g} keys`).toBe(ks.length)
    ks.forEach((k, i) => {
      expect(Math.abs(now.gearKeys[g][i].u - k.u), `${what}: ${g} key ${i}`).toBeLessThan(PHASE)
      expect(now.gearKeys[g][i].q).toEqual(k.q)
    })
  }
  expect(now.pulls.length, `${what}: pulls`).toBe(was.pulls.length)
  was.pulls.forEach((p, i) => sameWindows(p.windows, now.pulls[i].windows, `${what}: pull ${p.handle}`))
  for (const side of ['Left', 'Right'] as const) {
    expect(now.hands[side].map(l => l.reason), `${what}: ${side} hand layers`).toEqual(was.hands[side].map(l => l.reason))
    was.hands[side].forEach((l, i) => sameWindows(l.windows, now.hands[side][i].windows, `${what}: ${side} ${l.reason}`))
  }
  return worst
}

describe.skipIf(ids.length === 0)('schema 3 bakes every workspace slot as schema 2 did', () => {
  for (const id of ids) {
    it(id, async () => {
      const found = v2Of(id)
      if (found === null) { console.log(`${id}: no schema 2 record kept`); return }
      const { v2 } = found
      const times = await measureCharacter(id, { file: found.file, all: true })
      expect(times.problems).toEqual([])
      const v3 = migrate(v2, { clipTimes: times.times }, { strict: true }).character
      const ctx2 = await contextOf(v2); const ctx3 = await contextOf(v3)
      const horse = v2.mount === undefined ? null : v2Of(v2.mount.character)
      const horse3 = horse === null ? null : migrate(horse.v2, {}, { strict: true }).character
      const hctx2 = horse === null ? null : await contextOf(horse.v2)
      const hctx3 = horse3 === null ? null : await contextOf(horse3)
      const lines: string[] = []
      for (const [i, s2] of v2.clips.entries()) {
        const s3 = v3.clips[i]
        expect(s3.id).toBe(s2.id)
        const was = await bakeSlotV2(v2, s2, ctx2)
        const now = await bakeSlot(v3, s3, ctx3)
        let worst = sameBake(was, now, `${id} ${s2.name}`)
        if (v2.mount !== undefined && horse !== null) {
          const o = { loop: s2.loop, attack: was.cut !== undefined, rest: ctx2.rest }
          const r2 = await bakeRideV2(was, { c: horse.v2, ctx: hctx2!, slotName: s2.name }, v2.mount, o)
          const r3 = await bakeRide(now, { c: horse3!, ctx: hctx3!, slotName: s3.name }, v3.mount!, { ...o, rest: ctx3.rest })
          expect(r3.cycles).toBe(r2.cycles)
          worst = Math.max(worst, sameBake(r2.rider, r3.rider, `${id} ${s2.name} ridden`))
          if (r2.horse !== null) worst = Math.max(worst, sameClip(r2.horse, r3.horse!, `${id} ${s2.name}'s horse`))
        }
        lines.push(`${s2.name} ${worst.toExponential(1)}`)
      }
      console.log(`${id}: ${lines.join(', ')}`)
    }, 120_000)
  }
})
