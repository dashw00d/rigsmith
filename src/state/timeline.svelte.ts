// The Motion timeline's state (docs/motion-plan.md §9 B): the selection across tracks (keys, events, gear strips, hand
// bars, the Time track's items), the zoom, the clipboard (keys and events) and what the keyboard does. Every key edit is a pure
// helper (src/model/keyedit.ts) sent as one `slot.keys.set` (one journal entry, one undo); undo and redo are the
// journal's (Ctrl+Z, Ctrl+Shift+Z). Positions are played phases of one cycle of the slot's clip (its time map,
// baked.time, IDENTITY while it first bakes); stored times are source moments.
//
// The read API other areas use (C1, C2, C3): `timeline.view` (lanes.ts TimelineView, or null), `timeline.selection`,
// `timeline.select(items, mode)`, `timeline.keys` (the selected keys), `timeline.frame()` (the time frame keyedit takes),
// `timeline.applyKeys(edit)` (send a keyedit result).
import type { Command } from '../model/command-types.ts'
import {
  copyKeys, deleteKeys, isKeyTrack, keysOf, keysToFrame, keyTracks, moveKeys, pasteKeys, snapPlayed, spanOf, stretchFactor, stretchKeys,
  stretchMarkers, type KeyClipboard, type KeyEdit, type KeyRef, type TimeFrame,
} from '../model/keyedit.ts'
import { newId } from '../model/ids.ts'
import { hierarchyOf, slotById } from '../model/select.ts'
import { IDENTITY, type TimeMap } from '../model/timemap.ts'
import type { Character, Slot } from '../model/types.ts'
import type { BakedSlot } from '../engine/bake.ts'
import type { AreaClip, AreaEdit, AreaItems, AreaView, SelectedItem, TimelineView } from '../app/motion/lanes.ts'
import { AREAS } from '../app/motion/areas.ts'
import { framesOf, timeAt, cycleAt } from '../app/motion/rules.ts'
import { app } from './app.svelte.ts'
import { animator } from './animator.svelte.ts'
import { clipPieces } from './pieces.svelte.ts'

const same = (a: SelectedItem, b: SelectedItem): boolean => a.track === b.track && a.id === b.id

/** A key as a selected item (its id: its source moment, as a string). */
export const keyItem = (k: KeyRef): SelectedItem => ({ track: k.track, id: String(k.u), u: k.u })

/** What Ctrl+C took: the keys and the areas' items (events...), each with its offset in frames from the earliest of
 * them all, so they go down together. */
interface Clipboard { keys: KeyClipboard | null, keysAt: number, areas: Array<{ area: AreaItems, clip: AreaClip, at: number }> }

/** The slot playing on stage, with what the timeline reads of it. */
export interface Playing {
  character: Character
  slot: Slot
  baked: BakedSlot | null
  map: TimeMap
  /** One cycle's seconds and frames (a ridden loop plays several). */
  duration: number
  frames: number
  cycles: number
}

class Timeline {
  selection = $state.raw<SelectedItem[]>([])
  /** The part of the clip shown (played phases): zoomed in, a part of it. */
  zoom = $state.raw<[number, number]>([0, 1])
  /** Stretching a selection by its edge retimes the clip itself (writes retime markers) instead of moving the keys. */
  retimeClip = $state(false)
  /** The rows opened (Body's limb groups, a group's bones). */
  open = $state.raw<string[]>(['body'])
  /** The pointer is over the timeline: F fits the clip there, and frames the character elsewhere (Viewport). */
  hovered = $state(false)
  /** The lanes' width in pixels (the Timeline measures it). */
  width = $state(600)
  private clipboard: Clipboard | null = null
  /** Undos made from here (their journal entries, and the character's edit mark after each), for redo, newest last;
   * any new edit to the character ends them (its mark moves on: app.editMark). */
  private redos: Array<{ character: string, seq: number, mark: string }> = []
  /** The last bake of each slot (its time map stays while it bakes again). */
  private lastBaked = new Map<string, BakedSlot>()

  /** The slot playing on stage, or null (nothing, a preview, a test). */
  get playing (): Playing | null {
    const now = animator.playing
    if (now === null || now.kind !== 'slot') return null
    const character = app.byId(now.characterId)
    const slot = character === null ? undefined : slotById(character, now.slotId ?? '')
    if (character === null || slot === undefined) return null
    let baked = now.baked
    if (baked !== null) this.lastBaked.set(slot.id, baked)
    else baked = this.lastBaked.get(slot.id) ?? null
    const cycles = Math.max(1, now.cycles)
    const duration = animator.duration > 0 ? animator.duration / cycles : baked?.clip.duration ?? 1
    return { character, slot, baked, map: baked?.time ?? IDENTITY, duration, frames: framesOf(duration * cycles, cycles), cycles }
  }

  /** The time frame key edits go through (the slot's time map and its frames). */
  frame (p: Playing | null = this.playing): TimeFrame {
    const map = p?.map ?? IDENTITY
    return { toPlayed: map.toPlayed, toSource: map.toSource, frames: p?.frames ?? 30 }
  }

  /** The playhead: a played phase of one cycle. */
  get playhead (): number { return animator.playing?.phase ?? 0 }

  /** The cycle of a ridden loop the playhead is in. */
  get cycle (): number {
    const now = animator.playing
    return now === null || animator.duration <= 0 ? 0 : cycleAt(animator.time / animator.duration, now.cycles)
  }

  /** Move the playhead to a played phase (paused, on the nearest frame unless `free`). */
  seek (v: number, free = false): void {
    const p = this.playing
    const now = animator.playing
    if (now === null) return
    animator.setPlaying(false)
    const frames = p?.frames ?? framesOf(animator.duration, now.cycles)
    const at = free ? v : Math.round(Math.min(1, Math.max(0, v)) * frames) / frames
    animator.seek(timeAt(at, this.cycle, now.cycles, animator.duration))
  }

  /** A frame of the cycle shown. */
  seekFrame (frame: number): void {
    const p = this.playing
    if (p === null || !Number.isFinite(frame)) return
    this.seek(Math.max(0, Math.min(p.frames, Math.round(frame))) / p.frames)
  }

  get frameNow (): number {
    const p = this.playing
    return p === null ? 0 : Math.round(Math.min(1, Math.max(0, this.playhead)) * p.frames)
  }

  /** What an area's lanes are handed (lanes.ts). */
  view (toX: (v: number) => number, fromX: (x: number) => number): TimelineView | null {
    const p = this.playing
    if (p === null) return null
    const f = this.frame(p)
    return {
      character: p.character, slot: p.slot, baked: p.baked, toX, fromX, width: this.width, duration: p.duration, frames: p.frames,
      toPlayed: f.toPlayed, toSource: f.toSource,
      snap: (v, free) => (free === true ? v : Math.round(v * p.frames) / p.frames),
      playhead: this.playhead, seek: v => { this.seek(v) },
      selection: this.selection, select: (items, mode) => { this.select(items, mode) },
    }
  }

  // ---- selection -----------------------------------------------------------------------------------------------

  select (items: readonly SelectedItem[], mode: 'set' | 'add' | 'toggle' = 'set'): void {
    if (mode === 'set') { this.selection = [...items]; return }
    if (mode === 'add') { this.selection = [...this.selection, ...items.filter(i => !this.selection.some(s => same(s, i)))]; return }
    const all = items.every(i => this.selection.some(s => same(s, i)))
    this.selection = all ? this.selection.filter(s => !items.some(i => same(s, i))) : [...this.selection, ...items.filter(i => !this.selection.some(s => same(s, i)))]
  }

  isSelected (track: string, id: string): boolean { return this.selection.some(s => s.track === track && s.id === id) }

  /** The selected keys. */
  get keys (): KeyRef[] { return this.selection.filter(s => isKeyTrack(s.track)).map(s => ({ track: s.track, u: s.u })) }

  /** Every key of the slot selected (Ctrl+A). */
  selectAll (): void {
    const p = this.playing
    if (p === null) return
    this.select(keyTracks(p.slot).flatMap(t => keysOf(p.slot, t).map(k => keyItem({ track: t, u: k.u }))))
  }

  clear (): void { this.selection = [] }

  toggleOpen (row: string, on?: boolean): void {
    const isOpen = this.open.includes(row)
    if (on === isOpen) return
    this.open = isOpen ? this.open.filter(r => r !== row) : [...this.open, row]
  }

  // ---- key edits -----------------------------------------------------------------------------------------------

  /** Send a key edit (one undo) and select what it leaves. */
  async applyKeys (edit: KeyEdit | null, what?: string, extra: Command[] = []): Promise<boolean> {
    const p = this.playing
    if (p === null || (edit === null && extra.length === 0)) return false
    const commands: Command[] = [...(edit === null || edit.tracks.length === 0 ? [] : [{ type: 'slot.keys.set' as const, slot: p.slot.id, tracks: edit.tracks }]), ...extra]
    if (edit !== null) this.selection = [...this.selection.filter(s => !isKeyTrack(s.track)), ...edit.selection.map(keyItem)]
    return await this.send(p.character, commands, what)
  }

  /** Commands from the timeline, as one journal entry; a new edit ends what redo could put back. */
  async send (c: Character, commands: Command[], what?: string): Promise<boolean> {
    if (commands.length === 0) return false
    this.redos = []
    return await app.do(c.id, commands, what) !== null
  }

  /** The selection's items of each area (events, gear strips) that has some selected. */
  private areaItems (): Array<{ area: AreaItems, items: SelectedItem[] }> {
    return AREAS.map(area => ({ area, items: this.selection.filter(s => area.owns(s.track)) })).filter(x => x.items.length > 0)
  }

  private areaView (p: Playing): AreaView {
    const f = this.frame(p)
    return {
      character: p.character, slot: p.slot, baked: p.baked, frames: p.frames, toPlayed: f.toPlayed, toSource: f.toSource,
      snap: (v, free) => (free === true ? v : Math.round(v * p.frames) / p.frames),
    }
  }

  /** The played span of the whole selection: its keys and the areas' items that have a place in time. */
  private spanAll (p: Playing): [number, number] | null {
    const view = this.areaView(p)
    const spans = [spanOf(p.slot, this.keys, this.frame(p)), ...this.areaItems().map(x => x.area.span?.(view, x.items) ?? null)].filter((x): x is [number, number] => x !== null)
    return spans.length === 0 ? null : [Math.min(...spans.map(x => x[0])), Math.max(...spans.map(x => x[1]))]
  }

  /** A key edit and the areas' edits sent as one undo; each area's items selected as its edit leaves them. */
  private async applyAll (keys: KeyEdit | null, edits: Array<{ area: AreaItems, edit: AreaEdit }>, what?: string): Promise<boolean> {
    const sent = this.applyKeys(keys, what, edits.flatMap(e => e.edit.commands))
    if (edits.length > 0) this.selection = [...this.selection.filter(s => !edits.some(e => e.area.owns(s.track))), ...edits.flatMap(e => e.edit.selection)]
    return await sent
  }

  /** The selection moved by `dv` (a drag of its keys from `anchor`, snapped to frames unless free; or a nudge): its
   * keys and the areas' items together, none past the clip's ends. */
  move (dv: number, o: { free?: boolean, anchor?: number } = {}): void {
    const p = this.playing
    if (p === null) return
    const f = this.frame(p)
    const span = this.spanAll(p)
    if (span === null) return
    const anchor = o.anchor ?? span[0]
    let d = snapPlayed(anchor + dv, f.frames, o.free) - anchor
    d = Math.min(Math.max(1, span[1]) - span[1], Math.max(Math.min(0, span[0]) - span[0], d))
    if (Math.abs(d) < 1e-12) return
    const view = this.areaView(p)
    const edits = this.areaItems().flatMap(({ area, items }) => { const edit = area.move?.(view, items, d) ?? null; return edit === null ? [] : [{ area, edit }] })
    const keys = this.keys.length === 0 ? null : moveKeys(p.slot, this.keys, d, f, { free: true, anchor })
    void this.applyAll(keys, edits, 'move')
  }

  /** The selection moved by whole frames (Ctrl+← →; Shift: 10). */
  nudge (frames: number): void {
    const p = this.playing
    if (p !== null && this.selection.length > 0) this.move(frames / Math.max(1, p.frames), { free: true })
  }

  /** The selection's edge dragged to `to`: the keys stretched, or (retimeClip) the clip retimed under them. */
  stretch (edge: 'start' | 'end', to: number, o: { free?: boolean } = {}): void {
    const p = this.playing
    if (p === null) return
    const f = this.frame(p)
    if (!this.retimeClip) { void this.applyKeys(stretchKeys(p.slot, this.keys, edge, to, f, o)); return }
    const span = spanOf(p.slot, this.keys, f)
    const factor = span === null ? null : stretchFactor(span, edge, to, f.frames)
    if (span === null || factor === null) return
    const from = f.toSource(span[0]); const until = f.toSource(span[1])
    const markers = stretchMarkers(p.slot.time?.markers, from, until, edge, factor, newId)
    if (markers === null) { app.toast('error', 'The clip can’t be retimed that way: an edge of the selection is at the clip’s start or end, or it would run past another marker'); return }
    void this.send(p.character, [{ type: 'slot.time', slot: p.slot.id, patch: { markers } }], 'retime')
  }

  toFrame (frame: number): void {
    const p = this.playing
    if (p !== null) void this.applyKeys(keysToFrame(p.slot, this.keys, frame, this.frame(p)))
  }

  /** Whether the selection has what Ctrl+C and Ctrl+D take (keys, events). */
  get copyable (): boolean { return this.keys.length > 0 || this.areaItems().some(x => x.area.copy !== undefined) }

  /** The selection copied just after itself (keys and events together). */
  duplicate (): void {
    const p = this.playing
    if (p === null) return
    const span = this.spanAll(p)
    const clip = this.take(p)
    if (span === null || clip === null) return
    const step = 1 / Math.max(1, p.frames)
    const d = Math.max(step, snapPlayed(span[1] - span[0], p.frames) + step)
    if (span[1] + d > 1 + 1e-9) { app.toast('info', 'No room after the selection to duplicate it into'); return }
    void this.put(p, clip, Math.round((span[0] + d) * p.frames), 'duplicate')
  }

  /** The keys and the areas' items selected, as a clipboard (null: nothing to copy). */
  private take (p: Playing): Clipboard | null {
    const f = this.frame(p)
    const view = this.areaView(p)
    const keys = this.keys.length === 0 ? null : copyKeys(p.slot, this.keys, f)
    const keySpan = spanOf(p.slot, this.keys, f)
    const areas = this.areaItems().flatMap(({ area, items }) => { const clip = area.copy?.(view, items) ?? null; return clip === null ? [] : [{ area, clip }] })
    const firsts = [...(keys !== null && keys.items.length > 0 && keySpan !== null ? [keySpan[0]] : []), ...areas.map(a => a.clip.first)]
    if (firsts.length === 0) return null
    const first = Math.min(...firsts)
    const at = (v: number): number => Math.round((v - first) * p.frames)
    return { keys: keys !== null && keys.items.length > 0 ? keys : null, keysAt: keySpan === null ? 0 : at(keySpan[0]), areas: areas.map(a => ({ ...a, at: at(a.clip.first) })) }
  }

  /** A clipboard put down with its earliest item on `frame`: tracks this slot can't have are left out. */
  private async put (p: Playing, clip: Clipboard, frame: number, what: string): Promise<boolean> {
    const f = this.frame(p)
    const view = this.areaView(p)
    const bones = new Set(hierarchyOf(p.character).map(([n]) => n))
    const gear = new Set(p.character.gear.map(g => g.id))
    const ok = (t: string): boolean => (t.startsWith('gear:') ? gear.has(t.slice(5)) : bones.size === 0 || bones.has(t.slice(5)))
    const keys = clip.keys === null ? null : pasteKeys(p.slot, clip.keys, frame + clip.keysAt, f, { tracks: ok })
    const edits = clip.areas.flatMap(({ area, clip: c, at }) => {
      const edit = area.paste?.(view, c, (frame + at) / Math.max(1, p.frames)) ?? null
      return edit === null ? [] : [{ area, edit }]
    })
    if (keys === null && edits.length === 0) return false
    // (what was selected goes: the pasted items are)
    this.selection = []
    return await this.applyAll(keys, edits, what)
  }

  /** The selection copied (Ctrl+C): how many keys and other items. */
  copy (): number {
    const p = this.playing
    if (p === null) return 0
    const clip = this.take(p)
    if (clip === null) return 0
    this.clipboard = clip
    return this.keys.length + this.areaItems().filter(x => x.area.copy !== undefined).reduce((n, x) => n + x.items.length, 0)
  }

  get canPaste (): boolean { return this.clipboard !== null }

  /** What was copied put down at the playhead (in this clip or another). */
  paste (): void {
    const p = this.playing; const clip = this.clipboard
    if (p === null || clip === null) return
    void this.put(p, clip, this.frameNow, 'paste')
  }

  /** Delete what is selected, across tracks: keys, the areas' items (events, gear strips' switches and hidden spans),
   * hand bars, retime markers and pieces of the clip (with what is keyed on them). One undo. */
  remove (): void {
    const p = this.playing
    if (p === null || this.selection.length === 0) return
    const extra: Command[] = []
    const view = this.areaView(p)
    const areas = this.areaItems()
    for (const { area, items } of areas) extra.push(...(area.remove?.(view, items) ?? []))
    for (const s of this.selection) {
      if (s.track.startsWith('hands:')) {
        const id = s.track.slice(6)
        if (id.startsWith('ik:')) continue
        if (p.slot.adjustments.some(a => a.id === id) && !extra.some(x => x.type === 'slot.adjust.remove' && x.id === id)) extra.push({ type: 'slot.adjust.remove', slot: p.slot.id, id })
      }
    }
    // (a hand let go of what it holds by IK)
    const ikHands = this.selection.filter(s => s.track.startsWith('hands:ik:')).map(s => s.track.slice(9))
    if (ikHands.length > 0 && p.slot.ik !== undefined) {
      const hands = p.slot.ik.hands.filter(h => !ikHands.includes(h.hand))
      extra.push({ type: 'slot.ik', slot: p.slot.id, patch: { hands: hands.length > 0 ? hands : null } })
    }
    const time = this.selection.filter(s => s.track === 'time')
    if (time.length > 0) {
      const markers = (p.slot.time?.markers ?? []).filter(m => !time.some(s => s.id === m.id))
      if (markers.length !== (p.slot.time?.markers ?? []).length) extra.push({ type: 'slot.time', slot: p.slot.id, patch: { markers: markers.length > 0 ? markers : null } })
    }
    // (pieces of the clip: last, so what the other commands touched is moved or goes with them)
    const pieces = this.selection.filter(s => s.track === 'pieces').map(s => s.id)
    if (pieces.length > 0) {
      const sent = clipPieces.removeCommands(p, pieces)
      if (sent === null) { app.toast('info', 'A clip keeps at least one piece of a clip'); return }
      extra.push(...sent)
    }
    const keys = deleteKeys(p.slot, this.keys)
    const left = this.selection.filter(s => !isKeyTrack(s.track) && !areas.some(a => a.area.owns(s.track)) && !s.track.startsWith('hands:') && s.track !== 'time' && s.track !== 'pieces')
    void this.applyKeys(keys, 'delete', extra).then(ok => { if (ok) this.selection = left })
  }

  // ---- undo, redo (the journal's) ------------------------------------------------------------------------------

  async undo (c: Character): Promise<void> {
    const entry = await app.undo(c.id)
    if (entry === null) return
    const mark = app.editMark(c.id)
    this.redos = [...this.redos.filter(r => r.character !== c.id || r.mark === mark), { character: c.id, seq: entry.seq, mark }]
  }

  async redo (c: Character): Promise<void> {
    const last = this.redos.at(-1)
    if (last !== undefined && last.character === c.id) {
      if (last.mark === app.editMark(c.id)) { this.redos.pop(); await app.undo(c.id, last.seq); return }
      // (an edit made since the undo, here or anywhere (the posing, the events, a setting), ends what redo could put back)
      this.redos = this.redos.filter(r => r.character !== c.id)
    }
    app.toast('info', 'Nothing to redo')
  }

  // ---- zoom --------------------------------------------------------------------------------------------------------

  /** Zoom by `factor` about played phase `at` (in: under 1). */
  zoomBy (factor: number, at: number): void {
    const [a, b] = this.zoom
    const span = Math.min(1, Math.max(0.02, (b - a) * factor))
    let from = at - (at - a) * span / (b - a)
    from = Math.min(1 - span, Math.max(0, from))
    this.zoom = [from, from + span]
  }

  /** Scroll the part shown by `dv`. */
  pan (dv: number): void {
    const [a, b] = this.zoom
    const span = b - a
    const from = Math.min(1 - span, Math.max(0, a + dv))
    this.zoom = [from, from + span]
  }

  fit (): void { this.zoom = [0, 1] }

  /** Zoomed to the selection (or the whole clip when nothing is selected). */
  fitSelection (): void {
    const vs = this.selection.map(s => this.frame().toPlayed(s.u))
    if (vs.length === 0) { this.fit(); return }
    const lo = Math.min(...vs); const hi = Math.max(...vs)
    const pad = Math.max(0.05, (hi - lo) * 0.15)
    const from = Math.max(0, lo - pad); const to = Math.min(1, hi + pad)
    this.zoom = to - from < 0.02 ? [Math.max(0, from - 0.01), Math.min(1, to + 0.01)] : [from, to]
  }

  // ---- the loop region ---------------------------------------------------------------------------------------------

  /** The loop region's start or end at the playhead ([ and ]); the other end kept, or the clip's. */
  regionAt (edge: 'start' | 'end'): void {
    const v = this.playhead
    const r = animator.region ?? [0, 1]
    const next: [number, number] = edge === 'start' ? [v, Math.max(v + 1 / (this.playing?.frames ?? 30), r[1])] : [Math.min(r[0], v - 1 / (this.playing?.frames ?? 30)), v]
    animator.region = [Math.max(0, next[0]), Math.min(1, next[1])]
  }

  clearRegion (): void { animator.region = null }

  /** Another slot (or nothing) playing: nothing of the last one's selected, the whole clip shown. */
  reset (): void {
    this.selection = []
    this.zoom = [0, 1]
  }
}

export const timeline = new Timeline()
