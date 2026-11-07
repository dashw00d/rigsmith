import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'
export default { name: 'classes.tab', character: 'folk-v6-0ba482', async run (ui) {
  await ui.click({ role: 'tab', name: 'Dynamic classes 1' })
  await ui.waitFor({ testid: 'class-row', id: 'folk' })
  await ui.click({ role: 'button', name: 'Add class' })
  await ui.fill({ role: 'textbox', name: 'New class name' }, 'Spearman'); await ui.key('Enter')
  await ui.waitFor(r => r.app.selected?.folk?.kinds.some(k => k.id === 'spearman') === true)
  assert.ok(await ui.exists({ testid: 'class-row', id: 'spearman' }))
  await ui.click({ testid: 'class-remove', id: 'spearman' })
  await ui.click({ role: 'button', name: 'Remove', within: { role: 'alertdialog', name: 'Remove Spearman?' } })
  await ui.waitFor(r => !r.app.selected?.folk?.kinds.some(k => k.id === 'spearman'))
  await ui.click({ role: 'button', name: 'Undo' })
  await ui.waitFor(r => r.app.selected?.folk?.kinds.some(k => k.id === 'spearman') === true)
  await ui.click({ testid: 'class-row', id: 'spearman' })
  await ui.waitFor({ testid: 'class-section' })
  assert.equal((await ui.app()).step, 'gear')
  await ui.shot('class')
} } satisfies Scenario
