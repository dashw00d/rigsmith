// Painting carried over a rebuild, for the rig job (server/skinopt.ts). Read-only geometry mapping: it writes only the
// file it is asked to; no live rig or paint record is changed here.
//   node tools/skin_opt/painting.ts <candidate.glb> <previous.glb> <paint.json> <mapped.json>
//     the painting (addressed on the previous rig) readdressed onto the candidate, written to mapped.json; fails when a
//     painted point has no place on it
//   node tools/skin_opt/painting.ts --check <model.glb> <previous.glb> <paint.json>
//     before rigging: prints {"ok": true} or {"ok": false, "problem": "..."}, whether the painting still lies on the
//     model the next rig is built from (tools/lib/skintransfer.ts paintingProblem)
import { readFileSync, writeFileSync } from 'node:fs'
import { load } from '../lib/node3d.ts'
import { paintingProblem, transferPainting } from '../lib/skintransfer.ts'
import type { WeightEdit } from '../../server/weights.ts'

const args = process.argv.slice(2)
if (args[0] === '--check') {
  const [model, previous, input] = args.slice(1)
  if (!model || !previous || !input) throw new Error('Pass --check model.glb previous.glb paint.json')
  const edits = JSON.parse(readFileSync(input, 'utf8')) as WeightEdit[]
  const problem = paintingProblem((await load(model)).scene, (await load(previous)).scene, edits)
  console.log(JSON.stringify(problem === null ? { ok: true } : { ok: false, problem }))
} else {
  const [target, source, input, output] = args
  if (!target || !source || !input || !output) throw new Error('Pass candidate.glb previous.glb paint.json mapped.json')
  const old = (await load(source)).scene, now = (await load(target)).scene
  const edits = JSON.parse(readFileSync(input, 'utf8')) as WeightEdit[]
  writeFileSync(output, JSON.stringify(transferPainting(now, old, edits)))
}
