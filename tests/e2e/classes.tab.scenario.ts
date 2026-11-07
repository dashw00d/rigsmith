import assert from 'node:assert/strict'
import type { Scenario, UI } from './ui.ts'

async function openClasses (ui: UI): Promise<void> {
  await ui.waitFor({ testid: 'class-tab' })
  const name = await ui.eval(() => [...document.querySelectorAll('[data-testid="class-tab"] [data-tab="classes"] > span')].map(e => e.textContent?.trim() ?? '').filter(Boolean).join(' '))
  await ui.click({ role: 'tab', name })
}
export default { name: 'classes.tab', character: 'folk-v6-0ba482', step: 'import', async run (ui) {
  await openClasses(ui)
  await ui.waitFor({ testid: 'class-row', id: 'folk-v6-0ba482:folk' })
  await ui.click({ role: 'button', name: 'Add class' })
  await ui.fill({ role: 'textbox', name: 'New class name' }, 'Tab Scout'); await ui.key('Enter')
  await ui.waitFor(r => r.app.selected?.folk?.kinds.some(k => k.id === 'tab_scout') === true)
  assert.ok(await ui.exists({ testid: 'class-row', id: 'folk-v6-0ba482:tab_scout' }))
  await ui.eval(async () => {
    for (let i = 0; i < 100; i++) {
      const list = await (await fetch('/api/characters', { headers: { 'x-rigsmith': '1', 'x-rigsmith-schema': '5' } })).json() as Array<{ id: string, folk?: { kinds: Array<{ id: string }> } }>
      if (list.find(c => c.id === 'folk-v6-0ba482')?.folk?.kinds.some(k => k.id === 'tab_scout')) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('Class did not persist')
  })
  await ui.eval(() => { setTimeout(() => location.reload(), 0) })
  await ui.waitFor(r => performance.getEntriesByType('navigation').some(e => (e as PerformanceNavigationTiming).type === 'reload') && r.app.selected?.folk?.kinds.some(k => k.id === 'tab_scout') === true, 60_000)
  if (!await ui.exists({ testid: 'class-remove', id: 'folk-v6-0ba482:tab_scout' })) await openClasses(ui)
  await ui.waitFor({ testid: 'class-remove', id: 'folk-v6-0ba482:tab_scout' })
  await ui.rightClick({ testid: 'class-row', id: 'folk-v6-0ba482:tab_scout' })
  await ui.waitFor({ role: 'menuitem', name: 'Remove' })
  await ui.click({ role: 'menuitem', name: 'Remove' })
  await ui.click({ role: 'button', name: 'Remove', within: { role: 'alertdialog', name: 'Remove Tab Scout?' } })
  await ui.waitFor(r => !r.app.selected?.folk?.kinds.some(k => k.id === 'tab_scout'))
  await ui.waitFor({ role: 'button', name: 'Undo' }); await ui.click({ role: 'button', name: 'Undo' })
  await ui.waitFor(r => r.app.selected?.folk?.kinds.some(k => k.id === 'tab_scout') === true)
  await ui.click({ testid: 'class-row', id: 'folk-v6-0ba482:tab_scout' })
  await ui.waitFor({ testid: 'class-section' })
  assert.equal((await ui.app()).step, 'gear')
  await ui.shot('class')
} } satisfies Scenario
