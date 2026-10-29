// What the Gear lanes and inspector draw and write for one piece (GearLanes.svelte, GearInspector.svelte): its
// Held-by strip (segments, one per holder, split at a moment, boundaries dragged, a holder set per segment) and its
// Shown strip (hidden spans drawn, dragged, removed). Pure: every function takes a slot's stored entries (source
// time) and returns the next ones, which the components send as one slot.gear.update. Drawing is in played phases
// (the lanes' `toPlayed`); the stored moments stay source time.
import { hierarchyOf } from '../../../model/select.ts'
import { MAX_U, type Character, type Gear, type GearTrack, type HeldBy, type Placement } from '../../../model/types.ts'

export type Held = NonNullable<GearTrack['heldBy']>
export type Shown = NonNullable<GearTrack['shown']>

/** Two stored moments closer than this are one (the commands refuse them): a boundary keeps this far from its neighbours. */
export const GAP = 1e-3

/** One segment of the Held-by strip: who holds it over [from, to) (played phases, clamped to the clip), `index` its
 * entry in heldBy (-1: before the first, the Gear attach bone). */
export interface Segment { index: number, from: number, to: number, bone: string, how: 'gear' | 'place' | 'handle' | 'placed' | 'free', handle?: string }

/** The piece's holders over the clip, in played phases. */
export function segmentsOf (g: Gear, held: Held, toPlayed: (u: number) => number): Segment[] {
  const attach = g.attach.kind === 'bone' ? g.attach.bone : 'its place'
  const out: Segment[] = [{ index: -1, from: 0, to: 1, bone: attach, how: 'gear' }]
  held.forEach((x, index) => {
    const from = Math.min(1, Math.max(0, toPlayed(x.u)))
    const seg: Segment = { index, from, to: 1, bone: x.bone, how: holdHow(x), ...(x.handle !== undefined ? { handle: x.handle } : {}) }
    const last = out[out.length - 1]
    last.to = from
    out.push(seg)
  })
  // (a holder from before the clip's start, or after its end, has no length here)
  return out.filter(s => s.to - s.from > 1e-9)
}

export const holdHow = (x: HeldBy): Segment['how'] => (x.place !== undefined ? 'place' : x.handle !== undefined ? 'handle' : x.placed === true ? 'placed' : 'free')

/** The holder at source moment `u` (an entry, or null: the Gear attach bone). */
export function holderAt (held: Held, u: number): HeldBy | null {
  return held.findLast(x => x.u <= u + 1e-9) ?? null
}

/** A boundary added at `u`: the segment there split in two, the new one held by the same bone where it is (nothing
 * moves until its holder is set). Null when `u` is on (or within GAP of) a boundary already, or outside the clip. */
export function splitAt (g: Gear, held: Held, u: number): Held | null {
  if (u < 0 || held.some(x => Math.abs(x.u - u) < GAP)) return null
  const at = holderAt(held, u)
  const bone = at?.bone ?? (g.attach.kind === 'bone' ? g.attach.bone : null)
  if (bone === null) return null
  return sorted([...held, { u, bone }])
}

/** Boundary `index` moved to `u`, kept between its neighbours. */
export function moveBoundary (held: Held, index: number, u: number): Held {
  const lo = index > 0 ? held[index - 1].u + GAP : 0
  const hi = index < held.length - 1 ? held[index + 1].u - GAP : Infinity
  return held.map((x, i) => (i === index ? { ...x, u: Math.min(hi, Math.max(lo, u)) } : x))
}

/** Boundary `index` taken out: its segment joins the one before. */
export function removeBoundary (held: Held, index: number): Held {
  return held.filter((_, i) => i !== index)
}

/** Who a segment's holder is: a bone (where it is: no pop), a handle of the piece on a hand, its Gear placement on its
 * own bone, or a placement pinned. */
export type Holder = { bone: string } | { bone: string, handle: string } | { bone: string, placed: true } | { bone: string, place: Placement }

/** Segment `index`'s holder set (-1: from the clip's start, an entry at 0). */
export function setHolder (held: Held, index: number, holder: Holder): Held {
  const entry = (u: number): HeldBy => ({ u, ...holder })
  if (index >= 0) return held.map((x, i) => (i === index ? entry(x.u) : x))
  const first = held[0]
  if (first !== undefined && first.u <= GAP) return held.map((x, i) => (i === 0 ? entry(0) : x))
  return sorted([entry(0), ...held])
}

/** The holders a piece can have, as the inspector lists them: its handles on the hands they are for, its Gear
 * placement on its own bone, then the bones (the usual holders first: hands, back, hips, forearms, head, thighs; then
 * the skeleton's other joints but fingers and end joints). Each with the Holder it sets and a label. */
export function holderOptions (c: Pick<Character, 'skeleton'>, g: Gear): Array<{ value: string, label: string, group: string, holder: Holder }> {
  const out: Array<{ value: string, label: string, group: string, holder: Holder }> = []
  const attach = g.attach.kind === 'bone' ? g.attach.bone : null
  const joints = hierarchyOf(c).map(([j]) => j)
  if (attach !== null) out.push({ value: `placed:${attach}`, label: `${attach}, as placed in Gear`, group: 'Its places', holder: { bone: attach, placed: true } })
  for (const h of g.handles) {
    if (h.kind === 'pull') continue
    const bone = h.kind === 'carry' ? attach : h.hand !== undefined ? `${h.hand}Hand` : null
    const bones = bone !== null ? [bone] : ['LeftHand', 'RightHand']
    for (const b of bones) if (joints.includes(b)) out.push({ value: `handle:${h.id}:${b}`, label: `${handName(b)} on ${h.name}`, group: 'Its places', holder: { bone: b, handle: h.id } })
  }
  const usual = ['RightHand', 'LeftHand', 'Spine2', 'Spine1', 'Spine', 'Hips', 'LeftForeArm', 'RightForeArm', 'Head', 'LeftUpLeg', 'RightUpLeg']
  for (const b of usual) if (joints.includes(b)) out.push({ value: `bone:${b}`, label: boneName(b), group: 'Where it is, on', holder: { bone: b } })
  // (fingers and the chains' end joints hold nothing)
  for (const b of joints) if (!usual.includes(b) && !/Hand(Thumb|Index|Middle|Ring|Pinky)\d|_End$/.test(b)) out.push({ value: `bone:${b}`, label: b, group: 'Other bones', holder: { bone: b } })
  return out
}

/** The option value of a stored holder (null for a pinned placement, or none listed). */
export function holderValue (x: HeldBy | null, g: Gear): string | null {
  if (x === null) return g.attach.kind === 'bone' ? `placed:${g.attach.bone}` : null
  if (x.place !== undefined) return null
  if (x.handle !== undefined) return `handle:${x.handle}:${x.bone}`
  if (x.placed === true) return `placed:${x.bone}`
  return `bone:${x.bone}`
}

const handName = (b: string): string => (b === 'LeftHand' ? 'Left hand' : b === 'RightHand' ? 'Right hand' : b)
const NAMES: Record<string, string> = { RightHand: 'Right hand', LeftHand: 'Left hand', Spine2: 'Back (Spine2)', Spine1: 'Spine1', Spine: 'Belly (Spine)', Hips: 'Hips (belt)', LeftForeArm: 'Left forearm', RightForeArm: 'Right forearm', Head: 'Head', LeftUpLeg: 'Left thigh', RightUpLeg: 'Right thigh' }
export const boneName = (b: string): string => NAMES[b] ?? b

// ---- shown ----------------------------------------------------------------------------------------------------------

/** A hidden span of the Shown strip: [from, to) in source time (`to` Infinity: to the end), the entries that start and
 * end it (`end` -1: none, it stays hidden). */
export interface Span { from: number, to: number, start: number, end: number }

/** The hidden spans (source time; before the first entry it is shown). */
export function hiddenOf (shown: Shown): Span[] {
  const out: Span[] = []
  let open: { from: number, start: number } | null = null
  shown.forEach((x, i) => {
    if (!x.shown && open === null) open = { from: x.u, start: i }
    else if (x.shown && open !== null) { out.push({ ...open, to: x.u, end: i }); open = null }
  })
  if (open !== null) out.push({ ...(open as { from: number, start: number }), to: Infinity, end: -1 })
  return out
}

/** The entries for these hidden spans (each [from, to], source time; `to` Infinity: hidden to the end), spans that
 * touch or overlap merged, none shorter than GAP. */
export function shownFrom (spans: Array<[number, number]>): Shown {
  const xs = spans.map(([a, b]): [number, number] => [Math.max(0, Math.min(a, b)), Math.max(a, b)]).filter(([a, b]) => b - a >= GAP).sort((p, q) => p[0] - q[0])
  const merged: Array<[number, number]> = []
  for (const s of xs) {
    const last = merged[merged.length - 1]
    if (last !== undefined && s[0] <= last[1] + GAP) last[1] = Math.max(last[1], s[1])
    else merged.push([s[0], s[1]])
  }
  return merged.flatMap(([a, b]) => (b === Infinity ? [{ u: a, shown: false }] : [{ u: a, shown: false }, { u: b, shown: true }]))
}

const spansOf = (shown: Shown): Array<[number, number]> => hiddenOf(shown).map(s => [s.from, s.to])

/** Hidden over [a, b] too. */
export function hide (shown: Shown, a: number, b: number): Shown { return shownFrom([...spansOf(shown), [a, b]]) }

/** Hidden span `i` moved by `du` (its length kept, inside the clip), or one edge of it to `u`. */
export function moveSpan (shown: Shown, i: number, du: number): Shown {
  return shownFrom(spansOf(shown).map(([a, b], k): [number, number] => {
    if (k !== i) return [a, b]
    // (hidden to the end: its start moves, it stays hidden to the end)
    if (b === Infinity) return [Math.max(0, a + du), Infinity]
    const d = Math.min(MAX_U - b, Math.max(-a, du))
    return [a + d, b + d]
  }))
}
export function moveEdge (shown: Shown, i: number, edge: 'from' | 'to', u: number): Shown {
  return shownFrom(spansOf(shown).map(([a, b], k) => (k !== i ? [a, b] : edge === 'from' ? [Math.min(u, b - GAP), b] : [a, Math.max(u, a + GAP)])))
}

/** Hidden span `i` taken out. */
export function unhide (shown: Shown, i: number): Shown { return shownFrom(spansOf(shown).filter((_, k) => k !== i)) }

/** Shown or hidden from `u` to the next change: a hidden span begun (to the end, or to the next span) or ended there. */
export function toggleFrom (shown: Shown, u: number): Shown {
  const spans = spansOf(shown)
  const inside = spans.findIndex(([a, b]) => u >= a - 1e-9 && u < b)
  if (inside >= 0) {
    const [a] = spans[inside]
    return shownFrom(spans.map((s, k) => (k === inside ? [a, u] : s)))
  }
  const next = spans.find(([a]) => a > u)
  return shownFrom([...spans, [u, next !== undefined ? next[0] : Infinity]])
}

function sorted (held: Held): Held { return [...held].sort((a, b) => a.u - b.u) }
