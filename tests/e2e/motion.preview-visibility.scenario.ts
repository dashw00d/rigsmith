import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'motion.preview-visibility', character: 'folk-v6-0ba482', step: 'motion',
  async run (ui) {
    await ui.eval(async r => {
      const c = r.app.selected!
      const entry = await r.app.do(c.id, [
        { type: 'hands.hold', side: 'Left', pose: null },
        { type: 'gear.add', gear: { id: 'e2e51001', name: 'E2E Shield', status: 'ready', hidden: true, catalog: 'shield_A.glb', attach: { kind: 'bone', bone: 'LeftHand', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 0.6 } }, handles: [{ id: 'carry', name: 'Carry', kind: 'carry', hand: 'Left' }] } },
        { type: 'folk.set.add', set: { id: 'e2e51002', name: 'E2E Shield set', pieces: ['e2e51001'], tags: ['culture:zzz'], grants: [] } },
      ], 'e2e.dressed')
      if (!entry) throw new Error('Could not create shield fixture')
    })
    await ui.waitFor({ testid: 'motion-dressed-as' })
    await ui.click({ testid: 'motion-dressed-as' }); await ui.key('End'); await ui.key('Enter')
    await ui.waitFor(r => r.dress.worn(r.app.selected!).outfit === 'E2E Shield set')
    await ui.eval(async r => {
      const c = r.app.selected!
      const attack = c.clips.find(s => s.name === 'Attack')!
      if (!await r.animator.playSlot(c, attack.id)) throw new Error('Attack did not play')
      r.animator.setIntoIdle(true)
    })
    await ui.waitFor(r => r.animator.playing?.baked?.hands.Left.some(x => x.source === 'carry' && x.gear === 'e2e51001') === true, 60_000)
    await ui.waitFor(r => (r.animator as unknown as { idle: { key: string } | null }).idle !== null, 60_000)
    const before = await ui.eval(r => {
      const idle = (r.animator as unknown as { idle: { key: string, clip: { tracks: Array<{ name: string, values: ArrayLike<number> }> } } }).idle
      return { key: idle.key, tracks: JSON.stringify(idle.clip.tracks.map(t => [t.name, Array.from(t.values)])) }
    })
    await ui.click({ testid: 'bar-step-gear' })
    await ui.click({ testid: 'gear-row', id: 'e2e51001' })
    await ui.waitFor({ testid: 'gear-shown' })
    await ui.click({ testid: 'gear-shown' })
    await ui.waitFor(r => r.dress.of(r.app.selected!.id)?.off?.includes('e2e51001') === true)
    await ui.waitFor(r => r.animator.playing?.baked !== null && r.animator.playing?.baked !== undefined && !r.animator.loading && !r.animator.playing.baked.hands.Left.some(x => x.source === 'carry' && x.gear === 'e2e51001'), 60_000)
    await ui.waitFor(r => (r.animator as unknown as { idle: { key: string } | null }).idle !== null, 60_000)
    const after = await ui.eval(r => {
      const idle = (r.animator as unknown as { idle: { key: string, clip: { tracks: Array<{ name: string, values: ArrayLike<number> }> } } }).idle
      return { key: idle.key, tracks: JSON.stringify(idle.clip.tracks.map(t => [t.name, Array.from(t.values)])) }
    })
    assert.notEqual(after.key, before.key)
    assert.notEqual(after.tracks, before.tracks, 'blended Idle must be rebaked without the hidden shield')
    await ui.click({ testid: 'gear-shown' })
    await ui.waitFor(r => r.animator.playing?.baked?.hands.Left.some(x => x.source === 'carry' && x.gear === 'e2e51001') === true && !r.animator.loading, 60_000)
    await ui.click({ testid: 'bar-step-motion' })
    await ui.shot('restored-shield')
  },
} satisfies Scenario
