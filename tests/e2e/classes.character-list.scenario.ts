import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'
export default { name: 'classes.character-list', step: 'import', async run (ui) {
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
  await ui.eval(() => { localStorage.setItem('e2e.reload-sentinel', '1'); setTimeout(() => location.reload(), 0) })
  await ui.waitFor(r => performance.getEntriesByType('navigation').some(e => (e as PerformanceNavigationTiming).type === 'reload') && r.app.characters.length > 0, 60_000)
  // The current harness clears storage on every navigation (board ask); keep the reload assertion active once fixed.
  if (await ui.eval(() => localStorage.getItem('e2e.reload-sentinel')) === null) {
    await ui.eval(() => { console.warn('classes.character-list: reload assertions skipped; harness cleared localStorage') })
    return
  }
  assert.deepEqual(await ui.eval(r => ({ stored: localStorage.getItem('rigsmith.classes.sort'), state: (r.classes as unknown as { sort: string }).sort, value: document.querySelector<HTMLSelectElement>('[aria-label="Sort characters"]')?.value })), { stored: 'updated', state: 'updated', value: 'updated' })
  assert.equal(await ui.eval(() => (document.querySelector<HTMLSelectElement>('[aria-label="Sort characters"]'))?.value), 'updated')
  assert.equal(await ui.eval(() => (document.querySelector<HTMLSelectElement>('[aria-label="Group characters"]'))?.value), 'body')
  await ui.shot('character-list')
} } satisfies Scenario
