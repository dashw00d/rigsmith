// A character put back as a game build had it while no server runs: the offline twin of
// POST /api/characters/:id/restore (server/routes/restore.ts), as tools/apply.ts is of /commands. tools/game_import.py
// runs it when the app is not up; the request is the route's body.
//
//   node tools/restore.ts <character id> <request.json | -> [--dry-run] [--by <name>] [--ignore-server]
//
// --dry-run prints the batch it would apply ({ commands, notes }) and writes nothing; it reads the character as schema
// 2 whatever its file is. Otherwise it refuses while a Rigsmith server answers (that server must make the change), and
// parts the request names must already be on the character (new ones come in through the app's gear upload).
import { readFile } from 'node:fs/promises'
import { text } from 'node:stream/consumers'
import { dryRun, requestOf, restore, type RestoreRequest } from '../server/routes/restore.ts'
import { character } from './lib/node3d.ts'
import { IGNORE_SERVER, runningServer } from './lib/offline.ts'

const USAGE = `usage: node tools/restore.ts <character id> <request.json | -> [--dry-run] [--by <name>] [${IGNORE_SERVER}]`

const args = process.argv.slice(2)
const at = args.indexOf('--by')
const by = at >= 0 ? args[at + 1] : 'game_import'
const dry = args.includes('--dry-run')
const rest = args.filter((a, i) => a !== IGNORE_SERVER && a !== '--dry-run' && (at < 0 || (i !== at && i !== at + 1)))
if (by === undefined || by.trim() === '' || by.startsWith('--') || rest.length !== 2 || rest.some(a => a.startsWith('--'))) {
  console.error(USAGE)
  process.exit(2)
}
const [id, file] = rest

function fail (why: string): never {
  console.error(why)
  process.exit(1)
}

let body: RestoreRequest
try {
  body = requestOf(JSON.parse(file === '-' ? await text(process.stdin) : await readFile(file, 'utf8')))
} catch (error) {
  fail(`Could not read the request from ${file === '-' ? 'stdin' : file}: ${(error as Error).message}`)
}

try {
  if (dry || body.dryRun === true) {
    console.log(JSON.stringify(dryRun(character(id), body), null, 1))
  } else {
    if (!args.includes(IGNORE_SERVER)) {
      const url = await runningServer()
      if (url !== null) {
        fail(`A Rigsmith server answers at ${url}, so it must make this change: POST ${url}/api/characters/${id}/restore with ` +
          `the request and the header x-rigsmith-by: ${by}. (${IGNORE_SERVER}: that server serves another workspace.)`)
      }
    }
    const { character: c, entry, notes } = await restore(id, body, by)
    if (entry === null) console.log(`${c.name}: nothing changed`)
    else {
      console.log(`${c.name}: journal entry ${entry.seq} (${entry.what}, by ${entry.by}); version ${c.version}`)
      for (const line of entry.changes) console.log(`  ${line}`)
    }
    if (entry === null) for (const line of notes) console.log(`  ${line}`)
  }
} catch (error) {
  const status = (error as { status?: unknown }).status
  fail(typeof status === 'number' ? `Refused (${status}): ${(error as Error).message}. The character is as it was.` : `Failed: ${(error as Error).message}`)
}
