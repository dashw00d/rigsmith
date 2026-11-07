import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'look.skin-sheet', character: 'folk-v6-0ba482', step: 'look',
  async run (ui) {
    const skins = await ui.eval(r => r.app.selected!.look.skins!.map(s => s.name))
    await ui.click({ role: 'button', name: 'All skins' })
    assert.equal(await ui.count({ testid: 'look-skin-tile' }), skins.length)
    await ui.waitFor(() => document.querySelectorAll('[data-testid="look-skin-tile"] img').length >= 2, 60_000)
    const hashes = await ui.eval(async () => {
      const images = [...document.querySelectorAll<HTMLImageElement>('[data-testid="look-skin-tile"] img')].slice(0, 2)
      return await Promise.all(images.map(async image => {
        const bytes = await (await fetch(image.src)).arrayBuffer()
        return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].join(',')
      }))
    })
    assert.notEqual(hashes[0], hashes[1], 'two skins render distinct tiles')
    await ui.shot('contact-sheet')
    await ui.click({ testid: 'look-skin-tile', id: skins[4] })
    const selected = await ui.eval(r => r.dress.worn(r.app.selected!).skin)
    assert.equal(selected, skins[4])
    assert.equal(await ui.exists({ testid: 'look-skin-sheet' }), false)
  },
} satisfies Scenario
