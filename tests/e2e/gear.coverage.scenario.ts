import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'gear.coverage', step: 'gear',
  async run (ui) {
    await ui.waitFor({ testid: 'coverage-toggle' })
    await ui.click({ testid: 'coverage-toggle' })
    await ui.waitFor({ testid: 'coverage-region' })
    assert.equal(await ui.count({ testid: 'coverage-region' }), 28)
    assert.ok(await ui.eval(r => {
      let found = false
      r.viewer.character?.root.traverse(o => { if (o.name === 'coverage-region-overlay') found = true })
      return found
    }), 'a skinned full-body overlay is on stage')

    const helmet = await ui.eval(async r => {
      const c = r.app.selected!
      const set = c.folk?.sets.find(s => s.pieces.some(id => /brigandine_head/i.test(c.gear.find(g => g.id === id)?.name ?? '')))
      if (set === undefined) throw new Error('fixture needs the brigandine helmet')
      const head = c.gear.find(g => set.pieces.includes(g.id) && /brigandine_head/i.test(g.name))!
      r.wardrobe.set(c, 'outfit', set.name)
      for (let i = 0; i < 600; i++) {
        const worn = r.gear.coveragePieces().find(p => p.gear.id === head.id && p.shown && p.worn.hits !== undefined)
        if (worn !== undefined) return { id: head.id, hidden: worn.worn.hidden ?? [] }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw new Error('helmet coverage did not load')
    })
    assert.ok(helmet.hidden.length > 0, 'the fixture helmet hides a body region')
    assert.equal(await ui.eval((_, id) => document.querySelector(`[data-testid="coverage-region"][data-id="${id}"]`)?.getAttribute('data-state'), helmet.hidden[0]), 'hidden')

    const boot = await ui.eval(async r => {
      const c = r.app.selected!
      const set = c.folk?.sets.find(s => s.name === 'hat_kettle_villager')
      if (set === undefined) throw new Error('fixture needs hat_kettle_villager')
      r.wardrobe.set(c, 'outfit', set.name)
      for (let i = 0; i < 600; i++) {
        const piece = r.gear.coveragePieces().find(p => p.shown && /hat_kettle_villager_leg_L/i.test(p.gear.name) && p.worn.hits !== undefined)
        if (piece !== undefined) return { id: piece.gear.id, hidden: piece.worn.hidden ?? [] }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw new Error('boot coverage did not load')
    })
    assert.ok(boot.hidden.length > 0, 'fixture boot hides at least one foot region')
    await ui.waitFor({ testid: 'gear-row', id: boot.id })
    await ui.click({ testid: 'gear-row', id: boot.id })
    const percent = await ui.eval((_, region) => document.querySelector(`[data-testid="coverage-piece-region"][data-id="${region}"]`)?.getAttribute('aria-label'), boot.hidden[0])
    assert.ok(percent && Number(/(\d+)%/.exec(percent)?.[1]) >= 97, `boot region should be at least 97%: ${percent}`)
    await ui.shot('coverage')
    await ui.key('h')
    assert.equal(await ui.count({ testid: 'coverage-region' }), 0, 'H turns coverage off')
  },
} satisfies Scenario
