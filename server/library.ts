// The clip library: one searchable list of three catalogs, merged when asked: workspace/library/manifest.json (the
// converted Mixamo collection and clips made here, written by blender/library), the clips bundled with the app
// (static/animations/<rig>-*.glb, several per file) and the clips the animation editor made for creature rigs
// (workspace/library/creatures/index.json). One category vocabulary for all three (blender/library/aggregate.py's);
// each catalog is re-read when its file changes. Serves filtered, paginated pages (server/routes/library.ts).
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { readGlb, type Gltf } from '../src/engine/glb.ts'
import type { ClipKey } from '../src/model/types.ts'
import { libraryManifest } from './files.ts'
import { LIBRARY, readJson, ROOT } from './store.ts'

export interface Clip {
  id: string
  name: string
  /** Mixamo's longer description ("Walking With A Briefcase"); tells apart clips sharing a name. */
  description?: string
  /** Short label telling apart distinct clips with the same name + description ("turns 90° left"). */
  variant?: string
  sourceName?: string
  originalName?: string
  motionId?: string
  /**
   * Where the name came from: 'source' (the user's file name), 'matched' (pack clip matching one of
   * those), 'motion-match' (names file, confident), 'motion-candidate' (names file, closest of
   * several near-equal `candidates`), 'catalog' (publisher metadata for that exact source FBX),
   * 'provisional' (generated from motion features), 'bundled'.
   */
  nameSource?: string
  /** Where the motion contradicts the name (tools/library_audit.py): "walks?" a walk that doesn't step, "standing?" a
   * seated / crouched / lying clip whose name doesn't say so, "dies?", "jumps?". */
  problems?: Array<{ rule: string, says: string, motion: string }>
  /** Other names an uncertain ('motion-candidate') clip may have. */
  candidates?: Array<{ name: string, description?: string | null, rmsDeg?: number }>
  source: string
  file: string
  fps: number
  frames: number
  duration: number
  /** One of CATEGORIES. */
  category: string
  confidence?: number
  tags: string[]
  loop: boolean
  inPlace: boolean
  duplicateOf?: string | null
  /** Skeleton the clip is for: 'human' (Mixamo) or a creature template id. */
  rig?: string
  /** A clip made with gear leading (in the animation editor): each piece's path, by gear name (shared across
   * characters; a slot takes them as keys on its own gear of that name, select.gearKeysFromPaths). */
  propPaths?: Record<string, ClipKey[]>
  /** Absolute URL when the clip lives outside workspace/library (bundled clips). */
  href?: string
  /** Its file's content hash (server/files.ts), for a library clip: the page loads it as `url?h=<hash>`. */
  hash?: string
}

interface Manifest {
  version: number
  skeleton: string
  categories: Array<{ id: string, label: string, count: number }>
  clips: Clip[]
  catalog?: CatalogStatus | null
}

export interface CatalogStatus {
  repository: string
  revision: string
  complete: boolean
  count: number
  converted: number
  motionCount: number
  poseCount: number
}

/** The categories every clip is filed under, in the order they are offered (blender/library/aggregate.py's
 * CATEGORIES: the converted library's own; bundled clips are filed into the same ones). */
export const CATEGORIES: ReadonlyArray<{ id: string, label: string }> = [
  { id: 'locomotion', label: 'Locomotion' }, { id: 'idle', label: 'Idle' }, { id: 'combat', label: 'Combat' },
  { id: 'reactions', label: 'Reactions' }, { id: 'jump', label: 'Jump & Acrobatics' }, { id: 'climb', label: 'Climb & Hang' },
  { id: 'crouch-prone', label: 'Crouch & Prone' }, { id: 'sit-lie', label: 'Sit & Lie' }, { id: 'dance', label: 'Dance' },
  { id: 'gesture', label: 'Gesture' }, { id: 'work', label: 'Work' }, { id: 'sports', label: 'Sports & Fitness' },
  { id: 'transition', label: 'Transition' }, { id: 'pose', label: 'Pose' },
]

// (a bundled clip's category from its animation name: the first that matches, else gesture)
const CATEGORY_WORDS: Array<[string, RegExp]> = [
  ['climb', /climb|ladder|hang/i],
  ['locomotion', /walk|run|trot|gallop|canter|jog|sprint|swim|crawl|sneak|strafe|turn|side.?wind|fly|glide|flap/i],
  ['combat', /attack|punch|kick|slash|sword|bite|stab|shoot|bow|spell|cast|block|ground.?pound|head.?but|roar|tail/i],
  ['reactions', /death|die|dead|hit|knock|fall|damage/i],
  ['jump', /jump|flip|vault|roll|rear/i],
  ['work', /chop|farm|harvest|plant|water|fix|dig|mine|build|hammer|carry|push|pull|pick|craft|cook|fish|chest|consume|eat|drink|drive/i],
  ['dance', /dance/i],
  ['gesture', /wave|cheer|salute|bow\b|talk|angry|confused|insult|help|clap|point|nod|shake|howl|bark/i],
  ['sit-lie', /sit|lay|sleep|lie|rest/i],
  ['crouch-prone', /crouch|prone|kneel/i],
  ['idle', /idle|stand|breath|alert|coil|float/i],
  ['pose', /pose/i],
]

export function categorize (name: string): string {
  return CATEGORY_WORDS.find(([, re]) => re.test(name))?.[0] ?? 'gesture'
}

const haystacks = new WeakMap<Clip, { names: string, all: string }>()

/** Lower-case text a search term may match: the names (name, description, candidates) and all of it (+ tags, category). */
function haystack (c: Clip): { names: string, all: string } {
  let text = haystacks.get(c)
  if (text === undefined) {
    const names = [c.name, c.originalName, c.description, c.variant, c.id, c.motionId,
      c.sourceName === undefined ? undefined : `${c.sourceName}.fbx`,
      ...(c.candidates ?? []).flatMap(k => [k.name, k.description])]
      .filter(Boolean).join('\n').toLowerCase()
    text = { names, all: [names, ...c.tags, c.category, labelOf(c.category)].join('\n').toLowerCase() }
    haystacks.set(c, text)
  }
  return text
}

/** The user's own clips first, then everything with a real name, then generated names. */
function nameRank (c: Clip): number {
  if (c.nameSource === 'source' || c.nameSource === 'matched') return 0
  return c.nameSource === 'provisional' ? 2 : 1
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare

function labelOf (id: string): string {
  return CATEGORIES.find(c => c.id === id)?.label ?? id.replace(/-/g, ' & ').replace(/^\w/, ch => ch.toUpperCase())
}

// ---- the catalogs ----------------------------------------------------------------------------------------------------

const bundled = new Map<string, { mtime: number, clips: Clip[] }>()

/** Clips bundled with the app (static/animations/<rig>-*.glb, several per file), each file re-read when it changes. */
async function bundledClips (dir = path.join(ROOT, 'static', 'animations')): Promise<Clip[]> {
  let files: string[]
  try { files = (await readdir(dir)).filter(f => f.endsWith('.glb')).sort() } catch { return [] }
  for (const gone of [...bundled.keys()]) if (!files.includes(gone)) bundled.delete(gone)
  const out: Clip[] = []
  for (const file of files) {
    let mtime: number
    try { mtime = (await stat(path.join(dir, file))).mtimeMs } catch { continue }
    let entry = bundled.get(file)
    if (entry === undefined || entry.mtime !== mtime) {
      entry = { mtime, clips: clipsOfBundle(file, readGlb(await readFile(path.join(dir, file))).json) }
      bundled.set(file, entry)
    }
    out.push(...entry.clips)
  }
  return out
}

function clipsOfBundle (file: string, json: Gltf): Clip[] {
  const rig = file.split('-')[0]
  const out: Clip[] = []
  for (const anim of json.animations ?? []) {
    if (anim.name === undefined || /rest.?pose/i.test(anim.name)) continue
    const duration = Math.max(0, ...anim.samplers.map(sm => json.accessors?.[sm.input]?.max?.[0] ?? 0))
    const loop = /idle|walk|run|trot|canter|gallop|swim|fly|glide|flap|crawl|sneak|dance|wind/i.test(anim.name)
    const rootMotion = /RM$/.test(anim.name)
    out.push({
      id: `${rig}-${anim.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name: anim.name.replace(/_/g, ' ').replace(/\bRM\b/, '(root motion)').trim(),
      source: 'bundled',
      nameSource: 'bundled',
      file,
      fps: 30,
      frames: Math.round(duration * 30) + 1,
      duration,
      category: categorize(anim.name),
      tags: [loop ? 'loop' : 'one-shot', rootMotion ? 'root-motion' : 'in-place'],
      loop,
      inPlace: !rootMotion,
      rig,
      href: `/animations/${file}#${encodeURIComponent(anim.name)}`,
    })
  }
  return out
}

let creatures: { mtime: number, clips: Clip[] } | null = null

/** Clips made in the animation editor for a creature (a horse): workspace/library/creatures/index.json, the files
 * beside it (server/clipedits.ts). A person's are library clips like any. */
async function creatureClips (): Promise<Clip[]> {
  const file = path.join(LIBRARY, 'creatures', 'index.json')
  let mtime: number
  try { mtime = (await stat(file)).mtimeMs } catch { return [] }
  if (creatures === null || creatures.mtime !== mtime) {
    const index = await readJson<{ clips: Clip[] }>(file, { clips: [] })
    creatures = { mtime, clips: index.clips.map(c => ({ ...c, category: known(c.category), href: `/files/library/${c.file}` })) }
  }
  return creatures.clips
}

// (a category from outside the vocabulary is filed as a gesture, so every clip can be found by its category)
const known = (category: string | undefined): string => CATEGORIES.some(c => c.id === category) ? category! : 'gesture'

let cache: { mtime: number, manifest: Manifest } | null = null

async function manifest (): Promise<Manifest> {
  const file = path.join(LIBRARY, 'manifest.json')
  let mtime: number
  try { mtime = (await stat(file)).mtimeMs } catch { return { version: 0, skeleton: 'mixamo', categories: [], clips: [] } }
  if (cache === null || cache.mtime !== mtime) {
    const loaded = await readJson<Manifest>(file, { version: 0, skeleton: 'mixamo', categories: [], clips: [] })
    loaded.clips = loaded.clips.filter(c => c.duplicateOf === null || c.duplicateOf === undefined)
      .map(c => ({ ...c, rig: c.rig ?? 'human', category: known(c.category) }))
    cache = { mtime, manifest: loaded }
  }
  return cache.manifest
}

let audit: { mtime: number, clips: Record<string, { problems: Clip['problems'] }> } | null = null

/** tools/library_audit.py's findings, by clip id (re-read when the file changes). */
async function auditFindings (): Promise<Record<string, { problems: Clip['problems'] }>> {
  const file = path.join(LIBRARY, 'audit.json')
  let mtime: number
  try { mtime = (await stat(file)).mtimeMs } catch { return {} }
  if (audit === null || audit.mtime !== mtime) {
    audit = { mtime, clips: (await readJson<{ clips: Record<string, { problems: Clip['problems'] }> }>(file, { clips: {} })).clips }
  }
  return audit.clips
}

async function allClips (): Promise<Clip[]> {
  return [...(await manifest()).clips, ...await bundledClips(), ...await creatureClips()]
}

// ---- the query -------------------------------------------------------------------------------------------------------

export interface LibraryQuery { category?: string, query?: string, source?: string, rig?: string, page: number, pageSize: number }

export interface LibraryResult {
  /** Clips matching every filter. */
  total: number
  /** Clips for the rig, whatever the filters. */
  all: number
  page: number
  pages: number
  pageSize: number
  catalog: CatalogStatus | null
  /** Clips made here (the animation editor's, the scripted ones) for the rig: source custom. */
  custom: number
  /** Every category, with how many clips match the search and the source in it (the category filter aside). */
  categories: Array<{ id: string, label: string, count: number }>
  clips: Array<Clip & { url: string }>
}

export async function queryLibrary (q: LibraryQuery): Promise<LibraryResult> {
  const m = await manifest()
  const findings = await auditFindings()
  const rig = q.rig === undefined || q.rig === '' ? 'human' : q.rig
  const all = (await allClips()).filter(c => c.rig === rig)
  const terms = (q.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  // (searched and of the source: what the categories count, before the category filter)
  const found = all.filter(c => (q.source === undefined || q.source === '' || c.source === q.source) && terms.every(t => haystack(c).all.includes(t)))
  const matches = found.filter(c => q.category === undefined || q.category === '' || c.category === q.category)
  // Names starting a word with every term first ("laying", not "playing"), then names containing
  // them, then clips found only through tags ("left" ~ turn-left).
  const starts = terms.map(t => new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  const relevance = (c: Clip): number => {
    const { names } = haystack(c)
    return starts.every(re => re.test(names)) ? 0 : terms.every(t => names.includes(t)) ? 1 : 2
  }
  matches.sort((a, b) => relevance(a) - relevance(b) || nameRank(a) - nameRank(b) || byName(a.name, b.name) ||
    byName(a.description ?? '', b.description ?? '') || a.duration - b.duration)
  const pageSize = Math.min(Math.max(Number.isFinite(q.pageSize) ? Math.floor(q.pageSize) : 24, 1), 96)
  const pages = Math.max(1, Math.ceil(matches.length / pageSize))
  const page = Math.min(Math.max(Number.isFinite(q.page) ? Math.floor(q.page) : 0, 0), pages - 1)
  const counts = new Map<string, number>()
  for (const c of found) counts.set(c.category, (counts.get(c.category) ?? 0) + 1)
  const hashes = await libraryManifest()
  return {
    total: matches.length,
    all: all.length,
    page,
    pages,
    pageSize,
    catalog: rig === 'human' ? m.catalog ?? null : null,
    custom: all.filter(c => c.source === 'custom').length,
    categories: CATEGORIES.map(({ id, label }) => ({ id, label, count: counts.get(id) ?? 0 })),
    clips: matches.slice(page * pageSize, (page + 1) * pageSize).map(c => ({
      ...c, url: c.href ?? `/files/library/${c.file}`, problems: findings[c.id]?.problems,
      ...(c.href === undefined || c.href.startsWith('/files/library/') ? hashField(hashes[c.href?.slice('/files/library/'.length) ?? c.file]) : {}),
    })),
  }
}

const hashField = (hash: string | undefined): { hash?: string } => (hash === undefined ? {} : { hash })

/** A clip's category, by id (any rig's: the library's, the bundled, the made ones). */
export async function categoryOf (id: string): Promise<string | null> {
  return (await allClips()).find(c => c.id === id)?.category ?? null
}

/** Compact catalog for local sorting and filtering. Added time is the actual clip file's mtime in milliseconds. */
export interface LibraryIndexRow {
  id: string, name: string, description?: string, category: string, source: string, rig: string,
  duration: number, loop: boolean, inPlace: boolean, tags: string[], url: string, hash?: string,
  addedAt: number, nameSource?: string, problems?: Clip['problems'], variant?: Clip['variant'], candidates?: Clip['candidates']
}
let indexCache: { key: string, rows: LibraryIndexRow[] } | null = null
export async function libraryIndex (rig?: string): Promise<LibraryIndexRow[]> {
  const clips = await allClips()
  const findings = await auditFindings()
  const stamp = async (file: string): Promise<number> => (await stat(file).catch(() => null))?.mtimeMs ?? 0
  const key = JSON.stringify([cache?.mtime, creatures?.mtime, [...bundled.entries()].map(([f, x]) => [f, x.mtime]), audit?.mtime])
  if (indexCache?.key !== key) {
    const hashes = await libraryManifest()
    const times = new Map<string, Promise<number>>()
    const rows = await Promise.all(clips.map(async c => {
      const file = c.source === 'bundled' ? path.join(ROOT, 'static', 'animations', c.file) : path.join(LIBRARY, c.file)
      if (!times.has(file)) times.set(file, stamp(file))
      const hash = c.href === undefined || c.href.startsWith('/files/library/') ? hashes[c.href?.slice('/files/library/'.length) ?? c.file] : undefined
      return { id: c.id, name: c.name, description: c.description, category: c.category, source: c.source, rig: c.rig ?? 'human',
        duration: c.duration, loop: c.loop, inPlace: c.inPlace, tags: c.tags ?? [], url: c.href ?? `/files/library/${c.file}`,
        ...(hash === undefined ? {} : { hash }), addedAt: await times.get(file)!, nameSource: c.nameSource, variant: c.variant, candidates: c.candidates, problems: findings[c.id]?.problems }
    }))
    indexCache = { key, rows }
  }
  return rig === undefined || rig === '' || rig === 'all' ? indexCache.rows : indexCache.rows.filter(c => c.rig === rig)
}
