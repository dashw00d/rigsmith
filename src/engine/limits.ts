// Joint limits for the animation editor: every joint held within its range of motion as measured on real motion
// (tools/rom.ts: the library's Mixamo captures for a person, a template's own clips for a creature). A bone's local turn
// is split into where the bone points (in its parent's frame, a cell of a grid on the sphere) and its twist about
// itself (from its rest); a pose outside is put back on the nearest direction reached and the nearest twist in range.
// The ranges are kept in the measured skeleton's frames (a person's: the Y Bot's); a character's bones map onto them by
// the retarget's turns (src/engine/retarget.ts retargetOffsets: Qcharacter = Qsource * K).
import * as THREE from 'three'

export interface RomBone {
  /** The bone's axis in its own frame (towards the child that carries the chain on). */
  axis: [number, number, number]
  /** The reference rest turn (local), twists are measured from. */
  rest: [number, number, number, number]
  /** The cells reached (base64 bitmask, elevation-major). */
  cells: string
  reached: number
  /** Twist from rest, degrees. */
  twist: [number, number]
}
export interface Rom { rig: string, bins: [number, number], bones: Record<string, RomBone> }

/** Caps where the captures run past the body (noisy hands: a wrist bends 60 degrees each way, DSHS's chart). */
const SWING_CAP: Record<string, number> = { LeftHand: 70, RightHand: 70 }

function cellOf (d: THREE.Vector3, bins: [number, number]): number {
  const el = Math.acos(Math.max(-1, Math.min(1, d.y)))
  const az = Math.atan2(d.z, d.x) + Math.PI
  const i = Math.min(bins[0] - 1, Math.floor(el / Math.PI * bins[0]))
  const j = Math.min(bins[1] - 1, Math.floor(az / (2 * Math.PI) * bins[1]))
  return i * bins[1] + j
}

function centre (cell: number, bins: [number, number]): THREE.Vector3 {
  const i = Math.floor(cell / bins[1]); const j = cell % bins[1]
  const el = (i + 0.5) / bins[0] * Math.PI
  const az = (j + 0.5) / bins[1] * 2 * Math.PI - Math.PI
  return new THREE.Vector3(Math.sin(el) * Math.cos(az), Math.cos(el), Math.sin(el) * Math.sin(az))
}

/** The twist (radians, -pi..pi) of a turn about `axis`. */
export function twistOf (q: THREE.Quaternion, axis: THREE.Vector3): number {
  const t = 2 * Math.atan2(q.x * axis.x + q.y * axis.y + q.z * axis.z, q.w)
  return ((t + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
}

interface Range {
  axis: THREE.Vector3
  restInv: THREE.Quaternion
  restDir: THREE.Vector3
  allowed: Uint8Array
  directions: THREE.Vector3[]
  twist: [number, number]
}

export class JointLimits {
  private readonly ranges = new Map<string, Range>()

  /**
   * @param offsets the retarget's turns K per bone (character = measured skeleton * K), or none: the same skeleton
   * @param parentOf a bone's parent (by name) in the character's skeleton
   * @param slack how many cells round the ones reached also count (a little room past the captures); `twistSlack` degrees
   */
  readonly rom: Rom
  private readonly offsets: Map<string, THREE.Quaternion> | null
  private readonly parentOf: (bone: string) => string | null

  constructor (rom: Rom, offsets: Map<string, THREE.Quaternion> | null, parentOf: (bone: string) => string | null, slack = 1, twistSlack = 5) {
    this.rom = rom
    this.offsets = offsets
    this.parentOf = parentOf
    const [ni, nj] = rom.bins
    for (const [name, b] of Object.entries(rom.bones)) {
      const raw = Uint8Array.from(atob(b.cells), c => c.charCodeAt(0))
      const reached = new Uint8Array(ni * nj)
      for (let c = 0; c < ni * nj; c++) reached[c] = (raw[c >> 3] >> (c & 7)) & 1
      // (grown by `slack` cells each way; the azimuth wraps round)
      const allowed = new Uint8Array(ni * nj)
      for (let c = 0; c < ni * nj; c++) {
        if (reached[c] === 0) continue
        const i = Math.floor(c / nj); const j = c % nj
        for (let di = -slack; di <= slack; di++) {
          const ii = i + di
          if (ii < 0 || ii >= ni) continue
          // (near the poles a cell is narrow: grow further round)
          const wide = Math.min(nj / 2, Math.ceil(slack / Math.max(Math.sin((ii + 0.5) / ni * Math.PI), 1 / nj)))
          for (let dj = -wide; dj <= wide; dj++) allowed[ii * nj + (((j + dj) % nj) + nj) % nj] = 1
        }
      }
      const axis = new THREE.Vector3(...b.axis).normalize()
      const rest = new THREE.Quaternion(...b.rest)
      const rad = THREE.MathUtils.degToRad
      const restDir = axis.clone().applyQuaternion(rest)
      const cap = SWING_CAP[name] !== undefined ? rad(SWING_CAP[name]) : null
      // (a capped joint may point only where it was seen within the cap)
      if (cap !== null) for (let c = 0; c < ni * nj; c++) if (allowed[c] === 1 && centre(c, rom.bins).angleTo(restDir) > cap) allowed[c] = 0
      const directions: THREE.Vector3[] = []
      for (let c = 0; c < ni * nj; c++) if (allowed[c] === 1) directions.push(centre(c, rom.bins))
      this.ranges.set(name, {
        axis, restInv: rest.clone().invert(), restDir, allowed, directions,
        twist: [rad(b.twist[0] - twistSlack), rad(b.twist[1] + twistSlack)],
      })
    }
  }

  has (bone: string): boolean { return this.ranges.has(bone) && (this.offsets === null || this.offsets.has(bone)) }

  /** The character's local turn `local` of `bone` in the measured skeleton's frames, and back. */
  private toSource (bone: string, local: THREE.Quaternion): THREE.Quaternion | null {
    if (this.offsets === null) return local.clone()
    const parent = this.parentOf(bone)
    const kb = this.offsets.get(bone)
    const kp = parent === null ? null : this.offsets.get(parent)
    if (kb === undefined || kp === undefined || kp === null) return null
    return kp.clone().multiply(local).multiply(kb.clone().invert())
  }

  private fromSource (bone: string, local: THREE.Quaternion): THREE.Quaternion {
    if (this.offsets === null) return local
    const kb = this.offsets.get(bone)!
    const kp = this.offsets.get(this.parentOf(bone)!)!
    return kp.clone().invert().multiply(local).multiply(kb)
  }

  /** Is the bone's local turn within its range? */
  within (bone: string, local: THREE.Quaternion): boolean {
    const r = this.ranges.get(bone)
    const ls = this.toSource(bone, local)
    if (r === undefined || ls === null) return true
    const dir = r.axis.clone().applyQuaternion(ls)
    const tw = twistOf(r.restInv.clone().multiply(ls), r.axis)
    return r.allowed[cellOf(dir, this.rom.bins)] === 1 && tw >= r.twist[0] && tw <= r.twist[1]
  }

  /** The bone's local turn held within its range: the nearest direction it may point, the nearest twist it may take. */
  clamp (bone: string, local: THREE.Quaternion): THREE.Quaternion {
    const r = this.ranges.get(bone)
    const ls = this.toSource(bone, local)
    if (r === undefined || ls === null) return local.clone()
    let q = ls.clone()
    let dir = r.axis.clone().applyQuaternion(q)
    // where it points
    let to: THREE.Vector3 | null = null
    if (r.allowed[cellOf(dir, this.rom.bins)] === 0 && r.directions.length > 0) {
      let best = -2
      for (const d of r.directions) { const k = d.dot(dir); if (k > best) { best = k; to = d } }
    }
    if (to !== null) {
      q = new THREE.Quaternion().setFromUnitVectors(dir, to).multiply(q)
      dir = to
    }
    // its twist
    const tw = twistOf(r.restInv.clone().multiply(q), r.axis)
    const held = Math.min(r.twist[1], Math.max(r.twist[0], tw))
    if (held !== tw) q.multiply(new THREE.Quaternion().setFromAxisAngle(r.axis, held - tw))
    if (to === null && held === tw) return local.clone()
    return this.fromSource(bone, q.normalize())
  }
}
