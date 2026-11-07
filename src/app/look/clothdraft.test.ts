import { describe, expect, it } from 'vitest'
import { cutGroup, dropRegion, duplicateCut, groupRule } from './clothdraft.ts'

const regions = [{ id: 1, material: 'Trousers', x: -1 }, { id: 2, material: 'Trousers', x: 1 }, { id: 3, material: 'Shirt', x: -1 }]
describe('cloth cut drafts', () => {
  it('splits shared rules when changing one limb and retains the mask and other cuts', () => {
    const next = cutGroup({ below: [{ regions: [1, 2], y: 0.4, feather: 0.03 }], mask: 'cloth/mask.png', drop: [7] }, [1], 0.35, 0.01)
    expect(next).toEqual({ below: [{ regions: [2], y: 0.4, feather: 0.03 }, { regions: [1], y: 0.35, feather: 0.01 }], mask: 'cloth/mask.png', drop: [7] })
    expect(groupRule(next, [1]).y).toBe(0.35)
    expect(dropRegion(dropRegion(next, 2, true), 7, false).drop).toEqual([2])
  })
  it('duplicates the image as shorts with cuts for both legs', () => {
    const copy = duplicateCut({ id: 'original', name: 'Trousers', file: 'cloth.png', slots: ['top', 'bottom'] }, 'shorts', 'shorts', regions)
    expect(copy.file).toBe('cloth.png')
    expect(copy.slots).toEqual(['bottom'])
    expect(copy.cut?.below).toEqual([{ regions: [1], y: 0.35, feather: 0.01 }, { regions: [2], y: 0.35, feather: 0.01 }])
  })
})
