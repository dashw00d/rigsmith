// How much of a windowed adjustment plays at a moment (docs/motion-plan.md §12.1): a posture's turn and a layer's mix.
// 1 inside a window, smoothstepped up from 0 over `fade` after the window's start and down over `fade` before its end (a
// fade at most half the window), the largest over the windows; no windows: 1 everywhere. Pure, in source time: `u` and
// the windows are SourceU, the fade a phase of the source too (its seconds over the source's length).
import type { Window } from './types.ts'

export function envelope (u: number, windows: readonly Window[] | undefined, fade = 0): number {
  if (windows === undefined) return 1
  let most = 0
  for (const [a, b] of windows) {
    if (u < a || u > b) continue
    const f = Math.min(Math.max(0, fade), (b - a) / 2)
    const e = f <= 1e-12 ? 1 : smooth(Math.min(u - a, b - u) / f)
    if (e > most) most = e
    if (most >= 1) break
  }
  return most
}

/** The window holding `u` (the first one: windows a slot stores don't overlap within one adjustment), or null. */
export function windowAt (u: number, windows: readonly Window[]): Window | null {
  return windows.find(([a, b]) => u >= a && u <= b) ?? null
}

const smooth = (x: number): number => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c) }
