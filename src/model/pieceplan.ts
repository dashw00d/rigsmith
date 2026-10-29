// The Clip strip's gestures as commands (docs/motion-plan.md §11), pure: what the timeline knows of the slot playing
// (its time map, its played length, the composite's seconds, the blow fit's cut, the length of its own clip) and a
// gesture in played phases give the commands of one batch (one undo): the next pieces (src/model/pieces.ts helpers),
// and with the blow fit on the hit pinned first (a measured blow becomes the hit event, so a longer clip can't find
// another fastest moment) and fit.at after, so the played clip keeps its start and its blow where they are and ends
// where the gesture says. src/state/pieces.svelte.ts sends them.
import type { Command } from './command-types.ts'
import { stableJson } from './entities.ts'
import {
  appended, blended, endAt, fitFor, insertAt, layoutOf, moved, patched, piecesOf, remapper, removed, slotsUnder, startAt, trimmed,
  type Layout, type PiecesEdit,
} from './pieces.ts'
import { hitOf } from './select.ts'
import type { TimeMap } from './timemap.ts'
import type { Character, Piece, Slot } from './types.ts'

/** What the timeline knows of the slot playing. */
export interface PlanSlot {
  slot: Slot
  map: Pick<TimeMap, 'toSource' | 'range'>
  /** The played clip's seconds (one cycle). */
  duration: number
  /** The composite's seconds (the bake's raw clip). */
  seconds: number
  /** The blow fit's cut (BakedSlot.cut), seconds after the speed. */
  cut?: { start: number, end: number, blow: number }
  /** The length of the slot's own clip when known (a slot without pieces: `seconds`). */
  own?: number
  /** A piece's content length when known (what trimming may let it out to). */
  content?: (p: Piece) => number | undefined
}

/** The slot's pieces (its clip whole when it has none), their layout, the played range, source seconds per played. */
export interface PiecesNow { pieces: Piece[], layout: Layout, seconds: number, range: [number, number], perPlayed: number }

export function nowOf (s: PlanSlot): PiecesNow {
  const D = s.seconds
  const pieces = piecesOf(s.slot, D)
  const range: [number, number] = [s.map.range[0] * D, s.map.range[1] * D]
  return { pieces, layout: layoutOf(pieces), seconds: D, range, perPlayed: (range[1] - range[0]) / Math.max(1e-9, s.duration) }
}

/** A gesture's commands, or why it can't be done. */
export type Plan = { commands: Command[] } | { problem: string }

/** The second of the composite played at phase `v` (through the time map: retime markers, the fit, past its ends). */
export const secondOf = (s: PlanSlot, v: number): number => s.map.toSource(v) * s.seconds

/** The played clip's end moved to played phase `v` (past 1: longer, its last pose as it plays held; before: shorter). */
export function planEnd (s: PlanSlot, v: number, newId: () => string): Plan {
  const n = nowOf(s)
  const t = secondOf(s, v)
  if (t <= n.range[0] + 1 / 30) return { problem: 'The clip can’t end before it starts' }
  // (longer with the blow fit cutting the end: what it cut off goes first (trimming the piece's own end lets that out
  // again); a late blow's held end, past the clip, the hold covers as it is)
  const cuts = t > n.range[1] && n.range[1] < n.seconds - 1e-6
  const base = cuts ? endAt(n.pieces, n.range[1], newId) : { pieces: n.pieces }
  const edit = base === null ? null : endAt(base.pieces, cuts ? layoutOf(base.pieces).seconds + (t - n.range[1]) : t, newId)
  return edit === null ? { problem: 'Nothing would be left of the clip' } : planOf(s, n, edit, newId, { last: true })
}

/** The played clip's start moved to played phase `v` (below 0: longer, its first pose held; above: shorter). */
export function planStart (s: PlanSlot, v: number, newId: () => string): Plan {
  const n = nowOf(s)
  const t = secondOf(s, v)
  if (t >= n.range[1] - 1 / 30) return { problem: 'The clip can’t start after it ends' }
  const cuts = t < n.range[0] && n.range[0] > 1e-6
  const base = cuts ? startAt(n.pieces, n.range[0], newId) : { pieces: n.pieces }
  const edit = base === null ? null : startAt(base.pieces, cuts ? t - n.range[0] : t, newId)
  return edit === null ? { problem: 'Nothing would be left of the clip' } : planOf(s, n, edit, newId, { first: true })
}

/** `seconds` (played) of held pose put in at played phase `v` (the playhead): at either end, the clip longer there. */
export function planInsert (s: PlanSlot, v: number, seconds: number, newId: () => string): Plan {
  if (v >= 1 - 1e-6) return planEnd(s, 1 + seconds / Math.max(1e-9, s.duration), newId)
  if (v <= 1e-6) return planStart(s, -seconds / Math.max(1e-9, s.duration), newId)
  const n = nowOf(s)
  const edit = insertAt(n.pieces, secondOf(s, v), seconds * n.perPlayed, newId)
  return edit === null ? { problem: 'The playhead is inside a blend: move it off the blend to put time in there' } : planOf(s, n, edit, newId)
}

/** A piece put after the clip as it plays, blended in (what the blow fit cuts off the end goes first). */
export function planAppend (s: PlanSlot, piece: Piece, blend: number, newId: () => string): Plan {
  const n = nowOf(s)
  const base = n.range[1] < n.seconds - 1e-6 ? endAt(n.pieces, n.range[1], newId) : { pieces: n.pieces }
  if (base === null) return { problem: 'Nothing would be left of the clip' }
  return planOf(s, n, appended(base.pieces, piece, blend), newId, { last: true })
}

/** The other gestures: a piece's ends dragged (`dv` played phase), its range or blend typed, reordered, removed. */
export function planTrim (s: PlanSlot, id: string, edge: 'start' | 'end', dv: number, newId: () => string): Plan {
  const n = nowOf(s)
  const piece = n.pieces.find(x => x.id === id)
  return orNot(s, n, piece === undefined ? null : trimmed(n.pieces, id, edge, dv * s.duration * n.perPlayed, s.content?.(piece)), newId)
}
export function planPatch (s: PlanSlot, id: string, patch: { from?: number, to?: number, blend?: number }, newId: () => string): Plan {
  const n = nowOf(s)
  const piece = n.pieces.find(x => x.id === id)
  return orNot(s, n, piece === undefined ? null : patched(n.pieces, id, patch, s.content?.(piece)), newId)
}
/** The blend into piece `id` set to `seconds` (played). */
export const planBlend = (s: PlanSlot, id: string, seconds: number, newId: () => string): Plan => { const n = nowOf(s); return orNot(s, n, blended(n.pieces, id, seconds * n.perPlayed), newId) }
export const planMove = (s: PlanSlot, id: string, index: number, newId: () => string): Plan => { const n = nowOf(s); return orNot(s, n, moved(n.pieces, id, index), newId) }
export function planRemove (s: PlanSlot, ids: readonly string[], newId: () => string): Plan {
  const n = nowOf(s)
  const edit = removed(n.pieces, ids)
  return edit === null ? { problem: 'A clip keeps at least one piece of a clip' } : planOf(s, n, edit, newId)
}

const orNot = (s: PlanSlot, n: PiecesNow, edit: PiecesEdit | null, newId: () => string): Plan => (edit === null ? { problem: 'That piece is gone' } : planOf(s, n, edit, newId))

/**
 * An edit as commands: the hit pinned (a measured blow, with the fit on), the pieces (with the length of the slot's own
 * clip whenever it is known, so a list that is that clip whole again is stored as none), the fit following. `o.first`:
 * the played clip starts where the new pieces do; `o.last`: it ends where they do; else its start and end stay on their
 * moments (an end at or past the old end stays as far past the new one).
 */
export function planOf (s: PlanSlot, n: PiecesNow, edit: PiecesEdit, newId: () => string, o: { first?: boolean, last?: boolean } = {}): Plan {
  const slot = s.slot
  const out: Command[] = []
  const seconds = slot.pieces === undefined ? n.seconds : s.own
  const set: Command = { type: 'slot.pieces.set', slot: slot.id, pieces: edit.pieces, ...(seconds !== undefined ? { seconds } : {}), ...(edit.split !== undefined ? { split: edit.split } : {}) }
  const fit = slot.time?.fit
  if (fit?.enabled !== true || s.cut === undefined) return { commands: [set] }
  const D = n.seconds
  const cut = s.cut
  const hit = hitOf(slot)
  const blowV = (cut.blow - cut.start) / Math.max(1e-9, cut.end - cut.start)
  const blowU = hit?.u ?? s.map.toSource(blowV)
  if (hit === undefined) out.push({ type: 'slot.event.add', slot: slot.id, event: { id: newId(), name: 'hit', u: blowU } })
  out.push(set)
  const r = remapper(n.pieces, edit.pieces, edit.split)
  const D2 = Math.max(1e-9, r.seconds[1])
  const where = (t: number): number => (r.point(t / D) ?? r.clamp(t / D)) * D2
  const start = o.first === true ? 0 : where(n.range[0])
  const blow = (r.point(blowU) ?? NaN) * D2
  const end = o.last === true ? D2 : n.range[1] >= D - 1e-9 ? D2 + (n.range[1] - D) : where(n.range[1])
  const next = fitFor(fit, start, blow, end)
  if (next === null) return { problem: 'The hit would fall outside the clip: keep it inside' }
  if (next.at !== fit.at || next.window !== fit.window) out.push({ type: 'slot.time', slot: slot.id, patch: { fit: next } })
  return { commands: out }
}

/** A content's key among the lengths measured: a clip by its ref and in place; another slot by everything its bake reads
 * (so a change to it, or to what it plays, is measured again). */
export function contentKey (p: Piece, inPlace: boolean, c: Pick<Character, 'clips'>): string {
  if (p.kind === 'clip') return `clip:${p.clip.id}|${p.clip.url ?? ''}|${inPlace ? 1 : 0}`
  if (p.kind !== 'slot') return ''
  const s = c.clips.find(x => x.id === p.slot)
  return `slot:${p.slot}:${s === undefined ? '' : stableJson([s, slotsUnder(c, s)])}`
}
