import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'wardrobe.props-tab', step: 'gear',
  async run (ui) {
    const id = await ui.eval(r => r.app.characters.find(c => !c.folk && !c.gear.some(g => g.outfit !== undefined))?.id ?? null)
    assert.ok(id, 'a non-folk character is required')
    await ui.eval(async (r, id) => { await r.app.select(id) }, id)
    await ui.click({ role: 'button', name: 'Catalog' })
    await ui.waitFor({ testid: 'wardrobe-prop' })
    assert.equal(await ui.eval(() => document.querySelector('[data-testid="wardrobe-tab"][data-id="props"]')?.getAttribute('aria-selected')), 'true')
    assert.equal(await ui.count({ testid: 'wardrobe-tab' }), 2)
    const before = await ui.eval(r => r.app.selected?.gear.length ?? 0)
    const prop = await ui.eval(() => document.querySelector<HTMLElement>('[data-testid="wardrobe-prop"]')?.dataset.id ?? null)
    assert.ok(prop)
    await ui.click({ testid: 'wardrobe-prop', id: prop })
    await ui.eval(async (r, before) => { for (let i = 0; i < 100; i++) { if ((r.app.selected?.gear.length ?? 0) > before) return; await new Promise(resolve => setTimeout(resolve, 100)) } throw new Error('prop was not added') }, before)
    await ui.shot('props')
  },
} satisfies Scenario
