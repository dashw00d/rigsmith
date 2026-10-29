// Key editing in the timeline (docs/motion-plan.md §9 B), as pure functions: select, move, stretch, duplicate, delete,
// copy and paste in time, a typed frame, easing. Keys are stored against the slot's source clip (SourceU) but edited
// where the clip plays them: every function takes the slot's time map (`TimeFrame`: source <-> played phases and the
// played clip's frames), works in played phases, snaps to its frames (unless `free`), and writes source moments back.
// Each returns the tracks to send as one `slot.keys.set` (one undo) and the selection as it is after; null when
// nothing changes. A key moved onto another key's moment on its track replaces it.
import type { KeyTrack } from './command-types.ts'
import type { ClipKey, Ease, RetimeMarker, Slot } from './types.ts'
import { MAX_U } from './types.ts'

/** One key: its track (`body:<bone>` or `gear:<id>`) and its source moment. */
export interface KeyRef { track: string, u: number }

/** The time map the keys are edited through (src/model/timemap.ts TimeMap, or IDENTITY) and the played clip's frames. */
export interface TimeFrame {
  toPlayed: (u: number) => number
  toSource: (v: number) => number
  frames: number
}

/** What an edit sends (slot.keys.set's tracks) and the keys selected after it. */
export interface KeyEdit { tracks: KeyTrack[], selection: KeyRef[] }

/** Two moments closer than this are one (the reducer's rule). */
export const SAME = 1e-6

const near = (a: number, b: number): boolean => Math.abs(a - b) < SAME
const clampU = (u: number): number => Math.min(MAX_U, Math.max(0, u))
const round = (u: number): number => Math.round(u * 1e9) / 1e9

/** Whether a track names a key track. */
export const isKeyTrack = (track: string): boolean => track.startsWith('body:') || track.startsWith('gear:')

/** The keys of a track (sorted, as stored). */
export function keysOf (slot: Pick<Slot, 'bones' | 'gear'>, track: string): ClipKey[] {
  if (track.startsWith('body:')) return slot.bones?.[track.slice(5)] ?? []
  if (track.startsWith('gear:')) return slot.gear?.[track.slice(5)]?.keys ?? []
  return []
}

/** Every key track of the slot that has keys. */
export function keyTracks (slot: Pick<Slot, 'bones' | 'gear'>): string[] {
  return [
    ...Object.entries(slot.bones ?? {}).filter(([, ks]) => ks.length > 0).map(([b]) => `body:${b}`),
    ...Object.entries(slot.gear ?? {}).filter(([, t]) => (t.keys?.length ?? 0) > 0).map(([g]) => `gear:${g}`),
  ]
}

/** A track's keys as slot.keys.set takes them. */
export function trackOf (track: string, keys: ClipKey[]): KeyTrack {
  const sorted = [...keys].sort((a, b) => a.u - b.u)
  return track.startsWith('gear:') ? { gear: track.slice(5), keys: sorted } : { bone: track.slice(5), keys: sorted }
}

/** Whether `ref` is among `selection`. */
export const isSelected = (selection: readonly KeyRef[], track: string, u: number): boolean => selection.some(s => s.track === track && near(s.u, u))

/** A played phase on the nearest frame (as it is when `free`). */
export function snapPlayed (v: number, frames: number, free = false): number {
  return free || frames <= 0 ? v : Math.round(v * frames) / frames
}

/** The selected keys that exist, by track. */
function picked (slot: Pick<Slot, 'bones' | 'gear'>, selection: readonly KeyRef[]): Map<string, ClipKey[]> {
  const out = new Map<string, ClipKey[]>()
  for (const s of selection) {
    if (!isKeyTrack(s.track)) continue
    const k = keysOf(slot, s.track).find(x => near(x.u, s.u))
    if (k === undefined) continue
    const list = out.get(s.track) ?? []
    if (!list.includes(k)) list.push(k)
    out.set(s.track, list)
  }
  return out
}

/** Keys laid onto a track: each replaces any key at its moment (the later given wins). */
function lay (keys: readonly ClipKey[], put: readonly ClipKey[]): ClipKey[] {
  const out = keys.filter(k => !put.some(p => near(p.u, k.u)))
  const placed: ClipKey[] = []
  for (const p of put) {
    const at = placed.findIndex(x => near(x.u, p.u))
    if (at >= 0) placed[at] = p
    else placed.push(p)
  }
  return [...out, ...placed].sort((a, b) => a.u - b.u)
}

/** The selection's keys moved to new moments by `to` (a played phase -> the new played phase, null: stays): each
 * track's other keys kept, one at a new moment replaced. */
function remap (slot: Pick<Slot, 'bones' | 'gear'>, selection: readonly KeyRef[], f: TimeFrame, to: (v: number) => number): KeyEdit | null {
  const sel = picked(slot, selection)
  if (sel.size === 0) return null
  const tracks: KeyTrack[] = []
  const after: KeyRef[] = []
  let changed = false
  for (const [track, ks] of sel) {
    const moved = ks.map(k => {
      const v = f.toPlayed(k.u)
      const v2 = to(v)
      const u = Math.abs(v2 - v) < 1e-12 ? k.u : round(clampU(f.toSource(v2)))
      if (!near(u, k.u)) changed = true
      return { ...k, u }
    })
    const rest = keysOf(slot, track).filter(k => !ks.includes(k))
    const next = lay(rest, moved)
    tracks.push(trackOf(track, next))
    for (const k of moved) if (!after.some(a => a.track === track && near(a.u, k.u))) after.push({ track, u: k.u })
  }
  return changed ? { tracks, selection: after } : null
}

/** The played span of the selection ([earliest, latest]), or null when nothing is selected. */
export function spanOf (slot: Pick<Slot, 'bones' | 'gear'>, selection: readonly KeyRef[], f: Pick<TimeFrame, 'toPlayed'>): [number, number] | null {
  const vs = [...picked(slot, selection).values()].flat().map(k => f.toPlayed(k.u))
  return vs.length === 0 ? null : [Math.min(...vs), Math.max(...vs)]
}

/**
 * The selection moved by `dv` (played phase). Snapped so the key grabbed (`anchor`, its played phase; unset: the
 * earliest) lands on a frame, the others keeping their offsets from it; kept inside the played clip (a selection
 * already reaching past an end may stay out as far as it was).
 */
export function moveKeys (slot: Pick<Slot, 'bones' | 'gear'>, selection: readonly KeyRef[], dv: number, f: TimeFrame, o: { free?: boolean, anchor?: number } = {}): KeyEdit | null {
  const span = spanOf(slot, selection, f)
  if (span === null) return null
  const anchor = o.anchor ?? span[0]
  let d = snapPlayed(anchor + dv, f.frames, o.free) - anchor
  const lo = Math.min(0, span[0]); const hi = Math.max(1, span[1])
  d = Math.min(hi - span[1], Math.max(lo - span[0], d))
  if (Math.abs(d) < 1e-12) return null
  return remap(slot, selection, f, v => v + d)
}

/** The selection moved so its earliest key is on frame `frame` (a typed frame), the others keeping their offsets. */
export function keysToFrame (slot: Pick<Slot, 'bones' | 'gear'>, selection: readonly KeyRef[], frame: number, f: TimeFrame): KeyEdit | null {
  const span = spanOf(slot, selection, f)
  if (span === null || !Number.isFinite(frame)) return null
  const target = Math.min(f.frames, Math.max(0, Math.round(frame))) / Math.max(1, f.frames)
  return moveKeys(slot, selection, target - span[0], f, { free: true, anchor: span[0] })
}

/**
 * The selection stretched by one of its edges: `edge` 'end' moves its latest key to `to` (played), the earliest held;
 * 'start' the other way round. Every key between scales with it (each snapped to a frame unless `free`); the span
 * never goes under a frame or turns over.
 */
export function stretchKeys (slot: Pick<Slot, 'bones' | 'gear'>, selection: readonly KeyRef[], edge: 'start' | 'end', to: number, f: TimeFrame, o: { free?: boolean } = {}): KeyEdit | null {
  const span = spanOf(slot, selection, f)
  if (span === null || span[1] - span[0] < 1e-9) return null
  const factor = stretchFactor(span, edge, to, f.frames)
  if (factor === null) return null
  const fixed = edge === 'end' ? span[0] : span[1]
  return remap(slot, selection, f, v => snapPlayed(fixed + (v - fixed) * factor, f.frames, o.free))
}

/** How much a stretch of `span` by its `edge` to `to` scales it (at least a frame long, within the clip), or null. */
export function stretchFactor (span: [number, number], edge: 'start' | 'end', to: number, frames: number): number | null {
  const minimum = 1 / Math.max(1, frames)
  const length = span[1] - span[0]
  if (length < 1e-9) return null
  const next = edge === 'end' ? Math.min(Math.max(1, span[1]), to) - span[0] : span[1] - Math.max(Math.min(0, span[0]), to)
  const factor = Math.max(minimum, next) / length
  return Math.abs(factor - 1) < 1e-9 ? null : factor
}

/** The selection's keys taken out. */
export function deleteKeys (slot: Pick<Slot, 'bones' | 'gear'>, selection: readonly KeyRef[]): KeyEdit | null {
  const sel = picked(slot, selection)
  if (sel.size === 0) return null
  return { tracks: [...sel].map(([track, ks]) => trackOf(track, keysOf(slot, track).filter(k => !ks.includes(k)))), selection: [] }
}

/** The selection copied just after itself (a frame after its latest key), the copies selected; null when there is no
 * room left in the clip. */
export function duplicateKeys (slot: Pick<Slot, 'bones' | 'gear'>, selection: readonly KeyRef[], f: TimeFrame): KeyEdit | null {
  const span = spanOf(slot, selection, f)
  if (span === null) return null
  const step = 1 / Math.max(1, f.frames)
  const d = Math.max(step, snapPlayed(span[1] - span[0], f.frames) + step)
  if (span[1] + d > 1 + 1e-9) return null
  return pasteKeys(slot, copyKeys(slot, selection, f), Math.round((span[0] + d) * f.frames), f)
}

/** Keys copied: each with its track and its offset in frames from the earliest copied (pasted at another moment, in
 * this clip or another). */
export interface KeyClipboard { items: Array<{ track: string, frames: number, key: Omit<ClipKey, 'u'> }> }

export function copyKeys (slot: Pick<Slot, 'bones' | 'gear'>, selection: readonly KeyRef[], f: TimeFrame): KeyClipboard {
  const sel = [...picked(slot, selection)].flatMap(([track, ks]) => ks.map(k => ({ track, k, v: f.toPlayed(k.u) })))
  if (sel.length === 0) return { items: [] }
  const first = Math.min(...sel.map(x => x.v))
  return {
    items: sel.map(({ track, k, v }) => {
      const key: Partial<ClipKey> = JSON.parse(JSON.stringify(k)) as ClipKey
      delete key.u
      return { track, frames: Math.round((v - first) * f.frames), key: key as Omit<ClipKey, 'u'> }
    }),
  }
}

/** Copied keys put down with the earliest on frame `frame` (the playhead's): each replaces any key at its moment;
 * those past the clip's end are left out. The pasted keys are selected. */
export function pasteKeys (slot: Pick<Slot, 'bones' | 'gear'>, clip: KeyClipboard, frame: number, f: TimeFrame, o: { tracks?: (track: string) => boolean } = {}): KeyEdit | null {
  const byTrack = new Map<string, ClipKey[]>()
  for (const it of clip.items) {
    if (o.tracks !== undefined && !o.tracks(it.track)) continue
    const at = frame + it.frames
    if (at < 0 || at > f.frames) continue
    const u = round(clampU(f.toSource(at / Math.max(1, f.frames))))
    byTrack.set(it.track, [...(byTrack.get(it.track) ?? []), { ...JSON.parse(JSON.stringify(it.key)) as Omit<ClipKey, 'u'>, u }])
  }
  if (byTrack.size === 0) return null
  const tracks = [...byTrack].map(([track, put]) => trackOf(track, lay(keysOf(slot, track), put)))
  return { tracks, selection: [...byTrack].flatMap(([track, put]) => put.map(k => ({ track, u: k.u }))) }
}

/** The span from each selected key to the next eased so (C3's menu sends this; 'smooth' is stored as unset). */
export function easeKeys (slot: Pick<Slot, 'bones' | 'gear'>, selection: readonly KeyRef[], ease: Ease): KeyEdit | null {
  const sel = picked(slot, selection)
  if (sel.size === 0) return null
  const tracks: KeyTrack[] = []
  for (const [track, ks] of sel) {
    if (ks.every(k => (k.ease ?? 'smooth') === ease)) continue
    tracks.push(trackOf(track, keysOf(slot, track).map(k => {
      if (!ks.includes(k)) return k
      const next: ClipKey = { ...k }
      delete next.ease
      return ease === 'smooth' ? next : { ...next, ease }
    })))
  }
  return tracks.length === 0 ? null : { tracks, selection: [...selection] }
}

/** One key put on a track at its moment (replacing one there). */
export function putKey (slot: Pick<Slot, 'bones' | 'gear'>, track: string, key: ClipKey): KeyEdit {
  return { tracks: [trackOf(track, lay(keysOf(slot, track), [key]))], selection: [{ track, u: key.u }] }
}

/** The keys inside a box: tracks among `tracks`, played phases within [from, to]. */
export function keysIn (slot: Pick<Slot, 'bones' | 'gear'>, tracks: readonly string[], from: number, to: number, f: Pick<TimeFrame, 'toPlayed'>): KeyRef[] {
  const [a, b] = from <= to ? [from, to] : [to, from]
  return tracks.flatMap(track => keysOf(slot, track).filter(k => { const v = f.toPlayed(k.u); return v >= a - 1e-9 && v <= b + 1e-9 }).map(k => ({ track, u: k.u })))
}

/** The moments (played phases, distinct to a frame) the given tracks have keys at, each with the keys there: the
 * Summary row's and a group row's diamonds. */
export function momentsOf (slot: Pick<Slot, 'bones' | 'gear'>, tracks: readonly string[], f: TimeFrame): Array<{ v: number, keys: KeyRef[], eases: Ease[] }> {
  const out: Array<{ v: number, frame: number, keys: KeyRef[], eases: Ease[] }> = []
  for (const track of tracks) {
    for (const k of keysOf(slot, track)) {
      const v = f.toPlayed(k.u)
      const frame = Math.round(v * f.frames)
      let m = out.find(x => x.frame === frame && Math.abs(x.v - v) < 0.5 / Math.max(1, f.frames))
      if (m === undefined) { m = { v, frame, keys: [], eases: [] }; out.push(m) }
      m.keys.push({ track, u: k.u })
      m.eases.push(k.ease ?? 'smooth')
    }
  }
  return out.sort((a, b) => a.v - b.v).map(({ v, keys, eases }) => ({ v, keys, eases }))
}

// ---- retiming the clip with a stretch ---------------------------------------------------------------------------------

/** Where the warp puts source `u` (a phase of the source's length): piecewise linear through the markers, 0 -> 0 and
 * 1 -> 1. */
export function warpAt (markers: readonly RetimeMarker[] | undefined, u: number): number {
  const ms = [...(markers ?? [])].filter(m => m.u > 0 && m.u < 1).sort((a, b) => a.u - b.u)
  const s = [0, ...ms.map(m => m.u), 1]; const w = [0, ...ms.map(m => m.to), 1]
  if (u <= 0 || u >= 1) return u
  let i = 1
  while (i < s.length - 1 && s[i] < u) i++
  const f = (u - s[i - 1]) / Math.max(s[i] - s[i - 1], 1e-12)
  return w[i - 1] + f * (w[i] - w[i - 1])
}

/**
 * The retime markers that stretch the clip itself with a stretched selection (its keys then keep their source moments
 * and move with the clip): the source span [from, to] of the selection scaled by `factor` about its fixed edge, in the
 * warp; the markers inside it scaled along, the ones outside kept. Null when it can't: the moving edge is at the
 * source's very start or end, or the stretch would run into the next marker or past the end.
 */
export function stretchMarkers (markers: readonly RetimeMarker[] | undefined, from: number, to: number, edge: 'start' | 'end', factor: number, newId: () => string): RetimeMarker[] | null {
  const moving = edge === 'end' ? to : from
  const fixed = edge === 'end' ? from : to
  if (moving <= 1e-6 || moving >= 1 - 1e-6) return null
  const ms = [...(markers ?? [])].filter(m => m.u > 0 && m.u < 1).sort((a, b) => a.u - b.u)
  const wf = warpAt(ms, fixed)
  const inside = (u: number): boolean => u > Math.min(from, to) + 1e-9 && u < Math.max(from, to) - 1e-9
  const out: RetimeMarker[] = ms.filter(m => !inside(m.u) && !near(m.u, moving) && !near(m.u, fixed)).map(m => ({ ...m }))
  for (const m of ms) if (inside(m.u)) out.push({ ...m, to: wf + (m.to - wf) * factor })
  out.push({ id: ms.find(m => near(m.u, moving))?.id ?? newId(), u: moving, to: wf + (warpAt(ms, moving) - wf) * factor })
  if (fixed > 1e-6 && fixed < 1 - 1e-6) out.push({ id: ms.find(m => near(m.u, fixed))?.id ?? newId(), u: fixed, to: wf })
  out.sort((a, b) => a.u - b.u)
  // (strictly increasing in both, inside (0, 1): the reducer's rule)
  for (let i = 0; i < out.length; i++) {
    if (out[i].to <= 0 || out[i].to >= 1) return null
    if (i > 0 && (out[i].u - out[i - 1].u < 1e-6 || out[i].to - out[i - 1].to < 1e-6)) return null
  }
  return out.map(m => ({ ...m, to: round(m.to) }))
}
