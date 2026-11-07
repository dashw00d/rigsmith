import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'look.make-all', character: 'folk-v6-0ba482', step: 'look',
  async run (ui) {
    const before = await ui.eval(r => r.app.selected!.look.skins!.map(s => s.bare ?? null))
    await ui.eval((_r, values) => { (window as unknown as { bareBefore: Array<string | null> }).bareBefore = values }, before)
    await ui.click({ role: 'button', name: 'Make all bare' })
    await ui.waitFor(r => r.app.selected?.look.skins?.every(s => !!s.bare) === true, 75_000)
    const generated = await ui.eval(r => r.app.selected!.look.skins!.map(s => s.bare ?? null))
    assert.ok(generated.length > 1 && generated.every(Boolean))
    await ui.press('ctrl+z')
    await ui.waitFor(r => JSON.stringify(r.app.selected?.look.skins?.map(s => s.bare ?? null)) === JSON.stringify((window as unknown as { bareBefore: Array<string | null> }).bareBefore))
    assert.deepEqual(await ui.eval(r => r.app.selected!.look.skins!.map(s => s.bare ?? null)), before, 'one undo restores every skin')
  },
} satisfies Scenario
