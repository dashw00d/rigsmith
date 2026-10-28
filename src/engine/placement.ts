// Where a piece of gear sits in its character's rest space (src/model/types.ts Placement): the one function the viewer
// (garments.ts), the bake (bake.ts) and the game export (tools/lib/unit_export.ts) all place it by, so the game gets
// it where Rigsmith shows it. Also the placement read back from a node the gizmo moved, and the move of a piece over
// to the other side of the body (from one hand into the other).
import * as THREE from 'three'
import type { Placement } from '../model/types.ts'
import { smallestAxis } from './geom.ts'

type Place = Pick<Placement, 'position' | 'rotation' | 'scale'>

/** position, then the XYZ turn in degrees, then the uniform scale. */
export function placementMatrix (place: Place): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...place.rotation.map(d => THREE.MathUtils.degToRad(d)) as [number, number, number]))
  return new THREE.Matrix4().compose(new THREE.Vector3(...place.position), q, new THREE.Vector3(place.scale, place.scale, place.scale))
}

/** The same (the name the bake and the export call it by). */
export const garmentMatrix = placementMatrix

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4
const deg = (v: number): number => Math.round(THREE.MathUtils.radToDeg(v) * 10) / 10

/** A placement as it is kept (position and scale to 1e-4, degrees to a tenth) from a transform. A mirror's negative
 * scale is taken as its size: callers keep their transforms proper turns. */
export function placementOf (o: { position: THREE.Vector3, quaternion: THREE.Quaternion, scale: THREE.Vector3 }): Placement {
  const e = new THREE.Euler().setFromQuaternion(o.quaternion)
  // (-0 kept as 0: the same placement typed twice compares the same)
  const z = (v: number): number => (Object.is(v, -0) ? 0 : v)
  return {
    position: [z(r4(o.position.x)), z(r4(o.position.y)), z(r4(o.position.z))],
    rotation: [z(deg(e.x)), z(deg(e.y)), z(deg(e.z))],
    scale: Math.max(1e-4, r4(Math.abs(o.scale.x))),
  }
}

/** A placement from a matrix (its turn and its first axis' size). */
export function placementFromMatrix (m: THREE.Matrix4): Placement {
  const position = new THREE.Vector3(); const quaternion = new THREE.Quaternion(); const scale = new THREE.Vector3()
  m.decompose(position, quaternion, scale)
  return placementOf({ position, quaternion, scale })
}

/** The bone on the other side of the body (LeftHand <-> RightHand), or null for a bone in the middle. */
export function counterpart (bone: string): string | null {
  if (/^Left/.test(bone)) return bone.replace(/^Left/, 'Right')
  if (/^Right/.test(bone)) return bone.replace(/^Right/, 'Left')
  return null
}

/** Whether a piece placed at `position` (rest space) sits nearer the other side's mirror of `bone` (its rest position)
 * than `bone` itself: what moving it onto `bone` should carry it across the body for. */
export function nearerMirror (position: readonly number[], bone: THREE.Vector3): boolean {
  const here = new THREE.Vector3(position[0], position[1], position[2])
  return here.distanceTo(bone.clone().setX(-bone.x)) < here.distanceTo(bone)
}

/**
 * The placement that carries a piece across the body's middle, held the same way: turned over its own plane of
 * symmetry (an axe's blade, a pick's head: its thinnest axis, through its middle) and mirrored across x = 0, which
 * together are a plain turn, so the mesh isn't flipped inside out. `points`: its vertices in its own (model) space.
 * Null when it has too few points to tell its plane.
 */
export function mirroredPlacement (place: Place, points: readonly THREE.Vector3[]): Placement | null {
  if (points.length < 3) return null
  const m = placementMatrix(place)
  const placed = points.map(p => p.clone().applyMatrix4(m))
  const c = placed.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(placed.length)
  const n = smallestAxis(placed, c)
  const reflect = new THREE.Matrix4().set(
    1 - 2 * n.x * n.x, -2 * n.x * n.y, -2 * n.x * n.z, 0,
    -2 * n.y * n.x, 1 - 2 * n.y * n.y, -2 * n.y * n.z, 0,
    -2 * n.z * n.x, -2 * n.z * n.y, 1 - 2 * n.z * n.z, 0,
    0, 0, 0, 1)
  const over = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(reflect).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z))
  const across = new THREE.Matrix4().makeScale(-1, 1, 1).multiply(over)
  return placementFromMatrix(across.multiply(m))
}
