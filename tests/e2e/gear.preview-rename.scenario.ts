import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'gear.preview-rename', character: 'folk-v6-0ba482', step: 'gear',
  async run (ui) {
    await ui.waitFor({ testid: 'sets-section' })
    const picked = await ui.eval(r => {
      const c = r.app.selected!
      const own = r.dress.worn(c).outfit
      const set = c.folk!.sets.find(s => s.name !== own && s.pieces.length > 0)!
      r.dress.wearOutfit(c, set.name)
      r.dress.setShown(c, set.pieces[0], false)
      return { id: set.id, name: set.name, piece: set.pieces[0] }
    })
    const row = { testid: 'sets-row', id: picked.id }
    const renamed = `${picked.name} preview test`
    await ui.fill({ role: 'textbox', name: `Set name ${picked.name}`, within: row }, renamed)
    await ui.key('Enter')
    await ui.eval(async (r, arg) => {
      for (let i = 0; i < 200; i++) {
        if (r.app.selected!.folk!.sets.find(s => s.id === arg.id)?.name === arg.name && r.dress.worn(r.app.selected!).outfit === arg.name) return
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw new Error('Renamed set did not stay previewed')
    }, { id: picked.id, name: renamed })
    assert.equal(await ui.eval((r, id) => r.dress.of(r.app.selected!.id)?.off?.includes(id), picked.piece), true)
    await ui.click({ testid: 'bar-step-motion' })
    await ui.waitFor({ testid: 'motion-dressed-as' })
    assert.equal(await ui.eval(() => (document.querySelector('[data-testid="motion-dressed-as"]') as HTMLSelectElement).value), picked.id)
    await ui.click({ testid: 'bar-step-gear' })
    await ui.eval((_, id) => document.querySelector<HTMLElement>(`[data-testid="sets-row"][data-id="${CSS.escape(id)}"]`)?.focus(), picked.id)
    await ui.press('ctrl+z')
    await ui.eval(async (r, arg) => {
      for (let i = 0; i < 200; i++) {
        if (r.app.selected!.folk!.sets.find(s => s.id === arg.id)?.name === arg.name && r.dress.worn(r.app.selected!).outfit === arg.name) return
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw new Error('Undo did not preserve the previewed set')
    }, picked)
    assert.equal(await ui.eval((r, id) => r.dress.of(r.app.selected!.id)?.off?.includes(id), picked.piece), true)
    await ui.shot('undo-rename')
  },
} satisfies Scenario
