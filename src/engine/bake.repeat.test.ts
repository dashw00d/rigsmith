// @vitest-environment node
// A clip's events and keys repeated per cycle (a rider's over his horse's gait, bakeRide; the export's fitEvents uses
// eventsInClip too): what a blow cut left outside the played clip doesn't land inside another cycle.
import { describe, expect, it } from 'vitest'
import { eventsInClip, eventsRepeated, keysRepeated, type BakedEvent } from './bake.ts'
import type { ClipKey } from '../model/types.ts'

const Q: ClipKey['q'] = [0, 0, 0, 1]

describe('repeating a clip', () => {
  it('drops a point outside the clip and clips a span to it before repeating', () => {
    const es: BakedEvent[] = [
      { id: 'a', name: 'early', t: -0.2 }, { id: 'b', name: 'hit', t: 0.5 }, { id: 'c', name: 'swing', t: 0.8, to: 1.3 },
      { id: 'd', name: 'draw', t: -0.3, to: 0.2 }, { id: 'e', name: 'gone', t: 1.1, to: 1.4 }, { id: 'f', name: 'late', t: 1.2 },
    ]
    expect(eventsInClip(es).map(e => [e.id, e.t, e.to])).toEqual([['b', 0.5, undefined], ['c', 0.8, 1], ['d', 0, 0.2]])
    const twice = eventsRepeated(es, 2)
    expect(twice.map(e => [e.id, e.t, e.to])).toEqual([
      ['b', 0.25, undefined], ['c', 0.4, 0.5], ['d', 0, 0.1],
      ['b', 0.75, undefined], ['c', 0.9, 1], ['d', 0.5, 0.6],
    ])
    // (an event at -0.2 had landed at 0.4; the span 0.8-1.3 at 0.4-0.65)
    expect(twice.some(e => e.id === 'a')).toBe(false)
    expect(eventsRepeated(es, 1)).toBe(es)
  })

  it('keeps a key before the start only before the first cycle and one after the end only after the last', () => {
    const ks: ClipKey[] = [{ u: -0.2, q: Q }, { u: 0.5, q: Q }, { u: 1.2, q: Q }]
    expect(keysRepeated(ks, 2).map(k => k.u)).toEqual([-0.1, 0.25, 0.75, 1.1])
    expect(keysRepeated(ks, 3).map(k => +k.u.toFixed(4))).toEqual([-0.0667, 0.1667, 0.5, 0.8333, 1.0667])
    expect(keysRepeated(ks, 1)).toBe(ks)
  })
})
