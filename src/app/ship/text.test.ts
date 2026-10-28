import { describe, expect, it } from 'vitest'
import type { Check } from '../../engine/checks.ts'
import { addableClips, ago, auditFlags, checksSummary, clipChips, lodPercents, nextLod, strideEntry, strideValue, took, unitNameOf, unitState } from './text.ts'

describe('the Ship words', () => {
  it('names a unit after its character', () => {
    expect(unitNameOf('Horse Archer')).toBe('horse_archer')
    expect(unitNameOf('  Raven-Seer 2 ')).toBe('raven_seer_2')
    expect(unitNameOf('!!!')).toBe('')
  })

  it("says how a unit stands against the game's copy", () => {
    expect(unitState({ game: null, differs: true }).label).toBe('Not in the game yet')
    expect(unitState({ game: {}, differs: true })).toEqual({ label: 'Changed here', tone: 'warn' })
    expect(unitState({ game: {}, differs: false }).tone).toBe('ok')
  })

  it("checks the clip names against the character's slots", () => {
    expect(clipChips(['Idle', 'Walk', 'Fly'], ['Idle', 'Walk', 'Run'])).toEqual([
      { name: 'Idle', ok: true }, { name: 'Walk', ok: true }, { name: 'Fly', ok: false },
    ])
    expect(addableClips(['Idle', 'Fly'], ['Idle', 'Walk', 'Run'])).toEqual(['Walk', 'Run'])
  })

  it('shows and adds levels', () => {
    expect(lodPercents([0.45, 0.15])).toEqual([45, 15])
    expect(nextLod([])).toEqual([0.45])
    expect(nextLod([0.45, 0.15])).toEqual([0.45, 0.15, 0.05])
  })

  it("writes a stride as UnitView.cs's line", () => {
    expect(strideValue(1.02549)).toBe(1.025)
    expect(strideEntry('warrior', 1.02549)).toBe('["warrior"] = 1.025f,')
  })

  it("lists a build's audit complaints by clip", () => {
    expect(auditFlags(null)).toEqual([])
    const clips = { Walk: { clip: 'a', loop: true, inPlace: true, speed: 1, seconds: 1, audit: ['an idle under a walking name?'] }, Idle: { clip: 'b', loop: true, inPlace: true, speed: 1, seconds: 2 } }
    expect(auditFlags({ clips })).toEqual([{ clip: 'Walk', text: 'an idle under a walking name?' }])
  })

  it('sums up the checks', () => {
    const c = (status: Check['status']): Check => ({ rule: 'x', status, text: '' })
    expect(checksSummary([c('pass'), c('info')])).toEqual({ text: 'Every check passes', tone: 'ok' })
    expect(checksSummary([c('fail'), c('warn'), c('warn')])).toEqual({ text: '1 check fails, 2 warnings', tone: 'error' })
    expect(checksSummary([c('warn')])).toEqual({ text: '1 warning', tone: 'warn' })
  })

  it('says when, and how long', () => {
    const now = 1_000_000_000
    expect(ago(now - 10_000, now)).toBe('just now')
    expect(ago(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(ago(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(ago(now - 30 * 3_600_000, now)).toBe('yesterday')
    expect(took(0, 42_000)).toBe('42 s')
    expect(took(0, 125_000)).toBe('2 min 5 s')
  })
})
