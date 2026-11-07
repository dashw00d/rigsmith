import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'gear.panels',
  step: 'gear',
  async run (ui) {
    await ui.waitFor({ testid: 'gear-row' })
    const piece = await ui.eval(r => {
      const row = document.querySelector<HTMLElement>('[data-testid="gear-row"]')
      return (r.app.selected?.gear ?? []).find(g => g.id === row?.dataset.id) ?? null
    })
    assert.ok(piece, 'fixture has a visible gear row')
    await ui.click({ testid: 'gear-row', id: piece.id })
    assert.equal(await ui.eval(r => r.gear.selected), piece.id)
    await ui.waitFor({ role: 'heading', name: piece.name.toUpperCase() })
    assert.ok(await ui.exists({ role: 'button', name: 'Randomize' }))
    await ui.shot('gear-panel')
  },
} satisfies Scenario
