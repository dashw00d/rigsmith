// The rig report as the Skin step shows it: what each stage of the last rig decided and why (skin.report.decisions,
// written by the rig job), or for a rig from before decisions were kept, what its method code says; and the warnings
// the decisions don't already say. Pure.
import type { RigDecision, RigReport } from '../../model/types.ts'

/** The decisions a method code ('regions+hybrid-heat+retained-weights+pose-optimized') stands for, without their
 * reasons (a rig made before the reasons were kept). */
export function methodDecisions (method: string): RigDecision[] {
  const [base, ...steps] = method.split('+')
  const out: RigDecision[] = []
  const weights = base === 'regions' ? 'Regional heat' : base === 'heat' ? 'Bone heat' : base === 'native-heat' ? 'Volume heat' : base
  if (weights !== '') out.push({ stage: 'Weights', choice: weights, why: '' })
  for (const step of steps) {
    if (step === 'hybrid-heat') out.push({ stage: 'Volume heat', choice: 'Volume heat on some parts', why: '' })
    else if (step === 'retained-weights') out.push({ stage: 'Previous rig', choice: 'Previous weights kept, whole or in part', why: '' })
    else if (step === 'pose-optimized') out.push({ stage: 'Pose optimizer', choice: 'Optimized', why: '' })
    else if (step === 'hybrid-optimized') out.push({ stage: 'Pose optimizer', choice: 'Optimized, except some parts', why: '' })
    else out.push({ stage: 'Step', choice: step, why: '' })
  }
  return out
}

/** The report's decisions; `older` when they were read from its method code (no reasons kept). */
export function decisionsOf (report: RigReport): { decisions: RigDecision[], older: boolean } {
  if (report.decisions !== undefined && report.decisions.length > 0) return { decisions: report.decisions, older: false }
  return { decisions: methodDecisions(report.method), older: true }
}

// The warnings the rig job (server/routes/skin.ts) writes beside a decision that says the same, kept in the warnings
// for the v1 view's readers.
const RESTATED = [
  /^Used the previous weights as the starting skin/,
  /^Used previous weights on some surface islands/,
  /^Previous weights could not be compared/,
  /^weights not pose-optimized/,
  /^\d+ painted vertices put back/,
  /^Alternative heat skin unavailable/,
]

/** The warnings worth showing beside the decisions: all of them when there are no decisions, else those the
 * decisions don't already say. */
export function notesOf (report: RigReport): string[] {
  if (report.decisions === undefined || report.decisions.length === 0) return report.warnings
  const said = new Set(report.decisions.map(d => d.why))
  return report.warnings.filter(w => !said.has(w) && !RESTATED.some(r => r.test(w)))
}
