import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'gear.stage-ready', character: 'folk-v6-0ba482', step: 'gear',
  async run (ui) {
    const initial = await ui.eval(async r => {
      const stage = r.viewer.stage!
      await stage.ready
      return { environment: stage.scene.environment !== null, shown: r.viewer.shownId, other: r.app.characters.find(c => c.id !== r.app.selectedId)?.id }
    })
    assert.equal(initial.environment, true)
    assert.equal(initial.shown, 'folk-v6-0ba482')
    assert.ok(initial.other)
    await ui.click({ testid: 'chars-row', id: initial.other })
    await ui.eval(async (r, id) => {
      for (let i = 0; i < 300; i++) {
        if (!r.viewer.loading && r.viewer.shownId === id) return
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw new Error('Other character did not load')
    }, initial.other)
    await ui.click({ testid: 'chars-row', id: 'folk-v6-0ba482' })
    await ui.waitFor(r => !r.viewer.loading && r.viewer.shownId === 'folk-v6-0ba482', 60_000)
    assert.equal(await ui.eval(r => r.viewer.stage?.scene.environment !== null), true)
    await ui.shot('reloaded')
  },
} satisfies Scenario
