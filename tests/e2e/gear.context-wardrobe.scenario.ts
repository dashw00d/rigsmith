import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default { name: 'gear.context-wardrobe', character: 'folk-v6-0ba482', step: 'gear', async run (ui) {
  const info = await ui.eval(async r => {
    const c = r.app.selected!; const target = c.folk!.sets[0]; const other = c.folk!.sets[1]
    if (!target || !other) throw new Error('Need two sets')
    if (!await r.app.do(c.id, { type: 'folk.kind.add', kind: { id: 'ctx_kind', name: 'Context test', tags: [], sets: [{ set: target.id }] } })) throw new Error('Could not add class')
    r.wardrobe.setKind(r.app.selected!, 'ctx_kind')
    return { target: target.name, other: other.name }
  })
  await ui.click({ testid: 'wardrobe-button' })
  await ui.waitFor({ testid: 'wardrobe-tile', id: info.other })
  const state = await ui.eval((_r, names) => {
    const tiles = [...document.querySelectorAll<HTMLElement>('[data-testid="wardrobe-tile"]')]
    return names.map(name => tiles.find(tile => tile.dataset.id === name)?.classList.contains('out'))
  }, [info.target, info.other])
  assert.deepEqual(state, [false, true], 'class-ineligible set should be ruled out in the Wardrobe')
} } satisfies Scenario
