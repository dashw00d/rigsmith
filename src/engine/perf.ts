// Timing marks on the hot paths, in dev only (docs/dressing-plan.md Phase 0 §6): each `mark(name)` ... `done()` span
// becomes a performance measure ('rigsmith:<name>', seen in the browser's performance panel) and a line in a small
// ring the profile harness reads (tools/lib/profile.ts, through window.__rigsmith.perf). A long-task logger says
// which marks a task over 50 ms held. Off (free) in a build, in Node (the tools, the tests) and wherever performance
// is missing.

export interface Span { name: string, detail?: string, start: number, ms: number }
export interface LongTask { start: number, ms: number, marks: string[] }

const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env
export const enabled = env?.DEV === true && typeof performance !== 'undefined' && typeof performance.now === 'function'

const RING = 2000
const spans: Span[] = []
const longTasks: LongTask[] = []
const noop = (): void => {}

/** Start a span; the function it returns ends it (call it once). */
export function mark (name: string, detail?: string): () => void {
  if (!enabled) return noop
  const start = performance.now()
  return () => {
    const ms = performance.now() - start
    spans.push({ name, ...(detail !== undefined ? { detail } : {}), start, ms })
    if (spans.length > RING) spans.splice(0, spans.length - RING)
    try { performance.measure(`rigsmith:${name}`, { start, duration: ms, detail }) } catch { /* (an old browser: the ring has it) */ }
  }
}

/** `fn` run inside a span. */
export function timed<T> (name: string, fn: () => T, detail?: string): T {
  if (!enabled) return fn()
  const done = mark(name, detail)
  try { return fn() } finally { done() }
}

/** `fn`'s promise inside a span (its wall time, waits included). */
export async function timedAsync<T> (name: string, fn: () => Promise<T>, detail?: string): Promise<T> {
  if (!enabled) return await fn()
  const done = mark(name, detail)
  try { return await fn() } finally { done() }
}

/** What was measured (since the last clear), and the long tasks seen. */
export function report (): { spans: Span[], longTasks: LongTask[] } {
  return { spans: [...spans], longTasks: [...longTasks] }
}

export function clear (): void {
  spans.length = 0
  longTasks.length = 0
}

/** The spans that overlapped a stretch of time, by name, summed: what held a long task. */
export function heldBy (start: number, ms: number): string[] {
  const end = start + ms
  const by = new Map<string, number>()
  for (const s of spans) {
    const overlap = Math.min(end, s.start + s.ms) - Math.max(start, s.start)
    if (overlap > 0) by.set(s.name, (by.get(s.name) ?? 0) + overlap)
  }
  return [...by].sort((a, b) => b[1] - a[1]).map(([n, t]) => `${n} ${t.toFixed(0)}ms`)
}

let watching = false
/** Log every task over 50 ms on the main thread with the marks it held (dev; once). */
export function watchLongTasks (log: (line: string) => void = line => { console.warn(line) }): void {
  if (!enabled || watching || typeof PerformanceObserver === 'undefined') return
  watching = true
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        // (after the task: the spans it held are in by now)
        setTimeout(() => {
          const marks = heldBy(e.startTime, e.duration)
          longTasks.push({ start: e.startTime, ms: e.duration, marks })
          if (longTasks.length > RING) longTasks.splice(0, longTasks.length - RING)
          log(`rigsmith: long task ${e.duration.toFixed(0)} ms${marks.length > 0 ? ` (${marks.join(', ')})` : ''}`)
        }, 0)
      }
    }).observe({ type: 'longtask', buffered: true })
  } catch { /* (no long-task timing in this browser) */ }
}
