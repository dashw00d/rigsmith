import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'look.cut-uncovered', character: 'folk-v6-0ba482', step: 'look',
  async run (ui) {
    await ui.eval(async r => {
      const c = r.app.selected!
      r.dress.wearOutfit(c, null)
      const skin = c.look.skins!.find(s => s.name === r.dress.worn(c).skin)!
      const { bare } = await import('/state/bare.svelte.ts')
      await bare.make(c, [skin])
      const { clothBody } = await import('/engine/folkview.ts')
      const body = clothBody(r.viewer.character!.bodySkinned)
      const ids = body.list.filter(x => /trouser/i.test(x.material)).map(x => x.id)
      const source = r.app.selected!.look.cloth!.find(l => l.name === 'long_blue')!
      const layer = { ...source, id: 'e2e53001', name: 'Uncovered shorts', slots: ['bottom'], cut: { below: [{ regions: ids, y: 0.35, feather: 0 }] } }
      if (!await r.app.do(c.id, { type: 'look.cloth.add', layer })) throw new Error('Could not create layer')
      const mesh = r.viewer.character!.bodySkinned[0]; const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
      ;(window as unknown as { previousUncovered: unknown }).previousUncovered = (mat as { map: unknown }).map
      r.dress.setLayer(r.app.selected!, 'bottom', layer.id)
    })
    await ui.waitFor(r => {
      const mesh = r.viewer.character?.bodySkinned[0]; if (!mesh) return false
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
      return (mat as { map: unknown }).map !== (window as unknown as { previousUncovered: unknown }).previousUncovered
    }, 60_000)
    assert.equal(await ui.eval(r => r.dress.worn(r.app.selected!).outfit), null)
    await ui.shot('uncovered')
  },
} satisfies Scenario
