import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'motion.dressed-as', character: 'folk-v6-0ba482', step: 'motion',
  async run (ui) {
    await ui.eval(async r => {
      const c = r.app.selected!
      const entry = await r.app.do(c.id, [
        { type: 'gear.add', gear: { id: 'e2e51001', name: 'E2E Shield', status: 'ready', hidden: true, catalog: 'shield_A.glb', attach: { kind: 'bone', bone: 'LeftHand', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 0.6 } }, handles: [{ id: 'carry', name: 'Carry', kind: 'carry', hand: 'Left' }] } },
        { type: 'folk.set.add', set: { id: 'e2e51002', name: 'E2E Shield set', pieces: ['e2e51001'], tags: ['culture:zzz'], grants: [] } },
      ], 'e2e.dressed')
      if (!entry) throw new Error('Could not create shield fixture')
    })
    await ui.waitFor({ testid: 'motion-dressed-as' })
    await ui.click({ testid: 'motion-dressed-as' }); await ui.key('End'); await ui.key('Enter')
    await ui.waitFor(r => r.dress.worn(r.app.selected!).outfit === 'E2E Shield set')
    await ui.waitFor({ role: 'button', name: 'Play Idle' })
    await ui.click({ role: 'button', name: 'Play Idle' })
    await ui.waitFor(r => r.animator.playing?.baked?.hands.Left.some(layer => layer.source === 'carry' && layer.gear === 'e2e51001') === true, 60_000)
    await ui.shot('shield')
    await ui.click({ testid: 'motion-dressed-as' }); await ui.key('Home'); await ui.key('Enter')
    await ui.waitFor(r => r.dress.worn(r.app.selected!).outfit === null)
    await ui.waitFor(r => r.animator.playing?.baked !== null && r.animator.playing?.baked !== undefined && !r.animator.loading && !r.animator.playing.baked.hands.Left.some(layer => layer.source === 'carry' && layer.gear === 'e2e51001'), 60_000)
    assert.equal(await ui.eval(r => r.animator.playing!.baked!.hands.Left.some(layer => layer.source === 'carry' && layer.gear === 'e2e51001')), false)
  },
} satisfies Scenario
