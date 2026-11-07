import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'motion.stance', step: 'motion',
  async run (ui) {
    const trial = await ui.eval(r => r.app.selected?.clips.find(s => s.name !== 'Idle') ?? null)
    assert.ok(trial, 'fixture needs a clip to override Idle')
    await ui.fill({ role: 'textbox', name: 'New stance name' }, 'Shield')
    await ui.click({ role: 'button', name: 'New' })
    await ui.waitFor(r => r.app.selected?.folk?.stances.some(s => s.name === 'Shield') === true)
    const row = { testid: 'motion-stance-row', id: 'Idle' }
    await ui.waitFor(row)
    await ui.click({ testid: 'motion-override-open', within: row })
    await ui.click({ role: 'button', name: trial.name, within: { testid: 'motion-override-slots', within: row } })
    await ui.eval(async (r, id) => { for (let i = 0; i < 100; i++) { if (r.app.selected?.folk?.stances.find(s => s.name === 'Shield')?.clips.Idle?.includes(id)) return; await new Promise(resolve => setTimeout(resolve, 100)) } throw new Error('Override not saved') }, trial.id)
    assert.match(await ui.text(row), /plays:/)
    await ui.press('ctrl+z')
    await ui.waitFor(r => r.app.selected?.folk?.stances.find(s => s.name === 'Shield')?.clips.Idle === undefined)
    await ui.shot('stance')
  },
} satisfies Scenario
