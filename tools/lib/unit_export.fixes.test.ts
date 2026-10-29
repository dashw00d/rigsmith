// @vitest-environment node
// Review fixes in the export's events (tools/lib/unit_export.ts): what a blow cut left outside a clip isn't repeated
// into the clip by a companion's fit, and a companion's sound copied under its prefix never takes the name of one of
// the unit's own (the horse playing the rider's file).
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { UnitEvents } from '../../src/model/unit.ts'
import { copySounds, fitEvents } from './unit_export.ts'

const scratch = mkdtempSync(path.join(tmpdir(), 'rigsmith-export-fixes-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

describe('fitEvents', () => {
  it('drops what lies outside the clip and clips a span to it, then repeats and scales', () => {
    const es = [{ id: 'a', name: 'early', t: -0.2 }, { id: 'b', name: 'swing', t: 0.8, to: 1.3 }, { id: 'c', name: 'late', t: 1.2 }]
    expect(fitEvents(es, { repeat: 2, share: 1 }).map(e => [e.name, e.t, e.to])).toEqual([['swing', 0.4, 0.5], ['swing', 0.9, 1]])
    // (a clip that is half of the whole: an event after its end stays out of the other half)
    expect(fitEvents(es, { repeat: 1, share: 0.5 }).map(e => [e.name, e.t, e.to])).toEqual([['swing', 0.4, 0.5]])
  })
})

describe('copySounds', () => {
  it("numbers a companion's file whose prefixed name the unit's own has", () => {
    const from = path.join(scratch, 'clash')
    mkdirSync(path.join(from, 'unit', 'sounds'), { recursive: true })
    mkdirSync(path.join(from, 'horse', 'sounds'), { recursive: true })
    writeFileSync(path.join(from, 'unit', 'sounds', 'horse_neigh.wav'), 'rider')
    writeFileSync(path.join(from, 'horse', 'sounds', 'neigh.wav'), 'horse')
    const to = path.join(from, 'out')
    const f: UnitEvents = {
      unit: 'u', schema: 1, walkStride: null, runStride: null,
      clips: { Idle: { loop: true, seconds: 1, events: [{ t: 0.1, name: 'call', sound: 'file:sounds/horse_neigh.wav' }] } },
      companion: { prefix: 'Horse_', clips: { Idle: { events: [{ t: 0.5, name: 'neigh', sound: 'file:sounds/neigh.wav' }, { t: 0.9, name: 'neigh', sound: 'file:sounds/neigh.wav' }] } } },
    }
    expect(copySounds(f, { unit: path.join(from, 'unit'), companion: path.join(from, 'horse') }, to, () => {})).toEqual(['horse_neigh.wav', 'horse_neigh_2.wav'])
    expect(readdirSync(to).sort()).toEqual(['horse_neigh.wav', 'horse_neigh_2.wav'])
    expect(readFileSync(path.join(to, 'horse_neigh.wav'), 'utf8')).toBe('rider')
    expect(readFileSync(path.join(to, 'horse_neigh_2.wav'), 'utf8')).toBe('horse')
    expect(f.clips.Idle.events[0].sound).toBe('file:sounds/horse_neigh.wav')
    expect(f.companion!.clips.Idle.events.map(e => e.sound)).toEqual(['file:sounds/horse_neigh_2.wav', 'file:sounds/horse_neigh_2.wav'])
  })
})
