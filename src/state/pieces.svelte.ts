// The Clip strip's edits (docs/motion-plan.md §11): the slot playing's pieces as the timeline shows them (played phases
// of one cycle), and every gesture of the strip (drag the clip's end or start, type a length, insert time at the
// playhead, append a clip or another slot, trim, blend, reorder, remove a piece) sent as one batch: one undo. Each next
// list of pieces is a pure helper of src/model/pieces.ts; this adds what only the bake knows: the slot's clip length
// (a slot playing its clip whole), the played range and the blow, so that with the blow fit on the played clip keeps
// its start and its blow where they are and ends where the gesture says (the blow pinned as the hit event first, fit.at
// set after).
import type { Command } from '../model/command-types.ts'
import { newId } from '../model/ids.ts'
import {
  appended, blended, DEFAULT_BLEND, endAt, fitFor, insertAt, layoutOf, lengthOf, moved, patched, piecesOf, remapper, removed, startAt, trimmed,
  type Layout, type PiecesEdit,
} from '../model/pieces.ts'
import { hitOf } from '../model/select.ts'
import type { Character, Piece, Slot } from '../model/types.ts'
import { app } from './app.svelte.ts'
import { animator } from './animator.svelte.ts'
import type { Playing } from './timeline.svelte.ts'

/** A piece as the strip shows it: where it plays (played phases of one cycle) and its blend in. */
export interface ShownPiece { piece: Piece, index: number, from: number, to: number, blendTo: number, label: string, whole: boolean }

/** What the strip reads of the slot playing: its pieces, their layout (seconds of the composite), the played range. */
export interface PiecesNow {
  pieces: Piece[]
  layout: Layout
  /** The source's seconds (the composite's). */
  seconds: number
  /** The played clip's start and end, seconds of the composite (the fit's cut; else 0 and the end). */
  range: [number, number]
  /** Seconds of the source per played second (speed and pace), for drags. */
  perPlayed: number
}

class ClipPieces {
  /** Content lengths by piece key ('clip:<id>|<url>|<inPlace>', 'slot:<id>'), as the bake gave them. */
  lengths = $state.raw<Record<string, number>>({})

  /** The slot playing's pieces (its clip whole when it has none), or null before its first bake. */
  now (p: Playing | null): PiecesNow | null {
    if (p === null || p.baked === null) return null
    const D = p.baked.raw.duration
    const pieces = piecesOf(p.slot, D)
    const layout = layoutOf(pieces)
    const map = p.map
    const range: [number, number] = [map.range[0] * D, map.range[1] * D]
    const perPlayed = (range[1] - range[0]) / Math.max(1e-9, p.duration)
    return { pieces, layout, seconds: D, range, perPlayed }
  }

  /** The pieces where they play (played phases), with their names. */
  shown (p: Playing | null): ShownPiece[] {
    const n = this.now(p)
    if (p === null || n === null) return []
    const at = (t: number): number => p.map.toPlayed(t / Math.max(1e-9, n.seconds))
    const name = (sid: string): string => p.character.clips.find(s => s.id === sid)?.name ?? 'a clip that is gone'
    return n.layout.placed.map(x => ({
      piece: x.piece, index: x.index, from: at(x.start), to: at(x.start + x.length), blendTo: at(x.start + x.blend),
      label: labelOf(x.piece, name), whole: p.slot.pieces === undefined,
    }))
  }

  /** How long a piece's content is (seconds), when known: what trimming may let it out to. */
  contentOf (p: Playing, piece: Piece): number | undefined {
    if (piece.kind === 'hold') return undefined
    if (p.slot.pieces === undefined) return p.baked?.raw.duration
    return this.lengths[keyOf(piece, p.slot.inPlace)]
  }

  /** The content lengths of the slot's pieces looked up (once each). */
  async measure (p: Playing): Promise<void> {
    if (p.slot.pieces === undefined) return
    for (const piece of p.slot.pieces) {
      if (piece.kind === 'hold') continue
      const key = keyOf(piece, p.slot.inPlace)
      if (this.lengths[key] !== undefined) continue
      const seconds = await this.contentSeconds(p.character, p.slot, piece)
      if (seconds !== null) this.lengths = { ...this.lengths, [key]: seconds }
    }
  }

  /** A content's length: a library clip as it plays on the character, another slot as it plays. */
  async contentSeconds (c: Character, slot: Slot, piece: Piece): Promise<number | null> {
    if (piece.kind === 'clip') return await animator.clipSeconds(piece.clip, slot.inPlace)
    if (piece.kind === 'slot') {
      const other = c.clips.find(s => s.id === piece.slot)
      return other === undefined ? null : (await animator.bake(c, other))?.clip.duration ?? null
    }
    return null
  }

  // ---- the gestures --------------------------------------------------------------------------------------------

  /** The played clip's end moved to played phase `v` (past 1: longer, held; before: shorter). */
  async endTo (p: Playing, v: number): Promise<boolean> {
    const n = this.now(p)
    if (n === null) return false
    const t = n.range[0] + v * (n.range[1] - n.range[0])
    if (t <= n.range[0] + 1 / 30) return toast('The clip can’t end before it starts')
    // (longer: the last pose as it plays held, so what the blow fit cut off the clip's end goes first; trimming the
    // piece's own end lets that out again)
    const cut = t > n.range[1] && n.range[1] < n.seconds - 1e-6 ? endAt(n.pieces, n.range[1], newId) : { pieces: n.pieces }
    const edit = cut === null ? null : endAt(cut.pieces, t > n.range[1] ? layoutOf(cut.pieces).seconds + (t - n.range[1]) : t, newId)
    return edit === null ? toast('Nothing would be left of the clip') : await this.send(p, n, edit, v > 1 ? 'longer clip' : 'shorter clip', { last: true })
  }

  /** The played clip's start moved to played phase `v` (below 0: longer, held from its first pose; above: shorter). */
  async startTo (p: Playing, v: number): Promise<boolean> {
    const n = this.now(p)
    if (n === null) return false
    const t = n.range[0] + v * (n.range[1] - n.range[0])
    if (t >= n.range[1] - 1 / 30) return toast('The clip can’t start after it ends')
    // (longer: its first pose as it plays held, what the blow fit cut off its start gone first)
    const cut = t < n.range[0] && n.range[0] > 1e-6 ? startAt(n.pieces, n.range[0], newId) : { pieces: n.pieces }
    const edit = cut === null ? null : startAt(cut.pieces, t < n.range[0] ? t - n.range[0] : t, newId)
    return edit === null ? toast('Nothing would be left of the clip') : await this.send(p, n, edit, v < 0 ? 'longer clip' : 'shorter clip', { first: true })
  }

  /** The played clip made `seconds` long (typed): its end moved. */
  async setLength (p: Playing, seconds: number): Promise<boolean> {
    if (!(seconds > 1 / 30)) return toast('A clip lasts at least a frame')
    return await this.endTo(p, seconds / Math.max(1e-9, p.duration))
  }

  /** `seconds` (played) of held pose put in at played phase `v` (the playhead). */
  async insertTime (p: Playing, v: number, seconds: number): Promise<boolean> {
    const n = this.now(p)
    if (n === null) return false
    // (at the played end or start: the clip longer there, as if dragged)
    if (v >= 1 - 1e-6) return await this.endTo(p, 1 + seconds / Math.max(1e-9, p.duration))
    if (v <= 1e-6) return await this.startTo(p, -seconds / Math.max(1e-9, p.duration))
    const t = n.range[0] + v * (n.range[1] - n.range[0])
    const edit = insertAt(n.pieces, t, seconds * n.perPlayed, newId)
    if (edit === null) return toast('The playhead is inside a blend: move it off the blend to put time in there')
    return await this.send(p, n, edit, 'insert time')
  }

  /** A clip or another slot's range put after the clip as it plays, blended in. */
  async append (p: Playing, piece: Piece, blend = DEFAULT_BLEND): Promise<boolean> {
    const n = this.now(p)
    if (n === null) return false
    // (a blow fit that cuts the end: what it cuts off goes first, so what is appended plays straight after what plays)
    const base = n.range[1] < n.seconds - 1e-6 ? endAt(n.pieces, n.range[1], newId) : { pieces: n.pieces }
    if (base === null) return false
    const edit = appended(base.pieces, piece, blend)
    return await this.send(p, n, edit, 'append', { last: true })
  }

  async trim (p: Playing, id: string, edge: 'start' | 'end', dv: number): Promise<boolean> {
    const n = this.now(p)
    const piece = n?.pieces.find(x => x.id === id)
    if (n === null || piece === undefined) return false
    const edit = trimmed(n.pieces, id, edge, dv * p.duration * n.perPlayed, this.contentOf(p, piece))
    return edit !== null && await this.send(p, n, edit, 'trim')
  }

  /** A piece's range (seconds of its content) and blend (seconds of the source) as typed. */
  async update (p: Playing, id: string, patch: { from?: number, to?: number, blend?: number }): Promise<boolean> {
    const n = this.now(p)
    const piece = n?.pieces.find(x => x.id === id)
    if (n === null || piece === undefined) return false
    const edit = patched(n.pieces, id, patch, this.contentOf(p, piece))
    return edit !== null && await this.send(p, n, edit, 'piece')
  }

  async blend (p: Playing, id: string, seconds: number): Promise<boolean> {
    const n = this.now(p)
    if (n === null) return false
    const edit = blended(n.pieces, id, seconds * n.perPlayed)
    return edit !== null && await this.send(p, n, edit, 'blend')
  }

  async move (p: Playing, id: string, index: number): Promise<boolean> {
    const n = this.now(p)
    if (n === null) return false
    const edit = moved(n.pieces, id, index)
    return edit !== null && await this.send(p, n, edit, 'reorder')
  }

  async remove (p: Playing, ids: string[]): Promise<boolean> {
    const sent = this.removeCommands(p, ids)
    if (sent === null) return toast('A clip keeps at least one piece of a clip')
    return await app.do(p.character.id, sent, 'remove a piece') !== null
  }

  /** The commands that take `ids` out (null: nothing of a clip or a slot would be left). */
  removeCommands (p: Playing, ids: string[]): Command[] | null {
    const n = this.now(p)
    if (n === null) return null
    const edit = removed(n.pieces, ids)
    return edit === null ? null : this.commands(p, n, edit)
  }

  /** An edit as commands: the hit pinned (a measured blow, with the fit on), the pieces, the fit following. `o.first`:
   * the played clip starts where the new pieces do; `o.last`: it ends where they do; else its start and end stay on
   * their moments (an end at or past the old end stays as far past the new one). Null: the edit would leave the blow
   * outside the played clip. */
  commands (p: Playing, n: PiecesNow, edit: PiecesEdit, o: { first?: boolean, last?: boolean } = {}): Command[] | null {
    const slot = p.slot
    const out: Command[] = []
    const pieces = edit.pieces
    const seconds = slot.pieces === undefined ? n.seconds : undefined
    const set: Command = { type: 'slot.pieces.set', slot: slot.id, pieces, ...(seconds !== undefined ? { seconds } : {}), ...(edit.split !== undefined ? { split: edit.split } : {}) }
    const fit = slot.time?.fit
    const cut = p.baked?.cut
    if (fit?.enabled !== true || cut === undefined) return [set]
    // the blow, as a source moment: the hit event, or the one the fit measured (pinned now, so a longer clip can't
    // find another fastest moment)
    const D = n.seconds
    const hit = hitOf(slot)
    const blowV = (cut.blow - cut.start) / Math.max(1e-9, cut.end - cut.start)
    const blowU = hit?.u ?? Math.round(p.map.toSource(blowV) * 1e9) / 1e9
    if (hit === undefined) out.push({ type: 'slot.event.add', slot: slot.id, event: { id: newId(), name: 'hit', u: blowU } })
    out.push(set)
    const r = remapper(n.pieces, pieces, edit.split)
    const D2 = Math.max(1e-9, r.seconds[1])
    const where = (t: number): number => (r.point(t / D) ?? r.clamp(t / D)) * D2
    const start = o.first === true ? 0 : where(n.range[0])
    const blow = (r.point(blowU) ?? NaN) * D2
    const end = o.last === true ? D2 : n.range[1] >= D - 1e-9 ? D2 + (n.range[1] - D) : where(n.range[1])
    const next = fitFor(fit, start, blow, end)
    if (next === null) return null
    if (next.at !== fit.at || next.window !== fit.window) out.push({ type: 'slot.time', slot: slot.id, patch: { fit: next } })
    return out
  }

  private async send (p: Playing, n: PiecesNow, edit: PiecesEdit, what: string, o: Parameters<ClipPieces['commands']>[3] = {}): Promise<boolean> {
    const commands = this.commands(p, n, edit, o)
    if (commands === null) return toast('The hit would fall outside the clip: keep it inside')
    return await app.do(p.character.id, commands, what) !== null
  }
}

const toast = (text: string): false => { app.toast('info', text); return false }

const keyOf = (p: Piece, inPlace: boolean): string => (p.kind === 'clip' ? `clip:${p.clip.id}|${p.clip.url ?? ''}|${inPlace ? 1 : 0}` : p.kind === 'slot' ? `slot:${p.slot}` : '')

/** A piece's name on the strip. */
export function labelOf (p: Piece, slotName: (id: string) => string): string {
  if (p.kind === 'hold') return `held ${lengthOf(p).toFixed(2)} s`
  if (p.kind === 'slot') return slotName(p.slot)
  return p.clip.id.replace(/^(mixamo|custom|bundled)-/, '').replace(/_/g, ' ')
}

export const clipPieces = new ClipPieces()
