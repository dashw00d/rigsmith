// @vitest-environment node
// The events file with gear events and variants (src/engine/geartracks.ts gearEvents, src/model/variants.ts): the
// gear's among the clip's own, sorted, rounded as they are; `variants` only when given.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { BakedSlot } from '../../src/engine/bake.ts'
import { makeSlot } from '../../src/model/fixtures.ts'
import { eventsFile } from './unit_export.ts'

describe('unit export: gear events and variants in the events file', () => {
  const slots = [makeSlot({ id: 'a', name: 'Attack', loop: false }), makeSlot({ id: 'b', name: 'Attack_2', loop: false })]
  const clips = slots.map(s => new THREE.AnimationClip(s.name, 1.2, []))
  const baked = new Map(slots.map(s => [s.name, { events: [{ id: 'hit', name: 'hit', t: 0.45 }] } as unknown as BakedSlot]))
  const strides = { walk: null, run: null }

  it('is as before without them', () => {
    const out = eventsFile('u', slots, clips, baked, strides)
    expect(out.variants).toBeUndefined()
    expect(out.clips.Attack.events).toEqual([{ t: 0.45, name: 'hit' }])
  })

  it('puts each clip\'s gear events among its own, and lists the variants', () => {
    const gear = new Map([['Attack', [{ t: 0.123456, name: 'hide:Spear' }, { t: 0.45, name: 'detach:Spear', bone: 'RightHand' }, { t: 1.5, name: 'show:Spear' }]]])
    const out = eventsFile('u', slots, clips, baked, strides, { gear, variants: { Attack: ['Attack', 'Attack_2'] } })
    expect(out.clips.Attack.events).toEqual([{ t: 0.1235, name: 'hide:Spear' }, { t: 0.45, name: 'hit' }, { t: 0.45, name: 'detach:Spear', bone: 'RightHand' }])
    expect(out.clips.Attack_2.events).toEqual([{ t: 0.45, name: 'hit' }])
    expect(out.variants).toEqual({ Attack: ['Attack', 'Attack_2'] })
  })

  it('lists stance clip names beside their timed events', () => {
    const out = eventsFile('u', slots, clips, baked, strides, { stances: { shield: { Attack: ['Attack@shield', 'Attack_2@shield'] } } })
    expect(out.stances).toEqual({ shield: { Attack: ['Attack@shield', 'Attack_2@shield'] } })
    expect(out.clips.Attack.events).toEqual([{ t: 0.45, name: 'hit' }])
  })
})
