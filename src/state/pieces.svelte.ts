// The Clip strip's edits (docs/motion-plan.md §11): the slot playing's pieces as the timeline shows them (played phases
// of one cycle), and every gesture of the strip (drag the clip's end or start, type a length, insert time at the
// playhead, append a clip or another slot, trim, blend, reorder, remove a piece) sent as one batch: one undo. The
// commands are src/model/pieceplan.ts's (pure); this hands it what the bake and the clip source know (the played range,
// the blow, the clips' lengths) and sends them.
import type { Command } from '../model/command-types.ts'
import { newId } from '../model/ids.ts'
import { DEFAULT_BLEND, lengthOf } from '../model/pieces.ts'
import {
  contentKey, nowOf, planAppend, planBlend, planEnd, planInsert, planMove, planPatch, planRemove, planStart, planTrim, type Plan, type PiecesNow, type PlanSlot,
} from '../model/pieceplan.ts'
import type { Character, Piece, Slot } from '../model/types.ts'
import { app } from './app.svelte.ts'
import { animator } from './animator.svelte.ts'
import type { Playing } from './timeline.svelte.ts'

/** A piece as the strip shows it: where it plays (played phases of one cycle) and its blend in. */
export interface ShownPiece { piece: Piece, index: number, from: number, to: number, blendTo: number, label: string, whole: boolean }

class ClipPieces {
  /** Content lengths by piece key ('clip:<id>|<url>|<inPlace>', 'slot:<id>'), as the bake gave them. */
  lengths = $state.raw<Record<string, number>>({})

  /** The slot playing's pieces (its clip whole when it has none), or null before its first bake. */
  now (p: Playing | null): PiecesNow | null {
    const s = p === null ? null : this.plan(p)
    return s === null ? null : nowOf(s)
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
    return this.lengths[contentKey(piece, p.slot.inPlace, p.character)]
  }

  /** The length of the slot's own clip (what a slot playing it whole lasts), when known. */
  ownSeconds (p: Playing): number | undefined {
    if (p.slot.pieces === undefined) return p.baked?.raw.duration
    return this.lengths[contentKey({ id: 'own', kind: 'clip', clip: p.slot.clip, from: 0, to: 1 }, p.slot.inPlace, p.character)]
  }

  /** The content lengths of the slot's pieces looked up (once each). */
  async measure (p: Playing): Promise<void> {
    if (p.slot.pieces === undefined) return
    // (the slot's own clip too: a list that is that clip whole again is stored as none, which needs its length)
    const own: Piece = { id: 'own', kind: 'clip', clip: p.slot.clip, from: 0, to: 1 }
    for (const piece of [own, ...p.slot.pieces]) {
      if (piece.kind === 'hold') continue
      const key = contentKey(piece, p.slot.inPlace, p.character)
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

  /** What the plans read of the slot playing (null before its first bake). */
  plan (p: Playing): PlanSlot | null {
    if (p.baked === null) return null
    return {
      slot: p.slot, map: p.map, duration: p.duration, seconds: p.baked.raw.duration, cut: p.baked.cut,
      own: this.ownSeconds(p), content: piece => this.contentOf(p, piece),
    }
  }

  // ---- the gestures (src/model/pieceplan.ts), each one batch: one undo ------------------------------------------

  /** The played clip's end moved to played phase `v` (past 1: longer, held; before: shorter). */
  endTo = async (p: Playing, v: number): Promise<boolean> => await this.run(p, s => planEnd(s, v, newId), v > 1 ? 'longer clip' : 'shorter clip')
  /** The played clip's start moved to played phase `v` (below 0: longer, held from its first pose; above: shorter). */
  startTo = async (p: Playing, v: number): Promise<boolean> => await this.run(p, s => planStart(s, v, newId), v < 0 ? 'longer clip' : 'shorter clip')
  /** The played clip made `seconds` long (typed): its end moved. */
  async setLength (p: Playing, seconds: number): Promise<boolean> {
    if (!(seconds > 1 / 30)) return toast('A clip lasts at least a frame')
    return await this.endTo(p, seconds / Math.max(1e-9, p.duration))
  }
  /** `seconds` (played) of held pose put in at played phase `v` (the playhead). */
  insertTime = async (p: Playing, v: number, seconds: number): Promise<boolean> => await this.run(p, s => planInsert(s, v, seconds, newId), 'insert time')
  /** A clip or another slot's range put after the clip as it plays, blended in. */
  append = async (p: Playing, piece: Piece, blend = DEFAULT_BLEND): Promise<boolean> => await this.run(p, s => planAppend(s, piece, blend, newId), 'append')
  trim = async (p: Playing, id: string, edge: 'start' | 'end', dv: number): Promise<boolean> => await this.run(p, s => planTrim(s, id, edge, dv, newId), 'trim')
  /** A piece's range (seconds of its content) and blend (seconds of the source) as typed. */
  update = async (p: Playing, id: string, patch: { from?: number, to?: number, blend?: number }): Promise<boolean> => await this.run(p, s => planPatch(s, id, patch, newId), 'piece')
  blend = async (p: Playing, id: string, seconds: number): Promise<boolean> => await this.run(p, s => planBlend(s, id, seconds, newId), 'blend')
  move = async (p: Playing, id: string, index: number): Promise<boolean> => await this.run(p, s => planMove(s, id, index, newId), 'reorder')
  remove = async (p: Playing, ids: string[]): Promise<boolean> => await this.run(p, s => planRemove(s, ids, newId), 'remove a piece')

  /** The commands that take `ids` out (null: they can't go), for the timeline's Delete. */
  removeCommands (p: Playing, ids: string[]): Command[] | null {
    const s = this.plan(p)
    const plan = s === null ? null : planRemove(s, ids, newId)
    return plan === null || 'problem' in plan ? null : plan.commands
  }

  private async run (p: Playing, make: (s: PlanSlot) => Plan, what: string): Promise<boolean> {
    const s = this.plan(p)
    if (s === null) return false
    const plan = make(s)
    if ('problem' in plan) return toast(plan.problem)
    return await app.do(p.character.id, plan.commands, what) !== null
  }
}

const toast = (text: string): false => { app.toast('info', text); return false }

/** A piece's name on the strip. */
export function labelOf (p: Piece, slotName: (id: string) => string): string {
  if (p.kind === 'hold') return `held ${lengthOf(p).toFixed(2)} s`
  if (p.kind === 'slot') return slotName(p.slot)
  return p.clip.id.replace(/^(mixamo|custom|bundled)-/, '').replace(/_/g, ' ')
}

export const clipPieces = new ClipPieces()
