import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'harness.isolation-b', character: 'folk-v6-0ba482',
  async run (ui) {
    assert.equal(await ui.eval(r => r.app.selected!.folk!.kinds.some(k => k.id === 'e2e_isolation')), false,
      'another scenario must start from the original workspace, not the previous scenario changes')
  },
} satisfies Scenario
