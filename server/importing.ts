// What an import found (blender/jobs/inspect.py) laid into the character by DESIGN.md §2.2's rules, the size change
// Import -> Size asks for, and the journal's words for both. Pure, so the rules are tested without Blender or files.
import type { Character, Joints, Stats, Vec3 } from '../src/model/types.ts'

/** inspect.py's result. */
export interface InspectResult {
  kind: Character['source']['kind']
  rigPreset: string | null
  stats: Stats
  /** Detected human joints (glTF space), for an unrigged mesh; null when detection failed or the file is rigged. */
  joints: Joints | null
  /** The cleaned model it wrote (relative to its out dir); null for an animation file. */
  model: string | null
  warnings: string[]
}

// (an override this close to the new detection is the detection: placements keep only joints that differ)
const SAME = 1e-6

const near = (a: Vec3, b: Vec3): boolean => Math.abs(a[0] - b[0]) <= SAME && Math.abs(a[1] - b[1]) <= SAME && Math.abs(a[2] - b[2]) <= SAME
const count = (n: number): string => n.toLocaleString('en-US')
const metres = (h: number): string => h.toFixed(2)

/** Whether the character has a rig made here (rigged.glb), as opposed to none or the imported file's own. */
export function hasOwnRig (c: Pick<Character, 'files'>): boolean {
  return c.files.rigged !== undefined && c.files.rigged !== c.files.model
}

/**
 * The import's result laid into `c` (changed in place); the journal's lines for it. `again`: a re-import.
 *  - source: kind, preset, stats and warnings as found (the file's size is the one `source.scale` asked for).
 *  - skeleton, human template and detection succeeded: `detected` and `imported` replaced; the user's placements
 *    kept (those now equal to the detection dropped), and the journal says how many hide it. Detection failed, a
 *    creature, or a rigged file: the joints it had are kept (a warning says so).
 *  - files: a rig made here (rigged.glb) is never touched and the character stays rigged; a rigged file is its own
 *    rig (status rigged, files.rigged the model), converted or not; anything else is ready to rig.
 */
export function applyInspect (c: Character, r: InspectResult, o: { again: boolean }): string[] {
  const lines: string[] = []
  const what = r.kind === 'animation' ? 'an animation file, no model'
    : `${r.kind === 'rigged' ? `a rigged model${r.rigPreset !== null ? ` (${r.rigPreset})` : ''}` : 'an unrigged mesh'}, ${count(r.stats.triangles)} triangles, ${metres(r.stats.height)} tall`
  lines.push(`${o.again ? 'imported again' : 'import done'}: ${what}`)

  const warnings = [...r.warnings]
  c.source.kind = r.kind
  if (r.rigPreset !== null) c.source.rigPreset = r.rigPreset
  else delete c.source.rigPreset
  c.source.stats = { ...r.stats }

  const sk = c.skeleton
  if (r.kind === 'mesh') {
    if (sk.template === 'human' && r.joints !== null) {
      const joints = structuredClone(r.joints)
      sk.detected = joints
      sk.imported = structuredClone(joints)
      const same = Object.keys(sk.overrides).filter(j => joints[j] !== undefined && near(sk.overrides[j], joints[j]))
      for (const j of same) delete sk.overrides[j]
      const hiding = Object.keys(sk.overrides).filter(j => joints[j] !== undefined)
      lines.push(`joints detected (${Object.keys(joints).length})`)
      if (hiding.length > 0) {
        const names = hiding.slice(0, 6).join(', ') + (hiding.length > 6 ? `, and ${hiding.length - 6} more` : '')
        lines.push(`${hiding.length} placed ${hiding.length === 1 ? 'joint is' : 'joints are'} kept over the new detection: ${names}`)
      }
    } else if (sk.template !== 'human') {
      warnings.push(`It has the ${sk.template} skeleton: its joints were kept (detection finds people's).`)
    } else if (sk.detected !== undefined) {
      warnings.push('The joints it had are kept.')
    }
  }
  c.source.warnings = warnings
  for (const w of warnings) lines.push(w)

  if (r.model !== null) {
    c.files.model = r.model
    c.revision += 1
    delete c.files.thumbnail
  }
  if (hasOwnRig(c)) {
    // (a rig made here stays what is shown: a new rig is asked for in Skeleton)
    if (c.status !== 'rigging') c.status = 'rigged'
  } else if (r.kind === 'rigged' && r.model !== null) {
    c.files.rigged = r.model
    c.status = 'rigged'
  } else {
    delete c.files.rigged
    c.status = 'ready'
  }
  delete c.error
  return lines
}

/** The resize Import -> Size asks for: a scale and, per file, the move that stands it on the floor. */
export interface FitPlan { s: number, moves: Vec3[], height: number }

/** From each model file's lowest and highest point (the first file is the one shown: the rig if there is one), to
 * `height` tall (unset: as it is) and on the floor. Null: it is already so. Throws when the height can't be had. */
export function planFit (extents: Array<{ min: number, max: number }>, height?: number): FitPlan | null {
  if (extents.length === 0) throw new RangeError('No model to resize yet')
  const now = extents[0].max - extents[0].min
  if (!(now > 0)) throw new RangeError('The model has no height')
  if (height !== undefined && !(Number.isFinite(height) && height > 0)) throw new RangeError('A height is a number above 0')
  const s = height === undefined ? 1 : height / now
  if (!(s > 0.01 && s < 100)) throw new RangeError('Give a height between 1% and 100× its size')
  const moves = extents.map((e): Vec3 => [0, -e.min * s, 0])
  if (Math.abs(s - 1) < 1e-6 && moves.every(m => Math.abs(m[1]) < 1e-5)) return null
  return { s, moves, height: now * s }
}

/** The journal's lines for a resize from `before` tall. */
export function fitLines (before: number, plan: FitPlan): string[] {
  const lines: string[] = []
  if (Math.abs(plan.s - 1) >= 1e-6) lines.push(`resized from ${metres(before)} to ${metres(plan.height)} tall (×${plan.s.toFixed(3)})`)
  const up = plan.moves[0][1]
  if (Math.abs(up) >= 1e-5) lines.push(`stood on the floor (moved ${(Math.abs(up) * 100).toFixed(1)} cm ${up > 0 ? 'up' : 'down'})`)
  return lines
}
