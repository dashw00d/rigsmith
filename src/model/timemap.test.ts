// The time map (src/model/timemap.ts): a slot's source moments to phases of the clip as it plays and back, through
// markers, the speed, the blow fit and pace, and the blow fit's arithmetic that timing.ts blowCut shares.
import { describe, expect, it } from 'vitest'
import {
  eventToPlayed, fitBlow, fitRange, IDENTITY, keysToPlayed, phaseBeforeFit, resolveTime, sourceAt, sourceOfTime, warps, windowsToPlayed, windowsToSource,
} from './timemap.ts'

const near = (a: number, b: number): void => { expect(Math.abs(a - b)).toBeLessThan(1e-12) }

describe('resolveTime', () => {
  it('is the source itself without a fit, markers or holds, to the last bit, whatever the speed and pace', () => {
    const map = resolveTime({ seconds: 2, speed: 1.7, pace: 1.3 })
    for (const u of [0, 0.1, 1 / 3, 0.5, 0.97, 1, 1.4]) { expect(map.toPlayed(u)).toBe(u); expect(map.toSource(u)).toBe(u) }
    expect(map.duration).toBeCloseTo(2 / 1.7 / 1.3, 12)
    expect(map.range).toEqual([0, 1])
  })

  it('runs a fit\'s kept range over the played clip: a cut start, a held end past 1', () => {
    // (a 2 s source at speed 2 is 1 s; the fit keeps 0.2..1 of it)
    const cut = resolveTime({ seconds: 2, speed: 2, kept: [0.2, 1] })
    near(cut.toPlayed(0.2), 0); near(cut.toPlayed(1), 1); near(cut.toSource(0.5), 0.6)
    expect(cut.range.map(x => +x.toFixed(9))).toEqual([0.2, 1])
    // (held: the end at 1.5 s of a 1 s clip, the last third past the source's end)
    const held = resolveTime({ seconds: 1, speed: 1, kept: [0, 1.5] })
    near(held.toSource(1), 1.5); near(held.toPlayed(1.2), 0.8); near(held.duration, 1.5)
  })

  it('warps through retime markers: a source moment plays where its marker says, straight between', () => {
    const map = resolveTime({ seconds: 1, speed: 1, time: { markers: [{ id: 'm', u: 0.5, to: 0.25 }] } })
    near(map.toPlayed(0.5), 0.25); near(map.toPlayed(0.25), 0.125); near(map.toPlayed(0.75), 0.625)
    for (const u of [0.1, 0.5, 0.8, 1]) near(map.toSource(map.toPlayed(u)), u)
    expect(warps({ markers: [{ id: 'm', u: 0.5, to: 0.5 }] })).toBe(false)
  })

  it('has no holds (they are hold pieces of the source now): a picked blow is its own phase without markers', () => {
    expect(phaseBeforeFit(0.6, { seconds: 1, speed: 3 })).toBe(0.6)
    near(sourceOfTime(0.6, { seconds: 1 }), 0.6)
  })
})

describe('the blow fit', () => {
  it('cuts the start of a late blow, holds the end when asked, ends an early one, keeps a window', () => {
    expect(fitRange(1.2, 2, { at: 0.45 })).toEqual([(1.2 - 0.9) / 0.55, 2])
    expect(fitRange(1.2, 2, { at: 0.45, late: 'hold' })).toEqual([0, 1.2 / 0.45])
    expect(fitRange(0.6, 2, { at: 0.45 })).toEqual([0, 0.6 / 0.45])
    expect(fitRange(1, 2, { at: 0.45, window: 0.5 })).toEqual([1 - 0.225, 1 - 0.225 + 0.5])
  })

  it('keeps a picked blow a frame inside the clip', () => {
    expect(fitBlow(0.5, 2)).toBe(1)
    expect(fitBlow(0, 2)).toBe(1 / 30)
    expect(fitBlow(1, 2)).toBe(2 - 1 / 30)
  })
})

describe('converting a slot\'s times', () => {
  const map = resolveTime({ seconds: 1, speed: 1, kept: [0.25, 0.75] })

  it('shows windows as played, clipped to the played clip, and stores them back as source time', () => {
    expect(windowsToPlayed(map, [[0, 0.5], [0.8, 0.9], [0.5, 0.75]]).map(w => w.map(x => +x.toFixed(9)))).toEqual([[0, 0.5], [0.5, 1]])
    expect(windowsToSource(map, [[0, 0.5]]).map(w => w.map(x => +x.toFixed(9)))).toEqual([[0.25, 0.5]])
    expect(windowsToPlayed(IDENTITY, [[0.2, 0.3]])).toEqual([[0.2, 0.3]])
  })

  it('maps keys and events, keeping their eases and the rest of them', () => {
    expect(keysToPlayed(map, [{ u: 0.5, q: [0, 0, 0, 1], ease: 'step' }]).map(k => ({ ...k, u: +k.u.toFixed(9) }))).toEqual([{ u: 0.5, q: [0, 0, 0, 1], ease: 'step' }])
    expect(eventToPlayed(map, { u: 0.375, to: 0.5 })).toEqual({ t: 0.25, to: 0.5 })
    expect(sourceAt(map, 3)).toBeLessThanOrEqual(16)
  })
})
