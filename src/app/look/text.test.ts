import { describe, expect, it } from 'vitest'
import { makeCharacter } from '../../model/fixtures.ts'
import type { TextureLayer } from '../../model/types.ts'
import { ago, layerDetail, paintBlock, percent, promptFor, resultFile, scanLines } from './text.ts'

const layer = (over: Partial<TextureLayer>): TextureLayer => ({ id: 'a1', kind: 'repaint', image: 'Body', file: 'textures/layers/a1.png', enabled: true, at: 0, ...over })

describe('the Look step\'s words', () => {
  it('gives shares as percentages, small ones finer', () => {
    expect(percent(0.123)).toBe('12.3%')
    expect(percent(0.0042)).toBe('0.42%')
    expect(percent(0)).toBe('0.0%')
  })

  it('says what a layer holds', () => {
    expect(layerDetail(layer({ kind: 'fill', coverage: 0.031 }), false)).toBe('3.1% was unpainted')
    expect(layerDetail(layer({ note: 'a purple stole' }), true)).toBe('Body · a purple stole')
    expect(layerDetail(layer({ kind: 'snapshot' }), false)).toBe('')
  })

  it('reads the hole scan against the fill layers', () => {
    const scan = { images: [{ image: 'Body', coverage: 0.02 }, { image: 'Head', coverage: 0.0001 }, { image: 'Cape', coverage: 0.01 }] }
    const lines = scanLines(scan, [layer({ kind: 'fill', image: 'Body' }), layer({ kind: 'fill', image: 'Cape', enabled: false })])
    expect(lines).toEqual([
      { image: 'Body', text: '2.0% unpainted, filled', tone: 'ok' },
      { image: 'Head', text: 'no holes', tone: 'ok' },
      { image: 'Cape', text: '1.0% unpainted, its fill is off', tone: 'warn' },
    ])
    expect(scanLines({ images: [{ image: 'Body', coverage: 0.3 }] }, [])[0]).toEqual({ image: 'Body', text: '30.0% unpainted, not filled', tone: 'warn' })
    expect(scanLines(undefined, [])).toEqual([])
    // (a texture from before layers, named as v1 cleaned it, has its fill in it)
    expect(scanLines({ images: [{ image: 'tripo_rgb_c1_9', coverage: 0.05 }] }, [layer({ kind: 'snapshot', image: 'tripo_rgb_c1-9' })])[0])
      .toEqual({ image: 'tripo_rgb_c1_9', text: '5.0% unpainted, filled in the earlier texture', tone: 'ok' })
  })

  it('says why painting can\'t start', () => {
    const mesh = makeCharacter()
    const rigged = makeCharacter({ source: { ...mesh.source, kind: 'rigged' } })
    expect(paintBlock(mesh, 'needs-rig', 'ok')).toBeNull()
    expect(paintBlock(mesh, 'rigged', 'ok')).toBeNull()
    expect(paintBlock(rigged, 'needs-conversion', 'ok')).toMatch(/Convert/)
    expect(paintBlock(rigged, 'needs-rig', 'ok')).toMatch(/Rig it first/)
    expect(paintBlock(mesh, 'importing', 'ok')).toMatch(/import/)
    expect(paintBlock(mesh, 'animation-only', 'ok')).toMatch(/animation/)
    expect(paintBlock(mesh, 'rigged', 'loading')).toMatch(/loading/)
    expect(paintBlock(mesh, 'rigged', 'no-texture')).toMatch(/no colour texture/)
  })

  it('says how long ago', () => {
    const now = 10 * 86_400_000
    expect(ago(now - 20_000, now)).toBe('just now')
    expect(ago(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(ago(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(ago(now - 3 * 86_400_000, now)).toBe('3 days ago')
  })

  it('names a view\'s result after the image given', () => {
    expect(resultFile(2, { type: 'image/png', name: 'x.png' })).toBe('result-2.png')
    expect(resultFile(1, { type: 'image/jpeg', name: 'x' })).toBe('result-1.jpg')
    expect(resultFile(3, { type: '', name: 'paint.JPEG' })).toBe('result-3.jpg')
    expect(resultFile(1, { type: 'image/gif', name: 'x.gif' })).toBeNull()
  })

  it('asks Codex for one edit a view, with the notes', () => {
    const one = promptFor([{ name: 'front' }], '  a purple stole ', 'Priest')
    expect(one).toContain('# Repaint request: Priest')
    expect(one).toContain('- View 1 (front): view-1-flat.png + view-1-mask.png → result-1.png')
    expect(one).toContain('What to change: a purple stole\n')
    expect(one).not.toContain('one design')
    const two = promptFor([{ name: 'front' }, { name: 'back' }], '', 'Priest')
    expect(two).toContain('result-2.png')
    expect(two).toContain('paint it as one design')
    expect(two).not.toContain('What to change')
  })
})
