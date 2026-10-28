// Clips made in the animation editor, saved into the library (server/clipedits.ts), and which slots play a clip:
//   GET  /api/library/usage/:clipId     every slot of every character that plays it
//   POST /api/library/edits             a person's edit: into the library as a clip (a job: Blender builds it)
//   GET  /api/library/edits/:id         what an edit was made of (its keys and gear paths), to open it again
//   POST /api/library/creature-clips    a creature's edit: a .glb on its template's skeleton, beside its bundled clips
// Which of the two saves is the character's template's choice (a human's clips are library clips), and a save over a
// made clip (`replace`) is refused (409) while another slot plays it: the editor forks it then.
import { HttpError, readBody, readJsonBody, route, send } from '../http.ts'
import { categoryOf } from '../library.ts'
import { checkMaking, clipUsage, creatureClip, editId, editRecord, othersUsing, release, saveCreatureClip, saveEdit, usesText, type SavedEdit } from '../clipedits.ts'
import { enqueue } from '../jobs.ts'
import { getCharacter } from '../store.ts'
import type { Character } from '../../src/model/types.ts'

const CHARACTER = /^[a-z0-9-]+$/

/** The character saving, if named (404 when it isn't there). */
async function saver (id: unknown): Promise<Character | null> {
  if (id === undefined || id === null || id === '') return null
  if (typeof id !== 'string' || !CHARACTER.test(id)) throw new HttpError(400, 'Bad character id')
  const c = await getCharacter(id)
  if (c === null) throw new HttpError(404, `No character ${id}`)
  return c
}

/** Refuse a save over `clip` while a slot other than `slot` of `c` plays it. */
async function mayReplace (clip: string, c: Character | null, slot: string | undefined): Promise<void> {
  const others = othersUsing(await clipUsage(clip), c?.id, slot)
  if (others.length > 0) throw new HttpError(409, `${clip} is played by ${usesText(others)} too; save it as a new clip`, { uses: others })
}

route('GET', /^\/api\/library\/usage\/([^/]+)$/, async (_req, res, [raw]) => {
  const clip = decodeURIComponent(raw)
  if (!/^[\w.-]+$/.test(clip)) throw new HttpError(400, 'Bad clip id')
  send(res, 200, { uses: await clipUsage(clip) })
})

route('GET', /^\/api\/library\/edits\/([^/]+)$/, async (_req, res, [raw]) => {
  const record = await editRecord(decodeURIComponent(raw))
  if (record === null) throw new HttpError(404, 'No edit made here by that id')
  send(res, 200, record)
})

// A person's clip made in the animation editor: into the library (server/clipedits.ts), as a job.
route('POST', /^\/api\/library\/edits$/, async (req, res) => {
  const body = await readJsonBody<SavedEdit>(req)
  if (typeof body.name !== 'string' || body.name.trim() === '') throw new HttpError(400, 'Name the clip')
  if (body.slot !== undefined && typeof body.slot !== 'string') throw new HttpError(400, 'Bad slot')
  try { checkMaking(body.making) } catch (error) { throw new HttpError(400, (error as Error).message) }
  const c = await saver(body.characterId)
  if (c !== null && c.skeleton.template !== 'human') throw new HttpError(400, `A ${c.skeleton.template}'s clip is saved beside its own clips, not in the library`)
  if (typeof body.replace === 'string') await mayReplace(body.replace, c, body.slot)
  const id = await editId(body)
  let job
  try {
    job = enqueue('clip', `Save ${body.name.trim()} to the library`, c?.id, async (_job, update, signal) => {
      await saveEdit(id, body, (progress, message) => { update({ progress, message }) }, signal)
    }, { lock: 'none' })
  } catch (error) {
    release(id)
    throw error
  }
  send(res, 202, { id, job: job.id })
})

// A creature's clip made in the animation editor (a .glb on its template's skeleton): beside the bundled ones.
route('POST', /^\/api\/library\/creature-clips$/, async (req, res, _, url) => {
  const q = (k: string): string => url.searchParams.get(k) ?? ''
  const c = await saver(q('characterId'))
  if (c !== null && c.skeleton.template === 'human') throw new HttpError(400, "A person's clip is saved through the library")
  const rig = c?.skeleton.template ?? q('rig')
  const replace = q('replace') || undefined
  if (replace !== undefined) {
    if (await creatureClip(replace) === null) throw new HttpError(404, `No clip ${replace} made here`)
    await mayReplace(replace, c, q('slot') || undefined)
  }
  let glb = await readBody(req, 64 * 1024 * 1024)
  try {
    // (with props=1 the body is the gear paths first: their JSON's length (4 bytes, little-endian), the JSON, then the .glb)
    let propPaths: unknown
    if (q('props') === '1') {
      const n = glb.length >= 4 ? glb.readUInt32LE(0) : -1
      if (n < 0 || 4 + n > glb.length) throw new Error('Bad gear paths')
      propPaths = JSON.parse(glb.subarray(4, 4 + n).toString('utf8'))
      glb = glb.subarray(4 + n)
    }
    send(res, 200, await saveCreatureClip({
      rig, name: q('name'), base: q('base'), category: q('category') || (await categoryOf(q('base'))) || 'gesture', loop: q('loop') === '1',
      inPlace: q('inPlace') === '1', duration: Number(q('duration')) || 0, propPaths: propPaths as never, replace,
    }, glb))
  } catch (error) {
    throw new HttpError(400, (error as Error).message)
  }
})
