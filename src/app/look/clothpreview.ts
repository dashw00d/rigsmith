import type { Character, ClothCut } from '../../model/types.ts'
import { showDressed } from '../../engine/folkview.ts'
import { asset } from '../../state/assets.svelte.ts'
import { dress } from '../../state/dress.svelte.ts'
import { viewer } from '../../state/viewer.svelte.ts'

/** Show a cut draft without writing a command. The stage's next committed dress wins over an older render. */
export async function previewCut (c: Character, id: string, cut: ClothCut): Promise<void> {
  const view = viewer.shownId === c.id ? viewer.character : null
  if (view === null) return
  const worn = dress.worn(c)
  const skin = c.look.skins?.find(s => s.name === worn.skin)
  const ids = new Set(Object.values(worn.layers ?? {}).filter((x): x is string => typeof x === 'string'))
  const layers = (c.look.cloth ?? []).filter(layer => ids.has(layer.id)).map(layer => {
    const nextCut = layer.id === id ? cut : layer.cut
    const url = asset(c, layer.file)
    const mask = nextCut?.mask === undefined ? undefined : asset(c, nextCut.mask)
    if (url === null || mask === null) throw new Error('A selected cloth image is unavailable')
    return { id: layer.id, slots: layer.slots, url, ...(nextCut !== undefined ? { cut: nextCut } : {}), ...(mask !== undefined ? { mask } : {}) }
  })
  await showDressed(view.bodySkinned, {
    skin: skin === undefined ? null : asset(c, skin.file), bare: skin?.bare === undefined ? null : asset(c, skin.bare),
    previewBare: worn.bare === true, layers, height: view.height,
    long: (c.look.cloth ?? []).some(l => ids.has(l.id) && l.shapes?.includes('long_sleeve') === true),
  })
}
