// Export rigged characters as game units, headless: the command line of tools/lib/unit_export.ts (what each unit is
// built from and what is written is described there). The game's build.sh runs it; so do `rig.ts check|render` and
// `npm run export:game`.
//
// node tools/game_export.ts <spec.json> <models dir> <work dir> [unit ...]
//
// Spec: { "units": { "<unit>": { "character": "<rigsmith id>", "height": 2.0, "budget": 8000, "lods": [0.45, 0.15],
//   "clips": ["Idle", "Walk", "Run", "Attack", "Die"] } }, "defaults": { ... } }: every clip name must be a slot of the
// character. With no units named, every unit but the drafts is built. A unit's models_dir (relative to the spec's repo,
// two folders above the spec) takes its .glb elsewhere. RIGSMITH_RUN (the Ship job's run token) goes into each build
// record.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { GameSpec, UnitSpec } from '../src/model/unit.ts'
import { WORKSPACE } from './lib/node3d.ts'
import { exportUnit } from './lib/unit_export.ts'

const [specFile, modelsDir, workDir, ...only] = process.argv.slice(2)
if (specFile === undefined || modelsDir === undefined || workDir === undefined) {
  console.error('usage: node tools/game_export.ts <spec.json> <models dir> <work dir> [unit ...]')
  process.exit(2)
}
const spec = JSON.parse(readFileSync(specFile, 'utf8')) as GameSpec
const repo = path.resolve(path.dirname(specFile), '..', '..')
const runToken = process.env.RIGSMITH_RUN !== undefined && process.env.RIGSMITH_RUN !== '' ? process.env.RIGSMITH_RUN : undefined
for (const [unit, unitSpec] of Object.entries(spec.units)) {
  if (only.length > 0 && !only.includes(unit)) continue
  // (a draft is built only when named: the game keeps the unit it has till then)
  if (only.length === 0 && unitSpec.draft === true) { console.error(`${unit}: a draft, left out (name it to build it)`); continue }
  const merged = { ...spec.defaults, ...unitSpec } as UnitSpec
  const record = await exportUnit(unit, merged, {
    workspace: WORKSPACE,
    modelsDir: merged.models_dir !== undefined ? path.join(repo, merged.models_dir) : modelsDir,
    workDir,
    runToken,
  })
  console.log(JSON.stringify({ unit, triangles: record.triangles, walkStride: record.walkStride, runStride: record.runStride, clips: record.clips }))
}
