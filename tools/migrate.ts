// Migrates the whole workspace to schema 2 (docs/rebuild/DESIGN.md §2.3) with the steps the server takes for a
// character the first time it reads one (server/store.ts migrationContext and writeMigration): each
// characters/*/character.json still at v1 is kept as character.v1.json (once), its old textures copied in as layers,
// the document written and one 'migrate' journal entry made of its notes. settings.json keeps only what schema 2 has
// (the old file kept as settings.v1.json, once). GLBs and weight_edits.json are only ever read.
//
//   node tools/migrate.ts [--dry-run] [--check] [--hashes <file>] [--ignore-server]
//
//   --dry-run   say what it would do, write nothing
//   --check     then check every character against its v1 record (the file, or the character.v1.json kept): its
//               effective skeleton is the old one, its detected joints alone cover its skeleton, every slot's hands
//               close on the same fist or pose (or none) as v1 closed them (tools/lib/migrate_check.ts); and that no
//               GLB or painted-weights file changed during the run
//   --hashes    (implies --check) also compare those files with a sha256sum list whose paths are inside the
//               workspace (`cd workspace && sha256sum characters/*/rigged.glb characters/*/weight_edits.json`); a
//               list that doesn't exist yet is written, with the hashes from before the run
//
// It refuses to write while a Rigsmith server answers (that server migrates each character itself). Exits 1 when
// anything failed or a check did not pass.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stableJson } from '../src/model/entities.ts'
import { migrate, readCharacter } from '../src/model/migrate.ts'
import type { Character } from '../src/model/types.ts'
import type { V1Character } from '../src/model/v1.ts'
import { CHARACTERS, getSettings, locked, migrationContext, saveSettings, WORKSPACE, writeMigration } from '../server/store.ts'
import { formatHashes, handProblems, jointProblems, parseHashes } from './lib/migrate_check.ts'
import { IGNORE_SERVER, runningServer } from './lib/offline.ts'

const USAGE = `usage: node tools/migrate.ts [--dry-run] [--check] [--hashes <file>] [${IGNORE_SERVER}]`

const args = process.argv.slice(2)
const at = args.indexOf('--hashes')
const hashFile = at >= 0 && args[at + 1] !== undefined && !args[at + 1].startsWith('--') ? path.resolve(args[at + 1]) : undefined
const dry = args.includes('--dry-run')
const check = args.includes('--check') || hashFile !== undefined
if ((at >= 0 && hashFile === undefined) || args.some((a, i) => (at < 0 || i !== at + 1) && !['--dry-run', '--check', '--hashes', IGNORE_SERVER].includes(a))) {
  console.error(USAGE)
  process.exit(2)
}

if (!dry && !args.includes(IGNORE_SERVER)) {
  const url = await runningServer()
  if (url !== null) {
    console.error(`A Rigsmith server answers at ${url}; it migrates each character itself the first time it reads it. Stop it to ` +
      `migrate here, or look first with --dry-run. (${IGNORE_SERVER}: that server serves another workspace.)`)
    process.exit(1)
  }
}

const failures: string[] = []
const fail = (who: string, what: string): void => { failures.push(`${who}: ${what}`) }
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

const ids = existsSync(CHARACTERS)
  ? (await readdir(CHARACTERS)).filter(id => /^[a-z0-9-]+$/.test(id) && existsSync(path.join(CHARACTERS, id, 'character.json'))).sort()
  : []

const sha256 = async (file: string): Promise<string> => createHash('sha256').update(await readFile(file)).digest('hex')

/** The files no migration may change, by path inside the workspace: every GLB of a character (model, rig, gear,
 * backups) and its painted weights (body and gear). */
async function guarded (): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const id of ids) {
    const dir = path.join(CHARACTERS, id)
    for (const file of (await readdir(dir, { recursive: true })).map(f => f.split(path.sep).join('/')).sort()) {
      if (!/\.glb$/i.test(file) && file !== 'weight_edits.json' && !/^garments\/[^/]+\/weights\.json$/.test(file)) continue
      out.set(`characters/${id}/${file}`, await sha256(path.join(dir, file)))
    }
  }
  return out
}

const before = check ? await guarded() : new Map<string, string>()
let migrated = 0
let already = 0
let checked = 0

for (const id of ids) {
  const dir = path.join(CHARACTERS, id)
  let v1: V1Character
  let c: Character
  try {
    const raw = JSON.parse(await readFile(path.join(dir, 'character.json'), 'utf8')) as Record<string, unknown>
    if (raw.schema === 2) {
      already++
      const backup = path.join(dir, 'character.v1.json')
      if (!existsSync(backup)) { console.log(`${id}: schema 2 already${check ? ' (no v1 record kept, nothing to check against)' : ''}`); continue }
      console.log(`${id}: schema 2 already`)
      if (!check) continue
      // (what the migration made of it: the same function, and the parts checked don't depend on the files)
      v1 = JSON.parse(await readFile(backup, 'utf8')) as V1Character
      c = readCharacter(v1)
    } else {
      const { ctx, notes } = await migrationContext(id, raw)
      const out = migrate(raw, ctx)
      if (!dry) await locked(id, async () => await writeMigration(id, out, notes, 'migrate'))
      migrated++
      console.log(`${id}: ${dry ? 'would migrate' : 'migrated'}`)
      for (const line of [...out.notes, ...notes]) console.log(`  ${line}`)
      if (dry) for (const op of out.fileOps) console.log(`  (would copy ${op.from} to ${op.to})`)
      v1 = raw as unknown as V1Character
      c = out.character
    }
  } catch (error) {
    fail(id, message(error))
    continue
  }
  if (!check) continue
  try {
    const joints = jointProblems(v1, c)
    for (const line of joints.info) console.log(`  ${line}`)
    for (const problem of [...joints.problems, ...handProblems(v1, c)]) fail(id, problem)
    checked++
  } catch (error) {
    fail(id, `the check failed: ${message(error)}`)
  }
}

// settings.json: the game repo and the shared hand poses (what getSettings reads of any schema)
const settingsFile = path.join(WORKSPACE, 'settings.json')
if (existsSync(settingsFile)) {
  try {
    const raw = JSON.parse(await readFile(settingsFile, 'utf8')) as Record<string, unknown>
    const next = await getSettings()
    if (stableJson(raw) === stableJson(next)) console.log('settings: schema 2 already')
    else {
      const dropped = Object.keys(raw).filter(k => !(k in next))
      console.log(`settings: ${dry ? 'would migrate' : 'migrated'}${dropped.length > 0 ? ` (${dropped.join(', ')} dropped)` : ''}`)
      if (!dry) {
        const backup = path.join(WORKSPACE, 'settings.v1.json')
        if (!existsSync(backup)) await copyFile(settingsFile, backup)
        await saveSettings({})
      }
    }
  } catch (error) {
    fail('settings', message(error))
  }
}

if (check) {
  const after = await guarded()
  for (const [file, hash] of before) {
    const now = after.get(file)
    if (now !== hash) fail(file, now === undefined ? 'gone during the run' : 'changed during the run')
  }
  if (hashFile !== undefined && !existsSync(hashFile)) {
    await writeFile(hashFile, formatHashes(before))
    console.log(`hashes: wrote ${before.size} to ${hashFile} (nothing to compare with yet)`)
  } else if (hashFile !== undefined) {
    try {
      const listed = parseHashes(await readFile(hashFile, 'utf8'), WORKSPACE)
      for (const [file, hash] of listed) {
        const where = path.resolve(WORKSPACE, file)
        const now = after.get(file) ?? (existsSync(where) ? await sha256(where) : undefined)
        if (now !== hash) fail(file, now === undefined ? `missing (listed in ${hashFile})` : `differs from ${hashFile}`)
      }
      console.log(`hashes: ${listed.size} compared with ${hashFile}`)
    } catch (error) {
      fail(hashFile, message(error))
    }
  }
}

console.log(`\n${migrated} ${dry ? 'to migrate' : 'migrated'}, ${already} schema 2 already${check ? `; ${checked} checked, ${before.size} files hashed` : ''}`)
if (failures.length > 0) {
  console.error(`\n${failures.length} problem${failures.length === 1 ? '' : 's'}:`)
  for (const line of failures) console.error(`  ${line}`)
  process.exitCode = 1
} else if (check) {
  console.log('check passed')
}
