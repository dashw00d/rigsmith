import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default { name: 'incoming.drawer', character: 'folk-v6-0ba482', async run (ui) {
  await ui.waitFor({ testid: 'bar-incoming' })
  await ui.key('i')
  await ui.waitFor({ testid: 'incoming-drawer' })
  assert.equal((await ui.app()).drawer, 'incoming')
  await ui.shot('incoming')
  await ui.key('Escape')
  assert.equal((await ui.app()).drawer, null)
} } satisfies Scenario
