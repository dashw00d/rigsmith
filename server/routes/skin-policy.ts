// What a rig does to the document (DESIGN.md §2.2, the rig job's row), apart from running it: the weight lock every
// weight-changing route checks, why a character can't be rigged, how Blender's joints compare with the ones it was
// given, and the rig published into the document. Pure: server/routes/skin.ts runs Blender and the weight steps and
// hands the result here, inside the store lock.
import { hierarchyOf, jointsOf } from '../../src/model/select.ts'
import { TEMPLATE_PARENTS } from '../../src/model/skeletons.ts'
import type { Character, Joints, RigReport, Vec3 } from '../../src/model/types.ts'
import { HttpError } from '../http.ts'

/** A placed joint Blender gave back further than this (model units) has moved: a warning, the rig built on its. */
export const MOVED = 1e-4

/** The one check of the weight lock (DESIGN.md §6 row 13): whatever would change the body's weights (a rig, painting,
 * forgetting the painting, a template switch or conversion of a rigged character) is refused while it is on. */
export function assertUnlocked (c: Pick<Character, 'name' | 'skin'>): void {
  if (!c.skin.locked) return
  const reason = c.skin.lockReason !== undefined ? ` (${c.skin.lockReason})` : ''
  throw new HttpError(409, `${c.name}'s weights are locked${reason}: unlock them in the Skin step first`)
}

/** Why a character can't be rigged now, if it can't: what it is, or what it is doing. The lock and the painting are
 * checked apart (assertUnlocked, skinopt.checkPainting). */
export function rigRefusal (c: Pick<Character, 'status' | 'source' | 'skeleton'>): { status: 400 | 409, message: string } | null {
  if (c.source.kind === 'animation') return { status: 400, message: 'This file holds only an animation: there is no body to rig' }
  if (c.source.kind === 'rigged' && c.skeleton.converted !== true) return { status: 409, message: 'It is rigged elsewhere: convert it to the Rigsmith rig first (Skeleton step)' }
  if (c.status === 'importing') return { status: 409, message: 'Wait for the import to finish' }
  if (c.status === 'rigging') return { status: 409, message: 'It is rigging already' }
  const { template } = c.skeleton
  if (template !== 'human' && TEMPLATE_PARENTS[template] === undefined) return { status: 400, message: `This build has no ${template} template to rig it with` }
  if (template !== 'human' && Object.keys(jointsOf(c)).length === 0) return { status: 400, message: 'Place its joints first (Skeleton step)' }
  return null
}

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const listed = (names: string[], max = 4): string => names.slice(0, max).join(', ') + (names.length > max ? ` and ${names.length - max} more` : '')

/** Blender's joints against the ones it was given (`input`, the effective skeleton): the skeleton's joints it had to
 * complete (`added`), the given ones it moved (`moved`, by more than MOVED), and the warning that says so. */
export function jointsBack (hierarchy: string[], input: Joints, result: Joints): { added: string[], moved: string[], warning: string | null } {
  const moved = Object.keys(input).filter(j => result[j] !== undefined && distance(input[j], result[j]) > MOVED)
  const added = hierarchy.filter(j => input[j] === undefined && result[j] !== undefined)
  if (moved.length === 0) return { added, moved, warning: null }
  const most = Math.max(...moved.map(j => distance(input[j], result[j])))
  return { added, moved, warning: `Blender moved ${moved.length} of the placed joints (${listed(moved)}; up to ${(most * 100).toFixed(1)} cm): the rig is built where it put them` }
}

const sameJoints = (a: Joints, b: Joints): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, p]) => b[k] !== undefined && distance(p, b[k]) <= 1e-9)

/**
 * The rig published into the document: rigged, its report, the joints of its bind pose (`skin.rigJoints`: Blender's
 * joints the skeleton has) and its bone count, the painting put back. Joints Blender had to complete go into
 * `skeleton.detected` (over any the skeleton went without, a mitten's index at the full level); the user's placements
 * are never touched. Placements changed while it rigged leave the rig as built and a warning. Returns the journal's
 * lines.
 */
export function applyRig (c: Character, o: { input: Joints, result: Joints, report: RigReport, painted: number }): string[] {
  const hierarchy = hierarchyOf(c).map(([j]) => j)
  const { added } = jointsBack(hierarchy, o.input, o.result)
  const completed: Joints = Object.fromEntries(added.map(j => [j, o.result[j]]))
  const report: RigReport = { ...o.report, warnings: [...o.report.warnings] }
  c.status = 'rigged'
  delete c.error
  c.files.rigged = 'rigged.glb'
  c.revision = (c.revision ?? 0) + 1
  if (added.length > 0) c.skeleton.detected = { ...c.skeleton.detected, ...completed }
  if (!sameJoints(jointsOf(c), { ...o.input, ...completed })) report.warnings.push('Placements changed during rigging; rig again to use the latest joints')
  const rigJoints: Joints = {}
  for (const j of hierarchy) if (o.result[j] !== undefined) rigJoints[j] = o.result[j]
  c.skin.report = report
  c.skin.rigJoints = rigJoints
  c.skin.bones = Object.keys(rigJoints).length
  if (o.painted > 0) c.skin.painted = o.painted
  else delete c.skin.painted
  const changes = [`rigged (${report.method}, ${report.seconds} s)`]
  if (added.length > 0) changes.push(`skeleton: ${listed(added)} found by the rig, added to the detected joints`)
  if (o.painted > 0) changes.push(`${o.painted} painted points put back`)
  return changes
}
