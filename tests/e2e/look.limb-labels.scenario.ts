import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'look.limb-labels', character: 'folk-v6-0ba482', step: 'look',
  async run (ui) {
    const info = await ui.eval(async r => {
      const { clothBody } = await import('/engine/folkview.ts')
      const { cutLimbGroups } = await import('/app/look/clothdraft.ts')
      const body = clothBody(r.viewer.character!.bodySkinned)
      return { regions: body.list, groups: cutLimbGroups(body.list), layer: r.app.selected!.look.cloth![0].id }
    })
    const sleeves = info.groups.filter(g => g.name.endsWith('sleeve'))
    assert.ok(sleeves.some(g => g.name === 'left sleeve') && sleeves.some(g => g.name === 'right sleeve'), 'fixture must expose both sleeves')
    for (const group of sleeves) for (const id of group.regions) {
      const r = info.regions.find(x => x.id === id)!
      assert.ok(r.minX !== undefined && r.maxX !== undefined && r.sideMargin !== undefined, 'region bounds are present')
      assert.ok(group.name.startsWith('left') ? r.minX > r.sideMargin : r.maxX < -r.sideMargin, `${group.name} uses the character side`)
    }
    const row = { testid: 'look-cloth-row', id: info.layer }
    await ui.click({ testid: 'look-cloth-edit', within: row })
    for (const group of sleeves) assert.ok(await ui.exists({ role: 'slider', name: `${(await ui.eval((r, id) => r.app.selected!.look.cloth!.find(l => l.id === id)!.name, info.layer))} ${group.name} height` }))
    await ui.click({ role: 'button', name: 'Duplicate as short sleeves', within: row })
    await ui.waitFor(r => r.app.selected!.look.cloth!.some(l => l.name.endsWith('short sleeves')))
    const cut = await ui.eval(r => r.app.selected!.look.cloth!.find(l => l.name.endsWith('short sleeves'))!.cut!)
    const actual = cut.below!.flatMap(rule => rule.regions).sort((a, b) => a - b)
    const expected = sleeves.flatMap(g => g.regions).sort((a, b) => a - b)
    assert.deepEqual(actual, expected, 'preset cuts only the displayed sleeve regions')
    await ui.shot('sleeves')
  },
} satisfies Scenario
