// The Ship step's words and small rules, kept pure so they can be tested: a unit's state against the game's copy, its
// clip names against the character's slots, its levels, the strides as the game's UnitView.cs takes them, what a
// build record flags, how long ago a build ran.
import type { BuildRecord } from '../../model/unit.ts'
import type { Check } from '../../engine/checks.ts'

/** A unit name from a character's: lower case, words joined by _. */
export function unitNameOf (name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

/** How Rigsmith's entry stands against the game's (what Export would write). */
export function unitState (u: { game: unknown, differs: boolean }): { label: string, tone: 'muted' | 'warn' | 'ok' } {
  if (u.game === null) return { label: 'Not in the game yet', tone: 'muted' }
  return u.differs ? { label: 'Changed here', tone: 'warn' } : { label: 'As in the game', tone: 'ok' }
}

/** The unit's clip names, each with whether the character has a slot of that name (the export stops on one it hasn't). */
export function clipChips (clips: readonly string[], slots: readonly string[]): Array<{ name: string, ok: boolean }> {
  const have = new Set(slots)
  return clips.map(name => ({ name, ok: have.has(name) }))
}

/** The slot names a unit could add to the clips it plays (those not listed yet), in the slots' order. */
export function addableClips (clips: readonly string[], slots: readonly string[]): string[] {
  const listed = new Set(clips)
  return slots.filter(s => !listed.has(s))
}

/** Levels as whole percents of LOD0. */
export const lodPercents = (lods: readonly number[]): number[] => lods.map(r => Math.round(r * 1000) / 10)

/** A level added under the last (or the first, at 45 %): a third of the one before. */
export function nextLod (lods: readonly number[]): number[] {
  const last = lods.at(-1)
  return [...lods, last === undefined ? 0.45 : Math.round(last / 3 * 100) / 100]
}

/** A stride rounded as the game keeps it (three decimals). */
export const strideValue = (v: number): number => Math.round(v * 1000) / 1000

/** A stride as a line of UnitView.cs's Stride or RunStride dictionary: `["warrior"] = 1.025f,`. */
export function strideEntry (unit: string, v: number): string {
  return `[${JSON.stringify(unit)}] = ${strideValue(v)}f,`
}

/** The library audit's complaints about the clips a build used, clip by clip. */
export function auditFlags (record: Pick<BuildRecord, 'clips'> | null): Array<{ clip: string, text: string }> {
  if (record === null) return []
  return Object.entries(record.clips).flatMap(([clip, c]) => (c.audit ?? []).map(text => ({ clip, text })))
}

/** The checks in one line: all pass, or how many fail and warn. */
export function checksSummary (checks: readonly Check[]): { text: string, tone: 'ok' | 'warn' | 'error' } {
  const fail = checks.filter(c => c.status === 'fail').length
  const warn = checks.filter(c => c.status === 'warn').length
  if (fail === 0 && warn === 0) return { text: 'Every check passes', tone: 'ok' }
  const parts = [fail > 0 ? `${fail} ${fail === 1 ? 'check fails' : 'checks fail'}` : '', warn > 0 ? `${warn} ${warn === 1 ? 'warning' : 'warnings'}` : ''].filter(Boolean)
  return { text: parts.join(', '), tone: fail > 0 ? 'error' : 'warn' }
}

/** How long ago `at` was, in plain words. */
export function ago (at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

/** How long a build took. */
export function took (from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000))
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
}
