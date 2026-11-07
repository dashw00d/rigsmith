import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'
export default { name: 'classes.sets', character: 'folk-v6-0ba482', async run (ui) {
  await ui.click({ role: 'tab', name: 'Dynamic classes 1' }); await ui.click({ testid: 'class-row', id: 'folk' }); await ui.waitFor({ testid: 'class-section' })
  await ui.click({ role: 'radio', name: 'Listed' })
  const set = await ui.eval(r => r.app.selected!.folk!.sets[0].id)
  await ui.fill({ testid: `class-weight-${set}` }, '0'); await ui.key('Enter')
  await ui.waitFor(r => { const sets = r.app.selected?.folk?.kinds.find(k => k.id === 'folk')?.sets; return Array.isArray(sets) && sets[0]?.weight === 0 })
  await ui.click({ role: 'radio', name: 'By tags' })
  await ui.fill({ testid: 'class-query' }, 'culture:norse'); await ui.key('Enter')
  await ui.waitFor(r => { const sets = r.app.selected?.folk?.kinds.find(k => k.id === 'folk')?.sets; return sets !== undefined && !Array.isArray(sets) && sets.query[0] === 'culture:norse' })
  const expected = await ui.eval(r => r.app.selected!.folk!.sets.filter(s => s.tags.includes('culture:norse')).length)
  assert.match(await ui.text({ testid: 'class-section' }), new RegExp(`Matches ${expected} of`))
  await ui.click({ role: 'heading', name: 'CLASS' }); await ui.press('ctrl+z'); await ui.waitFor(r => { const sets = r.app.selected?.folk?.kinds.find(k => k.id === 'folk')?.sets; return sets !== undefined && !Array.isArray(sets) && sets.query.length === 0 })
  await ui.shot('sets')
} } satisfies Scenario
