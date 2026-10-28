// Import routes: re-import, and Size (resize and stand on the floor). Both are 'files' jobs and refused (409) while
// anything works on the character.
import { randomBytes } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { rescale } from '../../src/model/rescale.ts'
import { ridersFollowResize } from '../commands.ts'
import { extentY, transformedGlb } from '../glbtransform.ts'
import { by, HttpError, readJsonBody, route, send } from '../http.ts'
import { fitLines, hasOwnRig, planFit } from '../importing.ts'
import { inspect } from '../inspect.ts'
import { busy, enqueue } from '../jobs.ts'
import { type Character, characterDir, getCharacter, updateCharacter, withFiles } from '../store.ts'

async function found (id: string): Promise<Character> {
  const c = await getCharacter(id)
  if (c === null) throw new HttpError(404, 'No such character')
  return c
}

function idle (c: Character): void {
  const job = busy(c.id)
  if (job !== undefined) throw new HttpError(409, `${c.name} is busy (${job.label}); try again when that is done`)
}

// The upload imported again (the same as a first import, at its size and finger level). Placed joints are kept and a
// rig made here stays; a conversion stays converted.
route('POST', /^\/api\/characters\/([a-z0-9-]+)\/reimport$/, async (req, res, [id]) => {
  const c = await found(id)
  idle(c)
  if (c.skin.locked && !hasOwnRig(c) && c.files.rigged !== undefined) {
    throw new HttpError(409, 'Its weights are locked (Skin), and its rig is the imported file itself: importing again would write over it')
  }
  send(res, 202, inspect(c, { by: by(req), again: true }))
})

/** The model files, the one shown first (the rig if there is one): what is measured. */
const modelFiles = (c: Character): string[] =>
  [c.files.rigged, c.files.model].filter((f, i, all): f is string => f !== undefined && f.endsWith('.glb') && all.indexOf(f) === i)

/** Written over `file` whole or not at all. (Temp files are named <file>.fit-<hex>.tmp: a restart removes any left.) */
async function put (file: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${file}.fit-${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, bytes)
  await rename(tmp, file)
}

// Size and floor (Import → Size): the character resized to `height` (else as it is) and stood on the floor, in place.
// Its files are moved as they are (a rig keeps its weights and painting: server/glbtransform.ts), and every length the
// document keeps goes with them (src/model/rescale.ts). Every later import and rig of it does the same (its
// `source.scale`, then the floor). Both files are made before either is written, then put in place together; if
// anything fails after that, the ones already in place are put back.
route('POST', /^\/api\/characters\/([a-z0-9-]+)\/fit$/, async (req, res, [id]) => {
  const { height } = await readJsonBody<{ height?: number }>(req)
  if (height !== undefined && typeof height !== 'number') throw new HttpError(400, 'A height is a number')
  const c = await found(id)
  idle(c)
  const dir = characterDir(id)
  const files = modelFiles(c)
  if (files.length === 0) throw new HttpError(400, 'No model to resize yet')
  // (measured now to refuse a height at once; again in the job, under the files lock)
  try {
    planFit(await Promise.all(files.map(async f => extentY(await readFile(path.join(dir, f))))), height)
  } catch (error) {
    throw new HttpError(400, (error as Error).message)
  }
  const who = by(req)
  const job = enqueue('fit', `Resize ${c.name}`, id, async (_job, update, signal) => {
    let resized = 1
    await withFiles(id, async () => {
      const now = await found(id)
      const names = modelFiles(now)
      if (names.length === 0) throw new Error('No model to resize')
      const before = await Promise.all(names.map(async f => new Uint8Array(await readFile(path.join(dir, f)))))
      const extents = before.map(b => extentY(b))
      const plan = planFit(extents, height)
      if (plan === null) { update({ message: 'Already that size, on the floor' }); return }
      update({ progress: 0.3, message: 'Resizing' })
      const after = before.map((b, i) => transformedGlb(b, plan.s, plan.moves[i]))
      const token = randomBytes(4).toString('hex')
      const temps = names.map(f => path.join(dir, `${f}.fit-${token}.tmp`))
      const placed: number[] = []
      try {
        await Promise.all(temps.map(async (t, i) => { await writeFile(t, after[i]) }))
        signal.throwIfAborted()
        update({ progress: 0.8, message: 'Saving' })
        for (const [i, f] of names.entries()) { await rename(temps[i], path.join(dir, f)); placed.push(i) }
        const measured = extents[0].max - extents[0].min
        await updateCharacter(id, x => {
          const next = rescale(x, plan.s, plan.moves[0])
          // (the height as the file now measures: the one size the character has)
          if (next.source.stats !== undefined) next.source.stats.height = measured * plan.s
          next.revision = x.revision + 1
          delete next.files.thumbnail
          return next
        }, { by: who, what: 'fit', changes: fitLines(measured, plan) })
        resized = plan.s
      } catch (error) {
        for (const i of placed) await put(path.join(dir, names[i]), before[i])
        throw error
      } finally {
        for (const t of temps) await rm(t, { force: true })
      }
    })
    // (a horse: its riders' seats scaled with it)
    await ridersFollowResize(id, resized, who)
  }, { lock: 'files' })
  send(res, 202, job)
})
