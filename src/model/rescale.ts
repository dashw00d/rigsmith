// A character resized (Import -> Size): its files are scaled by `s` and moved by `d` (server/glbtransform.ts), and
// everything the document keeps in their units goes with them. The one list of every length in the document:
// whoever adds a field with a length adds it here.
import type { Adjustment, Character, Joints, Vec3 } from './types.ts'

/** Positions in the character's space get p·s + d; lengths get ×s. Left as they are: grip and carry handle places
 * and gear keys' moves (in the gear's placed frame, which its place.scale already sizes), a pull's rest (the gear
 * model's own space), the position of a piece still placed in the old grip frame (in bone lengths, which grow with
 * the bones), rotations, and mount.position (the horse's space). */
export function rescale (c: Character, s: number, d: Vec3): Character {
  const out = structuredClone(c)
  const at = (p: Vec3): Vec3 => [p[0] * s + d[0], p[1] * s + d[1], p[2] * s + d[2]]
  const times = (p: Vec3): Vec3 => [p[0] * s, p[1] * s, p[2] * s]
  const all = (o: Joints): Joints => Object.fromEntries(Object.entries(o).map(([k, p]) => [k, at(p)]))

  out.source.scale *= s
  if (out.source.stats !== undefined) out.source.stats.height *= s

  const sk = out.skeleton
  if (sk.detected !== undefined) sk.detected = all(sk.detected)
  if (sk.imported !== undefined) sk.imported = all(sk.imported)
  sk.overrides = all(sk.overrides)
  for (const o of sk.stale ?? []) o.at = at(o.at)
  if (sk.markers !== undefined) { sk.markers.base = all(sk.markers.base); sk.markers.positions = all(sk.markers.positions) }

  if (out.skin.rigJoints !== undefined) out.skin.rigJoints = all(out.skin.rigJoints)

  for (const g of out.gear) {
    const a = g.attach
    if (a.kind !== 'bone' || a.legacyFrame !== 'grip') a.place.position = at(a.place.position)
    a.place.scale *= s
    if (a.kind === 'spot' && a.anchor !== undefined) a.anchor = at(a.anchor)
    for (const h of g.handles) if (h.pull !== undefined) h.pull.grip = times(h.pull.grip)
  }

  for (const slot of out.clips) for (const a of slot.adjustments) lengths(a, s, times)

  if (out.mount?.hips !== undefined) out.mount.hips = times(out.mount.hips)
  return out
}

function lengths (a: Adjustment, s: number, times: (p: Vec3) => Vec3): void {
  if (a.kind === 'ground') a.lift *= s
  // (every bone's move, in its parent's frame: a human keys the Hips, a horse its hips or root)
  if (a.kind === 'keys') for (const keys of Object.values(a.bones ?? {})) for (const k of keys) if (k.p !== undefined) k.p = times(k.p)
}
