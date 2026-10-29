<script lang="ts">
  // The Motion timeline, docked under the viewport while anything plays (the animator registers it). One track timeline
  // over the slot playing (docs/motion-plan.md §9 B): a ruler (frames of one cycle as it plays, 30 a second; zoom with
  // Ctrl+wheel, or the wheel over the ruler; Shift+drag on it for a loop region), then the tracks: Summary (every key),
  // Body (limb groups opening to bones, following the joint selected in the viewport), Gear (each piece's keys, and its
  // Held by and Shown strips), Hands (hand poses, pulls held, hands on handles: bars dragged by their middle or edges),
  // Events, and Time (speed, retime markers, holds, the hit). Keys are clicked, Shift/Ctrl-clicked or boxed, dragged
  // (snapped to frames; Alt: free), stretched by the selection's edges; every edit is one command, one undo (the
  // journal's). A library preview or a rig test shows the ruler and the transport only.
  import {
    ChevronDown, ChevronRight, CircleDot, Eye, EyeOff, Footprints, FlipHorizontal2, Maximize2, Move3d, Pause, PersonStanding, Play, Plus, Repeat, Rotate3d,
    SkipBack, SkipForward, StepBack, StepForward, Swords, Timer, Undo2,
  } from '@lucide/svelte'
  import { app } from '../../state/app.svelte.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { pose } from '../../state/pose.svelte.ts'
  import { slots } from '../../state/slots.svelte.ts'
  import { keyItem, timeline } from '../../state/timeline.svelte.ts'
  import { eventsOf, hitOf } from '../../model/select.ts'
  import { keysOf, momentsOf, snapPlayed, spanOf, stretchFactor, warpAt } from '../../model/keyedit.ts'
  import { windowsToSource } from '../../model/timemap.ts'
  import { newId } from '../../model/ids.ts'
  import type { Ease, Side, Window } from '../../model/types.ts'
  import type { Command } from '../../model/command-types.ts'
  import type { SelectedItem } from './lanes.ts'
  import { tooltip } from '../../ui/tooltip.ts'
  import { allowsShortcut } from '../../ui/shortcuts.ts'
  import EventsLane from './events/EventsLane.svelte'
  import GearLanes from './gear/GearLanes.svelte'
  import PoseToolbar from './pose/PoseToolbar.svelte'
  import { cycleAt, frameOf, framesOf, speedOptions } from './rules.ts'
  import { bodyGroups, boneLabel, dragWindow, groupOf, handsBars, rulerTicks, type HandsBar } from './tracks.ts'

  const LABEL = 172
  const HEIGHT_KEY = 'rigsmith.timeline.height'

  let lanesEl = $state<HTMLDivElement | null>(null)
  let tracksEl = $state<HTMLDivElement | null>(null)
  let height = $state(Number(globalThis.localStorage?.getItem(HEIGHT_KEY) ?? '') || 230)
  let wasRunning = false

  const now = $derived(animator.playing)
  const p = $derived(timeline.playing)
  const motion = $derived(app.step === 'motion')
  const busy = $derived(animator.loading || pose.busy !== null)
  const cycles = $derived(Math.max(1, now?.cycles ?? 1))
  const frames = $derived(p?.frames ?? framesOf(animator.duration, cycles))
  const at = $derived(Math.min(1, Math.max(0, now?.phase ?? 0)))
  const frame = $derived(frameOf(at, frames))
  const cycle = $derived(animator.duration > 0 ? cycleAt(animator.time / animator.duration, cycles) : 0)
  const kind = $derived(now?.kind === 'library' ? 'Preview' : now?.kind === 'test' ? 'Rig test' : now?.kind === 'clip' ? 'Shown' : null)
  const zoom = $derived(timeline.zoom)
  const width = $derived(timeline.width)
  const f = $derived(timeline.frame(p))

  let rulerWidth = $state(0)
  $effect(() => { if (rulerWidth > 0) timeline.width = Math.max(50, rulerWidth) })
  // (another slot: nothing of the last one's selected)
  let lastSlot: string | null = null
  $effect(() => {
    const id = p?.slot.id ?? null
    if (id !== lastSlot) { lastSlot = id; timeline.reset() }
  })

  const toX = (v: number): number => (v - zoom[0]) / Math.max(1e-6, zoom[1] - zoom[0]) * width
  const fromX = (x: number): number => zoom[0] + x / Math.max(1, width) * (zoom[1] - zoom[0])
  const view = $derived(timeline.view(toX, fromX))
  const pct = (v: number): string => `${toX(v)}px`

  // ---- rows ----------------------------------------------------------------------------------------------------

  type Row =
    | { kind: 'summary' | 'section', key: string, label: string, tracks: string[], open?: boolean, mute?: string, count?: number }
    | { kind: 'group', key: string, label: string, tracks: string[], open: boolean }
    | { kind: 'bone', key: string, label: string, bone: string, tracks: string[], mute: string }
    | { kind: 'gear', key: string, label: string, gear: string, tracks: string[], mute: string }
    | { kind: 'bar', key: string, bar: HandsBar }
    | { kind: 'events' | 'time', key: string, label: string }

  const bones = $derived([...(animator.view?.bones.keys() ?? [])])
  const groups = $derived(bodyGroups(bones))
  const rows = $derived.by((): Row[] => {
    if (p === null) return []
    const slot = p.slot
    const out: Row[] = []
    const boneTracks = Object.keys(slot.bones ?? {}).map(b => `body:${b}`)
    const gearTracks = Object.keys(slot.gear ?? {}).filter(g => (slot.gear?.[g].keys?.length ?? 0) > 0).map(g => `gear:${g}`)
    out.push({ kind: 'summary', key: 'summary', label: 'Summary', tracks: [...boneTracks, ...gearTracks] })
    const bodyOpen = timeline.open.includes('body')
    out.push({ kind: 'section', key: 'body', label: 'Body', tracks: boneTracks, open: bodyOpen, mute: 'bones', count: boneTracks.length })
    if (bodyOpen) {
      for (const g of groups) {
        const keyed = g.bones.filter(b => (slot.bones?.[b]?.length ?? 0) > 0)
        const open = timeline.open.includes(`group:${g.id}`)
        out.push({ kind: 'group', key: `group:${g.id}`, label: g.label, tracks: keyed.map(b => `body:${b}`), open })
        if (!open) continue
        const shown = g.bones.filter(b => keyed.includes(b) || b === pose.selected || timeline.open.includes(`all:${g.id}`))
        for (const b of shown) out.push({ kind: 'bone', key: `bone:${b}`, label: boneLabel(b), bone: b, tracks: [`body:${b}`], mute: `bone:${b}` })
      }
    }
    const pieces = pose.pieces.length > 0 ? pose.pieces : p.character.gear.filter(g => g.attach.kind === 'bone').map(g => ({ id: g.id, name: g.name }))
    if (pieces.length > 0) {
      const open = timeline.open.includes('gear') || !timeline.open.includes('gear-closed')
      out.push({ kind: 'section', key: 'gear', label: 'Gear', tracks: gearTracks, open, mute: 'gear' })
      if (open) for (const g of pieces) out.push({ kind: 'gear', key: `gear:${g.id}`, label: g.name, gear: g.id, tracks: [`gear:${g.id}`], mute: `gear:${g.id}` })
    }
    const bars = handsBars(p.character, slot, p.map)
    const handsOpen = !timeline.open.includes('hands-closed')
    out.push({ kind: 'section', key: 'hands', label: 'Hands and pulls', tracks: [], open: handsOpen, count: bars.length })
    if (handsOpen) for (const bar of bars) out.push({ kind: 'bar', key: bar.track, bar })
    out.push({ kind: 'events', key: 'events', label: 'Events' })
    out.push({ kind: 'time', key: 'time', label: 'Time' })
    return out
  })

  // (the joint selected in the viewport: its group opened, its row shown)
  $effect(() => {
    const b = pose.selected
    if (b === null) return
    const g = groupOf(groups, b)
    if (g === undefined) return
    timeline.toggleOpen('body', true)
    timeline.toggleOpen(`group:${g.id}`, true)
    queueMicrotask(() => { tracksEl?.querySelector(`[data-row="bone:${CSS.escape(b)}"]`)?.scrollIntoView({ block: 'nearest' }) })
  })

  const sectionOpen = (key: string): void => {
    if (key === 'gear') timeline.open = timeline.open.includes('gear-closed') ? timeline.open.filter(r => r !== 'gear-closed') : [...timeline.open, 'gear-closed']
    else if (key === 'hands') timeline.open = timeline.open.includes('hands-closed') ? timeline.open.filter(r => r !== 'hands-closed') : [...timeline.open, 'hands-closed']
    else timeline.toggleOpen(key)
  }

  const muted = (name: string): boolean => p?.slot.muted?.includes(name) === true
  function toggleMute (name: string): void {
    if (p === null) return
    const m = p.slot.muted ?? []
    const next = m.includes(name) ? m.filter(x => x !== name) : [...m, name]
    void timeline.send(p.character, [{ type: 'slot.update', id: p.slot.id, patch: { muted: next.length > 0 ? next : null } }], `${m.includes(name) ? 'unmute' : 'mute'} ${name}`)
  }

  // ---- drags ---------------------------------------------------------------------------------------------------

  type Drag =
    | { kind: 'keys', x0: number, anchor: number, moved: boolean, dv: number, free: boolean, clicked: number }
    | { kind: 'stretch', edge: 'start' | 'end', x0: number, to: number, free: boolean, span: [number, number] }
    | { kind: 'box', x0: number, y0: number, x1: number, y1: number, add: boolean, moved: boolean }
    | { kind: 'scrub' }
    | { kind: 'region', from: number, to: number }
    | { kind: 'bar', bar: HandsBar, index: number, edge: 'start' | 'end' | 'body', x0: number, dv: number, free: boolean }
    | { kind: 'marker', id: string, x0: number, v0: number, dv: number, free: boolean }
    | { kind: 'hold', id: string, edge: 'body' | 'end', x0: number, v0: number, dv: number, free: boolean }
    | { kind: 'hit', x0: number, v0: number, dv: number, free: boolean }

  let drag = $state.raw<Drag | null>(null)

  /** The lanes measured again as a gesture starts (their width also follows the ruler's, as it resizes). */
  const measure = (): void => { const w = lanesEl?.clientWidth ?? 0; if (w > 0 && w !== timeline.width) timeline.width = w }
  const lanesX = (e: PointerEvent): number => { const r = lanesEl?.getBoundingClientRect(); return r === undefined ? 0 : e.clientX - r.left }
  const toDv = (dx: number): number => dx / Math.max(1, width) * (zoom[1] - zoom[0])

  /** Where a key shows now (played): a drag or a stretch of the selection in progress moves the selected ones. */
  function shownAt (track: string, u: number): number {
    const v = f.toPlayed(u)
    const d = drag
    if (d === null || !timeline.isSelected(track, String(u))) return v
    if (d.kind === 'keys' && d.moved) return v + keysDelta(d)
    if (d.kind === 'stretch') {
      const factor = stretchFactor(d.span, d.edge, d.to, frames)
      if (factor === null) return v
      const fixed = d.edge === 'end' ? d.span[0] : d.span[1]
      return snapPlayed(fixed + (v - fixed) * factor, frames, d.free)
    }
    return v
  }

  function keysDelta (d: Extract<Drag, { kind: 'keys' }>): number {
    const span = p === null ? null : spanOf(p.slot, timeline.keys, f)
    if (span === null) return 0
    const x = snapPlayed(d.anchor + d.dv, frames, d.free) - d.anchor
    return Math.min(Math.max(1, span[1]) - span[1], Math.max(Math.min(0, span[0]) - span[0], x))
  }

  function downKey (e: PointerEvent, keys: Array<{ track: string, u: number }>, v: number): void {
    measure()
    if (e.button !== 0 || busy) return
    e.stopPropagation(); e.preventDefault()
    const items = keys.map(keyItem)
    const all = items.every(i => timeline.isSelected(i.track, i.id))
    if (e.ctrlKey || e.metaKey) timeline.select(items, 'toggle')
    else if (e.shiftKey) timeline.select(items, 'add')
    else if (!all) timeline.select(items, 'set')
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag = { kind: 'keys', x0: e.clientX, anchor: v, moved: false, dv: 0, free: e.altKey, clicked: v }
  }

  function downStretch (e: PointerEvent, edge: 'start' | 'end', span: [number, number]): void {
    measure()
    if (e.button !== 0 || busy) return
    e.stopPropagation(); e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag = { kind: 'stretch', edge, x0: e.clientX, to: edge === 'end' ? span[1] : span[0], free: e.altKey, span }
  }

  function downLane (e: PointerEvent): void {
    measure()
    if (e.button !== 0 || busy || p === null) return
    const r = tracksEl?.getBoundingClientRect()
    if (r === undefined) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag = { kind: 'box', x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, add: e.shiftKey || e.ctrlKey || e.metaKey, moved: false }
  }

  function downRuler (e: PointerEvent): void {
    measure()
    if (e.button !== 0 || busy) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const v = fromX(lanesX(e))
    if (e.shiftKey) { drag = { kind: 'region', from: v, to: v }; return }
    wasRunning = animator.running
    drag = { kind: 'scrub' }
    timeline.seek(v, e.altKey)
  }

  function downBar (e: PointerEvent, bar: HandsBar, index: number, edge: 'start' | 'end' | 'body'): void {
    measure()
    if (e.button !== 0 || busy) return
    e.stopPropagation(); e.preventDefault()
    timeline.select([{ track: bar.track, id: String(index), u: f.toSource(bar.windows[index]?.[0] ?? 0) }], e.shiftKey ? 'add' : 'set')
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag = { kind: 'bar', bar, index, edge, x0: e.clientX, dv: 0, free: e.altKey }
  }

  function move (e: PointerEvent): void {
    const d = drag
    if (d === null) return
    const dv = toDv(e.clientX - ('x0' in d ? d.x0 : e.clientX))
    switch (d.kind) {
      case 'keys': drag = { ...d, dv, moved: d.moved || Math.abs(e.clientX - d.x0) > 3, free: e.altKey }; break
      case 'stretch': drag = { ...d, to: (d.edge === 'end' ? d.span[1] : d.span[0]) + dv, free: e.altKey }; break
      case 'box': drag = { ...d, x1: e.clientX, y1: e.clientY, moved: d.moved || Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 4 }; break
      case 'scrub': timeline.seek(fromX(lanesX(e)), e.altKey); break
      case 'region': drag = { ...d, to: fromX(lanesX(e)) }; break
      case 'bar': case 'marker': case 'hold': case 'hit': drag = { ...d, dv, free: e.altKey }; break
    }
  }

  function up (e: PointerEvent): void {
    const d = drag
    drag = null
    if (d === null || p === null && d.kind !== 'scrub' && d.kind !== 'region') return
    switch (d.kind) {
      case 'keys':
        if (d.moved) timeline.move(d.dv, { free: d.free, anchor: d.anchor })
        else { if (!(e.shiftKey || e.ctrlKey || e.metaKey)) timeline.select(timeline.selection.filter(s => Math.abs(f.toPlayed(s.u) - d.clicked) < 0.5 / frames)); timeline.seek(d.clicked) }
        break
      case 'stretch': if (Math.abs(d.to - (d.edge === 'end' ? d.span[1] : d.span[0])) > 1e-9) timeline.stretch(d.edge, d.to, { free: d.free }); break
      case 'box': finishBox(d); break
      case 'scrub': if (wasRunning) animator.setPlaying(true); break
      case 'region': {
        const [a, b] = d.from < d.to ? [d.from, d.to] : [d.to, d.from]
        animator.region = b - a < 1 / frames ? null : [Math.max(0, snapPlayed(a, frames)), Math.min(1, snapPlayed(b, frames))]
        break
      }
      case 'bar': finishBar(d); break
      case 'marker': finishMarker(d); break
      case 'hold': finishHold(d); break
      case 'hit': finishHit(d); break
    }
  }

  /** A box let go: the keys (and events) inside it selected; a click on an empty lane moves the playhead there. */
  function finishBox (d: Extract<Drag, { kind: 'box' }>): void {
    if (p === null || lanesEl === null || tracksEl === null) return
    const lr = lanesEl.getBoundingClientRect()
    if (!d.moved) { if (!d.add) timeline.clear(); timeline.seek(fromX(d.x0 - lr.left)); return }
    const [x0, x1] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)]
    const [y0, y1] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)]
    const from = fromX(x0 - lr.left); const to = fromX(x1 - lr.left)
    const items: SelectedItem[] = []
    for (const el of tracksEl.querySelectorAll<HTMLElement>('[data-tracks]')) {
      const r = el.getBoundingClientRect()
      if (r.bottom < y0 || r.top > y1) continue
      const tracks = (el.dataset.tracks ?? '').split('|').filter(t => t !== '')
      for (const t of tracks) {
        if (t === 'events') { for (const ev of eventsOf(p.slot)) { const v = f.toPlayed(ev.u); if (v >= from && v <= to) items.push({ track: 'events', id: ev.id, u: ev.u }) } continue }
        for (const k of keysOf(p.slot, t)) { const v = f.toPlayed(k.u); if (v >= from - 1e-9 && v <= to + 1e-9) items.push(keyItem({ track: t, u: k.u })) }
      }
    }
    const unique = items.filter((x, i) => items.findIndex(y => y.track === x.track && y.id === x.id) === i)
    timeline.select(unique, d.add ? 'add' : 'set')
  }

  /** A hand bar dragged: its window moved (or an edge), written where it is stored (source time). */
  function finishBar (d: Extract<Drag, { kind: 'bar' }>): void {
    if (p === null || Math.abs(d.dv) < 1e-9) return
    const bar = d.bar
    const wins: Window[] = bar.whole ? [[0, 1]] : bar.windows.map(w => [w[0], w[1]])
    const i = bar.whole ? 0 : d.index
    if (wins[i] === undefined) return
    wins[i] = dragWindow(wins[i], d.edge, d.dv, frames, d.free)
    const source = windowsToSource(p.map, wins)
    const commands: Command[] = []
    if (bar.kind === 'ik') {
      const hand = bar.track.slice(9) as Side
      const hands = (p.slot.ik?.hands ?? []).map(h => (h.hand === hand ? { ...h, windows: source } : h))
      commands.push({ type: 'slot.ik', slot: p.slot.id, patch: { hands } })
    } else {
      commands.push({ type: 'slot.adjust.update', slot: p.slot.id, id: bar.track.slice(6), patch: { windows: source } })
    }
    void timeline.send(p.character, commands, bar.label)
  }

  const barWindow = (bar: HandsBar, i: number): Window => {
    const w = bar.whole ? [0, 1] as Window : bar.windows[i]
    const d = drag
    if (d?.kind !== 'bar' || d.bar.track !== bar.track || (d.index !== i && !bar.whole)) return w
    return dragWindow(w, d.edge, d.dv, frames, d.free)
  }

  // ---- the Time track ----------------------------------------------------------------------------------------------

  const source = $derived(p?.baked?.raw.duration ?? 1)
  /** Played phase per unit of the warp (a marker's `to`): the clip's seconds per its kept span. */
  const perWarp = $derived(p === null ? 1 : source / Math.max(1e-9, p.slot.speed) / Math.max(1e-9, p.map.kept[1] - p.map.kept[0]))
  const markers = $derived((p?.slot.time?.markers ?? []).map(m => ({ ...m, v: f.toPlayed(m.u) })))
  const holds = $derived((p?.slot.time?.holds ?? []).map(h => ({ ...h, v: f.toPlayed(h.u), w: h.seconds / Math.max(1e-9, p?.slot.speed ?? 1) / Math.max(1e-9, (p?.map.kept[1] ?? 1) - (p?.map.kept[0] ?? 0)) })))
  const hit = $derived.by(() => {
    if (p === null) return null
    const e = hitOf(p.slot)
    if (e !== undefined) return { id: e.id, v: f.toPlayed(e.u), measured: false }
    const b = p.baked?.events.find(x => x.name === 'hit')
    return b === undefined ? null : { id: 'hit', v: b.t, measured: true }
  })
  const dragged = (kind: 'marker' | 'hold' | 'hit', id: string, v: number): number => {
    const d = drag
    if (d === null || d.kind !== kind || ('id' in d && d.id !== id)) return v
    return snapPlayed(v + d.dv, frames, d.free)
  }

  function downTime (e: PointerEvent, kind: 'marker' | 'hold' | 'hit', id: string, v: number, edge: 'body' | 'end' = 'body'): void {
    measure()
    if (e.button !== 0 || busy) return
    e.stopPropagation(); e.preventDefault()
    timeline.select([{ track: kind === 'hit' ? (hit?.measured === true ? 'time' : 'events') : 'time', id, u: f.toSource(v) }], e.shiftKey ? 'add' : 'set')
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    if (kind === 'marker') drag = { kind, id, x0: e.clientX, v0: v, dv: 0, free: e.altKey }
    else if (kind === 'hold') drag = { kind, id, edge, x0: e.clientX, v0: v, dv: 0, free: e.altKey }
    else drag = { kind, x0: e.clientX, v0: v, dv: 0, free: e.altKey }
  }

  function finishMarker (d: Extract<Drag, { kind: 'marker' }>): void {
    if (p === null || Math.abs(d.dv) < 1e-9) return
    const v = snapPlayed(d.v0 + d.dv, frames, d.free)
    const ms = (p.slot.time?.markers ?? []).map(m => (m.id !== d.id ? m : { ...m, to: Math.round((m.to + (v - d.v0) / perWarp) * 1e6) / 1e6 }))
    void timeline.send(p.character, [{ type: 'slot.time', slot: p.slot.id, patch: { markers: ms } }], 'retime marker')
  }

  function finishHold (d: Extract<Drag, { kind: 'hold' }>): void {
    if (p === null || Math.abs(d.dv) < 1e-9) return
    const hs = (p.slot.time?.holds ?? []).map(h => {
      if (h.id !== d.id) return h
      if (d.edge === 'end') {
        const w = Math.max(1 / frames, holds.find(x => x.id === h.id)!.w + d.dv)
        return { ...h, seconds: Math.round(w * (p.map.kept[1] - p.map.kept[0]) * p.slot.speed * 1000) / 1000 }
      }
      return { ...h, u: Math.round(Math.min(1, Math.max(0, f.toSource(snapPlayed(d.v0 + d.dv, frames, d.free)))) * 1e6) / 1e6 }
    })
    void timeline.send(p.character, [{ type: 'slot.time', slot: p.slot.id, patch: { holds: hs } }], 'hold')
  }

  function finishHit (d: Extract<Drag, { kind: 'hit' }>): void {
    if (p === null || hit === null || Math.abs(d.dv) < 1e-9) return
    const u = Math.round(f.toSource(Math.min(1, Math.max(0, snapPlayed(d.v0 + d.dv, frames, d.free)))) * 1e6) / 1e6
    const command: Command = hit.measured ? { type: 'slot.event.add', slot: p.slot.id, event: { id: newId(), name: 'hit', u } } : { type: 'slot.event.update', slot: p.slot.id, id: hit.id, patch: { u } }
    void timeline.send(p.character, [command], 'the hit')
  }

  function addMarker (): void {
    if (p === null) return
    const u = Math.round(f.toSource(at) * 1e6) / 1e6
    if (u <= 1e-4 || u >= 1 - 1e-4) { app.toast('info', 'A retime marker goes inside the clip: move the playhead off its ends'); return }
    const ms = [...(p.slot.time?.markers ?? []).filter(m => Math.abs(m.u - u) > 1e-6), { id: newId(), u, to: Math.round(warpAt(p.slot.time?.markers, u) * 1e6) / 1e6 }].sort((a, b) => a.u - b.u)
    void timeline.send(p.character, [{ type: 'slot.time', slot: p.slot.id, patch: { markers: ms } }], 'retime marker')
  }

  function addHold (): void {
    if (p === null) return
    const u = Math.round(Math.min(1, Math.max(0, f.toSource(at))) * 1e6) / 1e6
    if ((p.slot.time?.holds ?? []).some(h => Math.abs(h.u - u) < 1e-6)) return
    const hs = [...(p.slot.time?.holds ?? []), { id: newId(), u, seconds: 0.25 }].sort((a, b) => a.u - b.u)
    void timeline.send(p.character, [{ type: 'slot.time', slot: p.slot.id, patch: { holds: hs } }], 'hold')
  }

  // ---- transport and keys ------------------------------------------------------------------------------------------

  function togglePlay (): void {
    if (animator.running) { animator.setPlaying(false); timeline.seek(at) } else animator.setPlaying(true)
  }

  /** The playhead to the next (or previous) key: of the selection's tracks, else of every track. */
  function jumpKey (dir: number): void {
    if (p === null) return
    const tracks = timeline.keys.length > 0 ? [...new Set(timeline.keys.map(k => k.track))] : rows.find(r => r.kind === 'summary')?.kind === 'summary' ? (rows[0] as { tracks: string[] }).tracks : []
    const vs = momentsOf(p.slot, tracks, f).map(m => m.v).filter(v => v >= -1e-9 && v <= 1 + 1e-9)
    const next = dir > 0 ? vs.find(v => frameOf(v, frames) > frame) : vs.findLast(v => frameOf(v, frames) < frame)
    if (next !== undefined) timeline.seek(next)
  }

  function onKey (e: KeyboardEvent): void {
    if (now === null || busy || !allowsShortcut(e)) return
    const step = e.shiftKey ? 10 : 1
    if (e.key === ' ') togglePlay()
    else if (e.key === ',' || e.key === 'ArrowLeft') timeline.seekFrame(frame - step)
    else if (e.key === '.' || e.key === 'ArrowRight') timeline.seekFrame(frame + step)
    else if (e.key === 'ArrowUp') jumpKey(-1)
    else if (e.key === 'ArrowDown') jumpKey(1)
    else if (e.key === 'Home') timeline.seek(0)
    else if (e.key === 'End') timeline.seek(1)
    else return
    e.preventDefault()
  }

  function onWheel (e: WheelEvent, ruler = false): void {
    if (lanesEl === null) return
    const zoomIt = e.ctrlKey || e.metaKey || ruler
    if (!zoomIt && !e.shiftKey) return
    e.preventDefault()
    const r = lanesEl.getBoundingClientRect()
    if (zoomIt && !e.shiftKey) timeline.zoomBy(Math.exp(e.deltaY * 0.0015), fromX(e.clientX - r.left))
    else timeline.pan(toDv(e.deltaY + e.deltaX))
  }

  function startResize (e: PointerEvent): void {
    const y0 = e.clientY; const h0 = height
    const moveIt = (ev: PointerEvent): void => { height = Math.min(Math.round(window.innerHeight * 0.7), Math.max(90, h0 - (ev.clientY - y0))) }
    const done = (): void => {
      window.removeEventListener('pointermove', moveIt); window.removeEventListener('pointerup', done)
      globalThis.localStorage?.setItem(HEIGHT_KEY, String(height))
    }
    window.addEventListener('pointermove', moveIt); window.addEventListener('pointerup', done)
  }

  const ticks = $derived(rulerTicks(frames, zoom[0], zoom[1], width))
  const selSpan = $derived(p === null ? null : spanOf(p.slot, timeline.keys, f))
  const shownSpan = $derived.by((): [number, number] | null => {
    const s = selSpan
    const d = drag
    if (s === null) return null
    if (d?.kind === 'keys' && d.moved) { const x = keysDelta(d); return [s[0] + x, s[1] + x] }
    if (d?.kind === 'stretch') {
      const factor = stretchFactor(d.span, d.edge, d.to, frames)
      if (factor === null) return s
      const fixed = d.edge === 'end' ? s[0] : s[1]
      return d.edge === 'end' ? [s[0], fixed + (s[1] - fixed) * factor] : [fixed + (s[0] - fixed) * factor, s[1]]
    }
    return s
  })
  const region = $derived(drag?.kind === 'region' ? [Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)] as [number, number] : animator.region)
  const boxRect = $derived.by(() => {
    const d = drag
    if (d?.kind !== 'box' || !d.moved || tracksEl === null) return null
    const r = tracksEl.getBoundingClientRect()
    return { left: Math.min(d.x0, d.x1) - r.left, top: Math.min(d.y0, d.y1) - r.top + tracksEl.scrollTop, width: Math.abs(d.x1 - d.x0), height: Math.abs(d.y1 - d.y0) }
  })

  const EASE_TEXT: Record<Ease, string> = { smooth: 'smooth', linear: 'linear', ease: 'eases in and out', step: 'stepped', hold: 'held (the clip stopped)' }
  const frameText = (v: number): string => `frame ${frameOf(v, frames)}`
  const isPin = (k: { p?: unknown, q: number[] }): boolean => k.p === undefined && Math.abs(k.q[3]) > 1 - 1e-9
</script>

<svelte:window onkeydown={onKey} />

{#snippet keyLane(tracks: string[], single: boolean, faint = false)}
  {#if p !== null}
    {#if single && tracks.length === 1}
      {@const ks = keysOf(p.slot, tracks[0])}
      {#each ks as k, i (k.u)}
        {#if i < ks.length - 1}
          {@const a = shownAt(tracks[0], k.u)}
          {@const b = shownAt(tracks[0], ks[i + 1].u)}
          <div class="span ease-{k.ease ?? 'smooth'}" style:left={pct(Math.min(a, b))} style:width={`${Math.abs(toX(b) - toX(a))}px`} title={`${EASE_TEXT[k.ease ?? 'smooth']} to the next key`}></div>
        {/if}
      {/each}
    {/if}
    {#each momentsOf(p.slot, tracks, f) as m (m.keys.map(k => `${k.track}@${k.u}`).join(','))}
      {@const sel = m.keys.filter(k => timeline.isSelected(k.track, String(k.u))).length}
      {@const v = shownAt(m.keys[0].track, m.keys[0].u)}
      {@const pin = single && m.keys.length === 1 && isPin(keysOf(p.slot, m.keys[0].track).find(x => x.u === m.keys[0].u) ?? { q: [0, 0, 0, 0] })}
      <button class="key" class:on={sel === m.keys.length} class:part={sel > 0 && sel < m.keys.length} class:faint class:pin
        style:left={pct(v)} aria-label={`${m.keys.length} ${m.keys.length === 1 ? 'key' : 'keys'} at ${frameText(v)}`}
        use:tooltip={`${frameText(v)} · ${m.keys.length === 1 ? (pin ? 'a pin (as the clip)' : '1 key') : `${m.keys.length} keys`}${single ? ` · ${EASE_TEXT[m.eases[0]]}` : ''}`}
        onpointerdown={(e) => downKey(e, m.keys, v)} onpointermove={move} onpointerup={up} onpointercancel={() => { drag = null }}></button>
    {/each}
  {/if}
{/snippet}

{#if now !== null}
  <div class="timeline" aria-label="Timeline">
    {#if p !== null}<div class="grab" role="separator" aria-orientation="horizontal" aria-label="Resize the timeline" onpointerdown={startResize}></div>{/if}
    <div class="heading">
      <span class="name" title={now.label}>{now.label}</span>
      {#if kind !== null}<span class="kind">{kind}</span>{/if}
      {#if animator.inIdle}<span class="kind idle">then Idle</span>{/if}
      {#if p?.baked === null || animator.loading}<span class="faint small">baking…</span>{/if}
      <span class="spacer"></span>
      {#if cycles > 1}<span class="faint small" use:tooltip={'A ridden loop: his clip plays this many times to one of the horse\'s'}>cycle {cycle + 1} of {cycles}</span>{/if}
      <label class="readout mono" use:tooltip={'The frame shown (type one to go there)'}>
        <input aria-label="Frame" type="number" min="0" max={frames} step="1" value={frame} disabled={busy} onchange={(e) => timeline.seekFrame(e.currentTarget.valueAsNumber)} />
        <span class="faint">/ {frames}</span>
      </label>
      <span class="faint small mono">{(at * (p?.duration ?? animator.duration)).toFixed(2)} s</span>
    </div>

    <div class="controls">
      <div class="group" role="group" aria-label="Transport">
        <button disabled={busy} onclick={() => timeline.seek(0)} aria-label="First frame" use:tooltip={'First frame (Home)'}><SkipBack size={14} /></button>
        <button disabled={busy || p === null} onclick={() => jumpKey(-1)} aria-label="Previous key" use:tooltip={'Previous key (↑)'}><ChevronRight size={14} style="transform: scaleX(-1)" /></button>
        <button disabled={busy || frame === 0} onclick={() => timeline.seekFrame(frame - 1)} aria-label="Previous frame" use:tooltip={'Previous frame (, or ←; Shift: 10)'}><StepBack size={14} /></button>
        <button class="play" disabled={busy} onclick={togglePlay} aria-label={animator.running ? 'Pause' : 'Play'} use:tooltip={animator.running ? 'Pause (Space)' : 'Play (Space)'}>
          {#if animator.running}<Pause size={15} />{:else}<Play size={15} />{/if}
        </button>
        <button disabled={busy || frame === frames} onclick={() => timeline.seekFrame(frame + 1)} aria-label="Next frame" use:tooltip={'Next frame (. or →; Shift: 10)'}><StepForward size={14} /></button>
        <button disabled={busy || p === null} onclick={() => jumpKey(1)} aria-label="Next key" use:tooltip={'Next key (↓)'}><ChevronRight size={14} /></button>
        <button disabled={busy} onclick={() => timeline.seek(1)} aria-label="Last frame" use:tooltip={'Last frame (End)'}><SkipForward size={14} /></button>
      </div>
      {#if p !== null && motion}
        <div class="group" role="group" aria-label="Posing">
          <button class:on={pose.shown} aria-pressed={pose.shown} onclick={() => pose.setShown(!pose.shown)} aria-label="Joints" use:tooltip={pose.shown ? 'Hide the joints (posing off)' : 'Show the joints to pose them'}><CircleDot size={14} /></button>
          <button class:on={pose.gizmo === 'move'} aria-pressed={pose.gizmo === 'move'} onclick={() => pose.setGizmo('move')} aria-label="Move" use:tooltip={'The gizmo moves the joint (G)'}><Move3d size={14} /></button>
          <button class:on={pose.gizmo === 'rotate'} aria-pressed={pose.gizmo === 'rotate'} onclick={() => pose.setGizmo('rotate')} aria-label="Rotate" use:tooltip={'The gizmo turns its bone (R)'}><Rotate3d size={14} /></button>
          {#if pose.gizmo === 'rotate'}
            <button class="text" onclick={() => pose.setSpace(pose.space === 'local' ? 'world' : 'local')} use:tooltip={'The axes it turns about'}>{pose.space === 'local' ? 'Local' : 'World'}</button>
          {/if}
          <button disabled={busy || !pose.natural} onclick={() => { void pose.solveBody() }} aria-label="Solve body" use:tooltip={pose.natural ? 'Solve the body on this frame: arms pushed out of the body, the body fitted to the hands on gear; keys what moved (B)' : 'Needs a person (the pose model)'}><PersonStanding size={14} /></button>
          <button disabled={busy} onclick={() => { void timeline.undo(p.character) }} aria-label="Undo" use:tooltip={'Undo (Ctrl+Z; Ctrl+Shift+Z redoes)'}><Undo2 size={14} /></button>
        </div>
      {/if}
      <span class="spacer"></span>
      <div class="group" role="group" aria-label="View">
        {#if p !== null}
          <button class:on={region !== null} aria-pressed={region !== null} onclick={() => { if (animator.region !== null) timeline.clearRegion(); else timeline.regionAt('start') }}
            aria-label="Loop region" use:tooltip={region !== null ? 'Clear the loop region (\\)' : 'A loop region from the playhead ([ and ] set its ends; Shift+drag the ruler)'}><Repeat size={13} /><span class="mini">R</span></button>
          <button onclick={() => timeline.fit()} disabled={zoom[0] === 0 && zoom[1] === 1} aria-label="Fit" use:tooltip={'Fit the whole clip (F; Shift+F: the selection). Ctrl+wheel zooms'}><Maximize2 size={13} /></button>
          {#if p.slot.loop === false}
            <button class:on={animator.intoIdle} aria-pressed={animator.intoIdle} onclick={() => animator.setIntoIdle(!animator.intoIdle)} aria-label="Preview into Idle"
              use:tooltip={'Preview into Idle: the clip, then the character\'s Idle blended in over 0.2 s, as the game does'}><Timer size={13} /><span class="mini">Idle</span></button>
          {/if}
        {/if}
      </div>
      <div class="group preview" role="group" aria-label="Preview only">
        <button class:on={animator.loop} disabled={busy} aria-label="Loop the preview" aria-pressed={animator.loop} onclick={() => animator.setLoop(!animator.loop)}
          use:tooltip={now.kind === 'slot' ? 'Loop the preview (the clip\'s own loop is its saved setting)' : 'Loop the preview'}><Repeat size={14} /></button>
        {#if now.kind === 'library'}
          <button class:on={now.inPlace} disabled={busy} aria-pressed={now.inPlace} aria-label="Preview in place" onclick={() => animator.setInPlace(!now.inPlace)}
            use:tooltip={'Preview in place (root motion removed); a clip filled from it keeps this'}><Footprints size={14} /></button>
        {/if}
        <button class:on={animator.mirror} disabled={busy} aria-pressed={animator.mirror} aria-label="Mirror the preview" onclick={() => animator.setMirror(!animator.mirror)}
          use:tooltip={'Mirror left and right (preview only)'}><FlipHorizontal2 size={14} /></button>
        <select class="mono" value={String(animator.speed)} disabled={busy} onchange={(e) => animator.setSpeed(Number(e.currentTarget.value))} aria-label="Preview speed"
          use:tooltip={'Preview speed (the clip\'s own speed is in the Time track)'}>
          {#each speedOptions(animator.speed) as s (s)}<option value={String(s)}>{s}×</option>{/each}
        </select>
      </div>
    </div>
    {#if p !== null && motion && view !== null}
      <div class="tools"><PoseToolbar {view} /></div>
    {/if}

    <!-- the ruler -->
    <div class="ruler-row" style:--label={`${LABEL}px`}>
      <div class="corner">
        {#if p !== null && selSpan !== null}<span class="faint small">{timeline.keys.length} selected</span>{/if}
      </div>
      <div class="ruler" bind:this={lanesEl} bind:clientWidth={rulerWidth} role="slider" tabindex="-1" aria-label="Frame" aria-valuemin="0" aria-valuemax={frames} aria-valuenow={frame}
        onpointerdown={downRuler} onpointermove={move} onpointerup={up} onpointercancel={() => { drag = null }} onwheel={(e) => onWheel(e, true)}>
        {#each ticks.ticks as t (t)}
          <div class="tick" class:major={t % ticks.label === 0} style:left={pct(t / frames)}>{#if t % ticks.label === 0}<span>{t}</span>{/if}</div>
        {/each}
        {#if region !== null}<div class="region" style:left={pct(region[0])} style:width={`${toX(region[1]) - toX(region[0])}px`}></div>{/if}
        {#if hit !== null}<div class="hit-tick" style:left={pct(hit.v)}></div>{/if}
        {#if shownSpan !== null && shownSpan[1] - shownSpan[0] > 1e-9}
          <div class="selspan" style:left={pct(shownSpan[0])} style:width={`${toX(shownSpan[1]) - toX(shownSpan[0])}px`}>
            <button class="edge start" aria-label="Stretch the selection from its start" use:tooltip={timeline.retimeClip ? 'Drag: retime the clip under the selection' : 'Drag: stretch the selected keys (Alt: free)'}
              onpointerdown={(e) => downStretch(e, 'start', selSpan!)} onpointermove={move} onpointerup={up}></button>
            <button class="edge end" aria-label="Stretch the selection from its end" use:tooltip={timeline.retimeClip ? 'Drag: retime the clip under the selection' : 'Drag: stretch the selected keys (Alt: free)'}
              onpointerdown={(e) => downStretch(e, 'end', selSpan!)} onpointermove={move} onpointerup={up}></button>
          </div>
        {/if}
        <div class="head" style:left={pct(at)}></div>
      </div>
    </div>

    {#if p !== null}
      <div class="tracks" bind:this={tracksEl} style:max-height={`${height}px`} style:--label={`${LABEL}px`} onwheel={(e) => onWheel(e)}>
        {#each rows as row (row.key)}
          <div class="row k-{row.kind}" data-row={row.key} class:selected={row.kind === 'bone' && row.bone === pose.selected} class:hovered={row.kind === 'bone' && row.bone === pose.hovered}
            data-tracks={'tracks' in row ? row.tracks.join('|') : row.kind === 'events' ? 'events' : ''}>
            <div class="label" class:indent1={row.kind === 'group' || row.kind === 'gear' || row.kind === 'bar'} class:indent2={row.kind === 'bone'}>
              {#if row.kind === 'section' || row.kind === 'group'}
                <button class="toggle" onclick={() => (row.kind === 'section' ? sectionOpen(row.key) : timeline.toggleOpen(row.key))} aria-expanded={row.open} aria-label={`${row.open ? 'Close' : 'Open'} ${row.label}`}>
                  {#if row.open}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}
                  <span class="text">{row.label}</span>
                </button>
                {#if row.kind === 'group' && row.open}
                  {@const gid = row.key.slice(6)}
                  <button class="tiny" class:on={timeline.open.includes(`all:${gid}`)} onclick={() => timeline.toggleOpen(`all:${gid}`)} use:tooltip={'Show every bone of the group (else the keyed ones and the joint selected)'}>all</button>
                {/if}
                {#if row.kind === 'section' && row.mute !== undefined}
                  <button class="tiny icon" onclick={() => toggleMute(row.mute!)} aria-label={muted(row.mute) ? `Play ${row.label}` : `Switch ${row.label} off`} use:tooltip={muted(row.mute) ? 'Switched off (kept, not played): play it' : 'Switch the track off (kept, not played)'}>
                    {#if muted(row.mute)}<EyeOff size={11} />{:else}<Eye size={11} />{/if}
                  </button>
                {/if}
              {:else if row.kind === 'bone'}
                <button class="text name" onclick={() => pose.select(row.bone)} use:tooltip={`${row.bone}: click to select the joint`}>{row.label}</button>
                <button class="tiny icon" onclick={() => { void pose.keyHere([row.bone]) }} aria-label={`Key ${row.label} here`} use:tooltip={'Key it as it is on this frame (K)'}><Plus size={11} /></button>
                <button class="tiny icon" onclick={() => toggleMute(row.mute)} aria-label={muted(row.mute) ? `Play ${row.label}'s keys` : `Switch ${row.label}'s keys off`}>
                  {#if muted(row.mute)}<EyeOff size={11} />{:else}<Eye size={11} />{/if}
                </button>
              {:else if row.kind === 'gear'}
                <button class="text name" onclick={() => pose.selectGear(row.gear)} use:tooltip={'Click to select the piece'}>{row.label}{pose.leading(p.slot, row.gear) ? ' · leads' : ''}</button>
                <button class="tiny icon" onclick={() => toggleMute(row.mute)} aria-label={muted(row.mute) ? `Play ${row.label}'s keys` : `Switch ${row.label}'s keys off`}>
                  {#if muted(row.mute)}<EyeOff size={11} />{:else}<Eye size={11} />{/if}
                </button>
              {:else if row.kind === 'bar'}
                <span class="text name" title={row.bar.title}>{row.bar.label}</span>
              {:else if row.kind === 'events'}
                <span class="text">Events</span>
                <button class="tiny icon" onclick={() => toggleMute('events')} aria-label={muted('events') ? 'Play the events' : 'Switch the events off'}>
                  {#if muted('events')}<EyeOff size={11} />{:else}<Eye size={11} />{/if}
                </button>
              {:else if row.kind === 'time'}
                <span class="text">Time</span>
                <select class="mono speed" value={String(p.slot.speed)} aria-label="Speed of {p.slot.name}" use:tooltip={'The clip\'s speed (saved: what the game plays)'}
                  onchange={(e) => { void slots.update(p.character, p.slot.id, { speed: Number(e.currentTarget.value) }) }}>
                  {#each speedOptions(p.slot.speed) as v (v)}<option value={String(v)}>{v}×</option>{/each}
                </select>
                <button class="tiny icon" onclick={addMarker} aria-label="Add a retime marker" use:tooltip={'A retime marker at the playhead: drag it to speed up or slow down the clip round it'}><Plus size={11} /></button>
                <button class="tiny" onclick={addHold} use:tooltip={'Hold the pose at the playhead (a quarter second; drag its end)'}>hold</button>
              {:else}
                <span class="text">{row.label}</span>
              {/if}
            </div>
            <div class="lane" class:free={row.kind === 'events'} role="presentation" onpointerdown={downLane} onpointermove={move} onpointerup={up} onpointercancel={() => { drag = null }}>
              {#if region !== null}<div class="region-band" style:left={pct(region[0])} style:width={`${toX(region[1]) - toX(region[0])}px`}></div>{/if}
              {#if row.kind === 'summary' || row.kind === 'section' || row.kind === 'group'}
                {@render keyLane(row.tracks, false, row.kind === 'section' && row.mute !== undefined && muted(row.mute))}
              {:else if row.kind === 'bone' || row.kind === 'gear'}
                {@render keyLane(row.tracks, true, muted(row.mute))}
              {:else if row.kind === 'bar'}
                {#each row.bar.whole ? [0] : row.bar.windows.map((_, i) => i) as i (i)}
                  {@const w = barWindow(row.bar, i)}
                  <div class="bar {row.bar.kind}" class:on={timeline.isSelected(row.bar.track, String(i))} style:left={pct(w[0])} style:width={`${Math.max(3, toX(w[1]) - toX(w[0]))}px`}
                    role="button" tabindex="-1" aria-label={`${row.bar.label}, ${frameText(w[0])} to ${frameText(w[1])}`} use:tooltip={`${row.bar.title}: ${frameText(w[0])} to ${frameText(w[1])}. Drag it or its ends`}
                    onpointerdown={(e) => downBar(e, row.bar, i, 'body')} onpointermove={move} onpointerup={up}>
                    <span class="grip start" role="presentation" onpointerdown={(e) => downBar(e, row.bar, i, 'start')}></span>
                    <span class="grip end" role="presentation" onpointerdown={(e) => downBar(e, row.bar, i, 'end')}></span>
                  </div>
                {/each}
              {:else if row.kind === 'events' && view !== null}
                <EventsLane {view} />
              {:else if row.kind === 'time'}
                {#each holds as h (h.id)}
                  {@const v = dragged('hold', h.id, h.v)}
                  <div class="hold" class:on={timeline.isSelected('time', h.id)} style:left={pct(v)} style:width={`${Math.max(4, toX(v + h.w) - toX(v))}px`} role="button" tabindex="-1"
                    aria-label={`Hold of ${h.seconds} s at ${frameText(v)}`} use:tooltip={`The pose held ${h.seconds} s at ${frameText(v)}: drag it, or its end to hold longer`}
                    onpointerdown={(e) => downTime(e, 'hold', h.id, h.v)} onpointermove={move} onpointerup={up}>
                    <span class="grip end" role="presentation" onpointerdown={(e) => downTime(e, 'hold', h.id, h.v, 'end')}></span>
                  </div>
                {/each}
                {#each markers as m (m.id)}
                  {@const v = dragged('marker', m.id, m.v)}
                  <button class="marker" class:on={timeline.isSelected('time', m.id)} style:left={pct(v)} aria-label={`Retime marker at ${frameText(v)}`}
                    use:tooltip={`Retime marker: source ${Math.round(m.u * 100)}% plays at ${frameText(v)}. Drag to retime round it`}
                    onpointerdown={(e) => downTime(e, 'marker', m.id, m.v)} onpointermove={move} onpointerup={up}></button>
                {/each}
                {#if hit !== null}
                  {@const v = dragged('hit', hit.id, hit.v)}
                  <button class="hit" class:on={timeline.isSelected(hit.measured ? 'time' : 'events', hit.id)} class:measured={hit.measured} style:left={pct(v)} aria-label={`The hit at ${frameText(v)}`}
                    use:tooltip={`The hit at ${frameText(v)}${hit.measured ? ' (found: the hand\'s fastest moment; drag to set it by hand)' : ' (set by hand; drag to move it)'}${p.slot.time?.fit?.enabled === true ? '. The blow fit lands it where the game times hits' : ''}`}
                    onpointerdown={(e) => downTime(e, 'hit', hit.id, hit.v)} onpointermove={move} onpointerup={up}><Swords size={9} /></button>
                {/if}
              {/if}
              <div class="playhead" style:left={pct(at)}></div>
            </div>
          </div>
          {#if row.kind === 'gear' && view !== null}
            <div class="row strips">
              <div class="label indent2"></div>
              <div class="lane free"><GearLanes {view} gear={row.gear} /></div>
            </div>
          {/if}
        {/each}
        {#if boxRect !== null}<div class="box" style:left={`${boxRect.left}px`} style:top={`${boxRect.top}px`} style:width={`${boxRect.width}px`} style:height={`${boxRect.height}px`}></div>{/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .timeline { position: relative; display: flex; flex-direction: column; gap: 4px; padding: 6px 10px 8px; background: var(--bg-1); container-type: inline-size; user-select: none; }
  .grab { position: absolute; top: -3px; left: 0; right: 0; height: 6px; cursor: ns-resize; z-index: 3; }
  .grab:hover { background: var(--accent-soft); }
  .heading { display: flex; align-items: center; gap: 8px; font-size: 12px; min-width: 0; }
  .name { min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .kind { flex: none; padding: 1px 6px; border-radius: 4px; background: var(--bg-3); color: var(--text-2); font-size: 10.5px; font-weight: 600; }
  .kind.idle { background: var(--accent-soft); color: var(--accent-strong); }
  .spacer { flex: 1; }
  .small { font-size: 11px; white-space: nowrap; }
  .readout { display: flex; align-items: center; gap: 5px; flex: none; }
  .readout input { width: 46px; height: 22px; padding: 0 4px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg-2); text-align: right; appearance: textfield; }
  .readout input::-webkit-inner-spin-button { appearance: none; }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .group { display: flex; gap: 1px; align-items: center; flex: none; }
  .group + .group { padding-left: 6px; border-left: 1px solid var(--line); }
  .controls button { min-width: 26px; height: 26px; padding: 0 4px; border-radius: 6px; border: 0; background: transparent; color: var(--text-3); display: inline-flex; align-items: center; justify-content: center; gap: 2px; }
  .controls button:hover:not(:disabled) { color: var(--text-1); background: var(--bg-3); }
  .controls button.on { color: var(--accent-strong); background: var(--accent-soft); }
  .controls button.text { font-size: 11px; color: var(--text-2); }
  .controls .play { width: 30px; height: 30px; margin: 0 2px; border-radius: 50%; background: var(--text-1); color: var(--bg-0); }
  .controls .play:hover:not(:disabled) { background: #fff; color: var(--bg-0); }
  .mini { font-size: 10px; font-weight: 600; }
  button:disabled { opacity: 0.35; cursor: default; }
  select { width: 58px; height: 24px; margin-left: 3px; border-radius: 6px; border: 1px solid var(--line-strong); background: var(--bg-2); font-size: 11px; }
  .tools { position: relative; z-index: 5; display: flex; min-height: 0; }
  /* (the ruler keeps the room of the tracks' scrollbar, so a frame on the ruler is the same frame in every lane) */
  .ruler-row { display: grid; grid-template-columns: var(--label) 1fr; align-items: stretch; overflow-y: hidden; scrollbar-gutter: stable; }
  .corner { display: flex; align-items: center; padding-left: 4px; }
  .ruler { position: relative; height: 22px; border-radius: 4px; background: var(--bg-2); cursor: ew-resize; overflow: hidden; touch-action: none; }
  .tick { position: absolute; bottom: 0; width: 1px; height: 4px; background: var(--line-strong); pointer-events: none; }
  .tick.major { height: 8px; background: var(--text-4); }
  .tick span { position: absolute; bottom: 8px; left: 3px; font-size: 9.5px; color: var(--text-3); font-variant-numeric: tabular-nums; }
  .region { position: absolute; top: 0; height: 5px; background: var(--ok, #6bd38a); opacity: 0.8; border-radius: 2px; pointer-events: none; }
  .hit-tick { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--danger); opacity: 0.7; pointer-events: none; }
  .selspan { position: absolute; bottom: 0; height: 6px; background: rgb(255 122 184 / 35%); border-radius: 2px; }
  .selspan .edge { position: absolute; top: -8px; width: 9px; height: 14px; padding: 0; border: 0; border-radius: 2px; background: var(--side-right, #ff7ab8); cursor: ew-resize; }
  .selspan .edge.start { left: -5px; }
  .selspan .edge.end { right: -5px; }
  .selspan .edge:hover { filter: brightness(1.25); transform: scaleY(1.15); }
  .head { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--text-1); pointer-events: none; box-shadow: 0 0 4px rgb(0 0 0 / 60%); }
  .tracks { position: relative; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; min-height: 40px; border-top: 1px solid var(--line); }
  .row { display: grid; grid-template-columns: var(--label) 1fr; height: 19px; align-items: center; }
  .row:hover { background: rgb(255 255 255 / 2.5%); }
  .row.selected { background: var(--accent-soft); }
  .row.hovered .label .name { color: var(--text-1); }
  .row.k-section { margin-top: 3px; }
  .row.k-section .label { font-weight: 600; color: var(--text-2); }
  .row.k-summary .label { font-weight: 600; color: var(--text-1); }
  .row.strips { height: auto; min-height: 0; }
  .row.k-events { height: auto; min-height: 19px; align-items: start; }
  .row.k-events .label { height: 24px; }
  .label { display: flex; align-items: center; gap: 2px; min-width: 0; padding-right: 6px; font-size: 11px; color: var(--text-3); }
  .label.indent1 { padding-left: 12px; }
  .label.indent2 { padding-left: 24px; }
  .label .text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .label button { border: 0; background: transparent; color: inherit; padding: 0; font: inherit; }
  .label .toggle { display: flex; align-items: center; gap: 2px; min-width: 0; flex: 1; text-align: left; }
  .label .name { flex: 1; min-width: 0; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .label .name:hover { color: var(--text-1); }
  .label .tiny { flex: none; height: 15px; padding: 0 4px; border-radius: 3px; font-size: 9.5px; color: var(--text-4); opacity: 0; transition: opacity 0.1s; }
  .label .tiny.icon { display: grid; place-items: center; width: 16px; padding: 0; }
  .row:hover .label .tiny, .label .tiny.on, .label .tiny:focus-visible { opacity: 1; }
  .label .tiny:hover { color: var(--text-1); background: var(--bg-3); }
  .label .tiny.on { color: var(--accent-strong); }
  .label .speed { width: 50px; height: 16px; font-size: 10px; margin-left: 4px; padding: 0; }
  .lane { position: relative; height: 15px; border-radius: 3px; background: var(--bg-2); overflow: hidden; touch-action: none; cursor: crosshair; }
  .lane.free { height: auto; background: transparent; overflow: visible; cursor: default; }
  .row.k-section .lane, .row.k-summary .lane { background: var(--bg-3); }
  .region-band { position: absolute; top: 0; bottom: 0; background: rgb(107 211 138 / 8%); pointer-events: none; }
  .playhead { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--text-2); pointer-events: none; }
  .key { position: absolute; top: 3px; width: 9px; height: 9px; margin-left: -4.5px; padding: 0; border: 1px solid rgb(0 0 0 / 55%); background: var(--warn); transform: rotate(45deg); border-radius: 1.5px; cursor: grab; z-index: 2; }
  .key:hover { transform: rotate(45deg) scale(1.3); }
  .key.on { background: var(--side-right, #ff7ab8); box-shadow: 0 0 0 1px #fff; }
  .key.part { background: linear-gradient(135deg, var(--side-right, #ff7ab8) 50%, var(--warn) 50%); }
  .key.pin { background: var(--bg-4); border-color: var(--text-4); }
  .key.pin.on { background: var(--side-right, #ff7ab8); }
  .key.faint { opacity: 0.4; }
  .span { position: absolute; top: 7px; height: 1px; background: var(--text-4); pointer-events: none; }
  .span.ease-linear { height: 1px; background: var(--text-3); }
  .span.ease-ease { height: 0; border-top: 1px dashed var(--text-3); background: none; }
  .span.ease-step { top: 4px; height: 6px; border-top: 1px solid var(--text-3); border-right: 1px solid var(--text-3); background: none; }
  .span.ease-hold { top: 6px; height: 3px; background: var(--accent); opacity: 0.7; border-radius: 2px; }
  .bar { position: absolute; top: 2px; height: 11px; border-radius: 3px; background: rgb(142 162 255 / 45%); cursor: grab; }
  .bar.pull { background: rgb(240 190 90 / 50%); }
  .bar.ik { background: rgb(107 211 138 / 45%); }
  .bar:hover, .bar.on { filter: brightness(1.35); box-shadow: 0 0 0 1px var(--text-2); }
  .grip { position: absolute; top: 0; bottom: 0; width: 6px; cursor: ew-resize; }
  .grip.start { left: -2px; }
  .grip.end { right: -2px; }
  .grip:hover { background: rgb(255 255 255 / 35%); }
  .hold { position: absolute; top: 2px; height: 11px; border-radius: 2px; background: repeating-linear-gradient(45deg, rgb(142 162 255 / 50%) 0 3px, rgb(142 162 255 / 20%) 3px 6px); cursor: grab; }
  .hold.on, .hold:hover { box-shadow: 0 0 0 1px var(--text-1); }
  .marker { position: absolute; top: 1px; width: 7px; height: 13px; margin-left: -3.5px; padding: 0; border: 0; border-radius: 2px; background: var(--accent); cursor: ew-resize; z-index: 2; }
  .marker.on, .marker:hover { background: var(--side-right, #ff7ab8); }
  .hit { position: absolute; top: 0; width: 14px; height: 15px; margin-left: -7px; padding: 0; border: 0; border-radius: 3px; background: var(--danger); color: #fff; display: grid; place-items: center; cursor: ew-resize; z-index: 2; }
  .hit.measured { opacity: 0.6; }
  .hit.on, .hit:hover { box-shadow: 0 0 0 1px #fff; opacity: 1; }
  .box { position: absolute; border: 1px solid var(--accent); background: rgb(142 162 255 / 12%); pointer-events: none; z-index: 4; }
  @container (max-width: 520px) { .preview { display: none; } }
</style>
