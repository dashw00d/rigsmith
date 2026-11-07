import type { ClothCut, ClothLayer, ClothSlot } from '../../model/types.ts'
import type { RegionInfo } from '../../engine/clothcut.ts'
import { limbGroups } from '../../engine/clothcut.ts'

export function groupRule (cut: ClothCut | undefined, regions: readonly number[]): { y: number, feather: number } {
  return cut?.below?.find(rule => rule.regions.some(id => regions.includes(id))) ?? { y: 0, feather: 0.01 }
}

/** Change only this limb, splitting any rule it previously shared with another limb. */
export function cutGroup (cut: ClothCut | undefined, regions: readonly number[], y: number, feather: number): ClothCut {
  const ids = new Set(regions)
  const below = (cut?.below ?? []).flatMap(rule => {
    const kept = rule.regions.filter(id => !ids.has(id))
    return kept.length === 0 ? [] : [{ ...rule, regions: kept }]
  })
  return { ...cut, below: [...below, { regions: [...regions], y, feather }] }
}

export function dropRegion (cut: ClothCut | undefined, id: number, drop: boolean): ClothCut {
  const ids = new Set(cut?.drop ?? [])
  if (drop) ids.add(id); else ids.delete(id)
  const result = { ...cut }
  if (ids.size > 0) result.drop = [...ids].sort((a, b) => a - b)
  else delete result.drop
  return result
}

/** Create a duplicate with the requested limb cut, keeping its source image. */
export function duplicateCut (layer: ClothLayer, id: string, kind: 'shorts' | 'sleeves', regions: readonly RegionInfo[]): ClothLayer {
  const part = kind === 'shorts' ? 'leg' : 'sleeve'
  const slot: ClothSlot = kind === 'shorts' ? 'bottom' : 'top'
  const groups = limbGroups(regions).filter(group => group.name.endsWith(part))
  let cut: ClothCut = { ...layer.cut }
  for (const group of groups) cut = cutGroup(cut, group.regions, kind === 'shorts' ? 0.35 : 0.55, 0.01)
  const copy: ClothLayer = { ...layer, id, name: `${layer.name} ${kind === 'shorts' ? 'shorts' : 'short sleeves'}`, slots: [slot], cut }
  delete copy.from
  if (kind === 'sleeves' && copy.shapes !== undefined) {
    copy.shapes = copy.shapes.filter(shape => shape !== 'long_sleeve')
    if (copy.shapes.length === 0) delete copy.shapes
  }
  return copy
}
