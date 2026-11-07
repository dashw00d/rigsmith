import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'gear.bracers-layers', character: 'folk-v6-0ba482', step: 'gear',
  async run (ui) {
    const fixture = await ui.eval(r => {
      const c = r.app.selected!
      const set = c.folk!.sets.find(s => s.name === 'arm_brigandine' && s.grants.includes('bracers'))!
      const layer = c.look.cloth!.find(l => l.shapes?.includes('long_sleeve'))!
      r.dress.setLayer(c, layer.slots[0], layer.id)
      return { set: set.name, setId: set.id, layer: layer.id, slots: layer.slots }
    })
    await ui.click({ testid: 'wardrobe-button' })
    await ui.waitFor({ testid: 'wardrobe-drawer' })
    await ui.fill({ role: 'searchbox', name: 'Search', within: { testid: 'wardrobe-drawer' } }, fixture.set)
    const name = await ui.eval(() => {
      const options = [...document.querySelectorAll<HTMLElement>('[data-testid="wardrobe-drawer"] [role="option"]')]
      if (options.length !== 1) throw new Error(`Expected one filtered set, got ${options.length}`)
      return options[0].innerText.replace(/\s+/g, ' ').trim()
    })
    await ui.click({ role: 'option', name, within: { testid: 'wardrobe-drawer' } })
    await ui.waitFor(r => r.dress.worn(r.app.selected!).outfit === 'arm_brigandine')
    for (const slot of fixture.slots) assert.equal(await ui.eval((r, s) => r.dress.worn(r.app.selected!).layers?.[s as 'top' | 'bottom' | 'over'], slot), null)
    await ui.click({ testid: 'wardrobe-button' })
    await ui.eval((r, data) => {
      const c = r.app.selected!
      r.dress.wearOutfit(c, null)
      r.dress.setLayer(c, data.slots[0], data.layer)
    }, fixture)
    await ui.click({ testid: 'bar-step-motion' })
    await ui.waitFor({ testid: 'motion-dressed-as' })
    const index = await ui.eval((_, id) => [...(document.querySelector('[data-testid="motion-dressed-as"]') as HTMLSelectElement).options].findIndex(o => o.value === id), fixture.setId)
    assert.ok(index >= 0)
    await ui.click({ testid: 'motion-dressed-as' }); await ui.key('Home')
    for (let i = 0; i < index; i++) await ui.key('ArrowDown')
    await ui.key('Enter')
    await ui.waitFor(r => r.dress.worn(r.app.selected!).outfit === 'arm_brigandine')
    for (const slot of fixture.slots) assert.equal(await ui.eval((r, s) => r.dress.worn(r.app.selected!).layers?.[s as 'top' | 'bottom' | 'over'], slot), null)
    await ui.shot('bracers')
  },
} satisfies Scenario
