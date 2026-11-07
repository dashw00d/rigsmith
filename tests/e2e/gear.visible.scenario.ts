import assert from 'node:assert/strict'
import type { UI } from './gear-ui.ts'

export default {
  name: 'gear.visible',
  step: 'gear',
  async run (ui: UI): Promise<void> {
    await ui.click({ testid: 'wardrobe-button' })
    await ui.waitFor({ testid: 'wardrobe-drawer' })
    await ui.click({ testid: 'wardrobe-tab', id: 'pieces' })
    await ui.waitFor({ testid: 'wardrobe-piece-row' })
    const wardrobeId = await ui.eval(() => document.querySelector<HTMLElement>('[data-testid="wardrobe-piece-row"]')?.dataset.id ?? null)
    assert.ok(wardrobeId, 'fixture must have a wardrobe piece')
    await ui.click({ testid: 'wardrobe-piece-row', id: wardrobeId })
    assert.equal(await ui.eval(r => r.gear.selected), wardrobeId, 'a Wardrobe row selects the piece')
    await ui.click({ testid: 'wardrobe-button' })
    assert.equal(await ui.exists({ testid: 'wardrobe-drawer' }), false)

    assert.match(await ui.text({ testid: 'crowd-toggle' }), /C/)
    await ui.click({ testid: 'crowd-toggle' })
    await ui.waitFor({ testid: 'crowd-canvas' })
    await ui.key('Escape')
    await ui.waitFor(r => !r.wardrobe.crowdOpen)

    await ui.waitFor({ testid: 'gear-search' })
    const before = await ui.count({ testid: 'gear-row' })
    assert.ok(before > 0, 'fixture must list some gear')
    await ui.fill({ testid: 'gear-search' }, 'no-such-piece-zzzz')
    assert.equal(await ui.count({ testid: 'gear-row' }), 0)
    await ui.fill({ testid: 'gear-search' }, '')
    await ui.waitFor(r => [...document.querySelectorAll<HTMLElement>('[data-testid="gear-row"]')]
      .some(e => e.dataset.id !== undefined && r.gear.isWorn(e.dataset.id)), 60_000)
    const id = await ui.eval(r => {
      return [...document.querySelectorAll<HTMLElement>('[data-testid="gear-row"]')].map(e => e.dataset.id)
        .find((value): value is string => value !== undefined && r.gear.isWorn(value)) ?? null
    })
    assert.ok(id, 'fixture needs a worn row')
    await ui.rightClick({ testid: 'gear-row', id })
    await ui.waitFor({ role: 'menuitem', name: 'Hide' })
    await ui.click({ role: 'menuitem', name: 'Hide' })
    await ui.eval(async (r, id) => {
      for (let i = 0; i < 100; i++) { if (!r.gear.isWorn(id)) return; await new Promise(resolve => setTimeout(resolve, 50)) }
      throw new Error('context-menu Hide did not hide the piece')
    }, id)
    assert.ok(await ui.exists({ testid: 'gear-row', id }))
    await ui.shot('gear-visible')
  },
}
