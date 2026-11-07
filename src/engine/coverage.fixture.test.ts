// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import './headless.ts'
import { CharacterView } from './CharacterView.ts'
import { bodySurface, coveredVertices, takeOff, wear } from './garments.ts'
import { loadGlbFile } from './headless.ts'
import type { Character } from '../model/types.ts'

if (globalThis.ProgressEvent === undefined) {
  globalThis.ProgressEvent = class ProgressEvent extends Event {
    lengthComputable: boolean; loaded: number; total: number
    constructor (type: string, init: ProgressEventInit = {}) { super(type); this.lengthComputable = init.lengthComputable ?? false; this.loaded = init.loaded ?? 0; this.total = init.total ?? 0 }
  } as typeof ProgressEvent
}

const workspace = process.env.RIGSMITH_WORKSPACE
const id = 'folk-v6-0ba482'
const name = 'Outfit_norse_a_leg_L'

describe.skipIf(workspace === undefined || !existsSync(path.join(workspace ?? '', 'characters', id, 'character.json')))('v6 coverage fixture', () => {
  it('Worn.hits agrees within 1% with folk_regions for the same real piece', async () => {
    const dir = path.join(workspace!, 'characters', id)
    const c = JSON.parse(readFileSync(path.join(dir, 'character.json'), 'utf8')) as Character
    const g = c.gear.find(piece => piece.name === name)!
    expect(g.attach.kind).toBe('skin')
    const view = new CharacterView((await loadGlbFile(path.join(dir, c.files.rigged!))).scene)
    const body = bodySurface(view)!
    expect(body.regions.count).toBe(28)
    const url = `data:model/gltf-binary;base64,${readFileSync(path.join(dir, g.model!)).toString('base64')}`
    const worn = await wear(view, g, { url, place: g.attach.place })
    expect(worn?.hits).toBeDefined()
    const covered = coveredVertices(body, worn!.hides!, view.height)
    const expected = new Int32Array(body.regions.count)
    for (let v = 0; v < covered.length; v++) if (covered[v] && body.regions.of[v] >= 0) expected[body.regions.of[v]]++
    expect(Array.from(worn!.hits!)).toEqual(Array.from(expected))
    const cli = execFileSync(process.execPath, ['tools/dev/folk_regions.ts', id, name], { encoding: 'utf8', env: { ...process.env, RIGSMITH_WORKSPACE: workspace }, timeout: 120000 })
    const line = cli.split('\n').find(s => s.startsWith(name))
    expect(line).toBeDefined()
    const shares = new Map([...line!.matchAll(/(\d+):(\d+)%/g)].map(m => [Number(m[1]), Number(m[2])]))
    expect(shares.size).toBeGreaterThan(0)
    for (let r = 0; r < body.regions.count; r++) {
      const pct = worn!.hits![r] / body.regions.vertices[r] * 100
      if (pct > 5) expect(Math.abs(pct - (shares.get(r) ?? -100))).toBeLessThanOrEqual(1)
    }
    takeOff(view, worn!)
  }, 40000)
})

