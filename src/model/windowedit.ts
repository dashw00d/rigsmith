// A list of windows edited where the clip plays them, written back where they are stored (source time). The window
// editors show a slot's windows through its time map (timemap.ts windowsToPlayed: clipped to the played clip, a window
// wholly in a part it doesn't play left out) and hand back the whole list with one window changed, added or taken out;
// converting all of it back would clip or drop every window in a cut part. Only what changed is converted.
import type { Window } from './types.ts'
import { windowsToSource, type TimeMap } from './timemap.ts'

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

/**
 * `stored` (source windows) with the edit `next` (played windows: what the editor showed of them, edited) laid on.
 * A window shown and handed back as it was keeps its stored source times; one not shown (wholly outside the played
 * clip) is kept as stored; one shown and not handed back was edited or taken out. The windows handed back that weren't
 * shown are new or edited: converted, an edited one (paired, in order, with those shown and gone) keeping the stored
 * time of an edge that didn't move (its start before the clip starts, its end after it ends). Sorted by start.
 */
export function editWindows (map: TimeMap, stored: readonly Window[], next: readonly Window[]): Window[] {
  const out: Window[] = []
  const gone: Array<{ stored: Window, shown: Window }> = []
  const left = next.map(w => [w[0], w[1]] as Window)
  for (const w of stored) {
    const shown: Window = [Math.max(0, map.toPlayed(w[0])), Math.min(1, map.toPlayed(w[1]))]
    if (shown[1] - shown[0] <= 1e-9) { out.push([w[0], w[1]]); continue }
    const at = left.findIndex(x => near(x[0], shown[0]) && near(x[1], shown[1]))
    if (at >= 0) { left.splice(at, 1); out.push([w[0], w[1]]); continue }
    gone.push({ stored: w, shown })
  }
  const changed = [...left].sort((a, b) => a[0] - b[0])
  const was = [...gone].sort((a, b) => a.shown[0] - b.shown[0])
  const paired = changed.length === was.length
  for (const [i, w] of changed.entries()) {
    const [converted] = windowsToSource(map, [w])
    if (converted === undefined) continue
    const before = paired ? was[i] : undefined
    const from = before !== undefined && near(w[0], before.shown[0]) ? before.stored[0] : converted[0]
    const to = before !== undefined && near(w[1], before.shown[1]) ? before.stored[1] : converted[1]
    if (to - from > 1e-9) out.push([from, to])
  }
  return out.sort((a, b) => a[0] - b[0])
}
