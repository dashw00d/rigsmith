import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default { name: 'look.ship-stances', character: 'folk-v6-0ba482', step: 'ship', async run (ui) {
  await ui.eval(async r => {
    await r.ship.load()
    if (!await r.ship.create(r.app.selected!, 'scenario_stance')) throw new Error('unit creation failed')
    if (!await r.ship.create(r.app.selected!, 'scenario_stance_other')) throw new Error('second unit creation failed')
  })
  try { await ui.waitFor(r => r.ship.spec('scenario_stance')?.clips.includes('Idle') === true) }
  catch { throw new Error(`Ship lost the saved unit: ${JSON.stringify(await ui.eval(r => ({ spec: r.ship.spec('scenario_stance'), selected: r.app.selectedId, step: r.app.step, error: r.ship.error, units: Object.keys(r.ship.status?.units ?? {}) })))}`) }
  await ui.eval(async r => {
    const c = r.app.selected!; const slot = c.clips.find(s => s.name === 'Idle')!; const set = c.folk!.sets[0]
    if (!slot || !set) throw new Error('fixture needs Idle and a set')
    if (!await r.app.do(c.id, { type: 'folk.stance.add', stance: { id: 'e2eshield', name: 'Shield', clips: { Idle: [slot.id] } } })) throw new Error('stance add failed')
    if (!await r.app.do(c.id, { type: 'folk.set.update', id: set.id, patch: { stance: 'e2eshield' } })) throw new Error('stance assignment failed')
  })
  const first = { testid: 'ship-stances', id: 'scenario_stance' }
  const second = { testid: 'ship-stances', id: 'scenario_stance_other' }
  await ui.waitFor(first); await ui.waitFor(second)
  assert.match(await ui.text(first), /Stances:.*e2eshield \(1 clip\)/)
  assert.match(await ui.text(second), /Stances:.*e2eshield \(1 clip\)/)
  await ui.shot('ship-stances')
} } satisfies Scenario
