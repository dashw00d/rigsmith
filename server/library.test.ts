// Library search and ordering against a small fixture manifest (names from the Mixamo names file).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Clip } from './library.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'rigsmith-library-'))
let queryLibrary: typeof import('./library.ts').queryLibrary

function clip (id: string, name: string, extra: Partial<Clip> = {}): Clip {
  return {
    id, name, source: 'mixamo-pack', file: `clips/${id}.glb`, fps: 60, frames: 61, duration: 1, category: 'locomotion',
    tags: [], loop: true, inPlace: false, duplicateOf: null, nameSource: 'motion-match', ...extra,
  }
}

beforeAll(async () => {
  mkdirSync(path.join(dir, 'library'), { recursive: true })
  const clips = [
    clip('a', 'Walking', { description: 'Walking With A Briefcase' }),
    clip('b', 'Walking', { description: 'Male Standard Walk' }),
    clip('c', 'Belly Dance', { category: 'dance', tags: ['turn-left'] }),
    clip('d', 'Left Turn', { description: 'Standing Left Turn' }),
    clip('e', 'Laying Shaking Head', { category: 'sit-lie', nameSource: 'motion-candidate', candidates: [{ name: 'Laying Nodding' }] }),
    clip('f', 'Breathing Idle', { category: 'idle', nameSource: 'matched' }),
    clip('h', 'Guitar Playing', { category: 'work', description: 'Playing A Guitar' }),
    clip('g', 'Walking', { description: 'Walking With A Briefcase', duplicateOf: 'a' }),
    clip('mixamo-Jab_Cross', 'Jab Cross', { source: 'mixamo-catalog', nameSource: 'catalog', sourceName: 'Jab_Cross', originalName: 'Jab Cross', description: 'Short Jab Cross' }),
    clip('mixamo-Jab_Cross_2', 'Jab Cross 2', { source: 'mixamo-catalog', nameSource: 'catalog', sourceName: 'Jab_Cross_2', originalName: 'Jab Cross', description: 'Boxing Jab Cross Long' }),
  ]
  writeFileSync(path.join(dir, 'library', 'manifest.json'), JSON.stringify({ version: 1, skeleton: 'mixamo', categories: [], clips }))
  process.env.RIGSMITH_WORKSPACE = dir // read when workspace.ts is first imported
  ;({ queryLibrary } = await import('./library.ts'))
})
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

const ids = async (query: string): Promise<string[]> =>
  (await queryLibrary({ query, source: 'mixamo-pack', page: 0, pageSize: 96 })).clips.map(c => c.id)

describe('queryLibrary', () => {
  it('searches descriptions and candidate names', async () => {
    expect(await ids('briefcase')).toEqual(['a'])
    expect(await ids('nodding')).toEqual(['e'])
  })

  it('ranks word-start name matches, then other name matches, then tag-only matches', async () => {
    expect(await ids('left turn')).toEqual(['d', 'c'])
    expect(await ids('laying')).toEqual(['e', 'h'])
  })

  it('hides duplicates and sorts own clips first, then by name and description', async () => {
    expect(await ids('')).toEqual(['f', 'c', 'h', 'e', 'd', 'b', 'a'])
  })

  it('keeps numbered catalog variants and searches source filenames and descriptions', async () => {
    const query = async (query: string) => (await queryLibrary({ query, source: 'mixamo-catalog', page: 0, pageSize: 24 })).clips
    expect((await query('jab cross')).map(c => c.name)).toEqual(['Jab Cross', 'Jab Cross 2'])
    expect((await query('Jab_Cross_2.fbx')).map(c => c.id)).toEqual(['mixamo-Jab_Cross_2'])
    expect((await query('boxing long')).map(c => c.id)).toEqual(['mixamo-Jab_Cross_2'])
  })
})
