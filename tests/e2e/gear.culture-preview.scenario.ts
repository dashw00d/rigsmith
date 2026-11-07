import assert from 'node:assert/strict'
import type { Scenario, UI } from './ui.ts'

async function selectValue (ui: UI, testid: string, value: string): Promise<void> {
  const index = await ui.eval((_, arg) => [...(document.querySelector(`[data-testid="${arg.testid}"]`) as HTMLSelectElement).options].findIndex(o => o.value === arg.value), { testid, value })
  if (index < 0) throw new Error(`Missing ${value} in ${testid}`)
  await ui.click({ testid }); await ui.key('Home')
  for (let i = 0; i < index; i++) await ui.key('ArrowDown')
  await ui.key('Enter')
}

export default {
  name: 'gear.culture-preview', character: 'folk-v6-0ba482', step: 'gear',
  async run (ui) {
    await ui.waitFor({ testid: 'culture-select' })
    const fixture = await ui.eval(r => {
      const c = r.app.selected!
      const sets = c.folk!.sets.filter(s => /(?:^|_)gael(?:_|$)/i.test(s.name))
      const count = c.folk!.sets.filter(s => !s.tags.some(t => t.startsWith('culture:')) && /(?:^|_)(norse|gael|wagon|order|swiss|barrow)(?:_|$)/i.test(s.name)).length
      return { count, target: sets[0]?.id, before: c.folk!.sets.map(s => [s.id, s.tags]) }
    })
    assert.ok(fixture.count > 0 && fixture.target)
    await ui.click({ role: 'button', name: `Tag ${fixture.count} sets from their names` })
    await ui.waitFor(r => r.app.selected!.folk!.sets.some(s => s.tags.includes('culture:gael')))
    await ui.press('ctrl+z')
    await ui.eval(async (r, expected) => {
      for (let i = 0; i < 200; i++) {
        if (JSON.stringify(r.app.selected!.folk!.sets.map(s => [s.id, s.tags])) === JSON.stringify(expected)) return
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw new Error('One undo did not restore every set tag')
    }, fixture.before)
    await ui.click({ role: 'button', name: `Tag ${fixture.count} sets from their names` })
    await ui.waitFor(r => r.app.selected!.folk!.sets.some(s => s.tags.includes('culture:gael')))
    await selectValue(ui, 'culture-select', 'gael')
    for (let i = 0; i < 12; i++) {
      await ui.click({ role: 'button', name: 'Randomize' })
      const state = await ui.eval(r => {
        const c = r.app.selected!; const outfit = r.dress.worn(c).outfit
        return c.folk!.sets.find(s => s.name === outfit)?.tags ?? []
      })
      assert.equal(state.some(t => t.startsWith('culture:') && t !== 'culture:gael'), false)
    }
    await ui.eval(async (r, target) => {
      const c = r.app.selected!
      const entry = await r.app.do(c.id, { type: 'folk.kind.add', kind: { id: 'e2eclass', name: 'E2E Class', tags: [], sets: [{ set: target }] } }, 'e2e.class')
      if (!entry) throw new Error('Could not create class fixture')
    }, fixture.target)
    await selectValue(ui, 'kind-select', 'e2eclass')
    for (let i = 0; i < 4; i++) {
      await ui.click({ role: 'button', name: 'Randomize' })
      assert.equal(await ui.eval(r => r.dress.of(r.app.selected!.id)?.outfitId), fixture.target)
    }
    await ui.shot('class-culture')
  },
} satisfies Scenario
