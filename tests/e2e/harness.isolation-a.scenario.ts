import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'harness.isolation-a', character: 'folk-v6-0ba482',
  async run (ui) {
    const ok = await ui.eval(async r => {
      const c = r.app.selected!
      return !!await r.app.do(c.id, { type: 'folk.kind.add', kind: { id: 'e2e_isolation', name: 'Isolation sentinel', tags: [], sets: [] } })
    })
    assert.ok(ok, 'first scenario writes its own workspace')
  },
} satisfies Scenario
