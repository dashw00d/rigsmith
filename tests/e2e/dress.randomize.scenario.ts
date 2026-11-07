import assert from 'node:assert/strict'
import type { UI } from './gear-ui.ts'

export default {
  name: 'dress.randomize',
  step: 'gear',
  async run (ui: UI): Promise<void> {
    await ui.waitFor({ testid: 'dress-lock', id: 'skin' })
    await ui.click({ role: 'button', name: 'Randomize' })
    await ui.click({ testid: 'dress-lock', id: 'skin' })
    const before = await ui.eval(r => {
      const c = r.app.selected!
      return { uid: r.wardrobe.unit(c)?.uid ?? null, skin: r.dress.worn(c).skin, locked: r.dress.locked(c.id, 'skin') }
    })
    assert.ok(before.locked && before.uid !== null, 'skin is locked and a unit is shown')
    await ui.key('r')
    const after = await ui.eval(r => {
      const c = r.app.selected!
      return { uid: r.wardrobe.unit(c)?.uid ?? null, skin: r.dress.worn(c).skin }
    })
    assert.notEqual(after.uid, before.uid, 'R chooses a new unit number')
    assert.equal(after.skin, before.skin, 'R preserves the locked skin')
    await ui.shot('randomize')
  },
}
