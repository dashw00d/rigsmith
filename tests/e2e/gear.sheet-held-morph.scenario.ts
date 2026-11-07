import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'gear.sheet-held-morph', character: 'folk-v6-0ba482', step: 'look',
  async run (ui) {
    const proof = await ui.eval(async r => {
      const c = r.app.selected!
      const source = c.gear.find(g => g.model !== undefined && g.status === 'ready' && g.attach.kind === 'skin')!
      const file = c.files.rigged ?? c.files.model
      if (source === undefined || file === undefined) throw new Error('Missing fixture body or gear')
      const body = r.assets.asset(c, file); const url = r.assets.asset(c, source.model!)
      if (body === null || url === null) throw new Error('Missing fixture asset URL')
      const gear = { ...source, attach: { kind: 'bone' as const, bone: 'LeftHand', place: source.attach.place } }
      const modulePath = '/engine/OutfitThumbs.ts'
      const { OutfitThumbs } = await import(/* @vite-ignore */ modulePath)
      const renderer = new OutfitThumbs()
      try {
        const spec = { body, pieces: [{ gear, url, place: gear.attach.place }], framing: 'body' as const }
        await renderer.render({ ...spec, female: false }, true)
        const state = () => renderer.held.pieces[0].meshes.map((m: { morphTargetDictionary?: Record<string, number>, morphTargetInfluences?: number[] }) => ({ dictionary: m.morphTargetDictionary ?? {}, influences: m.morphTargetInfluences ?? [] }))
        const before = JSON.stringify(state())
        await renderer.render({ ...spec, female: true }, true)
        const after = JSON.stringify(state())
        const femaleBody = renderer.held.view.bodySkinned.some((m: { morphTargetDictionary?: Record<string, number>, morphTargetInfluences?: number[] }) => {
          const index = m.morphTargetDictionary?.female
          return index !== undefined && m.morphTargetInfluences?.[index] === 1
        })
        return { before, after, femaleBody }
      } finally { renderer.dispose() }
    })
    assert.equal(proof.after, proof.before, 'female body selection must not morph held geometry')
    assert.equal(proof.femaleBody, true, 'female body shape remains active')
    await ui.click({ role: 'button', name: 'All skins' })
    await ui.waitFor(() => document.querySelectorAll('[data-testid="look-skin-tile"] img').length >= 2, 60_000)
    await ui.shot('female-sheet')
    await ui.click({ role: 'button', name: 'Close' })
  },
} satisfies Scenario
