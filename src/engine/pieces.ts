// A slot's source clip (docs/motion-plan.md §11.4): its clip as the clip source retargets it, or, for a slot built from
// pieces, their composite: each piece's content (a library clip from the ClipSource, another slot as it plays, a held
// pose) read over its range, each moving piece turned and moved over the ground so it comes in standing and facing
// where the clip before left off, neighbours cross-faded over their blends, all on KEY_FPS frames. Pure three.js on
// whatever ClipSource it is given (the browser's RetargetCache, node's nodeClipSource), so the viewer and the export
// compose alike; nothing is written.
import * as THREE from 'three'
import type { Character, Piece, Slot } from '../model/types.ts'
import { layoutOf, piecesAt, type Placed } from '../model/pieces.ts'
import type { ClipSource } from './clips.ts'
import { frameTimes } from './keys.ts'
import { pelvisName, restUpOf, type RestSkeleton } from './retarget.ts'

export interface SourceContext { rest: RestSkeleton, clips: ClipSource, fps?: number }

/** What a slot piece plays: that slot baked (its bone tracks; the bake's own, so it is its result as it plays). */
export type SlotBaker = (slot: Slot) => Promise<THREE.AnimationClip>

/** The clip a slot's time map plays: `slot.clip` from the clip source (the one call it always was) or, with pieces,
 * their composite. `via`: the slots whose pieces led here (one of them again: it plays itself, refused). */
export async function sourceClip (c: Character, slot: Slot, ctx: SourceContext, o: { mirror?: boolean, bakeSlot: SlotBaker, via?: readonly string[] }): Promise<THREE.AnimationClip> {
  if (slot.pieces === undefined) return await ctx.clips.get(slot.clip, { inPlace: slot.inPlace, mirror: o.mirror, fps: ctx.fps })
  // (library clips only: the same pieces compose the same, so it is kept per clip source; a slot piece may change)
  const cacheable = slot.pieces.every(p => p.kind !== 'slot')
  const key = cacheable ? JSON.stringify([slot.pieces, slot.inPlace, o.mirror === true, ctx.fps ?? 30, slot.name]) : ''
  let kept = cacheable ? composites.get(ctx.clips) : undefined
  if (cacheable && kept === undefined) { kept = new Map(); composites.set(ctx.clips, kept) }
  const hit = kept?.get(key)
  if (hit !== undefined) return await hit
  const made = compose(c, slot, slot.pieces, ctx, o)
  if (kept !== undefined) {
    kept.set(key, made)
    if (kept.size > 64) kept.delete(kept.keys().next().value!)
    made.catch(() => kept.delete(key))
  }
  return await made
}

const composites = new WeakMap<ClipSource, Map<string, Promise<THREE.AnimationClip>>>()

async function compose (c: Character, slot: Slot, pieces: readonly Piece[], ctx: SourceContext, o: { mirror?: boolean, bakeSlot: SlotBaker, via?: readonly string[] }): Promise<THREE.AnimationClip> {
  const via = [...(o.via ?? []), slot.id]
  const contents = await Promise.all(pieces.map(async (p): Promise<THREE.AnimationClip | null> => {
    if (p.kind === 'hold') return null
    if (p.kind === 'clip') return await ctx.clips.get(p.clip, { inPlace: slot.inPlace, mirror: o.mirror, fps: ctx.fps })
    if (via.includes(p.slot)) throw new Error(`clip ${slot.name} plays itself (through its pieces)`)
    const other = c.clips.find(s => s.id === p.slot)
    if (other === undefined) throw new Error(`clip ${slot.name}: no clip ${p.slot} to play as a piece`)
    return await o.bakeSlot(other)
  }))
  return composePieces(pieces, contents, ctx.rest, slot.name)
}

/** The bone tracks a clip has, by bone (node name and property). */
type Value = number[]
interface Reader { size: number, at: (t: number) => Value }

/** The composite of `pieces` (`contents[i]` piece i's clip; null for a hold) on `rest`'s bones. */
export function composePieces (pieces: readonly Piece[], contents: ReadonlyArray<THREE.AnimationClip | null>, rest: RestSkeleton, name = 'pieces'): THREE.AnimationClip {
  const layout = layoutOf(pieces)
  const D = Math.max(layout.seconds, 1 / 30)
  const nodes = new Set([...rest.bones.values()].map(b => b.node.name))
  const isBone = (track: string): boolean => nodes.has(track.slice(0, track.lastIndexOf('.')))
  // (every bone track any piece has, in the order the first that has it has them)
  const names: string[] = []
  const kinds = new Map<string, 'quaternion' | 'vector'>()
  for (const clip of contents) {
    for (const t of clip?.tracks ?? []) {
      if (!isBone(t.name) || kinds.has(t.name)) continue
      names.push(t.name)
      kinds.set(t.name, t.getValueSize() === 4 ? 'quaternion' : 'vector')
    }
  }
  const restOf = new Map<string, Value>()
  for (const b of rest.bones.values()) {
    restOf.set(`${b.node.name}.quaternion`, b.localQuaternion.toArray())
    restOf.set(`${b.node.name}.position`, b.localPosition.toArray())
    restOf.set(`${b.node.name}.scale`, b.localScale.toArray())
  }
  const readers = contents.map(clip => {
    const out = new Map<string, Reader>()
    for (const t of clip?.tracks ?? []) {
      if (!kinds.has(t.name)) continue
      const size = t.getValueSize()
      const interpolant = (t as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant()
      const end = clip!.duration
      out.set(t.name, { size, at: time => Array.from(interpolant.evaluate(Math.min(end, Math.max(0, time))) as ArrayLike<number>).slice(0, size) })
    }
    return out
  })
  const fallback = (track: string): Value => restOf.get(track) ?? (kinds.get(track) === 'quaternion' ? [0, 0, 0, 1] : [0, 0, 0])

  // the hips: what the root continuation turns and moves
  const pelvis = pelvisName(rest)
  const hipsNode = rest.bones.get(pelvis)?.node.name
  const hq = hipsNode === undefined ? '' : `${hipsNode}.quaternion`
  const hp = hipsNode === undefined ? '' : `${hipsNode}.position`
  const up = restUpOf(rest, pelvis).normalize()

  /** Piece i's own pose at `local` seconds into it (a hold's: what was set for it), before its root continuation. */
  const holdPoses = new Map<number, Map<string, Value>>()
  const roots: Array<{ turn: THREE.Quaternion, pivot: THREE.Vector3, shift: THREE.Vector3 } | null> = pieces.map(() => null)
  const own = (i: number, track: string, local: number): Value => {
    const held = holdPoses.get(i)
    if (held !== undefined) return held.get(track) ?? fallback(track)
    const r = readers[i].get(track)
    return r === undefined ? fallback(track) : r.at(pieces[i].from + local)
  }
  /** Piece i's pose as composed (its root continuation on the hips). */
  const posed = (i: number, track: string, local: number): Value => {
    const v = own(i, track, local)
    const root = roots[i]
    if (root === null || (track !== hq && track !== hp)) return v
    if (track === hq) return root.turn.clone().multiply(new THREE.Quaternion().fromArray(v)).toArray()
    return new THREE.Vector3().fromArray(v).sub(root.pivot).applyQuaternion(root.turn).add(root.pivot).add(root.shift).toArray()
  }
  const poseOf = (i: number, local: number): Map<string, Value> => new Map(names.map(t => [t, posed(i, t, local)]))

  // each piece in turn: a hold takes the composed pose where the piece before ends (the first moving piece's first one
  // for holds before it); a moving piece after the first stands and faces where the clip is as it comes in
  const first = pieces.findIndex(p => p.kind !== 'hold')
  for (const [i, p] of pieces.entries()) {
    if (p.kind === 'hold') {
      if (i < first) continue
      holdPoses.set(i, poseOf(i - 1, layout.placed[i - 1].length))
      continue
    }
    if (i <= first || hipsNode === undefined) continue
    const prev = layout.placed[i - 1]
    const at = prev.length - layout.placed[i].blend
    const targetQ = new THREE.Quaternion().fromArray(posed(i - 1, hq, at))
    const targetP = new THREE.Vector3().fromArray(posed(i - 1, hp, at))
    const startQ = new THREE.Quaternion().fromArray(own(i, hq, 0))
    const startP = new THREE.Vector3().fromArray(own(i, hp, 0))
    const turn = twist(targetQ.clone().multiply(startQ.clone().invert()), up)
    const shift = targetP.clone().sub(startP)
    shift.sub(up.clone().multiplyScalar(shift.dot(up)))
    roots[i] = { turn, pivot: startP, shift }
  }
  if (first > 0) {
    const start = poseOf(first, 0)
    for (let i = 0; i < first; i++) holdPoses.set(i, start)
  }

  const times = frameTimes(D)
  const values = new Map(names.map(t => [t, [] as number[]]))
  const q = new THREE.Quaternion(); const q2 = new THREE.Quaternion()
  for (const t of times) {
    const on = piecesAt(layout, t)
    const parts: Placed[] = on.length === 0 ? [layout.placed[layout.placed.length - 1]] : on.slice(-2)
    const [a, b] = parts.length === 2 ? parts : [parts[0], null]
    const w = b === null ? 0 : b.blend <= 1e-9 ? 1 : smooth((t - b.start) / b.blend)
    for (const track of names) {
      const va = posed(a.index, track, Math.min(a.length, t - a.start))
      let v = va
      if (b !== null && w > 0) {
        const vb = posed(b.index, track, Math.max(0, t - b.start))
        if (w >= 1) v = vb
        else if (kinds.get(track) === 'quaternion') v = q.fromArray(va).slerp(q2.fromArray(vb), w).toArray()
        else v = va.map((x, k) => x + (vb[k] - x) * w)
      }
      values.get(track)!.push(...v)
    }
  }
  const tracks = names.map(n => kinds.get(n) === 'quaternion' ? new THREE.QuaternionKeyframeTrack(n, times, values.get(n)!) : new THREE.VectorKeyframeTrack(n, times, values.get(n)!))
  return new THREE.AnimationClip(name, D, tracks)
}

/** The part of a turn about `axis` (its twist). */
export function twist (q: THREE.Quaternion, axis: THREE.Vector3): THREE.Quaternion {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z
  const t = new THREE.Quaternion(axis.x * d, axis.y * d, axis.z * d, q.w)
  const length = t.length()
  return length < 1e-12 ? new THREE.Quaternion() : t.normalize()
}

const smooth = (x: number): number => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c) }
