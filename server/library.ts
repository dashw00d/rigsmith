// Animation library: reads workspace/library/manifest.json and serves filtered, paginated pages.
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { LIBRARY, readJson, ROOT } from './workspace.ts'

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
  category: string
  confidence?: number
  tags: string[]
  loop: boolean
  inPlace: boolean
  duplicateOf?: string | null
  /** Skeleton the clip is for: 'human' (Mixamo) or a creature template id. */
  rig?: string
  /** A clip made with props leading (in the animation editor): each prop's path, as a slot's prop keys (by prop name). */
  propPaths?: Record<string, Array<{ u: number, q: [number, number, number, number], p?: [number, number, number] }>>
  /** Absolute URL when the clip lives outside workspace/library (bundled clips). */
  href?: string
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

let cache: { mtime: number, manifest: Manifest } | null = null
let bundled: Clip[] | null = null
const haystacks = new WeakMap<Clip, { names: string, all: string }>()

/** Lower-case text a search term may match: the names (name, description, candidates) and all of it (+ tags, category). */
function haystack (c: Clip): { names: string, all: string } {
  let text = haystacks.get(c)
  if (text === undefined) {
    const names = [c.name, c.originalName, c.description, c.variant, c.id, c.motionId,
      c.sourceName === undefined ? undefined : `${c.sourceName}.fbx`,
      ...(c.candidates ?? []).flatMap(k => [k.name, k.description])]
      .filter(Boolean).join('\n').toLowerCase()
    text = { names, all: [names, ...c.tags, c.category].join('\n').toLowerCase() }
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

const CATEGORY_WORDS: Array<[string, RegExp]> = [
  ['locomotion', /walk|run|trot|gallop|jog|sprint|swim|crawl|sneak|strafe|turn|side.?wind|fly|glide|flap|climb/i],
  ['combat', /attack|punch|kick|slash|sword|bite|stab|shoot|bow|spell|cast|block|ground.?pound|head.?but|roar|tail/i],
  ['reactions', /death|die|dead|hit|knock|fall|damage/i],
  ['jump', /jump|flip|vault|roll|rear/i],
  ['work', /chop|farm|harvest|plant|water|fix|dig|mine|build|hammer|carry|push|pull|pick|craft|cook|fish|chest|consume|eat|drink|drive/i],
  ['dance', /dance/i],
  ['gesture', /wave|cheer|salute|bow\b|talk|angry|confused|insult|help|clap|point|nod|shake|howl|bark/i],
  ['sit-lie', /sit|lay|sleep|lie|rest/i],
  ['crouch-prone', /crouch|prone|kneel/i],
  ['idle', /idle|stand|breath|alert|coil|float/i],
]

function categorize (name: string): string {
  return CATEGORY_WORDS.find(([, re]) => re.test(name))?.[0] ?? 'gesture'
}

/** Clips bundled with the app (static/animations/<rig>-*.glb), several per file. */
async function bundledClips (): Promise<Clip[]> {
  if (bundled !== null) return bundled
  const dir = path.join(ROOT, 'static', 'animations')
  const out: Clip[] = []
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.glb')).sort()) {
    const rig = file.split('-')[0]
    const data = await readFile(path.join(dir, file))
    const json = JSON.parse(data.subarray(20, 20 + data.readUInt32LE(12)).toString('utf8')) as {
      animations?: Array<{ name: string, samplers: Array<{ input: number }> }>, accessors: Array<{ max?: number[] }>
    }
    for (const anim of json.animations ?? []) {
      if (/rest.?pose/i.test(anim.name)) continue
      const duration = Math.max(...anim.samplers.map(sm => json.accessors[sm.input].max?.[0] ?? 0))
      const name = anim.name.replace(/_/g, ' ').replace(/\bRM\b/, '(root motion)').trim()
      const loop = /idle|walk|run|trot|swim|fly|glide|flap|crawl|sneak|dance|wind/i.test(anim.name)
      out.push({
        id: `${rig}-${anim.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        name,
        source: 'bundled',
        nameSource: 'bundled',
        file: file,
        fps: 30,
        frames: Math.round(duration * 30) + 1,
        duration,
        category: categorize(anim.name),
        tags: [loop ? 'loop' : 'one-shot', /RM$/.test(anim.name) ? 'root-motion' : 'in-place'],
        loop,
        inPlace: !/RM$/.test(anim.name),
        rig,
        href: `/animations/${file}#${encodeURIComponent(anim.name)}`,
      })
    }
  }
  bundled = out
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
    creatures = { mtime, clips: index.clips.map(c => ({ ...c, href: `/files/library/${c.file}` })) }
  }
  return creatures.clips
}

async function manifest (): Promise<Manifest> {
  const file = path.join(LIBRARY, 'manifest.json')
  let mtime: number
  try { mtime = (await stat(file)).mtimeMs } catch { return { version: 0, skeleton: 'mixamo', categories: [], clips: [] } }
  if (cache === null || cache.mtime !== mtime) {
    const loaded = await readJson<Manifest>(file, { version: 0, skeleton: 'mixamo', categories: [], clips: [] })
    loaded.clips = loaded.clips.filter(c => c.duplicateOf === null || c.duplicateOf === undefined).map(c => ({ ...c, rig: c.rig ?? 'human' }))
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

export interface LibraryQuery { category?: string, query?: string, source?: string, rig?: string, page: number, pageSize: number }

export async function queryLibrary (q: LibraryQuery) {
  const m = await manifest()
  const findings = await auditFindings()
  const rig = q.rig ?? 'human'
  const all = [...m.clips, ...await bundledClips(), ...await creatureClips()].filter(c => c.rig === rig)
  const terms = (q.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const matches = all.filter(c =>
    (q.category === undefined || q.category === '' || c.category === q.category) &&
    (q.source === undefined || q.source === '' || c.source === q.source) &&
    terms.every(t => haystack(c).all.includes(t)))
  // Names starting a word with every term first ("laying", not "playing"), then names containing
  // them, then clips found only through tags ("left" ~ turn-left).
  const starts = terms.map(t => new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  const relevance = (c: Clip): number => {
    const { names } = haystack(c)
    return starts.every(re => re.test(names)) ? 0 : terms.every(t => names.includes(t)) ? 1 : 2
  }
  matches.sort((a, b) => relevance(a) - relevance(b) || nameRank(a) - nameRank(b) || byName(a.name, b.name) ||
    byName(a.description ?? '', b.description ?? '') || a.duration - b.duration)
  const pageSize = Math.min(Math.max(q.pageSize, 1), 96)
  const pages = Math.max(1, Math.ceil(matches.length / pageSize))
  const page = Math.min(Math.max(q.page, 0), pages - 1)
  const counts = new Map<string, number>()
  for (const c of all) counts.set(c.category, (counts.get(c.category) ?? 0) + 1)
  const labels = new Map(m.categories.map(c => [c.id, c.label]))
  const order = m.categories.length > 0 ? m.categories.map(c => c.id) : CATEGORY_WORDS.map(([id]) => id)
  return {
    total: matches.length,
    page,
    pages,
    pageSize,
    catalog: rig === 'human' ? m.catalog ?? null : null,
    /** Clips made here (the animation editor's, the scripted ones): source custom. */
    custom: all.filter(c => c.source === 'custom').length,
    categories: order.map(id => ({ id, label: labels.get(id) ?? id.replace(/-/g, ' & ').replace(/^\w/, ch => ch.toUpperCase()), count: counts.get(id) ?? 0 })),
    clips: matches.slice(page * pageSize, (page + 1) * pageSize).map(c => ({ ...c, url: c.href ?? `/files/library/${c.file}`, problems: findings[c.id]?.problems })),
  }
}

/** A clip's category, by id (any rig's: the library's, the bundled, the made ones). */
export async function categoryOf (id: string): Promise<string | null> {
  const m = await manifest()
  return [...m.clips, ...await bundledClips(), ...await creatureClips()].find(c => c.id === id)?.category ?? null
}
