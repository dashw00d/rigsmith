import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'
export default { name: 'classes.character-list', async run (ui) {
  await ui.fill({ testid: 'chars-search' }, 'folk')
  assert.ok(await ui.count({ testid: 'chars-row' }) > 0)
  assert.equal(await ui.eval(() => [...document.querySelectorAll<HTMLElement>('[data-testid="chars-row"]')].every(e => (e.textContent ?? '').toLowerCase().includes('folk') || e.dataset.id?.includes('folk'))), true)
  await ui.fill({ testid: 'chars-search' }, '')
  await ui.click({ role: 'combobox', name: 'Sort characters' }); await ui.key('End'); await ui.key('Enter')
  assert.deepEqual(await ui.eval(() => [...document.querySelectorAll<HTMLElement>('[data-testid="chars-row"]')].map(e => e.dataset.id)), await ui.eval(r => [...r.app.characters].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map(c => c.id)))
  await ui.click({ role: 'combobox', name: 'Group characters' }); await ui.key('End'); await ui.key('Enter')
  assert.ok(await ui.eval(() => [...document.querySelectorAll('summary')].some(e => e.textContent?.includes('Dynamic'))))
  assert.equal(await ui.eval(() => localStorage.getItem('rigsmith.classes.group')), 'body')
  assert.equal(await ui.eval(() => localStorage.getItem('rigsmith.classes.sort')), 'updated')
  await ui.shot('character-list')
} } satisfies Scenario
