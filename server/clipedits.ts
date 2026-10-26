// Clips made in the animation editor (src/state/clipedit.svelte.ts), saved into the library: the edit (its frames on
// the base clip's own skeleton, its keys to open it again) as workspace/library/sources/custom/<id>.edit.json, its line
// in the library's sources (made by blender/clips/edit.py), then the library's build: convert (which makes it) and
// aggregate (which lists it, tagged custom, in the base clip's category). One save at a time: they share the library.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { LIBRARY, ROOT } from './workspace.ts'

export interface EditFrames { fps: number, bones: string[], rotations: number[][][], hips: number[][] }
export interface SavedEdit { name: string, base: string, loop?: boolean, keys?: unknown, frames: EditFrames }

const MAKE = 'blender/clips/edit.py'

function slug (name: string): string {
  return name.trim().replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('_').slice(0, 60) || 'Clip'
}

async function readJson<T> (file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T } catch { return fallback }
}

/** The FBX whose armature has the base clip's rest: its source; a made clip's first input; an edit's own. */
async function restOf (base: string): Promise<string> {
  const meta = await readJson<{ sourcePath?: string, make?: string } | null>(path.join(LIBRARY, 'meta', `${base}.json`), null)
  if (meta === null) throw new Error(`No library clip ${base}`)
  let rest: string | undefined
  if (meta.make === MAKE && meta.sourcePath !== undefined) rest = (await readJson<{ restFrom?: string }>(meta.sourcePath, {})).restFrom
  else if (meta.make !== undefined) {
    const sources = await readJson<Array<{ id: string, inputs?: string[] }>>(path.join(LIBRARY, 'work', 'sources.json'), [])
    rest = sources.find(s => s.id === base)?.inputs?.find(p => p.toLowerCase().endsWith('.fbx'))
  } else rest = meta.sourcePath
  if (rest === undefined || !rest.toLowerCase().endsWith('.fbx') || !existsSync(rest)) throw new Error(`The skeleton ${base} came from isn't here (${rest ?? 'unknown'})`)
  return rest
}

function check (e: SavedEdit): void {
  if (typeof e.name !== 'string' || e.name.trim() === '' || e.name.length > 80) throw new Error('Name the clip')
  if (typeof e.base !== 'string' || !/^[\w-]+$/.test(e.base)) throw new Error('Which clip was edited?')
  const f = e.frames
  if (f === undefined || !Array.isArray(f.bones) || !Array.isArray(f.rotations) || !Array.isArray(f.hips) || f.rotations.length !== f.hips.length || f.rotations.length < 1 || f.rotations.length > 30 * 120) throw new Error('No frames')
  if (!f.rotations.every(r => Array.isArray(r) && r.length === f.bones.length && r.every(q => Array.isArray(q) && q.length === 4 && q.every(Number.isFinite)))) throw new Error('Bad frames')
  if (!f.hips.every(p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))) throw new Error('Bad hips')
}

async function run (command: string, args: string[], onLine: (line: string) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const take = (d: Buffer): void => { const s = d.toString(); tail = (tail + s).slice(-3000); for (const l of s.split('\n')) if (l.trim() !== '') onLine(l) }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', reject)
    child.on('close', code => { code === 0 ? resolve() : reject(new Error(`${path.basename(args[0] ?? command)} ${args[1] ?? ''} failed: ${tail.trim().split('\n').slice(-3).join(' ')}`)) })
  })
}

let queue: Promise<unknown> = Promise.resolve()

/** The id a new clip of this name gets (one the library hasn't). */
export async function newId (name: string): Promise<string> {
  const base = `custom-${slug(name)}`
  const sources = await readJson<Array<{ id: string }>>(path.join(LIBRARY, 'work', 'sources.json'), [])
  const taken = new Set(sources.map(s => s.id))
  let id = base
  for (let k = 2; taken.has(id) || existsSync(path.join(LIBRARY, 'meta', `${id}.json`)); k++) id = `${base}_${k}`
  return id
}

/** Save an edit into the library as clip `id`. */
export async function saveEdit (id: string, e: SavedEdit, update: (progress: number, message: string) => void): Promise<void> {
  check(e)
  const turn = queue.then(async () => {
    update(0.05, 'Finding the skeleton it came from')
    const restFrom = await restOf(e.base)
    const manifest = await readJson<{ clips: Array<{ id: string, name: string, category: string }> }>(path.join(LIBRARY, 'manifest.json'), { clips: [] })
    const from = manifest.clips.find(c => c.id === e.base)
    const dir = path.join(LIBRARY, 'sources', 'custom')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, `${id}.edit.json`)
    const edit = {
      id, name: e.name.trim(), base: e.base, category: from?.category ?? null, tags: ['custom'],
      description: `Made in Rigsmith's animation editor from ${from?.name ?? e.base}.`,
      restFrom, loop: e.loop ?? true, keys: e.keys ?? {}, frames: e.frames, createdAt: new Date().toISOString(),
    }
    await writeFile(file, JSON.stringify(edit))
    // its line in the sources: the build makes it with blender/clips/edit.py
    const sourcesFile = path.join(LIBRARY, 'work', 'sources.json')
    const sources = await readJson<Array<Record<string, unknown>>>(sourcesFile, [])
    const line = {
      id, sha256: '', kind: 'clip', source: 'custom', sourcePath: file, make: MAKE, args: ['--edit', file],
      inputs: [file, restFrom, path.join(ROOT, 'blender', 'clips', 'common.py')], sourceName: id, name: edit.name, originalName: edit.name,
      description: edit.description, tags: edit.tags, category: edit.category,
    }
    await writeFile(sourcesFile, JSON.stringify([...sources.filter(s => s.id !== id), line], null, 1))
    update(0.2, 'Writing it into the library (Blender)')
    await run('python3', [path.join(ROOT, 'blender', 'library', 'build.py'), 'convert', '--sources', 'custom'], l => { if (/making|convert done/.test(l)) update(0.5, l.replace(/^\S+ /, '').slice(0, 100)) })
    if (!existsSync(path.join(LIBRARY, 'clips', `${id}.glb`))) throw new Error('Blender wrote no clip (see workspace/library/failures.json)')
    update(0.75, 'Listing it in the library')
    await run('python3', [path.join(ROOT, 'blender', 'library', 'build.py'), 'aggregate'], () => {})
    update(1, `${edit.name} is in the library (${id}, ${edit.category ?? 'its own category'})`)
  })
  queue = turn.catch(() => {})
  await turn
}

/** A creature's clip (a horse's: not a library clip) saved as made: its file into workspace/library/creatures/<rig>/,
 * its line in creatures/index.json (server/library.ts lists them beside the bundled ones: source custom, tagged
 * custom, in the category of the clip it came from). */
export async function saveCreatureClip (p: { rig: string, name: string, base: string, category: string, loop: boolean, inPlace: boolean, duration: number }, glb: Buffer): Promise<{ id: string }> {
  if (!/^[a-z0-9_-]+$/.test(p.rig)) throw new Error('Which body?')
  if (p.name.trim() === '' || p.name.length > 80) throw new Error('Name the clip')
  if (glb.length < 20 || glb.readUInt32LE(0) !== 0x46546C67) throw new Error('Not a .glb')
  const dir = path.join(LIBRARY, 'creatures')
  const indexFile = path.join(dir, 'index.json')
  const index = await readJson<{ clips: Array<Record<string, unknown>> }>(indexFile, { clips: [] })
  const stem = `custom-${p.rig}-${slug(p.name)}`
  let id = stem
  for (let k = 2; index.clips.some(c => c.id === id); k++) id = `${stem}_${k}`
  await mkdir(path.join(dir, p.rig), { recursive: true })
  const file = `creatures/${p.rig}/${id}.glb`
  await writeFile(path.join(LIBRARY, file), glb)
  const frames = Math.round(p.duration * 30) + 1
  index.clips = [...index.clips.filter(c => c.id !== id), {
    id, name: p.name.trim(), description: `Made in Rigsmith's animation editor from ${p.base}.`, source: 'custom', nameSource: 'source', file, fps: 30, frames,
    duration: Math.round(p.duration * 1e4) / 1e4, category: p.category, tags: ['custom', p.loop ? 'loop' : 'one-shot', p.inPlace ? 'in-place' : 'root-motion'],
    loop: p.loop, inPlace: p.inPlace, rig: p.rig, base: p.base, createdAt: new Date().toISOString(),
  }]
  await writeFile(indexFile, JSON.stringify(index, null, 1))
  return { id }
}
