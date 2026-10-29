// Sound routes: what an event can play. The game's sounds are its mix table's (<gameRepo>/assets/audio/mix.json, read
// only: Emberhold plays events by id, Audio.Sound), each with the files it picks from, as the game finds them (Audio.Stream
// and Pick: name_1..name_4 and the bare name, in vo/, sfx/, music/ or the audio folder itself), so the app can play them
// for a preview. A file dropped on an event is the character's own: kept under characters/<id>/sounds/ and named on the
// event 'file:sounds/<file>'; the game export copies the ones its events play (tools/lib/unit_export.ts copySounds) and
// the game's build installs them into its mix.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { link, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { HttpError, readBody, route, send } from '../http.ts'
import { characterDir, getCharacter, getSettings } from '../store.ts'

/** The kinds of file the game plays (Godot imports these three). */
export const AUDIO = /\.(wav|ogg|mp3)$/i
const TYPES: Record<string, string> = { '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg' }
/** The largest file dropped on an event. */
export const MAX_SOUND = 16 * 1024 * 1024
/** Where the game looks for a sound's file, in this order (Audio.Stream). */
const SUBDIRS = ['vo/', 'sfx/', 'music/', '']
const EXTS = ['.wav', '.ogg', '.mp3']

/** One of the game's sounds: its mix id, category, the files (relative to assets/audio) it picks from (a family,
 * '*_select', every file its pattern names), its level (dB) and pitch variation (a share either way). */
export interface GameSound { id: string, cat: string, files: string[], db: number, pitch: number, family?: boolean }
export interface GameSounds { repo: string, found: boolean, sounds: GameSound[] }
/** A file dropped on one of a character's events. */
export interface CharacterSound { file: string, sound: string, bytes: number }

interface MixDef { file?: unknown, files?: unknown, cat?: unknown, db?: unknown, pitch?: unknown }

/** The game's sounds from its mix table and the audio files there (`files`: every file under assets/audio, relative,
 * as `name.ext` or `sub/name.ext`). Pure. */
export function gameSounds (mix: unknown, files: string[]): GameSound[] {
  const table = (mix as { sounds?: Record<string, MixDef> } | null)?.sounds
  if (table === undefined || table === null || typeof table !== 'object') return []
  const have = new Set(files)
  // (the first of the folders that has it, as the game loads it)
  const find = (name: string): string | null => {
    for (const sub of SUBDIRS) for (const ext of EXTS) if (have.has(sub + name + ext)) return sub + name + ext
    return null
  }
  const takes = (name: string): string[] => {
    const out: string[] = []
    for (let i = 1; i < 5; i++) { const f = find(`${name}_${i}`); if (f !== null) out.push(f) }
    const bare = find(name)
    // (the bare name too when there are no takes, or when it is a recorded file in a folder, not a procedural fallback)
    if (bare !== null && (out.length === 0 || bare.includes('/'))) out.push(bare)
    return [...new Set(out)]
  }
  const out: GameSound[] = []
  for (const [id, d] of Object.entries(table)) {
    if (d === null || typeof d !== 'object') continue
    const cat = typeof d.cat === 'string' ? d.cat : ''
    // (its own level and pitch variation, as the game plays it: a preview sounds like the game)
    const db = typeof d.db === 'number' && Number.isFinite(d.db) ? d.db : 0
    const pitch = typeof d.pitch === 'number' && Number.isFinite(d.pitch) ? d.pitch : 0
    const names = Array.isArray(d.files) && d.files.every(f => typeof f === 'string') && d.files.length > 0 ? d.files as string[] : typeof d.file === 'string' ? [d.file] : []
    if (names.some(n => n.includes('*'))) {
      const pattern = new RegExp(`^${names[0].split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[\\w-]+')}(_[1-4])?$`)
      const matched = files.filter(f => AUDIO.test(f) && pattern.test(path.basename(f).replace(AUDIO, '')))
      out.push({ id, cat, files: matched.sort(), db, pitch, family: true })
      continue
    }
    out.push({ id, cat, files: names.flatMap(takes), db, pitch })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/** A dropped file's name as kept: lower case, letters, digits, '_' and '-' ('sound' when nothing is left of it: a file
 * named `.wav`), its extension kept. */
export function soundName (file: string): string {
  const name = path.basename(file.replace(/\\/g, '/'))
  // (the extension as AUDIO reads it: path.extname takes `.wav` for a dot file without one)
  const ext = (AUDIO.exec(name)?.[0] ?? path.extname(name)).toLowerCase()
  const base = name.slice(0, name.length - ext.length).toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '').slice(0, 48)
  return `${base === '' ? 'sound' : base}${ext}`
}

const audioDir = async (): Promise<{ repo: string, dir: string }> => {
  const repo = (await getSettings()).gameRepo
  return { repo, dir: path.join(repo, 'assets', 'audio') }
}

async function audioFiles (dir: string): Promise<string[]> {
  const out: string[] = []
  for (const sub of SUBDIRS) {
    let names: string[]
    try { names = await readdir(path.join(dir, sub)) } catch { continue }
    for (const n of names) if (AUDIO.test(n)) out.push(sub + n)
  }
  return out
}

const soundsDir = (id: string): string => path.join(characterDir(id), 'sounds')

async function character (id: string): Promise<void> {
  if (await getCharacter(id) === null) throw new HttpError(404, 'No such character')
}

async function listSounds (id: string): Promise<CharacterSound[]> {
  let names: string[]
  try { names = await readdir(soundsDir(id)) } catch { return [] }
  const out: CharacterSound[] = []
  for (const file of names.filter(n => AUDIO.test(n)).sort()) out.push({ file, sound: `file:sounds/${file}`, bytes: (await stat(path.join(soundsDir(id), file))).size })
  return out
}

function stream (res: import('node:http').ServerResponse, file: string, bytes: Buffer): void {
  res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  res.end(bytes)
}

// The game's sounds (its mix table's ids, each with the files it plays), read only. No game repo or no table: none.
route('GET', /^\/api\/game\/sounds$/, async (req, res) => {
  const { repo, dir } = await audioDir()
  let mix: unknown = null
  try { mix = JSON.parse(await readFile(path.join(dir, 'mix.json'), 'utf8')) } catch { /* (no game here: no sounds) */ }
  const body: GameSounds = { repo, found: mix !== null, sounds: mix === null ? [] : gameSounds(mix, await audioFiles(dir)) }
  send(res, 200, body)
})

// One of the game's audio files (a preview plays it).
route('GET', /^\/api\/game\/sounds\/file\/((?:vo\/|sfx\/|music\/)?[\w-]+\.(?:wav|ogg|mp3))$/, async (req, res, [file]) => {
  const { dir } = await audioDir()
  const at = path.join(dir, file)
  if (!existsSync(at)) throw new HttpError(404, 'No such sound')
  stream(res, file, await readFile(at))
})

// The files dropped on a character's events.
route('GET', /^\/api\/characters\/([a-z0-9-]+)\/sounds$/, async (req, res, [id]) => {
  await character(id)
  send(res, 200, await listSounds(id))
})

route('GET', /^\/api\/characters\/([a-z0-9-]+)\/sounds\/([\w-]+\.(?:wav|ogg|mp3))$/, async (req, res, [id, file]) => {
  await character(id)
  const at = path.join(soundsDir(id), file)
  if (!existsSync(at)) throw new HttpError(404, 'No such sound')
  stream(res, file, await readFile(at))
})

// A file dropped on an event (?name=<its file name>): kept under the character's sounds/ by a clean name (the same
// bytes again: the file there; another file of that name: numbered). The event names it with slot.event.update.
route('POST', /^\/api\/characters\/([a-z0-9-]+)\/sounds$/, async (req, res, [id], url) => {
  await character(id)
  const given = url.searchParams.get('name')
  if (given === null || !AUDIO.test(given)) throw new HttpError(400, 'Sounds the game plays: WAV, OGG or MP3')
  const bytes = await readBody(req, MAX_SOUND)
  if (bytes.length === 0) throw new HttpError(400, 'The file is empty')
  const dir = soundsDir(id)
  await mkdir(dir, { recursive: true })
  const file = await keepSound(dir, soundName(given), bytes)
  const out: CharacterSound = { file, sound: `file:sounds/${file}`, bytes: bytes.length }
  send(res, 201, out)
})

/** `bytes` kept in `dir` as `want` (a clean name), or `<stem>_2<ext>`... when another file has the name; the file of the
 * same bytes when one is there already. Written whole under a name of its own first and linked to the name (which
 * fails if it is taken), so two uploads at once never overwrite each other or leave half a file under the name.
 * Returns the name kept. */
export async function keepSound (dir: string, want: string, bytes: Buffer): Promise<string> {
  const hash = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
  const mine = hash(bytes)
  const ext = path.extname(want)
  const stem = want.slice(0, want.length - ext.length)
  const tmp = path.join(dir, `.${want}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  await writeFile(tmp, bytes, { flag: 'wx' })
  try {
    for (let n = 1; n < 10000; n++) {
      const file = n === 1 ? want : `${stem}_${n}${ext}`
      const at = path.join(dir, file)
      try {
        await link(tmp, at)
        return file
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      // (taken: by the same bytes, that file; else the next number)
      let there: Buffer | null = null
      try { there = await readFile(at) } catch { /* (gone meanwhile: the next number) */ }
      if (there !== null && hash(there) === mine) return file
    }
    throw new HttpError(409, `Too many sounds named ${want}`)
  } finally {
    await unlink(tmp).catch(() => {})
  }
}
