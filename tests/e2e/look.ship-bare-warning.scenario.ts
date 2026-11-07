import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default { name: 'look.ship-bare-warning', character: 'folk-v6-0ba482', step: 'ship', async run (ui) {
  const info = await ui.eval(async r => {
    const c = r.app.selected!; const skin = c.look.skins!.find(x => !x.bare)!
    const source = c.look.cloth![0]
    if (!skin || !source) throw new Error('Need a skin without a bare image and a cloth layer')
    await r.ship.load()
    if (!await r.ship.create(c, 'bare_warning')) throw new Error('Could not create unit')
    if (!await r.app.do(c.id, { type: 'look.cloth.add', layer: { ...source, id: 'barewarning', name: 'Test shorts', slots: ['bottom'], cut: { drop: [1] } } })) throw new Error('Could not add cut layer')
    return { name: skin.name, file: skin.file }
  })
  const message = `Test shorts has a cut but skin ${info.name} has no bare version`
  await ui.eval((_r, text) => { (window as unknown as { expectedWarning: string }).expectedWarning = text }, message)
  await ui.waitFor(() => document.body.textContent?.includes((window as unknown as { expectedWarning: string }).expectedWarning) === true)
  assert.ok(await ui.eval(async (r, skin) => !!await r.app.do(r.app.selected!.id, { type: 'look.skin.bare', name: skin.name, file: skin.file }), info))
  await ui.waitFor(() => document.body.textContent?.includes((window as unknown as { expectedWarning: string }).expectedWarning) === false)
} } satisfies Scenario
