import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default { name: 'gear.context-crowd', character: 'folk-v6-0ba482', step: 'gear', async run (ui) {
  const target = await ui.eval(async r => {
    const c = r.app.selected!; const set = c.folk!.sets[0]
    if (!await r.app.do(c.id, { type: 'folk.kind.add', kind: { id: 'ctx_kind', name: 'Context test', tags: [], sets: [{ set: set.id }] } })) throw new Error('Could not add class')
    r.wardrobe.setKind(r.app.selected!, 'ctx_kind')
    const { Crowd } = await import('/engine/crowd.ts')
    const original = Crowd.prototype.setUnits
    Crowd.prototype.setUnits = function (looks) {
      ;(window as unknown as { capturedSets: Array<string | null> }).capturedSets = looks.map(look => look.set)
      return original.call(this, looks)
    }
    return set.id
  })
  await ui.click({ testid: 'crowd-toggle' })
  await ui.waitFor(() => ((window as unknown as { capturedSets?: unknown[] }).capturedSets?.length ?? 0) > 0, 30_000)
  const sets = await ui.eval(() => (window as unknown as { capturedSets: Array<string | null> }).capturedSets)
  assert.ok(sets.every(id => id === target), `crowd should use the selected class: ${JSON.stringify(sets)}`)
} } satisfies Scenario
