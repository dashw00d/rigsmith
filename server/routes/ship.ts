// Ship routes: the game's units (workspace/game/units.json, server/game.ts), the export into the game repo, a unit's
// last build, the game's own models for the scale room, and one character's side of the game.
import { createReadStream, existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  exportReads, exportUnits, gameSlots, gameStatus, putUnit, restoreInterruptedExport, strides, unitBuild, units, type UnitSpec,
} from '../game.ts'
import { by, HttpError, readJsonBody, route, send } from '../http.ts'
import { busy, enqueue, events } from '../jobs.ts'
import { getSettings } from '../store.ts'

// (once, at start: an export a restart cut off in its build leaves the game's units.json spliced)
void restoreInterruptedExport().catch(error => { console.error("rigsmith: could not check for an interrupted game export:", error) })

// The game's side of a character (Rigsmith's units): its unit and the clip names the game plays for it.
route('GET', /^\/api\/characters\/([a-z0-9-]+)\/game$/, async (req, res, [id]) => {
  send(res, 200, await gameSlots(id))
})

// The game's models, read only (the scale room sets a unit against them): what there is, and each file.
route('GET', /^\/api\/game\/models$/, async (req, res) => {
  const repo = (await getSettings()).gameRepo
  const kinds: Record<string, string[]> = {}
  for (const kind of ['units', 'buildings', 'props']) {
    try { kinds[kind] = (await readdir(path.join(repo, 'assets', 'models', kind))).filter(f => f.endsWith('.glb')).map(f => f.slice(0, -4)).sort() } catch { kinds[kind] = [] }
  }
  let visualScale = 1
  try { visualScale = (JSON.parse(await readFile(path.join(repo, 'data', 'visual.json'), 'utf8')) as { units?: { visual_scale?: number } }).units?.visual_scale ?? 1 } catch { /* (no game data: as modelled) */ }
  send(res, 200, { ...kinds, visualScale })
})
route('GET', /^\/api\/game\/models\/(units|buildings|props)\/([\w-]+)\.glb$/, async (req, res, [kind, name]) => {
  const file = path.join((await getSettings()).gameRepo, 'assets', 'models', kind, `${name}.glb`)
  if (!existsSync(file)) throw new HttpError(404, 'No such model')
  res.writeHead(200, { 'content-type': 'model/gltf-binary', 'cache-control': 'no-store' })
  createReadStream(file).pipe(res)
})

// Rigsmith's game units: each with the game's own entry and whether they differ (what Export would write).
route('GET', /^\/api\/game$/, async (req, res) => { send(res, 200, await gameStatus()) })

// One unit's entry (null takes it off Rigsmith's list; the game keeps its own till an export changes it), checked
// (its clips name slots of its character, its heights above 0...) and journaled on the characters it names.
route('PUT', /^\/api\/game\/units\/([a-z0-9_]+)$/, async (req, res, [name]) => {
  const entry = await readJsonBody<UnitSpec | null>(req)
  await putUnit(name, entry, by(req))
  send(res, 200, await gameStatus())
})

// A unit's last export, the build record the game has for it, and when its model was written.
route('GET', /^\/api\/game\/units\/([a-z0-9_]+)\/build$/, async (req, res, [name]) => {
  send(res, 200, await unitBuild(name))
})

// Export units into the game (its units.json entries, then its build): the one way Rigsmith writes into the game's
// repo. One export at a time; the job's result names its units and, when done, each one's build.
route('POST', /^\/api\/game\/export$/, async (req, res) => {
  const { units: names } = await readJsonBody<{ units?: string[] }>(req)
  if (!Array.isArray(names) || names.length === 0 || !names.every(n => typeof n === 'string' && /^[a-z0-9_]+$/.test(n))) throw new HttpError(400, 'Name the units to export')
  const list = [...new Set(names)]
  const spec = await units()
  const unknown = list.filter(n => spec.units[n] === undefined)
  if (unknown.length > 0) throw new HttpError(404, `No unit ${unknown.join(', ')}`)
  const who = by(req)
  // (it reads every file of each unit's character and companion: refused while a job rewrites any of them, and while
  // it runs their writers wait for it (exportUnits holds their files))
  for (const id of exportReads(spec, list)) {
    const running = busy(id, 'files')
    if (running !== undefined) throw new HttpError(409, `Wait for ${running.label} to finish`)
  }
  // (one character's export also holds that character's jobs as a rig would)
  const characters = new Set(list.map(n => spec.units[n].character))
  const characterId = characters.size === 1 ? [...characters][0] : undefined
  const job = enqueue('export', `Export ${list.join(', ')} to the game`, characterId, async (job, update, signal) => {
    try {
      const builds = await exportUnits(list, { by: who, job: job.id, signal, update })
      update({
        result: { units: list, builds },
        message: builds.map(b => `${b.unit}: ${strides(b)}${b.holdsFailed.length > 0 ? `, ${b.holdsFailed.length} holds failed` : ''}${b.warnings.length > 0 ? `, ${b.warnings.length} warning${b.warnings.length === 1 ? '' : 's'}` : ''}`).join('; '),
      })
    } finally {
      events.emit('game', list.join(','))
    }
  }, { lock: characterId !== undefined ? 'files' : 'none', exclusive: 'game-export' })
  // (its units from the start, so a page can tell which unit's export it is while it still waits for another)
  job.result = { units: list }
  events.emit('job', job)
  send(res, 202, job)
})
