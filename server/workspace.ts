// The on-disk workspace: characters, library, exports and settings. Plain files, no database.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ClipScript } from '../src/engine/scripts.ts'

export const ROOT = path.resolve(import.meta.dirname, '..')
export const WORKSPACE = path.resolve(process.env.RIGSMITH_WORKSPACE ?? path.join(ROOT, 'workspace'))
export const CHARACTERS = path.join(WORKSPACE, 'characters')
export const LIBRARY = path.join(WORKSPACE, 'library')
export const EXPORTS = path.join(WORKSPACE, 'exports')
const SETTINGS = path.join(WORKSPACE, 'settings.json')

export type Vec3 = [number, number, number]

export interface Character {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  source: { file: string, originalName: string, bytes: number }
  status: 'importing' | 'ready' | 'rigging' | 'rigged' | 'error'
  /** What the import contained. */
  kind?: 'mesh' | 'rigged' | 'animation'
  rigPreset?: string
  stats?: { vertices: number, triangles: number, height: number, meshes: number, bones: number }
  /** Auto-detected or user-edited joint positions (glTF space: Y up, +Z forward). */
  joints?: Record<string, Vec3>
  /** Joints as detected on import, for "reset". */
  autoJoints?: Record<string, Vec3>
  jointsEdited?: boolean
  /** The Rig step's markers (src/engine/markers.ts): the skeleton they were seeded from and where they are now. */
  markers?: { set: string, base: Record<string, Vec3>, positions: Record<string, Vec3> }
  fingers?: 'none' | 'one' | 'two' | 'full'
  /** Skeleton template: 'human' (Mixamo, auto-placed) or a creature template id from static/templates. */
  template?: string
  /** For imported non-Mixamo skeletons: Mixamo bone -> this character's bone. */
  boneMap?: Record<string, string>
  /** Files relative to the character folder. */
  files: { model?: string, rigged?: string, thumbnail?: string }
  /** Bumped whenever the files change (cache-busting without reloading on every edit). */
  revision?: number
  thumbVersion?: number
  rigReport?: { method: string, seconds: number, warnings: string[] }
  texture?: { filled: boolean, images: TextureImage[], at: number, painted?: boolean }
  animations: AnimationEntry[]
  /** Switchable changes to the clips, played here and exported to the game alike (src/engine/scripts.ts). */
  scripts?: ClipScript[]
  /** Props/accessories pinned to bones (see src/engine/props.ts). */
  props?: PropAttachment[]
  /** The user's own meshes worn by the character (see src/engine/garments.ts). */
  garments?: Garment[]
  /** A horse this character rides (src/engine/mount.ts): its clips play under his, he sits on its back. */
  mount?: Mount
  /** Other skins for this character: colour maps on its own UVs (a horse's coats), by name, files relative to the
   * character folder. A rider's mount picks one. */
  skins?: Array<{ name: string, file: string }>
  error?: string
}

/** Riding: the horse (a creature character), the bone he sits on and where, and his lower body held in a seated pose
 * while the rest of him plays his clips (with his scripts, keys and gear, as on foot). */
export interface Mount {
  character: string
  bone: string
  /** His rest space placed in the horse's (his hips on its back), turned (XYZ degrees). His size against the horse is
   * the game's (the two units' heights in the spec), else `scale`. */
  position: Vec3
  rotation: Vec3
  scale?: number
  /** The bones held still (his lower body) and their seated pose: local rotations [x, y, z, w]; the Hips' local
   * position too. */
  freeze: string[]
  pose: Record<string, [number, number, number, number]>
  hips?: Vec3
  /** The horse's look for this rider: one of its skins (by name; unset: its own texture) and which of its garments it
   * wears (by name: a harness, a saddle, barding). One horse, its clips tuned once, dressed per unit. */
  skin?: string
  gear?: string[]
}

export interface Garment {
  id: string
  name: string
  /** Normalized model, relative to the character folder; absent while importing. */
  file?: string
  status: 'importing' | 'ready' | 'error'
  error?: string
  /** 'clothing' skins to the body; 'rigid' follows one bone. */
  mode: 'clothing' | 'rigid'
  /** Clothing: which bones may influence it. */
  policy: 'body' | 'cape' | 'skirt' | 'upper' | 'lower' | 'head'
  bone: string
  position: [number, number, number]
  rotation: [number, number, number]
  scale: number
  /** Hide body triangles covered by this garment (stops poke-through). */
  hideBody: boolean
  /** Not worn for now (kept, not shown or exported): one of several a unit swaps, like a villager's job tools. */
  hidden?: boolean
  /** Brought in by a tool rather than added by hand (tools/game_import.py: "emberhold:<unit>/<part>"). */
  from?: string
  /** A rigid one's grips (the animation editor's: a hand put on one holds it there; src/engine/clipedit.ts Socket). */
  sockets?: GarmentSocket[]
}

/** A grip on a rigid garment: where a hand's wrist goes and how the hand turns, in the garment's own placed frame. */
export interface GarmentSocket {
  id: string
  name: string
  position: [number, number, number]
  rotation: [number, number, number, number]
}

export interface PropAttachment {
  id: string
  ref: string
  name: string
  socket: string
  position: [number, number, number]
  rotation: [number, number, number]
  scale: number
}

export interface TextureImage {
  image: string
  /** Fraction of the texture detected as unpainted (magenta). */
  coverage: number
  file: string | null
  mask?: string
}

export interface AnimationEntry {
  clipId: string
  /** Where the clip loads from; omitted for converted library clips (clips/<clipId>.glb). */
  url?: string
  name: string
  inPlace: boolean
  loop: boolean
  speed: number
  trim?: [number, number]
  /** Why this clip (what it does with the unit's gear, what the others did wrong). */
  note?: string
  /** Keyframed tweaks on top of the clip as it plays (after its speed and scripts): src/engine/keys.ts. */
  keys?: ClipKeys
  /** The clip's ground: the whole body raised (+) or lowered (-) through it, in the character's units (its height about
   * 1), so its feet meet the ground (Mixamo clips often sink them a few per cent of the height). */
  lift?: number
}

/** A clip's keyframed tweaks: per bone (by name) and per prop (rigid garment, by name), each a list of keys at a phase of
 * the clip (0 its start, 1 its end; a looping clip's keys wrap round). A bone's key turns it on top of the clip in its own
 * frame (the Hips may also move); a prop's moves and turns it from where it is placed, about its pivot (where it is held). */
export interface ClipKeys {
  bones?: Record<string, ClipKey[]>
  props?: Record<string, ClipKey[]>
}
export interface ClipKey {
  u: number
  /** The turn, a quaternion [x, y, z, w]. */
  q: [number, number, number, number]
  /** The move (the Hips: in its parent's frame; a prop: in its own placed frame). */
  p?: [number, number, number]
}

export interface Settings {
  exportDir: string
  exportFormat: 'glb' | 'fbx'
  boneNames: 'mixamo' | 'mixamorig'
  /** The game's repo (Emberhold): Export writes its units (tools/rigsmith/units.json, the models and maps). Rigsmith's own
   * list of units is server/game.ts's (workspace/game/units.json). */
  gameRepo: string
}

const DEFAULT_SETTINGS: Settings = {
  exportDir: EXPORTS,
  exportFormat: 'glb',
  boneNames: 'mixamo',
  gameRepo: path.join(homedir(), 'dev', 'games', 'emberhold'),
}

export async function ensureWorkspace (): Promise<void> {
  for (const dir of [CHARACTERS, LIBRARY, EXPORTS]) await mkdir(dir, { recursive: true })
}

export async function readJson<T> (file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Atomic JSON write (temp file + rename) so a crash never leaves half a file. */
export async function writeJson (file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 1))
  await rename(temp, file)
}

export function characterDir (id: string): string {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Bad character id')
  return path.join(CHARACTERS, id)
}

export async function listCharacters (): Promise<Character[]> {
  const entries = existsSync(CHARACTERS) ? await readdir(CHARACTERS) : []
  const all = await Promise.all(entries.map(async id => await readJson<Character | null>(path.join(CHARACTERS, id, 'character.json'), null)))
  return all.filter((c): c is Character => c !== null).sort((a, b) => a.createdAt - b.createdAt)
}

export async function getCharacter (id: string): Promise<Character | null> {
  return await readJson<Character | null>(path.join(characterDir(id), 'character.json'), null)
}

// Serialize writes per character so concurrent job updates can't clobber each other.
const locks = new Map<string, Promise<unknown>>()

export async function updateCharacter (id: string, change: (c: Character) => void): Promise<Character> {
  const previous = locks.get(id) ?? Promise.resolve()
  const next = previous.then(async () => {
    const character = await getCharacter(id)
    if (character === null) throw new Error(`No character ${id}`)
    change(character)
    character.updatedAt = Date.now()
    await writeJson(path.join(characterDir(id), 'character.json'), character)
    return character
  })
  locks.set(id, next.catch(() => {}))
  return await next
}

export async function createCharacter (originalName: string, bytes: Buffer): Promise<Character> {
  const stem = originalName.replace(/\.[^.]+$/, '').replace(/_rigged$/i, '')
  const slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'character'
  const id = `${slug}-${createHash('sha256').update(bytes).digest('hex').slice(0, 6)}`
  const dir = characterDir(id)
  const existing = await getCharacter(id)
  if (existing !== null) return existing
  const ext = path.extname(originalName).toLowerCase()
  await mkdir(path.join(dir, 'source'), { recursive: true })
  const file = `source/original${ext}`
  await writeFile(path.join(dir, file), bytes)
  const now = Date.now()
  const character: Character = {
    id,
    name: stem.replace(/[_-]+/g, ' ').replace(/\b\w/g, m => m.toUpperCase()),
    createdAt: now,
    updatedAt: now,
    source: { file, originalName, bytes: bytes.length },
    status: 'importing',
    files: {},
    animations: [],
  }
  await writeJson(path.join(dir, 'character.json'), character)
  return character
}

export async function deleteCharacter (id: string): Promise<void> {
  await rm(characterDir(id), { recursive: true, force: true })
}

export async function getSettings (): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await readJson<Partial<Settings>>(SETTINGS, {})) }
}

export async function saveSettings (change: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...change }
  if (next.exportDir.startsWith('~')) next.exportDir = path.join(homedir(), next.exportDir.slice(1))
  if (next.gameRepo.startsWith('~')) next.gameRepo = path.join(homedir(), next.gameRepo.slice(1))
  await writeJson(SETTINGS, next)
  return next
}
