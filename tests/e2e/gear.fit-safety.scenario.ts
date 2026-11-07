import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'gear.fit-safety', step: 'gear',
  async run (ui) {
    await ui.waitFor({ testid: 'gear-row' })
    await ui.waitFor(r => r.app.selected?.gear.some(g => g.attach.kind === 'skin' && r.gear.isWorn(g.id)) === true, 60_000)
    const piece = await ui.eval(r => {
      const ids = [...document.querySelectorAll<HTMLElement>('[data-testid="gear-row"]')].map(x => x.dataset.id)
      return r.app.selected!.gear.find(g => ids.includes(g.id) && g.attach.kind === 'skin' && g.status === 'ready' && r.gear.isWorn(g.id)) ?? null
    })
    assert.ok(piece, 'fixture needs a shown skin piece')
    await ui.click({ testid: 'gear-row', id: piece.id })
    await ui.click({ role: 'button', name: 'Place it' })
    const before = await ui.eval(r => r.gear.fitStart)
    assert.equal(before?.id, piece.id)
    await ui.clickAt({ testid: 'viewport-canvas' }, 12, 100)
    assert.equal(await ui.eval(r => r.gear.fitting), piece.id, 'stage click preserves placement')
    assert.deepEqual(await ui.eval(r => r.gear.fitStart), before)

    await ui.click({ role: 'button', name: 'Drag', within: { role: 'group', name: 'Origin' } })
    assert.equal(await ui.eval(r => r.gear.placingOrigin), piece.id)
    await ui.key('Escape')
    assert.equal(await ui.eval(r => r.gear.placingOrigin), null)
    assert.equal(await ui.eval(r => r.gear.fitting), piece.id, 'Escape ends origin drag only')

    const position = { role: 'spinbutton', name: 'Position X' }
    await ui.fill(position, String(piece.attach.place.position[0] + .2))
    await ui.key('Enter')
    await ui.key('Escape')
    assert.equal(await ui.eval(r => r.gear.fitting), piece.id, 'Escape in a field leaves placement active')
    await ui.click({ testid: 'wardrobe-button' })
    await ui.waitFor({ testid: 'wardrobe-drawer' })
    await ui.key('Escape')
    assert.equal(await ui.eval(r => r.gear.fitting), piece.id, 'Escape closing the drawer leaves placement active')
    await ui.click({ testid: 'fit-cancel' })
    await ui.waitFor(r => r.gear.fitting === null, 30_000)
    const place = await ui.eval((r, id) => r.app.selected!.gear.find(g => g.id === id)!.attach.place, piece.id)
    assert.deepEqual(place, piece.attach.place)
    await ui.shot('fit-safety')
  },
} satisfies Scenario
