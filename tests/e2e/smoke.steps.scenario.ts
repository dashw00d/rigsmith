import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'smoke.steps',
  async run (ui) {
    assert.equal(await ui.eval(r => Boolean(r.ship && r.wardrobe && r.pick?.pick)), true, 'dev hook exposes ship, wardrobe and the folk picker')
    for (const step of ['import', 'skeleton', 'skin', 'gear', 'look', 'motion', 'ship']) {
      await ui.click({ testid: `bar-step-${step}` })
      const selected = await ui.eval(async (r, expected) => {
        const end = Date.now() + 15_000
        while (Date.now() < end && r.app.step !== expected) await new Promise(resolve => setTimeout(resolve, 50))
        return r.app.step
      }, step)
      assert.equal(selected, step, `step after clicking ${step}`)
    }
    await ui.shot('steps')
  },
} satisfies Scenario
