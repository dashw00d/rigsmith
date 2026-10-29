// A slot's source built from pieces (docs/motion-plan.md §11): the layout of its pieces in the composite's seconds,
// which piece a moment belongs to, every stored time moved with its piece when the pieces change (slot.pieces.set's
// remap), and the gestures of the timeline's Clip strip as pure functions of the list (extend the end or the start,
// insert time, append, trim, blend, reorder, remove), as src/model/keyedit.ts is for keys. Pure: no three.js.
//
// The layout: piece i lasts d_i = to - from and starts at s_0 = 0, s_i = s_i-1 + d_i-1 - blend_i; the composite lasts
// D = s_last + d_last. A SourceU of a slot with pieces is t / D of the composite. A slot without pieces is one piece,
// its clip whole (id MAIN), so the same arithmetic covers it.
import type { Adjustment, BlowFit, Character, ClipEvent, ClipKey, ClipRef, GearTrack, Piece, Slot, SlotIk, Window } from './types.ts'
import { MAX_U } from './types.ts'

/** The id of a slot's clip whole as a piece (what a slot without pieces is). */
export const MAIN = 'main'
/** The shortest piece (a frame), and the blend appended pieces get by default (the game's blend into Idle). */
export const MIN_PIECE = 1 / 30
export const DEFAULT_BLEND = 0.2
const E = 1e-9

/** A slot's clip whole as one piece (`seconds` its length at speed 1). */
export const wholeClip = (clip: ClipRef, seconds: number): Piece[] => [{ id: MAIN, kind: 'clip', clip: { ...clip }, from: 0, to: seconds }]

/** The slot's pieces: its own, or its clip whole (`seconds` its length). */
export function piecesOf (slot: Pick<Slot, 'clip' | 'pieces'>, seconds: number): Piece[] {
  return slot.pieces !== undefined ? slot.pieces.map(p => ({ ...p })) : wholeClip(slot.clip, seconds)
}

/** Whether the list is just `clip` whole (stored as no list). */
export function isWhole (pieces: readonly Piece[], clip: ClipRef, seconds: number | undefined): boolean {
  if (pieces.length !== 1 || seconds === undefined) return false
  const p = pieces[0]
  return p.kind === 'clip' && p.clip.id === clip.id && p.clip.url === clip.url && p.from === 0 && Math.abs(p.to - seconds) < 1e-9 && (p.blend ?? 0) === 0
}

export const lengthOf = (p: Pick<Piece, 'from' | 'to'>): number => p.to - p.from

// ---- the layout ----------------------------------------------------------------------------------------------------

export interface Placed { piece: Piece, index: number, start: number, length: number, blend: number }
export interface Layout { placed: Placed[], seconds: number }

export function layoutOf (pieces: readonly Piece[]): Layout {
  const placed: Placed[] = []
  let at = 0
  for (const [index, piece] of pieces.entries()) {
    const blend = index === 0 ? 0 : piece.blend ?? 0
    const start = index === 0 ? 0 : at - blend
    const length = lengthOf(piece)
    placed.push({ piece, index, start, length, blend })
    at = start + length
  }
  return { placed, seconds: Math.max(at, 0) }
}

/** The piece a moment of the composite (seconds) belongs to: the one it falls in; inside a blend the piece before up to
 * its middle, the next from there; past the end the last piece (`past`). `local`: seconds from that piece's start. */
export function ownerAt (layout: Layout, t: number): { index: number, local: number, past: boolean } {
  const ps = layout.placed
  const last = ps.length - 1
  if (t > layout.seconds + E) return { index: last, local: t - ps[last].start, past: true }
  let i = last
  while (i > 0 && t < ps[i].start + ps[i].blend / 2 - 1e-12) i--
  return { index: i, local: t - ps[i].start, past: false }
}

/** The pieces a moment of the composite plays from: one, or two inside a blend (the one before, then the next). */
export function piecesAt (layout: Layout, t: number): Placed[] {
  return layout.placed.filter(p => t >= p.start - 1e-12 && t <= p.start + p.length + 1e-12)
}

// ---- the rules -----------------------------------------------------------------------------------------------------

/** What's wrong with a list of pieces (null: nothing): ids unique, from < to, at least one clip or slot, the first with
 * no blend, a blend at most either neighbour's length, a piece's two blends not overlapping. */
export function piecesProblem (pieces: readonly Piece[]): string | null {
  if (pieces.length === 0) return 'A clip needs a piece (null: its clip whole)'
  if (new Set(pieces.map(p => p.id)).size !== pieces.length) return 'Piece ids repeat'
  if (!pieces.some(p => p.kind !== 'hold')) return 'A clip needs a piece of a clip or of another clip slot, not only held poses'
  for (const [i, p] of pieces.entries()) {
    if (!(lengthOf(p) > 1e-6)) return `Piece ${i + 1} must end after it starts`
    const b = p.blend ?? 0
    if (i === 0 && b > 0) return 'The first piece has no piece before it to blend from'
    if (b < 0) return 'A blend is not negative'
    if (i > 0 && (b > lengthOf(pieces[i - 1]) + E || b > lengthOf(p) + E)) return `The blend into piece ${i + 1} is longer than a piece it blends`
    const next = pieces[i + 1]?.blend ?? 0
    if (b + next > lengthOf(p) + E) return `Piece ${i + 1}'s two blends overlap`
  }
  return null
}

/** Whether `pieces` (for slot `slotId`) play that slot again somewhere down their slot pieces. */
export function playsItself (c: Pick<Character, 'clips'>, slotId: string, pieces: readonly Piece[]): boolean {
  const seen = new Set<string>()
  const walk = (ps: readonly Piece[]): boolean => ps.some(p => {
    if (p.kind !== 'slot') return false
    if (p.slot === slotId) return true
    if (seen.has(p.slot)) return false
    seen.add(p.slot)
    const s = c.clips.find(x => x.id === p.slot)
    return s?.pieces !== undefined && walk(s.pieces)
  })
  return walk(pieces)
}

/** The slots a slot's bake reads besides itself (its slot pieces, a pace's like, theirs in turn): what the viewer
 * compares to know it must bake again. */
export function slotsUnder (c: Pick<Character, 'clips'>, slot: Slot): Slot[] {
  const out = new Map<string, Slot>()
  const visit = (s: Slot): void => {
    const next = [...(s.pieces ?? []).flatMap(p => (p.kind === 'slot' ? [p.slot] : [])), ...(s.time?.pace !== undefined ? [s.time.pace.like] : [])]
    for (const id of next) {
      if (id === slot.id || out.has(id)) continue
      const o = c.clips.find(x => x.id === id)
      if (o === undefined) continue
      out.set(id, o)
      visit(o)
    }
  }
  visit(slot)
  return [...out.values()]
}

// ---- remapping what a slot stores ------------------------------------------------------------------------------------

export interface Remap {
  /** A point (a key, an event) moved with its piece; null when its piece went or its moment was trimmed off. */
  point: (u: number) => number | null
  /** A window's end or a switch (a holder, a shown change) moved with its piece, kept inside what is left of it (a
   * piece removed: the seam where it was). */
  clamp: (u: number) => number
  /** The composites' seconds, before and after. */
  seconds: [number, number]
}

/** How the composite's moments move from `old` pieces to `next` ones (each item to the piece of the same id, or a part
 * `split` from it, whose range still holds its moment). */
export function remapper (old: readonly Piece[], next: readonly Piece[], split: Readonly<Record<string, string>> = {}): Remap {
  const a = layoutOf(old); const b = layoutOf(next)
  const D = Math.max(a.seconds, 1e-9); const D2 = Math.max(b.seconds, 1e-9)
  const continued = new Map<string, Placed[]>()
  for (const p of b.placed) {
    const of = split[p.piece.id] ?? p.piece.id
    continued.set(of, [...(continued.get(of) ?? []), p])
  }
  const at = (c: Placed, m: number): number => c.start + (m - c.piece.from)
  // (a moment on the boundary of two parts goes to the later: time inserted at the playhead pushes what is there on)
  const holding = (m: number, cs: Placed[]): Placed | undefined =>
    cs.find(c => m >= c.piece.from - E && m < c.piece.to - E) ?? cs.find(c => m >= c.piece.from - E && m <= c.piece.to + E)
  /** The seam where a removed piece was: the new start of the first piece after it that is left (else the end). */
  const seam = (index: number): number => {
    for (let i = index + 1; i < a.placed.length; i++) {
      const cs = continued.get(a.placed[i].piece.id)
      if (cs !== undefined && cs.length > 0) return Math.min(...cs.map(c => c.start))
    }
    for (let i = index - 1; i >= 0; i--) {
      const cs = continued.get(a.placed[i].piece.id)
      if (cs !== undefined && cs.length > 0) return Math.max(...cs.map(c => c.start + c.length))
    }
    return D2
  }
  const locate = (u: number): { o: ReturnType<typeof ownerAt>, m: number, cs: Placed[] } => {
    const o = ownerAt(a, u * D)
    const p = a.placed[o.index].piece
    return { o, m: p.from + o.local, cs: continued.get(p.id) ?? [] }
  }
  const point = (u: number): number | null => {
    const { o, m, cs } = locate(u)
    if (o.past) {
      // (past the end: as far from the last piece's start as it was)
      if (cs.length === 0) return (u * D - D + D2) / D2
      return at(cs.reduce((x, y) => (y.piece.to > x.piece.to ? y : x)), m) / D2
    }
    const c = holding(m, cs)
    if (c !== undefined) return at(c, m) / D2
    // (a moment the other piece there plays too (a seam, a blend): with that piece, when its own went or lost it)
    const t = u * D
    for (const other of piecesAt(a, t)) {
      if (other.index === o.index) continue
      const om = other.piece.from + (t - other.start)
      const oc = holding(om, continued.get(other.piece.id) ?? [])
      if (oc !== undefined) return at(oc, om) / D2
    }
    return null
  }
  const clamp = (u: number): number => {
    const { o, m, cs } = locate(u)
    if (o.past) return point(u)!
    const c = holding(m, cs)
    if (c !== undefined) return at(c, m) / D2
    if (cs.length === 0) return seam(o.index) / D2
    const nearest = cs.reduce((x, y) => (dist(m, y.piece) < dist(m, x.piece) ? y : x))
    return at(nearest, Math.min(nearest.piece.to, Math.max(nearest.piece.from, m))) / D2
  }
  return { point, clamp, seconds: [a.seconds, b.seconds] }
}

const dist = (m: number, p: Pick<Piece, 'from' | 'to'>): number => (m < p.from ? p.from - m : m > p.to ? m - p.to : 0)
const okU = (u: number | null): u is number => u !== null && Number.isFinite(u) && u >= -E && u <= MAX_U
const fixU = (u: number): number => Math.min(MAX_U, Math.max(0, Math.round(u * 1e9) / 1e9))

/** Keys moved with their pieces: those whose piece went or that were trimmed off dropped; sorted, one a moment. */
function remapKeys (keys: readonly ClipKey[], r: Remap): { keys: ClipKey[], dropped: number } {
  const out: ClipKey[] = []
  for (const k of keys) { const u = r.point(k.u); if (okU(u)) out.push({ ...k, u: fixU(u) }) }
  out.sort((x, y) => x.u - y.u)
  const kept = out.filter((k, i) => i === 0 || k.u - out[i - 1].u >= 1e-6)
  return { keys: kept, dropped: keys.length - kept.length }
}

/** Switches from `u` on (holders, shown) moved, each kept (at the seam when its piece went); one a moment, the later. */
function remapSwitches<T extends { u: number }> (xs: readonly T[], r: Remap): T[] {
  const moved = xs.map(x => ({ ...x, u: fixU(r.clamp(x.u)) })).sort((x, y) => x.u - y.u)
  return moved.filter((x, i) => i === moved.length - 1 || moved[i + 1].u - x.u >= 1e-6)
}

/** Windows moved, each end kept inside what is left of its piece; empty ones gone, overlapping ones merged. */
function remapWindows (ws: readonly Window[], r: Remap): Window[] {
  const moved = ws.map(([x, y]): Window => [fixU(r.clamp(x)), fixU(r.clamp(y))]).filter(([x, y]) => y - x > 1e-6).sort((p, q) => p[0] - q[0])
  const out: Window[] = []
  for (const w of moved) {
    const last = out.at(-1)
    if (last !== undefined && w[0] <= last[1]) last[1] = Math.max(last[1], w[1])
    else out.push([w[0], w[1]])
  }
  return out
}

/**
 * The slot with every time it stores moved from the `old` pieces' composite to the `next` one's (docs/motion-plan.md
 * §11.3): keys, gear keys, holders and shown switches, events, the windows of its hand poses, handle holds and hands on
 * gear, its retime markers. What sat on a piece that went, or was trimmed off its piece, goes (`dropped` counts the
 * keys, events, windows and markers lost); its pieces are left to the caller.
 */
export function remapSlot (slot: Slot, old: readonly Piece[], next: readonly Piece[], split?: Readonly<Record<string, string>>): { slot: Slot, dropped: number } {
  const r = remapper(old, next, split)
  const s: Slot = JSON.parse(JSON.stringify(slot)) as Slot
  let dropped = 0
  if (s.bones !== undefined) {
    for (const [b, ks] of Object.entries(s.bones)) {
      const m = remapKeys(ks, r)
      dropped += m.dropped
      if (m.keys.length > 0) s.bones[b] = m.keys
      else delete s.bones[b]
    }
    if (Object.keys(s.bones).length === 0) delete s.bones
  }
  if (s.gear !== undefined) {
    for (const [g, t] of Object.entries(s.gear)) {
      const track: GearTrack = {}
      if (t.keys !== undefined) { const m = remapKeys(t.keys, r); dropped += m.dropped; if (m.keys.length > 0) track.keys = m.keys }
      if (t.heldBy !== undefined) track.heldBy = remapSwitches(t.heldBy, r)
      if (t.shown !== undefined) track.shown = remapSwitches(t.shown, r)
      if (track.keys === undefined && track.heldBy === undefined && track.shown === undefined) delete s.gear[g]
      else s.gear[g] = track
    }
    if (Object.keys(s.gear).length === 0) delete s.gear
  }
  if (s.events !== undefined) {
    const events: ClipEvent[] = []
    for (const e of s.events) {
      if (e.to === undefined) {
        const u = r.point(e.u)
        if (okU(u)) events.push({ ...e, u: fixU(u) }); else dropped++
        continue
      }
      const from = r.point(e.u) ?? r.clamp(e.u); const to = r.point(e.to) ?? r.clamp(e.to)
      if (okU(from) && okU(to) && to - from > 1e-6) events.push({ ...e, u: fixU(from), to: fixU(to) }); else dropped++
    }
    events.sort((x, y) => x.u - y.u)
    if (events.length > 0) s.events = events
    else delete s.events
  }
  s.adjustments = s.adjustments.flatMap((a): Adjustment[] => {
    if (a.kind === 'ground' || (a.kind === 'handPose' && a.windows === undefined)) return [a]
    const ws = remapWindows(a.windows!, r)
    if (ws.length === 0) { dropped++; return [] }
    return [{ ...a, windows: ws }]
  })
  if (s.ik !== undefined) {
    const hands: SlotIk['hands'] = s.ik.hands.flatMap(h => {
      if (h.windows === undefined) return [h]
      const ws = remapWindows(h.windows, r)
      if (ws.length === 0) { dropped++; return [] }
      return [{ ...h, windows: ws }]
    })
    s.ik = { ...s.ik, hands }
    if (hands.length === 0 && s.ik.lead === undefined) delete s.ik
  }
  if (s.time?.markers !== undefined) {
    const [D, D2] = r.seconds
    const moved = s.time.markers.flatMap(m => {
      const u = r.point(m.u)
      if (!okU(u)) return []
      return [{ ...m, u: fixU(u), to: fixU((m.to * D + (u * D2 - m.u * D)) / Math.max(D2, 1e-9)) }]
    }).sort((x, y) => x.u - y.u)
    const kept = moved.filter(m => m.u > 1e-6 && m.u < 1 - 1e-6 && m.to > 1e-6 && m.to < 1 - 1e-6)
      .filter((m, i, all) => i === 0 || (m.u - all[i - 1].u >= 1e-6 && m.to - all[i - 1].to >= 1e-6))
    dropped += s.time.markers.length - kept.length
    if (kept.length > 0) s.time.markers = kept
    else delete s.time.markers
    if (Object.keys(s.time).length === 0) delete s.time
  }
  return { slot: s, dropped }
}

// ---- the gestures (each a next list for slot.pieces.set) -------------------------------------------------------------

/** A next list of pieces, and the parts it split off old pieces (new id -> old id). */
export interface PiecesEdit { pieces: Piece[], split?: Record<string, string> }

/** The composite ending at `t` seconds: past its end, the time added as a held pose (the last hold grown, or one
 * appended); before it, the piece there trimmed to end at `t` and those after it gone. Null: nothing would be left. */
export function endAt (pieces: readonly Piece[], t: number, newId: () => string): PiecesEdit | null {
  const L = layoutOf(pieces)
  const out = pieces.map(p => ({ ...p }))
  if (t >= L.seconds - E) {
    const extra = t - L.seconds
    if (extra < E) return { pieces: out }
    const last = out[out.length - 1]
    if (last.kind === 'hold') last.to += extra
    else out.push({ id: newId(), kind: 'hold', from: 0, to: extra })
    return { pieces: out }
  }
  const k = L.placed.findIndex(p => p.start + p.length >= t - E)
  const cut = out.slice(0, k + 1)
  const p = cut[k]
  const length = t - L.placed[k].start
  if (length < MIN_PIECE - E) return null
  p.to = p.from + length
  if ((p.blend ?? 0) > length) p.blend = length
  if (!cut.some(x => x.kind !== 'hold')) return null
  return { pieces: cut }
}

/** The composite starting at `t` seconds (negative: that long before its start, held: the first hold grown, or one put
 * first); after its start, the piece there trimmed to start at `t` and those before it gone. */
export function startAt (pieces: readonly Piece[], t: number, newId: () => string): PiecesEdit | null {
  const L = layoutOf(pieces)
  const out = pieces.map(p => ({ ...p }))
  if (t <= E) {
    const extra = -t
    if (extra < E) return { pieces: out }
    const first = out[0]
    if (first.kind === 'hold') first.from -= extra
    else out.unshift({ id: newId(), kind: 'hold', from: -extra, to: 0 })
    return { pieces: out }
  }
  if (t > L.seconds - MIN_PIECE) return null
  let k = 0
  for (const p of L.placed) if (p.start <= t + E) k = p.index
  const cut = out.slice(k)
  const p = cut[0]
  p.from += t - L.placed[k].start
  delete p.blend
  if (lengthOf(p) < MIN_PIECE - E || !cut.some(x => x.kind !== 'hold')) return null
  const next = cut[1]
  if (next !== undefined && (next.blend ?? 0) > lengthOf(p)) next.blend = lengthOf(p)
  return { pieces: cut }
}

/** `seconds` of held pose put in at moment `t` of the composite: at the start or the end, the clip made longer there;
 * inside a piece, the piece split there with the hold between its parts (a hold: its second part's clock set back, so
 * what is after the moment moves on). Null: `t` is inside a blend. */
export function insertAt (pieces: readonly Piece[], t: number, seconds: number, newId: () => string): PiecesEdit | null {
  const L = layoutOf(pieces)
  if (t <= 1e-6) return startAt(pieces, -seconds, newId)
  if (t >= L.seconds - 1e-6) return endAt(pieces, L.seconds + seconds, newId)
  const o = ownerAt(L, t)
  const at = L.placed[o.index]
  const nextStart = L.placed[o.index + 1]?.start ?? Infinity
  if (o.local < at.blend - E || t > nextStart + E) return null
  const out = pieces.map(p => ({ ...p }))
  const p = out[o.index]
  const cutAt = p.from + o.local
  // (at the very start of a piece: the hold goes between it and the piece before)
  if (o.local < E) {
    out.splice(o.index, 0, { id: newId(), kind: 'hold', from: 0, to: seconds })
    delete out[o.index + 1].blend
    return { pieces: out }
  }
  const rest: Piece = { ...p, id: newId(), from: p.kind === 'hold' ? cutAt - seconds : cutAt }
  delete rest.blend
  p.to = cutAt
  const parts: Piece[] = p.kind === 'hold' ? [p, rest] : [p, { id: newId(), kind: 'hold', from: 0, to: seconds }, rest]
  out.splice(o.index, 1, ...parts)
  return { pieces: out, split: { [rest.id]: p.id } }
}

/** A piece put after the last, blended in over `blend` seconds (as much of it as the two pieces allow). */
export function appended (pieces: readonly Piece[], piece: Piece, blend = DEFAULT_BLEND): PiecesEdit {
  const out = pieces.map(p => ({ ...p }))
  const last = out[out.length - 1]
  const room = Math.min(lengthOf(last) - (last.blend ?? 0), lengthOf(piece))
  const b = Math.max(0, Math.min(blend, room))
  const next: Piece = { ...piece }
  delete next.blend
  if (b > 0) next.blend = round(b)
  out.push(next)
  return { pieces: out }
}

/** A piece's start or end moved by `dt` seconds of its content (trimmed or let out): at least a frame long, inside its
 * content (`content`: its length; unset: anywhere, a hold), its blends cut down to fit. */
export function trimmed (pieces: readonly Piece[], id: string, edge: 'start' | 'end', dt: number, content?: number): PiecesEdit | null {
  const out = pieces.map(p => ({ ...p }))
  const i = out.findIndex(p => p.id === id)
  if (i < 0) return null
  const p = out[i]
  if (edge === 'start') p.from = Math.min(p.to - MIN_PIECE, Math.max(content !== undefined ? 0 : -Infinity, p.from + dt))
  else p.to = Math.max(p.from + MIN_PIECE, Math.min(content ?? Infinity, p.to + dt))
  p.from = round(p.from); p.to = round(p.to)
  fitBlends(out)
  return { pieces: out }
}

/** A piece's range and blend typed (the inspector's): as trimmed and blended would make them. */
export function patched (pieces: readonly Piece[], id: string, patch: { from?: number, to?: number, blend?: number }, content?: number): PiecesEdit | null {
  const p = pieces.find(x => x.id === id)
  if (p === undefined) return null
  let edit: PiecesEdit | null = { pieces: pieces.map(x => ({ ...x })) }
  if (patch.from !== undefined && edit !== null) edit = trimmed(edit.pieces, id, 'start', patch.from - p.from, content)
  if (patch.to !== undefined && edit !== null) edit = trimmed(edit.pieces, id, 'end', patch.to - (edit.pieces.find(x => x.id === id)?.to ?? p.to), content)
  if (patch.blend !== undefined && edit !== null) edit = blended(edit.pieces, id, patch.blend)
  return edit
}

/** The blend into piece `id` set to `seconds` (as much as its neighbours allow; 0 a cut). */
export function blended (pieces: readonly Piece[], id: string, seconds: number): PiecesEdit | null {
  const out = pieces.map(p => ({ ...p }))
  const i = out.findIndex(p => p.id === id)
  if (i <= 0) return null
  const room = Math.min(lengthOf(out[i - 1]) - (i > 1 ? out[i - 1].blend ?? 0 : 0), lengthOf(out[i]) - (out[i + 1]?.blend ?? 0))
  const b = round(Math.max(0, Math.min(seconds, room)))
  if (b > 0) out[i].blend = b
  else delete out[i].blend
  return { pieces: out }
}

/** Piece `id` moved to `index` (the first piece has no blend: one moved there loses its; the one that was first comes
 * in with a cut). */
export function moved (pieces: readonly Piece[], id: string, index: number): PiecesEdit | null {
  const out = pieces.map(p => ({ ...p }))
  const i = out.findIndex(p => p.id === id)
  if (i < 0) return null
  const [p] = out.splice(i, 1)
  out.splice(Math.max(0, Math.min(out.length, index)), 0, p)
  delete out[0].blend
  fitBlends(out)
  return { pieces: out }
}

/** The pieces without `ids` (null: nothing of a clip or a slot would be left). */
export function removed (pieces: readonly Piece[], ids: readonly string[]): PiecesEdit | null {
  const out = pieces.filter(p => !ids.includes(p.id)).map(p => ({ ...p }))
  if (out.length === pieces.length || !out.some(p => p.kind !== 'hold')) return null
  delete out[0].blend
  fitBlends(out)
  return { pieces: out }
}

/** Blends cut down until the rules hold (piecesProblem). */
function fitBlends (ps: Piece[]): void {
  for (let i = 1; i < ps.length; i++) {
    const b = ps[i].blend ?? 0
    if (b === 0) continue
    const room = Math.min(lengthOf(ps[i - 1]) - (i > 1 ? ps[i - 1].blend ?? 0 : 0), lengthOf(ps[i]))
    if (b > room) {
      if (room > 1e-6) ps[i].blend = round(room)
      else delete ps[i].blend
    }
  }
}

const round = (x: number): number => Math.round(x * 1e6) / 1e6

// ---- the blow fit kept through an edit -------------------------------------------------------------------------------

/** The fit that keeps the played clip's start and its blow where they are (seconds of the new composite) and ends it at
 * `end`: `at` the blow's share of [start, end] (and a `window` that long); null when the blow isn't inside it. */
export function fitFor (fit: BlowFit, start: number, blow: number, end: number): BlowFit | null {
  const span = end - start
  if (!(span > MIN_PIECE) || blow <= start + E || blow >= end - E) return null
  const at = Math.round((blow - start) / span * 1e6) / 1e6
  return { ...fit, at, ...(fit.window !== undefined ? { window: round(span) } : {}) }
}

// ---- in words ------------------------------------------------------------------------------------------------------

/** A piece in words (the journal's, the strip's): the clip's name, another slot's, or how long it holds. */
export function pieceText (p: Piece, slotName: (id: string) => string | undefined = () => undefined): string {
  if (p.kind === 'hold') return `held ${lengthOf(p).toFixed(2)} s`
  const name = p.kind === 'clip' ? clipName(p.clip) : `${slotName(p.slot) ?? p.slot} as it plays`
  return name
}

/** A library clip id as a name (mixamo-Sword_Slash -> Sword Slash). */
export const clipName = (ref: ClipRef): string => ref.id.replace(/^(mixamo|custom|bundled)-/, '').replace(/_/g, ' ')
