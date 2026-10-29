import { describe, expect, it } from 'vitest'
import type { Window } from './types.ts'
import { IDENTITY, resolveTime, windowsToPlayed } from './timemap.ts'
import { editWindows } from './windowedit.ts'

// (a blow fit keeping the middle of a 2 s source: source 0.25-0.75 plays as 0-1)
const cut = resolveTime({ seconds: 2, speed: 1, kept: [0.5, 1.5] })

describe('windows edited where the clip plays them', () => {
  it('converts only the window edited: one in a cut part and one running into it keep their source times', () => {
    const stored: Window[] = [[0.05, 0.15], [0.2, 0.4], [0.5, 0.6]]
    const shown = windowsToPlayed(cut, stored)
    expect(shown.length).toBe(2)
    // (the last one's end moved)
    const next = shown.map((w, i): Window => (i === 1 ? [w[0], 0.9] : w))
    const out = editWindows(cut, stored, next)
    expect(out[0]).toEqual([0.05, 0.15])
    expect(out[1]).toEqual([0.2, 0.4])
    expect(out[2][0]).toBe(0.5)
    expect(out[2][1]).toBeCloseTo(0.25 + 0.9 * 0.5, 9)
  })

  it('keeps the stored start of an edited window cut at the clip start when only its end moved', () => {
    const stored: Window[] = [[0.1, 0.5]]
    const [shown] = windowsToPlayed(cut, stored)
    expect(shown[0]).toBe(0)
    const out = editWindows(cut, stored, [[0, 0.8]])
    expect(out[0][0]).toBe(0.1)
    expect(out[0][1]).toBeCloseTo(0.65, 9)
  })

  it('adds and takes out windows, the hidden ones kept', () => {
    const stored: Window[] = [[0.05, 0.15], [0.4, 0.5]]
    expect(editWindows(cut, stored, [])).toEqual([[0.05, 0.15]])
    const out = editWindows(cut, stored, [...windowsToPlayed(cut, stored), [0.8, 0.9]])
    expect(out.slice(0, 2)).toEqual([[0.05, 0.15], [0.4, 0.5]])
    expect(out[2][0]).toBeCloseTo(0.65, 9)
    // (played as stored: as given)
    expect(editWindows(IDENTITY, [[0.1, 0.2]], [[0.1, 0.3]])).toEqual([[0.1, 0.3]])
  })
})
