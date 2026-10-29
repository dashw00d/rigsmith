// A schema 1 to 3 character's clips measured for the move to schema 4 (src/engine/measure.ts, through
// tools/lib/node3d.ts measureCharacter): what server/store.ts runs (as a child, so three's headless shims stay out of
// the server) before migrating a character whose slots need it. Prints {"times": {<slot id>: {"seconds", "blow"?}},
// "problems": [...]} on stdout.
//
//   node tools/measure_clips.ts <character id> [--all]
//
// The workspace is RIGSMITH_WORKSPACE's (as every tool's). Reads only.
import { measureCharacter } from './lib/node3d.ts'

const [id, ...rest] = process.argv.slice(2)
if (id === undefined || !/^[a-z0-9-]+$/.test(id) || rest.some(a => a !== '--all')) {
  console.error('usage: node tools/measure_clips.ts <character id> [--all]')
  process.exit(2)
}
console.log(JSON.stringify(await measureCharacter(id, { all: rest.includes('--all') })))
