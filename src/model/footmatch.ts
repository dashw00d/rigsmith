// Match feet (docs/motion-plan.md §12.4): where a piece should start in its content so its feet carry on the gait of the
// piece before. The gait phase where the piece before hands over is the foot that last came down in its content before
// then, and how far it is from that fall to the same foot's next one (0 just down, 0.5 half way to the next fall); the
// same phase is found in this piece's content, between two falls of that foot, nearest where it starts now. Pure: the
// falls are measured by the caller (src/app/motion/events/footsteps.ts), in seconds of each content. A content that loops
// round (one stride of a walk) has its falls repeat every `period` seconds: the gait reads across its seam, and a start
// can be found in a cycle where each foot came down once.

/** A foot's falls, by its step name ('step.L', 'step.R'), seconds of a content, ascending. */
export type Falls = Record<string, number[]>

export interface FootMatch { from: number, foot: string, phase: number }

/** The gait phase at `at` seconds of a content: the foot that fell last at or before it and how far it is to its next
 * fall (the stride before it when there is none after); null when no foot fell twice around it. */
export function gaitAt (falls: Falls, at: number): { foot: string, phase: number } | null {
  let best: { foot: string, fall: number, next: number } | null = null
  for (const [foot, ts] of Object.entries(falls)) {
    const i = lastAtOrBefore(ts, at)
    if (i < 0) continue
    const next = ts[i + 1] ?? (i > 0 ? ts[i] + (ts[i] - ts[i - 1]) : undefined)
    if (next === undefined || next <= ts[i]) continue
    if (best === null || ts[i] > best.fall) best = { foot, fall: ts[i], next }
  }
  if (best === null) return null
  return { foot: best.foot, phase: Math.min(1, (at - best.fall) / (best.next - best.fall)) }
}

/** Where a piece `length` seconds long should start in a content `seconds` long with these falls to carry on the gait
 * of the piece before (its falls, handing over at `at` seconds of its content), nearest `near`. A start that leaves the
 * piece inside its content wins over one nearer that runs past its end. Null, with why, when it can't be matched. */
export function matchFeet (before: Falls, at: number, falls: Falls, seconds: number, length: number, near: number,
  o: { beforePeriod?: number, period?: number } = {}): FootMatch | string {
  if (o.beforePeriod !== undefined) before = repeated(before, o.beforePeriod, at - 2 * o.beforePeriod, at + 2 * o.beforePeriod)
  if (o.period !== undefined) falls = repeated(falls, o.period, -2 * o.period, seconds + 2 * o.period)
  const gait = gaitAt(before, at)
  if (gait === null) return 'The clip before has no full stride there: its feet never come down twice'
  const ts = falls[gait.foot] ?? []
  if (ts.length < 2) return 'This clip has no full stride of that foot: its feet never come down twice'
  const starts: number[] = []
  for (let k = 0; k + 1 < ts.length; k++) starts.push(ts[k] + gait.phase * (ts[k + 1] - ts[k]))
  const fits = starts.filter(t => t >= 0 && t + length <= seconds + 1e-6)
  const pool = fits.length > 0 ? fits : starts.filter(t => t >= 0)
  if (pool.length === 0) return 'This clip has no stride to start from there'
  const from = pool.reduce((a, b) => (Math.abs(b - near) < Math.abs(a - near) ? b : a))
  return { from: Math.round(from * 1000) / 1000, ...gait }
}

/** Falls repeated every `period` seconds over [from, to]. */
export function repeated (falls: Falls, period: number, from: number, to: number): Falls {
  if (!(period > 0)) return falls
  const out: Falls = {}
  for (const [foot, ts] of Object.entries(falls)) {
    const all: number[] = []
    for (let k = Math.floor((from - period) / period); k <= Math.ceil(to / period); k++) for (const t of ts) { const x = t + k * period; if (x >= from && x <= to) all.push(x) }
    out[foot] = [...new Set(all.map(x => Math.round(x * 1e6) / 1e6))].sort((a, b) => a - b)
  }
  return out
}

function lastAtOrBefore (ts: readonly number[], at: number): number {
  let out = -1
  for (let i = 0; i < ts.length; i++) if (ts[i] <= at + 1e-9) out = i
  return out
}
