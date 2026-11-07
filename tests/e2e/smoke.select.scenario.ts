import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'smoke.select',
  async run (ui) {
    const app = await ui.app()
    const other = app.characters.find(c => c.id !== app.selectedId)
    assert.ok(other, 'workspace must contain another character')
    await ui.click({ testid: 'chars-row', id: other.id })
    await ui.waitFor(r => r.app.selectedId !== null && r.viewer.shownId === r.app.selectedId && !r.viewer.loading, 60_000)
    assert.equal(await ui.eval(r => r.viewer.shownId), other.id)
    await ui.shot('selected')
  },
} satisfies Scenario
