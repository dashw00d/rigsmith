// Applies a batch of commands (src/model/command-types.ts) to a character while no server runs, the way
// POST /api/characters/:id/commands does (server/commands.ts runCommands, through the store's commit): all or nothing,
// one undoable journal entry by --by (default 'agent'), and gear removed from a horse comes off its riders' mounts.
//
//   node tools/apply.ts <character id> <commands.json | -> [--by <name>] [--ignore-server]
//
// The file ('-': stdin) holds a list of commands, one command, or { "commands": [...] }. While a Rigsmith server runs
// it refuses: send the batch to that server instead, so it stays the only writer. Look commands always go through the
// server (it recomposes the texture after them).
import { readFile } from 'node:fs/promises'
import { text } from 'node:stream/consumers'
import type { Command } from '../src/model/command-types.ts'
import { runCommands } from '../server/commands.ts'
import { IGNORE_SERVER, runningServer } from './lib/offline.ts'

const USAGE = `usage: node tools/apply.ts <character id> <commands.json | -> [--by <name>] [${IGNORE_SERVER}]`

const args = process.argv.slice(2)
const at = args.indexOf('--by')
const by = at >= 0 ? args[at + 1] : 'agent'
const rest = args.filter((a, i) => a !== IGNORE_SERVER && (at < 0 || (i !== at && i !== at + 1)))
if (by === undefined || by.trim() === '' || by.startsWith('--') || rest.length !== 2 || rest.some(a => a.startsWith('--'))) {
  console.error(USAGE)
  process.exit(2)
}
const [id, file] = rest

function fail (why: string): never {
  console.error(why)
  process.exit(1)
}

if (!args.includes(IGNORE_SERVER)) {
  const url = await runningServer()
  if (url !== null) {
    fail(`A Rigsmith server answers at ${url}, so it must make this change: POST ${url}/api/characters/${id}/commands with the ` +
      `body { "commands": [...] } and the header x-rigsmith-by: ${by}. (${IGNORE_SERVER}: that server serves another workspace.)`)
  }
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

let commands: unknown
try {
  const json = JSON.parse(file === '-' ? await text(process.stdin) : await readFile(file, 'utf8')) as unknown
  commands = Array.isArray(json) ? json : isObject(json) && 'commands' in json ? json.commands : isObject(json) && 'command' in json ? [json.command] : [json]
} catch (error) {
  fail(`Could not read the commands from ${file === '-' ? 'stdin' : file}: ${(error as Error).message}`)
}
if (!Array.isArray(commands) || commands.length === 0) fail('No commands (give a list of { "type": ... } objects)')
const list = commands as Command[]
const look = list.filter(c => isObject(c) && typeof c.type === 'string' && c.type.startsWith('look.')).map(c => c.type)
if (look.length > 0) fail(`${[...new Set(look)].join(', ')}: look commands need the server, which recomposes the texture after them`)

try {
  const { character, entry } = await runCommands(id, list, { by })
  if (entry === null) console.log(`${character.name}: nothing changed`)
  else {
    console.log(`${character.name}: journal entry ${entry.seq} (${entry.what}, by ${entry.by}); version ${character.version}`)
    for (const line of entry.changes) console.log(`  ${line}`)
  }
} catch (error) {
  // (a refused command or batch: the reducers' CommandError, the store's HttpError)
  const status = (error as { status?: unknown }).status
  fail(typeof status === 'number' ? `Refused (${status}): ${(error as Error).message}. Nothing was written.` : `Failed: ${(error as Error).message}`)
}
