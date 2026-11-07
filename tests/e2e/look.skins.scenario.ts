import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'look.skins', step: 'look',
  async run (ui) {
    const first = await ui.eval(r => r.app.selected?.look.skins?.[0]?.name ?? null)
    assert.ok(first, 'fixture needs a skin')
    const renamed = `${first} edited`
    await ui.fill({ role: 'textbox', name: `Skin name ${first}` }, renamed)
    await ui.key('Enter')
    await ui.waitFor(r => r.app.selected?.look.skins?.[0]?.name?.endsWith(' edited') === true)
    const before = await ui.eval(r => r.app.selected?.look.skins?.[0]?.tags?.includes('female') ?? false)
    await ui.click({ role: 'button', name: 'female', within: { testid: 'look-skin-row', id: renamed } })
    await ui.eval(async (r, was) => { for (let i = 0; i < 100; i++) { if ((r.app.selected?.look.skins?.[0]?.tags?.includes('female') ?? false) !== was) return; await new Promise(resolve => setTimeout(resolve, 100)) } throw new Error('Tag did not change') }, before)
    await ui.fill({ role: 'textbox', name: `Hair colour for ${renamed}` }, '#123456')
    await ui.key('Enter')
    await ui.waitFor(r => r.app.selected?.look.skins?.[0]?.hair === '#123456')
    await ui.key('Escape')
    await ui.press('ctrl+z')
    await ui.waitFor(r => r.app.selected?.look.skins?.[0]?.hair !== '#123456')
    await ui.shot('skins')
  },
} satisfies Scenario
