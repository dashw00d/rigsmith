import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default { name: 'classes.pools', character: 'folk-v6-0ba482', step: 'gear', async run (ui) {
  const seed = await ui.eval(async r => {
    const c = r.app.selected!
    const pool = c.folk!.pools.find(p => p.kind === 'skin')!
    const entry = await r.app.do(c.id, { type: 'folk.kind.add', kind: { id: 'scenario_other', name: 'Other', tags: [], sets: { query: [] }, pools: { skin: pool.id } } })
    if (!entry) throw new Error('Could not create second class')
    const live = r.app.selected!
    const world = r.pick.worldOf(live)
    const item = Array.from({ length: 200 }, (_, i) => r.pick.pick(world, i + 1, { kind: 'scenario_other' }).picks.skin).find(x => x !== null)
    if (!item) throw new Error('No eligible skin in the shared pool')
    await r.classes!.openClass(c.id, c.folk!.kinds[0].id)
    return { pool: pool.id, item, kind: c.folk!.kinds[0].id, kindName: c.folk!.kinds[0].name }
  })
  await ui.waitFor({ testid: 'class-pool-skin' })
  await ui.click({ testid: 'class-pool-expand-skin' })
  assert.match(await ui.text({ testid: 'class-pool-skin' }), /Shared with Other/)
  await ui.click({ role: 'button', name: `Make a copy for ${seed.kindName}` })
  await ui.waitFor(r => r.app.selected?.folk?.kinds.find(k => k.id === r.classes?.openId)?.pools?.skin?.endsWith('-copy') === true)
  await ui.click({ testid: 'class-pool-item', id: seed.item, within: { testid: 'class-pool-skin' } })
  const result = await ui.eval((r, s) => {
    const c = r.app.selected!; const world = r.pick.worldOf(c)
    const picks = Array.from({ length: 200 }, (_, i) => {
      r.wardrobe.showUnit(c, i + 1)
      return [r.pick.pick(world, i + 1, { kind: s.kind }).picks.skin, r.pick.pick(world, i + 1, { kind: 'scenario_other' }).picks.skin]
    })
    return { own: picks.map(p => p[0]), other: picks.map(p => p[1]), original: c.folk!.pools.find(p => p.id === s.pool)!.items.map(x => x.ref) }
  }, seed)
  assert.ok(result.original.includes(seed.item))
  assert.ok(result.own.every(x => x !== seed.item))
  assert.ok(result.other.includes(seed.item))
  await ui.shot('pools')
} } satisfies Scenario
