import { describe, expect, it } from 'vitest'
import { bodyField, composeCloth, cutAlpha, limbGroups, makeBare, skinTone } from './clothcut.ts'

describe('cloth image core', () => {
  const field = bodyField({
    positions: [0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 2, 0, 0],
    uv: [0, 0, 0, 1, 0.5, 0, 0.5, 0, 0.5, 1, 1, 0], index: [0, 1, 2, 3, 4, 5],
  }, [0, 0, 0, 1, 1, 1], 1, 8)
  it('rasterises two regions and interpolates body height', () => {
    expect(new Set(field.region)).toEqual(new Set([-1, 0, 1]))
    expect(field.y[6 * 8]).toBeLessThan(field.y[3 * 8])
  })
  it('feathers monotonically, drops regions, and multiplies by the mask', () => {
    const rgba = new Uint8ClampedArray(8 * 8 * 4).fill(255)
    const cut = cutAlpha(rgba, 8, 8, field, { below: [{ regions: [0], y: 0.5, feather: 0.4 }], drop: [1] })
    expect(cut[(6 * 8) * 4 + 3]).toBeLessThan(cut[(3 * 8) * 4 + 3])
    const p = field.region.findIndex(r => r === 1)
    expect(cut[p * 4 + 3]).toBe(0)
    expect(cutAlpha(rgba, 8, 8, field, {}, new Uint8ClampedArray(rgba.length))[3]).toBe(0)
  })
  it('fills clothes and seam padding without changing skin texels', () => {
    const rgba = new Uint8ClampedArray(8 * 8 * 4).fill(255)
    for (let p = 0; p < field.region.length; p++) if (field.region[p] === 0) rgba.set([120, 80, 60, 255], p * 4)
    expect(skinTone(rgba, field, [0])).toEqual([120, 80, 60])
    const out = makeBare(rgba, field, [0], [1])
    for (let p = 0; p < field.region.length; p++) {
      if (field.region[p] === 0) expect([...out.slice(p * 4, p * 4 + 4)]).toEqual([...rgba.slice(p * 4, p * 4 + 4)])
      if (field.region[p] === 1) expect([...out.slice(p * 4, p * 4 + 3)]).toEqual([120, 80, 60])
    }
  })
  it('composites a two-slot layer once in slot order', () => {
    const image = (rgba: number[]) => ({ rgba: Uint8ClampedArray.from(rgba), width: 1, height: 1 })
    const base = image([0, 0, 0, 255])
    const result = composeCloth({ base, layers: [{ ...image([255, 0, 0, 128]), id: 'both', slots: ['bottom', 'top'] }] })
    expect([...result.rgba]).toEqual([128, 0, 0, 255])
    expect(limbGroups([{ id: 3, material: 'Trousers', x: -1 }, { id: 4, material: 'Shirt', x: 1 }])).toEqual([{ name: 'left leg', regions: [3] }, { name: 'right sleeve', regions: [4] }])
  })
})
