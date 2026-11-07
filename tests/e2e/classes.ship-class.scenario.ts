import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'
export default { name: 'classes.ship-class', character: 'folk-v6-0ba482', step: 'ship', async run (ui) {
  const setup = await ui.eval(async r => {
    const c = r.app.selected!; await r.ship.load()
    await r.app.do(c.id, { type: 'folk.kind.add', kind: { id: 'spearman', name: 'Spearman', tags: [], sets: { query: [] } } })
    const created = await r.ship.create(c, 'scenario_spearman'); const patched = await r.ship.patch('scenario_spearman', { folk: { pools: ['skin'] } })
    return { created, patched, rows: r.ship.unitsOf(c.id).map(x => x.name), character: c.id, selected: r.app.selectedId, step: r.app.step }
  })
  assert.equal(setup.created, true, `unit creation failed: ${JSON.stringify(setup)}`)
  assert.equal(setup.patched, true, `unit patch failed: ${JSON.stringify(setup)}`)
  assert.ok(setup.rows.includes('scenario_spearman'), `unit missing from selected character: ${JSON.stringify(setup)}`)
  await ui.waitFor({ testid: 'ship-class-select' })
  await ui.click({ testid: 'ship-class-select' }); await ui.key('End'); await ui.key('Enter')
  await ui.waitFor(r => r.ship.spec('scenario_spearman')?.folk?.kind === 'spearman')
  assert.deepEqual(await ui.eval(r => r.ship.spec('scenario_spearman')?.folk?.pools), ['skin'])
  await ui.click({ testid: 'ship-class-select' }); await ui.key('Home'); await ui.key('Enter')
  await ui.waitFor(r => r.ship.spec('scenario_spearman')?.folk?.kind === undefined)
  assert.deepEqual(await ui.eval(r => r.ship.spec('scenario_spearman')?.folk?.pools), ['skin'])
  await ui.shot('ship-class')
} } satisfies Scenario
