// The Events track's edits as commands (slot.event.add / update / remove, docs/motion-plan.md §4), worked out in played
// time and stored in source time: the lane drags and the inspector types played phases (frames of the clip as it
// plays), and every write goes through the slot's time map (`toSource`), so a later change of the timing never moves an
// event. Also when the playhead crosses an event (the preview's sounds). Pure.
import type { Command } from '../../../model/command-types.ts'
import type { ClipEvent, Slot } from '../../../model/types.ts'
import { clampU, newEventId } from './vocabulary.ts'

/** The slot's time map as the lane uses it (TimelineView's). */
export interface TimeView {
  toPlayed: (source: number) => number
  toSource: (played: number) => number
  snap: (played: number, free?: boolean) => number
}

/** An event as it plays: its played phase (and a span's end), from the slot's or measured (the fit's blow, no event). */
export interface PlayedEvent { id: string, name: string, t: number, to?: number, sound?: string, volume?: number, pitch?: number, measured?: boolean }

/** The id the measured blow goes by in the lane and the selection (it has no event till it is moved or typed). */
export const MEASURED_HIT = 'measured-hit'

/** The slot's events as they play (sorted), and the blow the fit measured when it has no hit event (`measured`: its
 * played phase, from the baked cut). */
export function playedEvents (slot: Pick<Slot, 'events'>, time: Pick<TimeView, 'toPlayed'>, measured: number | null): PlayedEvent[] {
  const out: PlayedEvent[] = (slot.events ?? []).map(e => ({
    id: e.id, name: e.name, t: time.toPlayed(e.u), ...(e.to !== undefined ? { to: time.toPlayed(e.to) } : {}),
    ...(e.sound !== undefined ? { sound: e.sound } : {}), ...(e.volume !== undefined ? { volume: e.volume } : {}), ...(e.pitch !== undefined ? { pitch: e.pitch } : {}),
  }))
  const hit = (slot.events ?? []).some(e => e.name === 'hit' && e.to === undefined)
  if (!hit && measured !== null) out.push({ id: MEASURED_HIT, name: 'hit', t: measured, measured: true })
  return out.sort((a, b) => a.t - b.t)
}

/** The blow the fit measured, as a played phase (the bake's own expression), or null. */
export function measuredHit (cut: { start: number, end: number, blow: number } | undefined): number | null {
  return cut === undefined ? null : (cut.blow - cut.start) / Math.max(cut.end - cut.start, 1e-12)
}

const within = (v: number): number => Math.min(1, Math.max(0, v))

/** A new event at a played phase (snapped as given), with what it starts with; a span lasts `span` of the clip. */
export function addEvent (slot: Pick<Slot, 'id' | 'events'>, name: string, played: number, time: TimeView,
  o: { span?: number, defaults?: Partial<ClipEvent>, free?: boolean, id?: string } = {}): Command {
  const t = within(time.snap(played, o.free))
  const u = clampU(time.toSource(t))
  const event: ClipEvent = { id: o.id ?? newEventId(slot), name, u, ...o.defaults }
  if (o.span !== undefined && o.span > 0) {
    const end = within(time.snap(Math.min(1, t + o.span), o.free))
    const to = clampU(time.toSource(end > t ? end : Math.min(1, t + o.span)))
    if (to > u) event.to = to
  }
  return { type: 'slot.event.add', slot: slot.id, event }
}

/** The selected events moved together by `dv` of the played clip: the one grabbed lands on a frame (unless free), the
 * rest keep their distance to it; none leaves the clip (a span keeps its length). The measured blow, moved, becomes
 * the slot's hit event (picked by hand). */
export function moveEvents (slot: Pick<Slot, 'id' | 'events'>, ids: string[], grabbed: string, dv: number, time: TimeView,
  o: { free?: boolean, measured?: number | null } = {}): Command[] {
  const played = playedEvents(slot, time, o.measured ?? null)
  const moving = played.filter(e => ids.includes(e.id))
  const lead = moving.find(e => e.id === grabbed) ?? moving[0]
  if (lead === undefined) return []
  let delta = time.snap(lead.t + dv, o.free) - lead.t
  // (kept inside the clip, all of them)
  const lo = Math.min(...moving.map(e => e.t)); const hi = Math.max(...moving.map(e => e.to ?? e.t))
  delta = Math.min(1 - hi, Math.max(-lo, delta))
  if (Math.abs(delta) < 1e-9) return []
  const out: Command[] = []
  for (const e of moving) {
    const u = clampU(time.toSource(e.t + delta))
    if (e.measured === true) {
      out.push({ type: 'slot.event.add', slot: slot.id, event: { id: newEventId(slot), name: 'hit', u } })
      continue
    }
    const patch: { u: number, to?: number } = { u }
    if (e.to !== undefined) patch.to = clampU(time.toSource(e.to + delta))
    out.push({ type: 'slot.event.update', slot: slot.id, id: e.id, patch })
  }
  return out
}

/** A span's start or end dragged to a played phase (on a frame unless free), never past its other end (a frame apart
 * at least: `minimum`, a share of the clip). */
export function moveEdge (slot: Pick<Slot, 'id' | 'events'>, id: string, edge: 'start' | 'end', played: number, time: TimeView,
  o: { free?: boolean, minimum?: number } = {}): Command[] {
  const e = (slot.events ?? []).find(x => x.id === id)
  if (e?.to === undefined) return []
  const gap = o.minimum ?? 1e-3
  const start = time.toPlayed(e.u); const end = time.toPlayed(e.to)
  const t = within(time.snap(played, o.free))
  if (edge === 'start') {
    const v = Math.min(t, end - gap)
    const u = clampU(time.toSource(v))
    return Math.abs(u - e.u) < 1e-9 || !(u < e.to) ? [] : [{ type: 'slot.event.update', slot: slot.id, id, patch: { u } }]
  }
  const v = Math.max(t, start + gap)
  const to = clampU(time.toSource(v))
  return Math.abs(to - e.to) < 1e-9 || !(to > e.u) ? [] : [{ type: 'slot.event.update', slot: slot.id, id, patch: { to } }]
}

/** The events taken off (the measured blow has none to take: it stays measured). */
export function removeEvents (slot: Pick<Slot, 'id' | 'events'>, ids: string[]): Command[] {
  return (slot.events ?? []).filter(e => ids.includes(e.id)).map(e => ({ type: 'slot.event.remove', slot: slot.id, id: e.id }))
}

/** A point made a span lasting `span` of the played clip (inside it), or a span made the point at its start. The hit
 * stays a point. */
export function toggleSpan (slot: Pick<Slot, 'id' | 'events'>, id: string, time: TimeView, span = 0.15): Command[] {
  const e = (slot.events ?? []).find(x => x.id === id)
  if (e === undefined || e.name === 'hit') return []
  if (e.to !== undefined) return [{ type: 'slot.event.update', slot: slot.id, id, patch: { to: null } }]
  const t = time.toPlayed(e.u)
  const end = Math.min(1, time.snap(t + span))
  const to = clampU(time.toSource(end > t ? end : Math.min(1, t + span)))
  return to > e.u ? [{ type: 'slot.event.update', slot: slot.id, id, patch: { to } }] : []
}

/** The events whose moment the playhead passed going from `from` to `to` (played phases): forward, (from, to]; past
 * the end of a loop, round through 0; going back (a one-shot started again), from its start. */
export function crossed<T extends { t: number }> (events: T[], from: number, to: number, loop: boolean): T[] {
  if (to >= from) return events.filter(e => e.t > from && e.t <= to)
  if (loop) return events.filter(e => e.t > from || e.t <= to)
  return events.filter(e => e.t >= 0 && e.t <= to)
}
