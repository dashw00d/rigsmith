import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'look.skins', step: 'look',
  async run (ui) {
    const first = await ui.eval(r => r.app.selected?.look.skins?.[0]?.name ?? null)
    assert.ok(first, 'fixture needs a skin')
    const beforeRefs = await ui.eval((r, name) => ({ selected: r.app.selected?.look.skin === name, pools: (r.app.selected?.folk?.pools ?? []).filter(p => p.kind === 'skin').flatMap(p => p.items.filter(item => item.ref === name)).length }), first)
    const renamed = `${first} edited`
    await ui.fill({ role: 'textbox', name: `Skin name ${first}` }, renamed)
    await ui.key('Enter')
    await ui.waitFor(r => r.app.selected?.look.skins?.[0]?.name?.endsWith(' edited') === true).catch(() => { throw new Error('Skin rename did not persist') })
    const refs = await ui.eval((r, name) => ({ selected: r.app.selected?.look.skin === name, pools: (r.app.selected?.folk?.pools ?? []).filter(p => p.kind === 'skin').flatMap(p => p.items.filter(item => item.ref === name)).length }), renamed)
    assert.deepEqual(refs, beforeRefs, 'rename keeps skin references')
    const before = await ui.eval(r => r.app.selected?.look.skins?.[0]?.tags?.includes('female') ?? false)
    await ui.click({ role: 'button', name: 'female', within: { testid: 'look-skin-row', id: renamed } })
    await ui.eval(async (r, was) => { for (let i = 0; i < 100; i++) { if ((r.app.selected?.look.skins?.[0]?.tags?.includes('female') ?? false) !== was) return; await new Promise(resolve => setTimeout(resolve, 100)) } throw new Error('Tag did not change') }, before)
    await ui.fill({ role: 'textbox', name: `Hair colour for ${renamed}` }, '#123456')
    await ui.key('Enter')
    await ui.waitFor(r => r.app.selected?.look.skins?.[0]?.hair === '#123456').catch(() => { throw new Error('Hair colour did not persist') })
    await ui.click({ testid: 'bar-step-gear' })
    const swatch = renamed.replace(/^\d+[_ -]*/, '').replace(/_/g, ' ')
    await ui.waitFor({ role: 'button', name: swatch })
    await ui.click({ testid: 'bar-step-look' })
    await ui.click({ role: 'heading', name: 'SKINS' })
    await ui.press('ctrl+z')
    await ui.waitFor(r => r.app.selected?.look.skins?.[0]?.hair !== '#123456').catch(() => { throw new Error('Hair colour undo did not persist') })
    await ui.press('ctrl+z')
    await ui.eval(async (r, was) => { for (let i = 0; i < 100; i++) { if ((r.app.selected?.look.skins?.[0]?.tags?.includes('female') ?? false) === was) return; await new Promise(resolve => setTimeout(resolve, 100)) } throw new Error('Tag undo did not persist') }, before)
    await ui.press('ctrl+z')
    await ui.eval(async (r, name) => { for (let i = 0; i < 100; i++) { if (r.app.selected?.look.skins?.[0]?.name === name) return; await new Promise(resolve => setTimeout(resolve, 100)) } throw new Error('Rename undo did not persist') }, first)
    assert.deepEqual(await ui.eval((r, name) => ({ selected: r.app.selected?.look.skin === name, pools: (r.app.selected?.folk?.pools ?? []).filter(p => p.kind === 'skin').flatMap(p => p.items.filter(item => item.ref === name)).length }), first), beforeRefs)
    await ui.shot('skins')
  },
} satisfies Scenario
