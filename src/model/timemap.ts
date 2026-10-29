// A slot's time map (docs/motion-plan.md §2.2): how a moment of its source clip (SourceU) becomes a phase of the clip
// as it finally plays, and back. Pure arithmetic, no three.js: the bake resolves one per slot it bakes (with the blow
// it measured and the pace factor it found) and hands it to whoever shows or writes source time (the timeline, the
// window editors); the migration resolves one per schema 2 slot to move its phases into source time.
//
// The stages, in order (D the source's seconds: a slot built from pieces, their composite's, docs/motion-plan.md §11;
// T seconds):
//   warp   S -> W, piecewise linear through the retime markers (0 -> 0 and 1 -> 1; past 1, W = S); tau = W * D
//   speed  T1 = tau / speed
//   fit    the kept range [start, end] of T1 (the blow landed where the game times hits; end past the clip: its last
//          pose held); T2 = T1 - start
//   pace   T3 = T2 / factor
// so the played phase is v = (T1 - start) / (end - start): speed and pace are uniform, only the warp and the fit move
// phases. A slot without markers maps exactly as schema 2 played it (and, with no fit either, v = S to the last bit, so
// a migrated slot's windows and keys come back unchanged). (Schema 3's holds are hold pieces of the source now.)
import type { BlowFit, ClipEvent, ClipKey, RetimeMarker, SlotTime, SourceU, Window } from './types.ts'
import { MAX_U } from './types.ts'

export interface TimeInput {
  /** The source's length, seconds (at speed 1). */
  seconds: number
  speed: number
  /** Markers are read from it; its fit and pace only through `kept` and `pace`. */
  time?: SlotTime
  /** The fit's kept range, seconds of the clip after speed (and markers): blowCut's `kept`. Unset: no fit. */
  kept?: [number, number]
  /** The pace's factor (the played clip is the kept range retimed by it). Unset: 1. */
  pace?: number
}

export interface TimeMap {
  /** Seconds of the played clip. */
  duration: number
  /** Seconds of the clip after speed (and markers), before the fit: `kept` is in these. */
  uncut: number
  /** The kept range in those seconds ([0, uncut] without a fit). */
  kept: [number, number]
  /** Played phase (0..1 over the played clip; outside it, the source played before or after) of a source moment. */
  toPlayed: (u: SourceU) => number
  /** The source moment played at phase `v` (in the held end: past 1). */
  toSource: (v: number) => SourceU
  /** The source moments the played clip starts and ends on. */
  range: [SourceU, SourceU]
}

/** The time map of a slot as baked. */
export function resolveTime (s: TimeInput): TimeMap {
  const D = s.seconds > 0 ? s.seconds : 1e-9
  const speed = s.speed > 0 ? s.speed : 1
  const warp = warpOf(s.time?.markers)
  const plain = warp === null
  const uncut = D / speed
  const kept: [number, number] = s.kept === undefined ? [0, uncut] : [s.kept[0], s.kept[1]]
  const span = Math.max(kept[1] - kept[0], 1e-12)
  const factor = s.pace !== undefined && s.pace > 0 ? s.pace : 1
  // (the plain map in schema 2's own arithmetic: no fit is S itself, a fit is a straight line through the kept range)
  const exact = plain && s.kept === undefined
  const t1 = (u: SourceU): number => (plain ? u * (D / speed) : tauOf(u, D, warp) / speed)
  const u1 = (t: number): SourceU => (plain ? t / (D / speed) : sourceOfTau(t * speed, D, warp))
  const toPlayed = (u: SourceU): number => (exact ? u : (t1(u) - kept[0]) / span)
  const toSource = (v: number): SourceU => (exact ? v : u1(kept[0] + v * span))
  return { duration: span / factor, uncut, kept, toPlayed, toSource, range: [toSource(0), toSource(1)] }
}

/** The identity: a clip played as its source is (the clip alone, a library preview). */
export const IDENTITY: TimeMap = { duration: 1, uncut: 1, kept: [0, 1], toPlayed: u => u, toSource: v => v, range: [0, 1] }

// ---- the blow fit (the one place its arithmetic lives: src/engine/timing.ts blowCut calls these) -------------------

/** A blow picked as a phase of the clip before the fit, in its seconds: kept a frame inside the clip (a blow on its
 * first or last frame would cut it down to nothing). */
export function fitBlow (phase: number, duration: number): number {
  const edge = Math.min(1 / 30, duration / 4)
  return Math.min(duration - edge, Math.max(edge, Math.min(1, Math.max(0, phase)) * duration))
}

/** The part of the clip (seconds of it, `duration` long) the fit keeps so the blow at `blow` lands at `at` of it (or
 * `window` seconds round it); a late blow cuts the start, or with late 'hold' runs the end past the clip (its last pose
 * held there). */
export function fitRange (blow: number, duration: number, fit: Pick<BlowFit, 'at' | 'late' | 'window'>): [number, number] {
  let start = 0; let end = duration
  if (fit.window !== undefined) {
    start = Math.max(0, blow - fit.at * fit.window)
    end = Math.min(duration, start + fit.window)
  } else if (blow / duration < fit.at) end = Math.min(duration, blow / fit.at)
  else if (fit.late === 'hold') end = blow / fit.at    // (past its end: the last pose held there)
  else start = Math.max(0, (blow - fit.at * end) / (1 - fit.at))
  return [start, end]
}

/** The phase (of the clip before the fit) a source moment is at, for a picked blow: the moment itself when the slot
 * has no markers (schema 2's blowU, to the last bit). */
export function phaseBeforeFit (u: SourceU, s: Pick<TimeInput, 'seconds' | 'speed' | 'time'>): number {
  const warp = warpOf(s.time?.markers)
  if (warp === null) return u
  const D = s.seconds > 0 ? s.seconds : 1e-9
  return tauOf(u, D, warp) / D
}

// ---- converting what a slot stores -----------------------------------------------------------------------------------

/** The source moment at `tau` seconds of the clip after markers, before speed (what warpClip samples). */
export function sourceOfTime (tau: number, s: Pick<TimeInput, 'seconds' | 'time'>): SourceU {
  return sourceOfTau(tau, s.seconds > 0 ? s.seconds : 1e-9, warpOf(s.time?.markers))
}

/** Whether the slot's time has markers that change anything (else the clip is the source, retimed). */
export function warps (time: SlotTime | undefined): boolean {
  return warpOf(time?.markers) !== null
}

/** Source windows as played phases, clipped to the played clip (a part it doesn't play is left out). */
export function windowsToPlayed (map: TimeMap, windows: readonly Window[]): Window[] {
  const out: Window[] = []
  for (const [a, b] of windows) {
    const from = Math.max(0, map.toPlayed(a)); const to = Math.min(1, map.toPlayed(b))
    if (to - from > 1e-9) out.push([from, to])
  }
  return out
}

/** Played windows (0..1) as source windows. */
export function windowsToSource (map: TimeMap, windows: readonly Window[]): Window[] {
  return windows.map(([a, b]): Window => [clampU(map.toSource(a)), clampU(map.toSource(b))]).filter(([a, b]) => b - a > 1e-9)
}

/** Keys at their played phases (what keys.ts samples). Keys outside the played clip stay: they shape the tween in. */
export function keysToPlayed (map: TimeMap, keys: readonly ClipKey[]): ClipKey[] {
  return keys.map(k => ({ ...k, u: map.toPlayed(k.u) }))
}

/** A played phase as a source moment, kept inside 0..MAX_U. */
export function sourceAt (map: TimeMap, v: number): SourceU {
  return clampU(map.toSource(v))
}

/** An event's played phases. */
export function eventToPlayed (map: TimeMap, e: Pick<ClipEvent, 'u' | 'to'>): { t: number, to?: number } {
  return e.to === undefined ? { t: map.toPlayed(e.u) } : { t: map.toPlayed(e.u), to: map.toPlayed(e.to) }
}

const clampU = (u: number): number => Math.min(MAX_U, Math.max(0, u))

// ---- inside: the warp -------------------------------------------------------------------------------------------------

interface Warp { s: number[], w: number[] }

/** The markers as knots (0, 0) ... (1, 1); null: none (or only ones that change nothing). */
function warpOf (markers: readonly RetimeMarker[] | undefined): Warp | null {
  const ms = [...(markers ?? [])].filter(m => m.u > 0 && m.u < 1).sort((a, b) => a.u - b.u)
  if (ms.length === 0 || ms.every(m => Math.abs(m.u - m.to) < 1e-12)) return null
  return { s: [0, ...ms.map(m => m.u), 1], w: [0, ...ms.map(m => m.to), 1] }
}

function lerpKnots (x: number, xs: number[], ys: number[]): number {
  if (x <= 0) return x * (ys[1] - ys[0]) / (xs[1] - xs[0])
  if (x >= 1) return x
  let i = 1
  while (i < xs.length - 1 && xs[i] < x) i++
  const f = (x - xs[i - 1]) / Math.max(xs[i] - xs[i - 1], 1e-12)
  return ys[i - 1] + f * (ys[i] - ys[i - 1])
}

/** Seconds of the clip before speed at which source `u` plays. */
function tauOf (u: SourceU, D: number, warp: Warp | null): number {
  return (warp === null ? u : lerpKnots(u, warp.s, warp.w)) * D
}

/** The source moment at `tau` seconds of the clip before speed. */
function sourceOfTau (tau: number, D: number, warp: Warp | null): SourceU {
  const w = tau / D
  return warp === null ? w : lerpKnots(w, warp.w, warp.s)
}
