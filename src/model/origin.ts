// A piece's origin moved (the designer, 2026-10-29: "we really need to handle origin and alignment better. Half the
// items origins are world center instead of item"). Gear.origin is a point of the model's own space; the model is
// loaded moved by minus it, so whatever is kept in the piece's own frame is about it. Moving the origin by `o` (a point
// of the piece's frame as it is now) carries every one of those over, so nothing moves:
//   placement   P' = P · T(o): its position moves by its turn and size applied to o, its turn and size stay
//   handles     a grip's or a carry handle's place (the wrist in the piece's frame) moves by -o, its turn stays
//   pulls       the rest point on the piece moves by -o (the grip, in the pulling bone's frame, stays)
//   gear keys   K' = T(-o) · K · T(o) (a key's move and turn are in the piece's placed frame): p' = p + q·o - o
//   holders     a held-by `place` (rest space, rigid; the piece sized by its Gear placement): moves by its turn
//               applied to o times the Gear size, as the placement does
// A leading piece's keys (slot.ik.lead) are world moves and turns about its origin from where it rode in the clip:
// only a bake can carry them (where it rode at each key), so the caller gives them (gear.origin `lead`).
// At every key the piece is exactly where it was; between two keys that turn it, a key tweens about its new origin
// (the point of moving it), so a turn swept between keys sweeps round the new point.
// Painted weights are per vertex and stay; library clips' gear paths are kept by gear name for any character and stay.
// Pure: the model has no three.js, so the few turns needed are written out here (three's XYZ Euler order).
import type { Character, ClipKey, Gear, Quat, Vec3 } from './types.ts'

const DEG = Math.PI / 180

/** The turn of a placement's XYZ degrees, as three's Euler (order XYZ) gives it. */
export function eulerQuat (deg: readonly number[]): Quat {
  const [x, y, z] = deg.map(d => d * DEG / 2)
  const c1 = Math.cos(x); const c2 = Math.cos(y); const c3 = Math.cos(z)
  const s1 = Math.sin(x); const s2 = Math.sin(y); const s3 = Math.sin(z)
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3]
}

/** `v` turned by the unit quaternion `q` ([x, y, z, w]). */
export function rotate (q: readonly number[], v: readonly number[]): Vec3 {
  const [x, y, z, w] = q
  const n = Math.hypot(x, y, z, w) || 1
  const qx = x / n; const qy = y / n; const qz = z / n; const qw = w / n
  // v + 2w (q × v) + 2 q × (q × v)
  const tx = 2 * (qy * v[2] - qz * v[1]); const ty = 2 * (qz * v[0] - qx * v[2]); const tz = 2 * (qx * v[1] - qy * v[0])
  return [v[0] + qw * tx + (qy * tz - qz * ty), v[1] + qw * ty + (qz * tx - qx * tz), v[2] + qw * tz + (qx * ty - qy * tx)]
}

const add = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const times = (a: readonly number[], s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
// (-0 kept as 0: the same numbers compare the same)
const tidy = (v: Vec3): Vec3 => v.map(x => (Object.is(x, -0) ? 0 : x)) as Vec3

/** A gear key carried into a frame whose origin is `o` of the old one: K' = T(-o) · K · T(o). A key without a move
 * gets one only when its turn moves the origin. */
export function rebasedKey (k: ClipKey, o: readonly number[]): ClipKey {
  const p = tidy(sub(add(k.p ?? [0, 0, 0], rotate(k.q, o)), o))
  if (k.p === undefined && p.every(x => x === 0)) return { ...k }
  return { ...k, p }
}

/** Where a piece's origin is in its model's own space ([0, 0, 0]: the file's own). */
export const originOf = (g: Pick<Gear, 'origin'>): Vec3 => g.origin ?? [0, 0, 0]

/** What moving the origin carried over, for the journal. */
export interface Rebased { handles: number, pulls: number, slots: string[], leadKept: string[] }

/**
 * Move `g`'s origin to `origin` (a point of its model's own space; null: the file's own), in place on `c`, carrying
 * everything kept in its frame over (above). `lead`: the keys of the slots it leads in, already carried (by slot id).
 */
export function rebaseGear (c: Character, g: Gear, origin: Vec3 | null, lead: Record<string, ClipKey[]> = {}): Rebased {
  const o = sub(origin ?? [0, 0, 0], originOf(g))
  const out: Rebased = { handles: 0, pulls: 0, slots: [], leadKept: [] }
  if (origin === null || origin.every(x => x === 0)) delete g.origin
  else g.origin = tidy([...origin] as Vec3)
  if (o.every(x => x === 0)) return out
  const place = g.attach.place
  // (the placement's position, then its turn, then its size: P · T(o) moves the position by turn · size · o)
  place.position = tidy(add(place.position, rotate(eulerQuat(place.rotation), times(o, place.scale))))
  for (const h of g.handles) {
    if (h.place !== undefined) { h.place = { ...h.place, position: tidy(sub(h.place.position, o)) }; out.handles++ }
    if (h.pull !== undefined) { h.pull = { ...h.pull, rest: tidy(sub(h.pull.rest, o)) }; out.pulls++ }
  }
  const size = place.scale
  for (const s of c.clips) {
    const track = s.gear?.[g.id]
    if (track === undefined) continue
    const next = { ...track }
    let changed = false
    if (track.keys !== undefined && track.keys.length > 0) {
      if (s.ik?.lead?.includes(g.id) === true) {
        if (lead[s.id] !== undefined) { next.keys = lead[s.id].map(k => ({ ...k })); changed = true } else out.leadKept.push(s.name)
      } else {
        next.keys = track.keys.map(k => rebasedKey(k, o))
        changed = true
      }
    }
    if (track.heldBy?.some(x => x.place !== undefined) === true) {
      next.heldBy = track.heldBy.map(x => x.place === undefined ? x
        : { ...x, place: { ...x.place, position: tidy(add(x.place.position, rotate(eulerQuat(x.place.rotation), times(o, size)))) } })
      changed = true
    }
    if (!changed) continue
    s.gear = { ...s.gear, [g.id]: next }
    out.slots.push(s.name)
  }
  return out
}
