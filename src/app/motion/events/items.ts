// The Events track's items in the timeline's cross-track selection (src/app/motion/lanes.ts AreaItems): what Delete,
// Ctrl+D, the nudge (Ctrl+← →, a drag of selected keys) and Ctrl+C / Ctrl+V do to the selected events, so a selection
// of keys and events goes together. Worked out in played time with C1's edits (./edit.ts), stored in source time. Pure.
import type { Command } from '../../../model/command-types.ts'
import type { ClipEvent } from '../../../model/types.ts'
import type { AreaEdit, AreaItems, AreaView, SelectedItem } from '../lanes.ts'
import { MEASURED_HIT, measuredHit, moveEvents, playedEvents, removeEvents, type PlayedEvent } from './edit.ts'
import { clampU, newEventId } from './vocabulary.ts'

/** Events copied: each with its offset (and a span's length) in frames from the earliest copied. */
interface EventsClip { items: Array<{ frames: number, length?: number, event: Omit<ClipEvent, 'id' | 'u' | 'to'> }> }

const isEvents = (track: string): boolean => track === 'events'

/** The selected events as they play (the measured blow too, when it is selected). */
function chosen (view: AreaView, items: readonly SelectedItem[]): PlayedEvent[] {
  const ids = new Set(items.filter(s => isEvents(s.track)).map(s => s.id))
  return playedEvents(view.slot, view, measuredHit(view.baked?.cut)).filter(e => ids.has(e.id))
}

const select = (e: ClipEvent): SelectedItem => ({ track: 'events', id: e.id, u: e.u })

export const eventItems: AreaItems = {
  owns: isEvents,

  span (view, items) {
    const es = chosen(view, items)
    return es.length === 0 ? null : [Math.min(...es.map(e => e.t)), Math.max(...es.map(e => e.to ?? e.t))]
  },

  remove (view, items) {
    return removeEvents(view.slot, items.filter(s => isEvents(s.track)).map(s => s.id))
  },

  move (view, items, dv) {
    const es = chosen(view, items)
    if (es.length === 0) return null
    // (by dv exactly: the timeline has snapped it, so the events keep their distance to the keys moved with them)
    const commands = moveEvents(view.slot, es.map(e => e.id), es[0].id, dv, view, { free: true, measured: measuredHit(view.baked?.cut) })
    if (commands.length === 0) return null
    // (the measured blow, moved, is a hit event of its own now: that one selected)
    const selection = items.filter(s => isEvents(s.track) && s.id !== MEASURED_HIT).map(s => ({ ...s }))
    for (const c of commands) {
      if (c.type === 'slot.event.add') selection.push(select(c.event))
      else if (c.type === 'slot.event.update' && c.patch.u !== undefined && c.patch.u !== null) {
        const at = selection.findIndex(s => s.id === c.id)
        if (at >= 0) selection[at] = { ...selection[at], u: c.patch.u }
      }
    }
    return { commands, selection }
  },

  copy (view, items) {
    const es = chosen(view, items).filter(e => e.measured !== true)
    if (es.length === 0) return null
    const first = Math.min(...es.map(e => e.t))
    const stored = new Map((view.slot.events ?? []).map(e => [e.id, e]))
    const clip: EventsClip = {
      items: es.map(e => {
        const rest: Partial<ClipEvent> = { ...stored.get(e.id)! }
        delete rest.id; delete rest.u; delete rest.to
        const frames = Math.round((e.t - first) * view.frames)
        return { frames, ...(e.to !== undefined ? { length: Math.max(1, Math.round((e.to - e.t) * view.frames)) } : {}), event: JSON.parse(JSON.stringify(rest)) as EventsClip['items'][number]['event'] }
      }),
    }
    return { first, data: clip }
  },

  paste (view, clip, at) {
    const data = clip.data as EventsClip
    const frames = Math.max(1, view.frames)
    const start = Math.round(at * frames)
    const made: ClipEvent[] = []
    let hit = (view.slot.events ?? []).some(e => e.name === 'hit' && e.to === undefined)
    for (const it of data.items) {
      const f = start + it.frames
      if (f < 0 || f > frames) continue
      // (one hit a clip: a copied hit is left out where there is one)
      if (it.event.name === 'hit') { if (hit) continue; hit = true }
      const event: ClipEvent = { ...JSON.parse(JSON.stringify(it.event)) as Omit<ClipEvent, 'id' | 'u'>, id: newEventId({ events: [...(view.slot.events ?? []), ...made] }), u: clampU(view.toSource(f / frames)) }
      if (it.length !== undefined) {
        const to = clampU(view.toSource(Math.min(frames, f + it.length) / frames))
        if (to > event.u) event.to = to
      }
      made.push(event)
    }
    if (made.length === 0) return null
    const commands: Command[] = made.map(event => ({ type: 'slot.event.add', slot: view.slot.id, event }))
    return { commands, selection: made.map(select) } satisfies AreaEdit
  },
}
