// The deprecated v1 HTTP layer (DESIGN.md §4.2), kept for clients that can't be changed yet: the game repo's scripts
// (tools/rigsmith/import_new_units.py, import_gear.py, replace_body.py) and tools/game_import.py. Reads of characters
// answer the v1 view (src/model/legacy.ts toV1) unless the request carries `x-rigsmith-schema: 2`, `3` or `4` (the app and the
// ported tools always do). PATCH takes only the whole-array fields those scripts write (animations, scripts, garments,
// props), turned into one batch of commands; anything else is gone (410): send commands instead. Remove once they are
// ported.
//
// v1 scripts follow their work by polling `status` (replace_body.py posts /reimport, waits for ready or rigged, then
// posts /rig and waits for rigged). In schema 2 a re-import never changes `status` and a queued rig hasn't changed it
// yet, so their view carries the character's job (toV1 shows it in `status`), and a v1 POST /rig waits for the job
// before it rather than failing with 409.
import type { IncomingMessage } from 'node:http'
import { newId } from '../src/model/ids.ts'
import { toV1, v1PatchToCommands } from '../src/model/legacy.ts'
import type { Job } from '../src/model/types.ts'
import type { GameSpec } from '../src/model/unit.ts'
import { runCommands } from './commands.ts'
import { by, header, HttpError, NEXT, readJsonBody, route, send } from './http.ts'
import { busy, listJobs } from './jobs.ts'
import { type Character, events, readJson, UNITS_FILE } from './store.ts'

const V1_KEYS = new Set(['animations', 'scripts', 'garments', 'props'])

/** Clients that don't say they speak schema 2 get the v1 view. */
export const wantsV1 = (req: IncomingMessage): boolean => !['2', '3', '4'].includes(header(req, 'x-rigsmith-schema') ?? '')

/** The jobs that change what v1 called the status: an import or re-import ('importing') and a rig ('rigging'). */
const LIFECYCLE = new Set(['inspect', 'reimport', 'rig'])

/** The job a v1 client should see on the character: of its queued and running jobs, one that changes the lifecycle
 * first, then a running one before a queued one, then the oldest (it runs first). Null when nothing works on it. */
export function jobOf (id: string, jobs: Job[] = listJobs()): Pick<Job, 'kind' | 'status'> | null {
  const rank = (j: Job): number => (LIFECYCLE.has(j.kind) ? 0 : 2) + (j.status === 'running' ? 0 : 1)
  const mine = jobs.filter(j => j.characterId === id && (j.status === 'queued' || j.status === 'running'))
    .sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt)
  return mine.length === 0 ? null : { kind: mine[0].kind, status: mine[0].status }
}

/** A character (or the list) as the request wants it. */
export async function view (req: IncomingMessage, c: Character | Character[]): Promise<unknown> {
  if (!wantsV1(req)) return c
  // (read as it is: game.ts's units() would seed the file from the game's)
  const units = await readJson<GameSpec>(UNITS_FILE, { units: {} })
  const jobs = listJobs()
  return Array.isArray(c) ? c.map(x => toV1(x, units, jobOf(x.id, jobs))) : toV1(c, units, jobOf(c.id, jobs))
}

route('PATCH', /^\/api\/characters\/([a-z0-9-]+)$/, async (req, res, [id]) => {
  const patch = await readJsonBody<Record<string, unknown>>(req)
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new HttpError(400, 'A patch is an object')
  const other = Object.keys(patch).filter(k => !V1_KEYS.has(k))
  if (other.length > 0) {
    throw new HttpError(410, `PATCH of ${other.join(', ')} is no longer taken: send commands to POST /api/characters/${id}/commands (PATCH takes only animations, scripts, garments and props)`)
  }
  const done = await runCommands(id, c => v1PatchToCommands(c, patch as Parameters<typeof v1PatchToCommands>[1], newId), { by: by(req), what: 'v1 patch' })
  send(res, 200, await view(req, done.character))
})

/** How long a v1 POST /rig waits for the character's file jobs: under the 120 s the game's scripts give a request. */
export const RIG_WAIT_MS = 100_000

/** Resolves true once no job that rewrites the character's files is queued or running, false after `ms`. */
export async function filesIdle (id: string, ms: number): Promise<boolean> {
  if (busy(id, 'files') === undefined) return true
  return await new Promise(resolve => {
    const done = (idle: boolean): void => { clearTimeout(timer); events.off('job', check); resolve(idle) }
    // (a job's last event comes after it stops counting as busy)
    const check = (): void => { if (busy(id, 'files') === undefined) done(true) }
    const timer = setTimeout(() => { done(false) }, ms)
    events.on('job', check)
  })
}

// A v1 client's rig (replace_body.py re-imports, then rigs) waits for the file job before it, then goes on to the rig
// route (server/routes/skin.ts), which checks everything again on the character as that job left it. Still busy after
// RIG_WAIT_MS: the rig route's 409. Schema 2 clients get the 409 at once (the app says what is busy).
route('POST', /^\/api\/characters\/([a-z0-9-]+)\/rig$/, async (req, _res, [id]) => {
  if (wantsV1(req)) await filesIdle(id, RIG_WAIT_MS)
  return NEXT
})
