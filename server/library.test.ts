// Library search and ordering against a small fixture manifest (names from the Mixamo names file).
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Clip } from './library.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'rigsmith-library-'))
let queryLibrary: typeof import('./library.ts').queryLibrary
let libraryIndex: typeof import('./library.ts').libraryIndex
let categorize: typeof import('./library.ts').categorize
let CATEGORIES: typeof import('./library.ts').CATEGORIES

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
  mkdirSync(path.join(dir, 'library', 'clips'))
  writeFileSync(path.join(dir, 'library', 'clips', 'a.glb'), 'fixture')
  writeFileSync(path.join(dir, 'library', 'manifest.json'), JSON.stringify({ version: 1, skeleton: 'mixamo', categories: [], clips }))
  process.env.RIGSMITH_WORKSPACE = dir // read when workspace.ts is first imported
  ;({ queryLibrary, libraryIndex, categorize, CATEGORIES } = await import('./library.ts'))
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

describe('counts and categories', () => {
  it('counts the matches, the rig and each category under the search', async () => {
    const page = await queryLibrary({ query: 'walking', source: 'mixamo-pack', page: 0, pageSize: 24 })
    expect(page.total).toBe(2)
    expect(page.all).toBeGreaterThanOrEqual(9)
    expect(page.categories.find(c => c.id === 'locomotion')?.count).toBe(2)
    expect(page.categories.find(c => c.id === 'dance')?.count).toBe(0)
    // (the category filter narrows the clips, not the counts)
    const dance = await queryLibrary({ category: 'dance', source: 'mixamo-pack', page: 0, pageSize: 24 })
    expect(dance.total).toBe(1)
    expect(dance.categories.find(c => c.id === 'locomotion')?.count).toBe(3)
  })

  it('offers one category vocabulary, and files bundled clips in it', async () => {
    const page = await queryLibrary({ page: 0, pageSize: 1 })
    expect(page.categories.map(c => c.id)).toEqual(CATEGORIES.map(c => c.id))
    expect(categorize('Trot')).toBe('locomotion')
    expect(categorize('Climbing_Ladder')).toBe('climb')
    expect(categorize('Something')).toBe('gesture')
    expect(CATEGORIES.map(c => c.id)).toContain(categorize('Idle_Breathe'))
  })

  it('clamps the page and its size', async () => {
    const page = await queryLibrary({ source: 'mixamo-pack', page: 99, pageSize: 0 })
    expect(page.pageSize).toBe(1)
    expect(page.page).toBe(page.pages - 1)
  })
})

describe('compact index', () => {
  it('contains the clip URL and file mtime and filters by rig', async () => {
    const rows = await libraryIndex('human')
    expect(rows.find(c => c.id === 'a')).toMatchObject({ name: 'Walking', url: '/files/library/clips/a.glb', addedAt: statSync(path.join(dir, 'library', 'clips', 'a.glb')).mtimeMs, rig: 'human' })
    expect(rows.some(c => c.id === 'g')).toBe(false)
    expect((await libraryIndex('not-a-rig'))).toEqual([])
  })
})
