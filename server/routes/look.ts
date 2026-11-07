// Look (DESIGN.md §7): the texture a character wears is each of its source model's images with the enabled look layers
// laid over it in order. Fill (holes repainted from the surface round them) and Keep (a projection painting) add
// layers; the look.layer.* commands switch, remove and order them; after any change to the layers the compose job lays
// them over the source's images again (texture_compose.py) and swaps the result into the model files. Never the
// import job: that would detect the joints again.
//
// Projection captures are folders (projections/<id>/) of what each view saw, what to repaint and the prompt; each
// view's result-N comes back from Codex or from the user.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { newId } from '../../src/model/ids.ts'
import type { Character, TextureImage, TextureLayer } from '../../src/model/types.ts'
import { imageNames, sameImage, swapImages } from '../glbimages.ts'
import { by, HttpError, readBody, route, send } from '../http.ts'
import { enqueue, getJob, type Job, listJobs, runBlender, runCodex, runQwenPaint, type Update } from '../jobs.ts'
import { afterChange, type Change, commit, getCharacter, paths, readJson, updateCharacter, withFiles, writeJson } from '../store.ts'

async function found (id: string): Promise<Character> {
  const c = await getCharacter(id)
  if (c === null) throw new HttpError(404, 'No such character')
  return c
}

const live = (job: Job | undefined): job is Job => job !== undefined && (job.status === 'queued' || job.status === 'running')
const KIND: Record<TextureLayer['kind'], string> = { fill: 'hole fill', repaint: 'repaint', snapshot: 'earlier texture' }

/** The clean names of the images in the character's model files: the one the viewer shows (the rig) first. */
async function modelImages (c: Character): Promise<string[]> {
  const dir = paths(c.id).dir
  const out: string[] = []
  for (const file of [c.files.rigged, c.files.model]) {
    if (file === undefined || !file.endsWith('.glb') || !existsSync(path.join(dir, file))) continue
    try {
      for (const name of await imageNames(path.join(dir, file))) if (!out.includes(name)) out.push(name)
    } catch { /* (not a GLB after all: it has no images to name) */ }
  }
  return out
}

/** An image found in the source by the names it goes by (texture_images.py), as the model files call it. */
const modelName = (names: string[], known: string[]): string =>
  known.find(k => names.some(n => sameImage(n, k))) ?? names[0]

const percent = (share: number): string => `${(share * 100).toFixed(share < 0.01 ? 2 : 1)}%`

// ---- compose ----------------------------------------------------------------------------------------------------

/** A compose queued that hasn't read the layers yet, per character: a change meanwhile needs no other. */
const waiting = new Map<string, Job>()
/** What the texture files hold, per character (its enabled layers in order), as of the last compose that finished. */
const composed = new Map<string, string>()

/** Enabled layers as a compose reads them: id, image and file, bottom to top. */
type Stack = Array<{ id: string, image: string, file: string }>

const stackOf = (layers: Stack): Stack => layers.map(l => ({ id: l.id, image: l.image, file: l.file }))
const signatureOf = (layers: Stack): string => JSON.stringify(stackOf(layers))
const signature = (c: Character): string => signatureOf(c.look.layers.filter(l => l.enabled))

/** textures/.composed.json: the enabled layers the texture files and model files were last composed from, and the
 * source they were composed on (its sha256). `layers` is null while a compose is under way: it writes the files in place,
 * so a restart can't tell what they hold. */
interface ComposedRecord { layers: Stack | null, at: number, source?: string }

const recordFile = (id: string): string => path.join(paths(id).textures, '.composed.json')

/** The sha256 of a character's source file (what its composites and layers were made on). */
async function sourceSha (c: Character): Promise<string> {
  return createHash('sha256').update(await readFile(path.join(paths(c.id).dir, c.source.file))).digest('hex')
}

async function writeRecord (id: string, layers: Stack | null, source?: string): Promise<void> {
  if (source === undefined) {
    const c = await getCharacter(id)
    if (c !== null && existsSync(path.join(paths(id).dir, c.source.file))) source = await sourceSha(c)
  }
  await writeJson(recordFile(id), { layers: layers === null ? null : stackOf(layers), at: Date.now(), ...(source !== undefined ? { source } : {}) } satisfies ComposedRecord)
}

/**
 * The texture overrides an import or a rig may lay over the source (textures/, its composites), or null for none.
 * A composite is only ever the source's own images with enabled layers over them, composed on THAT source: one left
 * from another body (a replaced or re-imported source), or with no enabled layer behind it, is old state, and laid over
 * a new body it put the old body's texture on it (the shaman healer, 2026-11-01: "old stuff poisoning current stuff for
 * weeks"). Those are moved to textures/.stale-<time>/ (recoverable, never applied), and when the source changed under
 * enabled layers, the layers (painted on the old body's UVs) are switched off, saying so in the journal.
 */
export async function textureOverrides (id: string, by: string): Promise<string | null> {
  const c = await getCharacter(id)
  if (c === null) return null
  const p = paths(id)
  const files = await composites(id)
  const sha = existsSync(path.join(p.dir, c.source.file)) ? await sourceSha(c) : undefined
  const record = await readRecord(id)
  const enabled = c.look.layers.filter(l => l.enabled)
  // (a record from before sources were recorded: trusted only with enabled layers behind it, and stamped now)
  const moved = record?.source !== undefined && sha !== undefined && record.source !== sha
  if (!moved && enabled.length > 0 && files.length > 0) {
    if (record?.source === undefined && sha !== undefined && record !== undefined) await writeJson(recordFile(id), { ...record, source: sha })
    return p.textures
  }
  if (files.length > 0) {
    const aside = path.join(p.textures, `.stale-${Date.now()}`)
    await mkdir(aside, { recursive: true })
    for (const f of files) await rename(path.join(p.textures, `${f}.png`), path.join(aside, `${f}.png`))
  }
  await writeJson(recordFile(id), { layers: [], at: Date.now(), ...(sha !== undefined ? { source: sha } : {}) } satisfies ComposedRecord)
  const lines: string[] = []
  if (files.length > 0) lines.push(`old texture composite${files.length === 1 ? '' : 's'} set aside, not applied (${files.join(', ')}: ${moved ? 'made on another body' : 'no paint layer behind ' + (files.length === 1 ? 'it' : 'them')}; textures/.stale-*)`)
  if (moved && enabled.length > 0) lines.push(`${enabled.length} paint layer${enabled.length === 1 ? '' : 's'} switched off: painted on another body's UVs`)
  if (lines.length > 0) {
    await updateCharacter(id, x => {
      if (moved) for (const l of x.look.layers) l.enabled = false
      x.look.at = Date.now()
    }, { by, what: 'look', changes: lines })
  }
  return null
}

/** The record, or undefined when the character was never composed. One that can't be read counts as a compose cut off. */
async function readRecord (id: string): Promise<ComposedRecord | undefined> {
  const file = recordFile(id)
  if (!existsSync(file)) return undefined
  const r = await readJson<Partial<ComposedRecord> | null>(file, null)
  const list: unknown = r?.layers
  const layers = Array.isArray(list) && list.every(l => typeof l === 'object' && l !== null) ? list as Stack : null
  return { layers, at: typeof r?.at === 'number' ? r.at : 0, ...(typeof r?.source === 'string' ? { source: r.source } : {}) }
}

/** Lay the character's enabled layers over its source's images and swap the result into its model files. Jobs asked
 * for while one waits to start are that one. */
export function compose (id: string, name: string): Job {
  const queued = waiting.get(id)
  if (live(queued)) return queued
  const job = enqueue('compose', `Texture · ${name}`, id, async (job, update, signal) => {
    // (from here a change to the layers needs a compose of its own: this one may have read them before it)
    if (waiting.get(id) === job) waiting.delete(id)
    const c = await getCharacter(id)
    if (c === null) return
    const wanted = signature(c)
    if (composed.get(id) === wanted) { update({ message: 'Already up to date' }); return }
    composed.delete(id)
    await runCompose(c, update, signal)
    composed.set(id, wanted)
  }, { lock: 'files' })
  waiting.set(id, job)
  return job
}

interface Composed { images: Array<{ names: string[], layers: number, composed: boolean, restored: boolean }>, unmatched: string[] }

async function runCompose (c: Character, update: Update, signal: AbortSignal): Promise<void> {
  const p = paths(c.id)
  const layers = c.look.layers.filter(l => l.enabled)
  for (const l of layers) {
    if (!existsSync(path.join(p.dir, l.file))) throw new Error(`The ${KIND[l.kind]} layer on ${l.image} has lost its file (${l.file})`)
  }
  const work = await mkdtemp(path.join(os.tmpdir(), 'rigsmith-compose-'))
  try {
    const list = path.join(work, 'layers.json')
    const restore = path.join(work, 'restore')
    await writeFile(list, JSON.stringify(layers.map(l => ({ image: l.image, file: path.join(p.dir, l.file) }))))
    update({ progress: 0.05, message: 'Laying the layers over the texture' })
    // (from here the files change; until the swap below is done they hold neither the old layers nor these)
    await writeRecord(c.id, null)
    const { result } = await runBlender('jobs/texture_compose.py', ['--input', path.join(p.dir, c.source.file), '--layers', list, '--textures', p.textures, '--restore', restore],
      (progress, message) => { update({ progress: 0.05 + progress * 0.8, message }) }, { signal })
    const r = result as unknown as Composed
    if (r.unmatched.length > 0) {
      const names = r.images.map(i => i.names[0]).join(', ') || 'none'
      throw new Error(`No image of the source is called ${[...new Set(r.unmatched)].join(', ')} (it has ${names}): switch that layer off or remove it`)
    }
    const changed = r.images.filter(i => i.composed || i.restored)
    update({ progress: 0.9, message: 'Putting the texture into the model' })
    let swapped = 0
    await withFiles(c.id, async () => {
      for (const file of [...new Set([c.files.model, c.files.rigged])]) {
        if (file === undefined || !file.endsWith('.glb') || !existsSync(path.join(p.dir, file))) continue
        const s = await swapImages(path.join(p.dir, file), p.textures, restore)
        swapped += s.swapped + s.restored
        // (a composite no image of the file takes would leave the texture shown and the look disagreeing)
        const missed = changed.filter(i => !i.names.some(n => s.matched.includes(n)))
        if (missed.length > 0) throw new Error(`${file} has no image called ${missed.map(i => i.names.join(' or ')).join(', ')}, so its texture didn't change`)
      }
      // (the texture files and the model files now hold these layers)
      await writeRecord(c.id, layers)
    })
    if (changed.length === 0 && swapped === 0) return
    // (housekeeping: the layer change that asked for it is the journal's line)
    await updateCharacter(c.id, x => {
      x.look.at = Date.now()
      if (swapped > 0) {
        x.revision += 1
        delete x.files.thumbnail
      }
    })
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

// Any change to the layers (a command, an undo, a fill or a keep) composes again; one that leaves the enabled layers
// as the files have them (a note) only when a compose is on its way anyway.
function layersChanged ({ id, character }: Change): void {
  const pending = listJobs().some(j => j.characterId === id && j.kind === 'compose' && live(j))
  if (!pending && composed.get(id) === signature(character)) return
  compose(id, character.name)
}
afterChange('layer:', layersChanged)
afterChange('layerOrder', layersChanged)

// ---- after a restart --------------------------------------------------------------------------------------------

/** The stems of textures/*.png, the composites (not the hole masks). */
async function composites (id: string): Promise<string[]> {
  const dir = paths(id).textures
  if (!existsSync(dir)) return []
  return (await readdir(dir)).filter(f => /\.png$/i.test(f) && !/\.mask\.png$/i.test(f)).map(f => f.slice(0, -4))
}

/** Whether the texture and model files may not hold the enabled layers, because a compose a restart cut off (or one
 * that never got to run) went with the server: the enabled layers (ids, images and files, in order) differ from
 * textures/.composed.json, or it says a compose was under way, or an image with enabled layers has no
 * textures/<image>.png. With no record yet, any enabled layer counts except the migration's snapshots (copied out of
 * the composites the files still hold), and so does a composite left on a model image with no enabled layer (a
 * compose deletes it). False when a compose would only fail, a layer having lost its file or naming an image the
 * model files don't have: the Look step says so on the next change. */
export async function composeStale (c: Character): Promise<boolean> {
  const p = paths(c.id)
  const layers = c.look.layers.filter(l => l.enabled)
  if (layers.some(l => !existsSync(path.join(p.dir, l.file)))) return false
  const record = await readRecord(c.id)
  const files = await composites(c.id)
  // (the model files are read only when the answer needs them)
  let known: string[] | undefined
  const model = async (): Promise<string[]> => (known ??= await modelImages(c))
  const missing = layers.some(l => !files.some(f => sameImage(f, l.image)))
  let stale: boolean
  if (record !== undefined) stale = missing || record.layers === null || signatureOf(record.layers) !== signature(c)
  else if (missing || layers.some(l => l.kind !== 'snapshot')) stale = true
  else if (files.length === 0) stale = false
  else {
    const images = await model()
    stale = files.some(f => images.some(k => sameImage(k, f)) && !layers.some(l => sameImage(l.image, f)))
  }
  if (!stale) return false
  const images = await model()
  return layers.every(l => images.some(k => sameImage(k, l.image)))
}

/** Delete the working folders of fills a restart cut off (textures/layers/.fill-*). How many went. */
export async function sweepFills (id: string): Promise<number> {
  const layers = paths(id).layers
  if (!existsSync(layers)) return 0
  let swept = 0
  for (const e of await readdir(layers, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith('.fill-')) continue
    await rm(path.join(layers, e.name), { recursive: true, force: true })
    swept++
  }
  return swept
}

// ---- fill -------------------------------------------------------------------------------------------------------

interface Filled { names: string[], coverage: number, file: string | null }

/** Find the source's holes and fill them: per image with holes, a fill layer at the bottom in place of its last. */
function fill (c: Character, who: string): Job {
  return enqueue('texture', `Fill holes · ${c.name}`, c.id, async (job, update, signal) => {
    const p = paths(c.id)
    await mkdir(p.layers, { recursive: true })
    // (made beside the layers, so each is moved into place on the same disk)
    const work = await mkdtemp(path.join(p.layers, '.fill-'))
    try {
      const now = await found(c.id)
      const { result } = await runBlender('jobs/texture_fill.py', ['--input', path.join(p.dir, now.source.file), '--out', work],
        (progress, message) => { update({ progress: progress * 0.9, message }) }, { signal })
      const known = await modelImages(now)
      const scan: TextureImage[] = []
      const made: TextureLayer[] = []
      for (const im of (result as unknown as { images: Filled[] }).images) {
        const image = modelName(im.names, known)
        scan.push({ image, coverage: im.coverage })
        if (im.file === null) continue
        const id = newId()
        await rename(path.join(work, im.file), path.join(p.layers, `${id}.png`))
        made.push({ id, kind: 'fill', image, file: `textures/layers/${id}.png`, enabled: true, at: Date.now(), coverage: im.coverage })
      }
      const changes = made.length === 0
        ? [`hole scan: no holes in ${scan.map(s => s.image).join(', ') || 'the texture'}`]
        : made.map(l => `hole fill layer on ${l.image} (${percent(l.coverage ?? 0)} of it was unpainted)`)
      await commit(c.id, x => {
        x.look.scan = { images: scan, at: Date.now() }
        if (made.length === 0) return
        const replaced = x.look.layers.filter(l => l.kind === 'fill' && made.some(m => sameImage(m.image, l.image)))
        if (replaced.length > 0) changes.push(`replaces the earlier hole fill${replaced.length === 1 ? '' : 's'} (undo brings ${replaced.length === 1 ? 'it' : 'them'} back)`)
        x.look.layers = [...made, ...x.look.layers.filter(l => !replaced.includes(l))]
      }, { by: who, what: 'look.fill', changes, undoable: made.length > 0 })
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }, { lock: 'files' })
}

route('POST', /^\/api\/characters\/([a-z0-9-]+)\/texture\/fill$/, async (req, res, [id]) => {
  const c = await found(id)
  const running = listJobs().find(j => j.characterId === id && j.kind === 'texture' && live(j))
  send(res, 202, running ?? fill(c, by(req)))
})

// ---- layers -----------------------------------------------------------------------------------------------------

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PART = /^[A-Za-z0-9_-]{1,64}$/

// A repaint (projection painting's Keep): a decal in an image's layout, a new layer on top; then compose.
route('POST', /^\/api\/characters\/([a-z0-9-]+)\/look\/layers$/, async (req, res, [id], url) => {
  const c = await found(id)
  const asked = url.searchParams.get('image') ?? ''
  const known = await modelImages(c)
  const image = known.find(k => k === asked) ?? known.find(k => sameImage(k, asked))
  if (asked === '' || image === undefined) {
    throw new HttpError(400, known.length === 0 ? 'The model has no named images to paint' : `The model has no image called ${asked || '(none)'}: it has ${known.join(', ')}`)
  }
  const capture = url.searchParams.get('capture') ?? undefined
  if (capture !== undefined && !PART.test(capture)) throw new HttpError(400, 'Bad capture id')
  const note = (url.searchParams.get('note') ?? '').trim().slice(0, 2000) || undefined
  const bytes = await readBody(req, 256 * 1024 * 1024)
  if (bytes.length < 8 || PNG.some((b, i) => bytes[i] !== b)) throw new HttpError(400, 'A layer is a PNG image')
  const layer: TextureLayer = { id: newId(), kind: 'repaint', image, file: '', enabled: true, at: Date.now() }
  layer.file = `textures/layers/${layer.id}.png`
  if (capture !== undefined) layer.capture = capture
  if (note !== undefined) layer.note = note
  await mkdir(paths(id).layers, { recursive: true })
  await writeFile(path.join(paths(id).dir, layer.file), bytes)
  const done = await commit(id, x => { x.look.layers.push(layer) }, {
    by: by(req), what: 'look.layer.add', changes: [`repaint layer on ${image}${note === undefined ? '' : `: ${note.length > 80 ? `${note.slice(0, 80)}…` : note}`}`], undoable: true,
  })
  send(res, 201, { character: done.character, entry: done.entry, job: compose(id, done.character.name) })
})

// ---- projection captures ----------------------------------------------------------------------------------------

/** What a capture's views.json holds. */
interface Views { views: Array<{ name: string }>, notes?: string }

async function viewsOf (dir: string): Promise<Views | null> {
  try {
    const v = JSON.parse(await readFile(path.join(dir, 'views.json'), 'utf8')) as Views
    return Array.isArray(v.views) && v.views.length > 0 ? v : null
  } catch { return null }
}

/** When Codex was last asked to paint the capture (results from before don't count). */
async function requestedAt (dir: string): Promise<number | null> {
  try {
    const r = JSON.parse(await readFile(path.join(dir, 'request.json'), 'utf8')) as { requestedAt?: unknown }
    return typeof r.requestedAt === 'number' ? r.requestedAt : null
  } catch { return null }
}

const RESULT = /^result-(\d{1,2})\.(png|jpe?g|webp)$/i

/** Each view's result-N, with when it was written, or null where it has none. */
async function resultsOf (dir: string, views: number): Promise<Array<{ file: string, at: number } | null>> {
  const files = existsSync(dir) ? await readdir(dir) : []
  return await Promise.all(Array.from({ length: views }, async (_, i) => {
    const file = files.find(f => RESULT.exec(f)?.[1] === String(i + 1))
    return file === undefined ? null : { file, at: (await stat(path.join(dir, file))).mtimeMs }
  }))
}

/** A capture as the app sees it: a view counts as painted when its result is newer than the last request to Codex,
 * and the capture is ready to preview only when every view is. */
async function captureInfo (id: string, pid: string): Promise<{
  id: string, path: string, createdAt: number, views: number, names: string[], notes: string, requestedAt: number | null
  results: Array<{ file: string, at: number, fresh: boolean } | null>, painted: number, ready: boolean, resultVersion: number | null
} | null> {
  const dir = paths(id).projection(pid)
  const v = await viewsOf(dir)
  if (v === null) return null
  const asked = await requestedAt(dir)
  const results = (await resultsOf(dir, v.views.length)).map(r => (r === null ? null : { ...r, fresh: asked === null || r.at >= asked }))
  const painted = results.filter(r => r?.fresh === true).length
  const ready = painted === results.length
  // (the app names a capture after when it was made: p<base-36 ms>; a folder's own times move as results land)
  const stamp = /^p([0-9a-z]{6,12})$/.exec(pid)
  const createdAt = stamp !== null ? parseInt(stamp[1], 36) : await stat(dir).then(s => s.birthtimeMs || s.mtimeMs)
  return {
    id: pid, path: dir, createdAt, views: v.views.length, names: v.views.map(x => x.name),
    notes: typeof v.notes === 'string' ? v.notes : '', requestedAt: asked, results, painted, ready,
    resultVersion: ready ? Math.max(...results.map(r => r!.at)) : null,
  }
}

// (what a capture holds: what each view saw, the masks, the prompt and each view's result; nothing else is written)
const CAPTURE_FILE = /^(view-\d{1,2}-(color|flat|mask)\.png|uvmask\.png|views\.json|prompt\.md|result-\d{1,2}\.(png|jpe?g|webp))$/i

route('PUT', /^\/api\/characters\/([a-z0-9-]+)\/projections\/([A-Za-z0-9_-]+)\/([\w.-]+)$/, async (req, res, [id, pid, file]) => {
  if (!CAPTURE_FILE.test(file)) throw new HttpError(400, `A capture has no file called ${file}`)
  await found(id)
  const dir = paths(id).projection(pid)
  const bytes = await readBody(req, 64 * 1024 * 1024)
  await mkdir(dir, { recursive: true })
  const result = RESULT.exec(file)
  if (result !== null) {
    // (one result a view: the one before goes, whatever kind of image it was)
    for (const f of await readdir(dir)) if (f !== file && RESULT.exec(f)?.[1] === result[1]) await unlink(path.join(dir, f))
  }
  // (written beside it, then moved over it: a poll never reads half an image)
  const tmp = path.join(dir, `.${file}.${process.pid}.tmp`)
  await writeFile(tmp, bytes)
  await rename(tmp, path.join(dir, file))
  send(res, 200, { path: path.join(dir, file) })
})

route('GET', /^\/api\/characters\/([a-z0-9-]+)\/projections$/, async (req, res, [id]) => {
  await found(id)
  const root = path.join(paths(id).dir, 'projections')
  const ids = existsSync(root) ? (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory() && PART.test(e.name)).map(e => e.name) : []
  // (captures from before views.json, one view masked on its image, are left on disk unlisted)
  const all = (await Promise.all(ids.map(async pid => await captureInfo(id, pid)))).filter(c => c !== null)
  send(res, 200, all.sort((a, b) => b.createdAt - a.createdAt).slice(0, 12)
    .map(c => ({ id: c.id, createdAt: c.createdAt, views: c.views, notes: c.notes, painted: c.painted, ready: c.ready })))
})

route('GET', /^\/api\/characters\/([a-z0-9-]+)\/projections\/([A-Za-z0-9_-]+)$/, async (req, res, [id, pid]) => {
  await found(id)
  const info = await captureInfo(id, pid)
  if (info === null) throw new HttpError(404, 'No such capture')
  send(res, 200, info)
})

/** The Codex job working on each capture. */
const painting = new Map<string, string>()

// Ask Codex (its CLI's image generation) to paint each view's result-N. Results older than this request no longer
// count: the capture is ready again once Codex has written every one.
route('POST', /^\/api\/characters\/([a-z0-9-]+)\/projections\/([A-Za-z0-9_-]+)\/codex$/, async (req, res, [id, pid]) => {
  const c = await found(id)
  const dir = paths(id).projection(pid)
  const v = await viewsOf(dir)
  if (v === null || !existsSync(path.join(dir, 'prompt.md'))) throw new HttpError(400, 'Capture the views first')
  const key = `${id}/${pid}`
  const busy = getJob(painting.get(key) ?? '')
  if (live(busy)) throw new HttpError(409, 'Codex is already painting this capture', { job: busy })
  const asked = Date.now()
  await writeFile(path.join(dir, 'request.json'), JSON.stringify({ requestedAt: asked, by: by(req) }))
  const count = v.views.length
  const job = enqueue('codex', `Codex painting · ${c.name}`, id, async (job, update, signal) => {
    update({ progress: 0.1, message: 'Codex is painting' })
    const prompt = await readFile(path.join(dir, 'prompt.md'), 'utf8')
    const images = Array.from({ length: count }, (_, i) => [`view-${i + 1}-flat.png`, `view-${i + 1}-mask.png`]).flat()
    await runCodex(dir, prompt, images, message => { update({ message }) }, { signal })
    const missing = (await resultsOf(dir, count)).flatMap((r, i) => (r === null || r.at < asked ? [`result-${i + 1}.png`] : []))
    if (missing.length > 0) throw new Error(`Codex finished without painting ${missing.join(', ')}`)
  }, { lock: 'none' })
  painting.set(key, job.id)
  send(res, 202, job)
})

// The same with Qwen Image 2.1 in the local ComfyUI (tools/paint_capture.py): each view's masked area painted at
// 512 px and laid back in its place, seconds a view; ComfyUI must be running. Shares the Codex job's slot per capture.
route('POST', /^\/api\/characters\/([a-z0-9-]+)\/projections\/([A-Za-z0-9_-]+)\/qwen$/, async (req, res, [id, pid]) => {
  const c = await found(id)
  const dir = paths(id).projection(pid)
  const v = await viewsOf(dir)
  if (v === null) throw new HttpError(400, 'Capture the views first')
  const key = `${id}/${pid}`
  const busy = getJob(painting.get(key) ?? '')
  if (live(busy)) throw new HttpError(409, 'This capture is already being painted', { job: busy })
  const asked = Date.now()
  await writeFile(path.join(dir, 'request.json'), JSON.stringify({ requestedAt: asked, by: by(req), painter: 'qwen' }))
  const count = v.views.length
  const job = enqueue('codex', `Qwen painting · ${c.name}`, id, async (job, update, signal) => {
    update({ progress: 0.05, message: 'Qwen is painting' })
    await runQwenPaint(dir, (progress, message) => { update({ progress, message }) }, { signal, job })
    const missing = (await resultsOf(dir, count)).flatMap((r, i) => (r === null || r.at < asked ? [`result-${i + 1}.png`] : []))
    if (missing.length > 0) throw new Error(`Qwen finished without painting ${missing.join(', ')}`)
  }, { lock: 'none' })
  painting.set(key, job.id)
  send(res, 202, job)
})
