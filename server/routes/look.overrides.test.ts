// @vitest-environment node
// Texture overrides an import or a rig may lay over a character's source (look.ts textureOverrides): only composites
// composed on that very source with enabled layers behind them. A composite left from another body, or with no layer
// behind it, is set aside (textures/.stale-*), never applied; layers painted on another body are switched off. The
// shaman healer (2026-11-01): the old healer's texture came back on the new body through textures/baked.png.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeRigged } from '../../src/model/fixtures.ts'
import type { Character, TextureLayer } from '../../src/model/types.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'rigsmith-overrides-'))
process.env.RIGSMITH_WORKSPACE = dir
process.env.BLENDER = 'false'
let look: typeof import('./look.ts')
let store: typeof import('../store.ts')

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const layer = (image: string): TextureLayer => ({ id: `l-${image}`, kind: 'repaint', image, file: `textures/layers/l-${image}.png`, enabled: true, at: 1 })

/** A character with a source file, one composite (textures/Body.png) and a record composed on `composedOn`. */
function setup (id: string, o: { layers: TextureLayer[], composedOn?: Buffer }): { folder: string, source: Buffer } {
  const c: Character = { ...makeRigged(), id }
  const source = Buffer.from(`source of ${id}`)
  const folder = path.join(dir, 'characters', id)
  mkdirSync(path.join(folder, 'textures', 'layers'), { recursive: true })
  mkdirSync(path.join(folder, path.dirname(c.source.file)), { recursive: true })
  writeFileSync(path.join(folder, c.source.file), source)
  c.look = { ...c.look, layers: o.layers }
  for (const l of o.layers) writeFileSync(path.join(folder, l.file), 'png')
  writeFileSync(path.join(folder, 'character.json'), JSON.stringify(c))
  writeFileSync(path.join(folder, 'textures', 'Body.png'), 'old composite')
  writeFileSync(path.join(folder, 'textures', '.composed.json'), JSON.stringify({ layers: [], at: 1, ...(o.composedOn !== undefined ? { source: sha(o.composedOn) } : {}) }))
  return { folder, source }
}

beforeAll(async () => {
  look = await import('./look.ts')
  store = await import('../store.ts')
})
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

describe('texture overrides: only composites made on this source', () => {
  it('a composite with no paint layer behind it is set aside, not applied', async () => {
    const { folder } = setup('c1', { layers: [] })
    expect(await look.textureOverrides('c1', 'agent')).toBe(null)
    expect(existsSync(path.join(folder, 'textures', 'Body.png'))).toBe(false)
    const aside = readdirSync(path.join(folder, 'textures')).filter(f => f.startsWith('.stale-'))
    expect(aside.length).toBe(1)
    expect(readFileSync(path.join(folder, 'textures', aside[0], 'Body.png'), 'utf8')).toBe('old composite')
  })
  it('composites and layers made on this very source are applied', async () => {
    const id = 'c2'
    const { folder } = setup(id, { layers: [layer('Body')], composedOn: Buffer.from(`source of ${id}`) })
    expect(await look.textureOverrides(id, 'agent')).toBe(path.join(folder, 'textures'))
    expect(existsSync(path.join(folder, 'textures', 'Body.png'))).toBe(true)
    expect((await store.getCharacter(id))!.look.layers[0].enabled).toBe(true)
  })
  it('a new body: the old composite set aside and the old layers switched off, said in the journal', async () => {
    const { folder } = setup('c3', { layers: [layer('Body')], composedOn: Buffer.from('the old body') })
    expect(await look.textureOverrides('c3', 'agent')).toBe(null)
    expect(existsSync(path.join(folder, 'textures', 'Body.png'))).toBe(false)
    expect((await store.getCharacter('c3'))!.look.layers[0].enabled).toBe(false)
    const journal = readFileSync(path.join(folder, 'journal.jsonl'), 'utf8')
    expect(journal).toContain('made on another body')
    expect(journal).toContain('switched off')
    // (and the record now names this source: a second import applies nothing old)
    expect(await look.textureOverrides('c3', 'agent')).toBe(null)
  })
})
