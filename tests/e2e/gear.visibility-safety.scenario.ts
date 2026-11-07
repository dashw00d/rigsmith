import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'gear.visibility-safety', step: 'gear',
  async run (ui) {
    await ui.waitFor({ testid: 'gear-row' })
    const setup = await ui.eval(r => {
      const c = r.app.selected!
      const worn = r.dress.worn(c).outfit
      const set = c.folk!.sets.find(s => s.name !== worn && s.pieces.some(id => c.gear.some(g => g.id === id && g.status === 'ready')))
      const hair = c.gear.find(g => g.role === 'hair' && g.status === 'ready')
      if (set === undefined || hair === undefined) return null
      return { set: set.name, piece: set.pieces[0], hair: hair.id }
    })
    assert.ok(setup, 'fixture needs another set and hair')
    await ui.eval((r, id) => { r.gear.select(id) }, setup.piece)
    await ui.waitFor({ testid: 'gear-shown' })
    assert.equal(await ui.eval((r, id) => r.gear.shownOnStage(r.app.selected!, r.app.selected!.gear.find(g => g.id === id)!), setup.piece), false)
    await ui.click({ testid: 'gear-shown' })
    assert.equal(await ui.eval((r, id) => r.gear.shownOnStage(r.app.selected!, r.app.selected!.gear.find(g => g.id === id)!), setup.piece), true)
    assert.equal(await ui.eval(r => r.dress.worn(r.app.selected!).outfit), setup.set)

    await ui.eval((r, id) => { const c = r.app.selected!; r.dress.setHair(c, null); r.gear.select(id) }, setup.hair)
    await ui.waitFor({ testid: 'gear-shown' })
    await ui.click({ testid: 'gear-shown' })
    assert.equal(await ui.eval((r, id) => r.gear.shownOnStage(r.app.selected!, r.app.selected!.gear.find(g => g.id === id)!), setup.hair), true)

    await ui.waitFor({ testid: 'gear-eye', id: setup.piece })
    await ui.click({ testid: 'gear-eye', id: setup.piece })
    assert.equal(await ui.eval((r, id) => r.gear.shownOnStage(r.app.selected!, r.app.selected!.gear.find(g => g.id === id)!), setup.piece), false)
    await ui.click({ testid: 'wardrobe-button' })
    await ui.waitFor({ testid: 'wardrobe-drawer' })
    await ui.click({ testid: 'wardrobe-tab', id: 'sets' })
    await ui.eval(async r => {
      const grid = document.querySelector<HTMLElement>('[role="listbox"][aria-label="Sets"]')
      const tile = grid?.querySelector<HTMLElement>('[role="option"][aria-selected="false"]')
      if (grid === null || grid === undefined || tile === null || tile === undefined) throw new Error('No alternate Wardrobe tile')
      const before = r.dress.worn(r.app.selected!).outfit
      tile.dispatchEvent(new PointerEvent('pointerenter'))
      for (let i = 0; i < 80 && r.dress.worn(r.app.selected!).outfit === before; i++) await new Promise(resolve => setTimeout(resolve, 50))
      if (r.dress.worn(r.app.selected!).outfit === before) throw new Error('Hover did not preview an alternate set')
      grid.dispatchEvent(new PointerEvent('pointerleave'))
    })
    assert.equal(await ui.eval((r, id) => r.gear.shownOnStage(r.app.selected!, r.app.selected!.gear.find(g => g.id === id)!), setup.piece), false, 'hover leaves the eye hide intact')
    await ui.shot('visibility')
  },
} satisfies Scenario
