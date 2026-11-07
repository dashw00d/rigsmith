import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'ui.searchbox',
  async run (ui) {
    const app = await ui.app()
    const first = app.characters[0]
    assert.ok(first && app.characters.length > 1, 'search requires two characters')
    await ui.fill({ testid: 'chars-search' }, first.name)
    await ui.waitFor(async r => document.querySelectorAll('[data-testid="chars-row"]').length === 1 && r.app.characters.length > 1)
    assert.equal(await ui.count({ testid: 'chars-row' }), 1)
    assert.ok(await ui.exists({ testid: 'chars-row', id: first.id }))
    await ui.fill({ testid: 'chars-search' }, '')
    assert.equal(await ui.count({ testid: 'chars-row' }), app.characters.length)
    await ui.shot('search')
  },
} satisfies Scenario
