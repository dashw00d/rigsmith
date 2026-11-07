import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'smoke.gear-select',
  step: 'gear',
  async run (ui) {
    // Until the gear lane adds its stable row testid, resolve the visible row by its accessible button name.
    const row = await ui.eval(r => {
      const gear = r.app.selected?.gear ?? []
      for (const button of document.querySelectorAll('button[aria-pressed]')) {
        const name = (button.textContent ?? '').replace(/\s+/g, ' ').trim()
        const match = gear.find(g => name === g.name || name.startsWith(`${g.name} `))
        if (match !== undefined && button.getBoundingClientRect().width > 0) return { id: match.id, name }
      }
      return null
    })
    assert.ok(row, 'selected folk character must show a gear row')
    await ui.click({ role: 'button', name: row.name })
    assert.equal(await ui.eval(r => r.gear.selected), row.id)
    await ui.shot('gear')
  },
} satisfies Scenario
