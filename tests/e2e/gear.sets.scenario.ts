import assert from 'node:assert/strict'
import type { Scenario, UI } from './ui.ts'

async function waitSet (ui: UI, id: string, property: 'name' | 'tag' | 'piece' | 'grant', value: string, present = true): Promise<void> {
  await ui.eval(async (r, arg) => {
    for (let i = 0; i < 200; i++) {
      const set = r.app.selected?.folk?.sets.find(s => s.id === arg.id)
      const match = arg.property === 'name' ? set?.name === arg.value
        : arg.property === 'tag' ? set?.tags.includes(arg.value)
          : arg.property === 'piece' ? set?.pieces.includes(arg.value) : set?.grants.includes(arg.value)
      if (match === arg.present) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`Set ${arg.id} did not update ${arg.property}: ${arg.value}`)
  }, { id, property, value, present })
}

export default {
  name: 'gear.sets', step: 'gear',
  async run (ui) {
    await ui.waitFor({ testid: 'sets-section' })
    const info = await ui.eval(r => {
      const c = r.app.selected!
      const visible = [...document.querySelectorAll<HTMLElement>('[data-testid="gear-row"]')].map(row => row.dataset.id!)
      const set = c.folk?.sets.find(s => !s.grants.includes('covers-hair') && !s.tags.includes('culture:gael') && visible.some(id => !s.pieces.includes(id)))
      if (set === undefined) return null
      const piece = visible.find(id => !set.pieces.includes(id))!
      const kinds = c.folk!.kinds.filter(k => Array.isArray(k.sets) ? k.sets.some(v => v.set === set.id) : k.sets.query.every(t => set.tags.includes(t))).map(k => k.id).sort()
      return { id: set.id, name: set.name, piece, kinds }
    })
    assert.ok(info, 'fixture has an eligible set and another visible piece')
    const row = { testid: 'sets-row', id: info.id }
    const chipIds = await ui.eval((_, id) => [...document.querySelectorAll<HTMLElement>(`[data-testid="sets-row"][data-id="${CSS.escape(id)}"] [data-testid="sets-kind"]`)].map(x => x.dataset.id).sort(), info.id)
    assert.deepEqual(chipIds, info.kinds, 'worn-by chips match listed and query classes')

    const renamed = `${info.name} edited`
    await ui.fill({ role: 'textbox', name: `Set name ${info.name}`, within: row }, renamed)
    await ui.key('Enter')
    await waitSet(ui, info.id, 'name', renamed)
    await ui.eval((_, id) => document.querySelector<HTMLElement>(`[data-testid="sets-row"][data-id="${CSS.escape(id)}"]`)?.focus(), info.id); await ui.press('ctrl+z')
    await waitSet(ui, info.id, 'name', info.name)

    await ui.fill({ role: 'textbox', name: `Add tags to ${info.name}`, within: row }, 'culture:gael')
    await ui.key('Enter')
    await waitSet(ui, info.id, 'tag', 'culture:gael')
    assert.ok(await ui.exists({ testid: 'sets-row', id: info.id, within: { testid: 'sets-culture', id: 'gael' } }), 'tag regroups the set')
    await ui.eval((_, id) => document.querySelector<HTMLElement>(`[data-testid="sets-row"][data-id="${CSS.escape(id)}"]`)?.focus(), info.id); await ui.press('ctrl+z')
    await waitSet(ui, info.id, 'tag', 'culture:gael', false)

    await ui.eval((_, arg) => {
      const source = document.querySelector<HTMLElement>(`[data-testid="gear-row"][data-id="${CSS.escape(arg.piece)}"]`)
      const target = document.querySelector<HTMLElement>(`[data-testid="sets-row"][data-id="${CSS.escape(arg.set)}"]`)
      if (source === null || target === null) throw new Error('Missing drag source or set target')
      const dataTransfer = new DataTransfer()
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }))
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }))
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
    }, { piece: info.piece, set: info.id })
    await waitSet(ui, info.id, 'piece', info.piece)
    await ui.eval((_, id) => document.querySelector<HTMLElement>(`[data-testid="sets-row"][data-id="${CSS.escape(id)}"]`)?.focus(), info.id); await ui.press('ctrl+z')
    await waitSet(ui, info.id, 'piece', info.piece, false)

    await ui.click({ role: 'button', name: 'covers-hair', within: row })
    await waitSet(ui, info.id, 'grant', 'covers-hair')
    const hair = await ui.eval((r, id) => {
      const c = r.app.selected!
      const set = c.folk!.sets.find(s => s.id === id)!
      r.dress.wearOutfit(c, set.name)
      if (!r.dress.locked(c.id, 'outfit')) r.dress.toggleLock(c, 'outfit')
      r.wardrobe.randomize(c)
      return { outfit: r.dress.worn(c).outfit, hair: r.dress.worn(c).hair }
    }, info.id)
    assert.deepEqual(hair, { outfit: info.name, hair: null })
    await ui.eval((_, id) => document.querySelector<HTMLElement>(`[data-testid="sets-row"][data-id="${CSS.escape(id)}"]`)?.focus(), info.id); await ui.press('ctrl+z')
    await waitSet(ui, info.id, 'grant', 'covers-hair', false)
    await ui.shot('sets')
  },
} satisfies Scenario
