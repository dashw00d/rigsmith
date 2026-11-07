// Publish: a set's finished items into the game and the character. Each item's picked attempts (every published stage
// ready: picked, approved where its gate asks) are copied into the game's folder for it (later stages over earlier
// ones), its spec put in the game's roster, and the game's asset hashes taken again once for the whole batch (never
// committed: assets are out of Git). Then into the Rigsmith character, as import_folk.py does it: each piece uploaded
// through the gear upload route, and one batch of gear commands wearing them. A piece the character already has (the
// same `from`) has only its model replaced, so where it sits and how it is worn stay as they were.
import { existsSync } from 'node:fs'
import { chmod, cp, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { Command } from '../../src/model/command-types.ts'
import type { Character, Gear, Placement } from '../../src/model/types.ts'
import { spawnJob } from '../jobs.ts'
import { characterDir } from '../store.ts'
import { fill } from './runner.ts'
import { filesUnder, type ForgeStore, isReady, writeJsonFile } from './store.ts'
import type { ForgeConfig, ForgeItem, ForgeStage, PublishCharacter } from './types.ts'

/** How publish reaches the character: the server's own routes (routeSink), or a fake in tests. */
export interface CharacterSink {
  character: (id: string) => Promise<Character>
  /** The gear upload route (POST /api/characters/:id/garments?name=&kind=skin&from=). */
  upload: (id: string, file: string, name: string, from?: string) => Promise<void>
  /** One batch of commands: one journal entry, one undo. */
  commands: (id: string, commands: Command[], what: string) => Promise<void>
  /** The character's source model (its import's scale and centring are read off it). */
  sourceFile: (c: Character) => string
}

export interface PublishOptions {
  config: ForgeConfig
  store: ForgeStore
  set: string
  /** The items to publish (default every item of the set). */
  items?: string[]
  /** The Rigsmith character pieces go into (default forge.json's); none: the game only. */
  character?: string | null
  sink?: CharacterSink
  by?: string
  signal?: AbortSignal
  onProgress?: (progress: number, message: string) => void
  /** Seconds to wait for uploaded pieces to import (default an hour; then it fails, saying which). */
  importWait?: number
}

export interface PublishReport {
  items: Array<{ id: string, into?: string, files?: number, skipped?: string }>
  roster: boolean
  hashes: 'ran' | 'not asked' | 'nothing published' | string
  character?: { id: string, added: string[], replaced: string[], skipped: string[] }
}

/** The stages an item's publish copies, in order. */
export function publishedStages (stages: ForgeStage[], names?: string[]): ForgeStage[] {
  return names === undefined ? stages : names.map(n => stages.find(s => s.id === n)!).filter(s => s !== undefined)
}

/** Copy a tree of read-only attempt files over a folder of the game: a file there is replaced (never written through,
 * so a link into the main checkout's assets is replaced, not followed), and the copies are made writable. */
async function copyInto (src: string, dest: string): Promise<number> {
  let n = 0
  for (const rel of await filesUnder(src)) {
    const to = path.join(dest, rel)
    await mkdir(path.dirname(to), { recursive: true })
    if (existsSync(to)) await unlink(to)
    await cp(path.join(src, rel), to, { dereference: true })
    await chmod(to, 0o644)
    n++
  }
  return n
}

/** The run-once command (forge.json `hashes`) in the repo. */
async function runHashes (config: ForgeConfig, signal?: AbortSignal): Promise<void> {
  const [cmd, ...args] = config.hashes!
  await new Promise<void>((resolve, reject) => {
    const child = spawnJob(cmd, args, { cwd: config.repo, stdio: ['ignore', 'ignore', 'pipe'] }, signal)
    let err = ''
    child.stderr!.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-2000) })
    child.on('error', reject)
    child.on('close', code => { code === 0 ? resolve() : reject(new Error(`${config.hashes!.join(' ')} exited with ${code}: ${err.trim().split('\n').pop() ?? ''}`)) })
  })
}

export async function publish (o: PublishOptions): Promise<PublishReport> {
  const { config, store } = o
  const set = await store.getSet(o.set)
  if (set === null) throw new Error(`No set is called ${o.set}`)
  const pipeline = config.pipelines[set.pipeline]
  const spec = pipeline?.publish
  if (spec === undefined) throw new Error(`The ${set.pipeline} pipeline has nothing to publish to`)
  const all = await store.items(set.id)
  const items = o.items === undefined ? all : o.items.map(id => {
    const i = all.find(x => x.id === id)
    if (i === undefined) throw new Error(`${set.name} has no item ${id}`)
    return i
  })
  const stages = publishedStages(pipeline.stages, spec.stages)
  const report: PublishReport = { items: [], roster: false, hashes: config.hashes === undefined ? 'not asked' : 'nothing published' }
  const done: Array<{ item: ForgeItem, into: string }> = []

  for (const [k, item] of items.entries()) {
    o.onProgress?.(0.5 * k / items.length, `Publishing ${item.name}`)
    const picks: Record<string, string> = {}
    let skipped: string | undefined
    for (const st of stages) {
      const sel = await store.selection(set.id, item.id, st.id)
      const m = sel === null ? null : await store.manifest(set.id, item.id, st.id, sel.attempt)
      if (!isReady(st, sel, m)) { skipped = `${st.label} isn't ${st.gate === 'pick' ? 'picked' : st.gate !== undefined ? 'approved' : 'done'}`; break }
      picks[st.id] = sel!.attempt
    }
    if (skipped !== undefined) { report.items.push({ id: item.id, skipped }); continue }
    const values = { item: item.id, set: set.id }
    const into = path.resolve(config.repo, fill(spec.into, values))
    if (!into.startsWith(config.repo + path.sep)) throw new Error(`${spec.into} is outside the game's repo`)
    let files = 0
    for (const st of stages) {
      const from = path.join(store.attemptDir(set.id, item.id, st.id, picks[st.id]), 'out', fill(spec.from ?? '{item}', values))
      if (existsSync(from)) files += await copyInto(from, into)
    }
    await writeJsonFile(path.join(into, 'forge.json'), { set: set.id, item: item.id, stages: picks, at: new Date().toISOString(), by: o.by ?? 'app' })
    await writeJsonFile(path.join(store.itemDir(set.id, item.id), 'published.json'), { into: path.relative(config.repo, into), stages: picks, at: Date.now(), by: o.by ?? 'app' })
    report.items.push({ id: item.id, into: path.relative(config.repo, into), files })
    done.push({ item, into })
  }

  if (done.length > 0 && spec.roster !== undefined) {
    const file = path.resolve(config.repo, spec.roster.file)
    const roster = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown> : {}
    const list = Array.isArray(roster[spec.roster.list]) ? roster[spec.roster.list] as Array<Record<string, unknown>> : []
    for (const { item } of done) {
      const entry = { ...item.spec, [spec.roster.key]: item.id }
      const i = list.findIndex(e => e[spec.roster!.key] === item.id)
      if (i >= 0) list[i] = entry
      else list.push(entry)
    }
    roster[spec.roster.list] = list
    await writeJsonFile(file, roster)
    report.roster = true
  }
  if (done.length > 0 && config.hashes !== undefined) {
    o.onProgress?.(0.55, 'Taking the asset hashes again')
    try { await runHashes(config, o.signal); report.hashes = 'ran' } catch (error) { report.hashes = (error as Error).message }
  }

  const cid = o.character === undefined ? config.character : o.character
  if (done.length > 0 && cid !== undefined && cid !== null && spec.character !== undefined) {
    report.character = await intoCharacter(o, cid, spec.character, done)
  }
  o.onProgress?.(1, 'Published')
  return report
}

// ---- into the character ---------------------------------------------------------------------------------------------

/** A GLB's bounds (its meshes' POSITION accessors, as import_folk.py's glb_bounds). */
export async function glbBounds (file: string): Promise<{ lo: number[], hi: number[] }> {
  const fh = await open(file, 'r')
  try {
    const head = Buffer.alloc(20)
    await fh.read(head, 0, 20, 0)
    if (head.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} isn't a GLB`)
    const n = head.readUInt32LE(12)
    const text = Buffer.alloc(n)
    await fh.read(text, 0, n, 20)
    const j = JSON.parse(text.toString('utf8')) as { meshes?: Array<{ primitives: Array<{ attributes: { POSITION?: number } }> }>, accessors?: Array<{ min?: number[], max?: number[] }> }
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (const m of j.meshes ?? []) {
      for (const p of m.primitives) {
        const a = p.attributes.POSITION === undefined ? undefined : j.accessors?.[p.attributes.POSITION]
        if (a?.min === undefined || a.max === undefined) continue
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], a.min[k]); hi[k] = Math.max(hi[k], a.max[k]) }
      }
    }
    if (!Number.isFinite(lo[1])) throw new Error(`${file} has no mesh bounds`)
    return { lo, hi }
  } finally {
    await fh.close()
  }
}

const r6 = (x: number): number => Math.round(x * 1e6) / 1e6

/** The body's metres into the character's rest space: its import scaled the body to its height and centred it. */
export function placementOf (body: { lo: number[], hi: number[] }, character: { lo: number[], hi: number[] }): Placement {
  const s = (character.hi[1] - character.lo[1]) / (body.hi[1] - body.lo[1])
  const at = (k: number): number => (character.lo[k] + character.hi[k]) / 2 - (body.lo[k] + body.hi[k]) / 2 * s
  return { position: [r6(at(0)), r6(character.lo[1] - body.lo[1] * s), r6(at(2))], rotation: [0, 0, 0], scale: r6(s) }
}

const sleep = async (ms: number): Promise<void> => { await new Promise(resolve => setTimeout(resolve, ms)) }

async function intoCharacter (o: PublishOptions, cid: string, spec: PublishCharacter, done: Array<{ item: ForgeItem, into: string }>): Promise<NonNullable<PublishReport['character']>> {
  const sink = o.sink ?? routeSink
  const out = { id: cid, added: [] as string[], replaced: [] as string[], skipped: [] as string[] }
  let c = await sink.character(cid)
  const place = await (async (): Promise<Placement> => {
    try {
      if (o.config.body === undefined) throw new Error('no body')
      return placementOf(await glbBounds(path.resolve(o.config.repo, o.config.body)), await glbBounds(sink.sourceFile(c)))
    } catch {
      // (no body to measure: where the pieces already worn sit)
      const worn = c.gear.find(g => g.attach.kind === 'skin' && g.from?.startsWith(spec.from.split('{')[0]) === true)
      return worn !== undefined && 'place' in worn.attach && worn.attach.place !== undefined ? worn.attach.place : { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }
    }
  })()
  interface Piece { name: string, from: string, file: string, policy: string, item: ForgeItem, piece: string, old?: Gear, temp?: string }
  const pieces: Piece[] = []
  for (const { item, into } of done) {
    const have = Object.keys((item.spec.pieces ?? {}) as Record<string, unknown>)
    const dir = path.join(into, path.posix.dirname(spec.pieces))
    const re = new RegExp(`^${path.posix.basename(spec.pieces).split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
    const files = existsSync(dir) ? (await readdir(dir)).filter(f => re.test(f)).sort() : []
    for (const f of files) {
      const piece = f.replace(/\.[^.]+$/, '')
      const part = piece.split('_')[0]
      if ((spec.skip?.[piece] ?? spec.skip?.[part] ?? []).some(k => have.includes(k))) continue
      const name = fill(spec.name, { item: item.id, piece })
      const policy = spec.policy[part]
      if (policy === undefined) { out.skipped.push(`${name}: no policy for ${part}`); continue }
      const from = fill(spec.from, { name, item: item.id, piece })
      pieces.push({ name, from, file: path.join(dir, f), policy, item, piece, old: c.gear.find(g => g.from === from) })
    }
  }
  // (a replacement comes in as a piece of its own; its model then goes to the old piece and it goes)
  for (const [k, p] of pieces.entries()) {
    o.onProgress?.(0.6 + 0.2 * k / Math.max(1, pieces.length), `Uploading ${p.name}`)
    if (p.old === undefined) await sink.upload(cid, p.file, `${p.name}.glb`, p.from)
    else {
      p.temp = `${p.name}__forge_${Date.now().toString(36)}`
      await sink.upload(cid, p.file, `${p.temp}.glb`)
    }
  }
  const names = new Set(pieces.map(p => p.temp ?? p.name))
  const limit = Date.now() + (o.importWait ?? 3600) * 1000
  for (;;) {
    c = await sink.character(cid)
    const mine = c.gear.filter(g => names.has(g.name))
    if (mine.length >= names.size && mine.every(g => g.status !== 'importing')) break
    if (o.signal?.aborted === true) throw new Error('Cancelled')
    if (Date.now() > limit) throw new Error(`The pieces were still importing after ${o.importWait ?? 3600} s: ${mine.filter(g => g.status === 'importing').map(g => g.name).join(', ')}`)
    o.onProgress?.(0.85, `Waiting for ${mine.filter(g => g.status === 'importing').length || names.size} pieces to import`)
    await sleep(500)
  }
  const commands: Command[] = []
  for (const p of pieces) {
    const g = c.gear.find(x => x.name === (p.temp ?? p.name))
    if (g === undefined || g.status !== 'ready') { out.skipped.push(`${p.name}: its import ${g?.error !== undefined ? `failed (${g.error})` : 'failed'}`); continue }
    if (p.old !== undefined) {
      commands.push({ type: 'gear.update', id: p.old.id, patch: { model: g.model } }, { type: 'gear.remove', id: g.id })
      out.replaced.push(p.name)
      continue
    }
    const have = Object.keys((p.item.spec.pieces ?? {}) as Record<string, unknown>)
    const tags = (spec.tags ?? []).filter(t => (t.piece === p.piece || t.piece === p.piece.split('_')[0]) && t.anyOf.some(k => have.includes(k))).flatMap(t => t.tags)
    commands.push({ type: 'gear.attach', id: g.id, attach: { kind: 'skin', policy: p.policy, place, ...(spec.hideBody === true ? { hideBody: true } : {}) } as Gear['attach'] })
    const patch: Extract<Command, { type: 'gear.update' }>['patch'] = {
      ...(spec.field === 'outfit' ? { outfit: p.item.id } : {}),
      ...(tags.length > 0 ? { tags: [...new Set(tags)] } : {}),
    }
    if (Object.keys(patch).length > 0) commands.push({ type: 'gear.update', id: g.id, patch })
    out.added.push(p.name)
  }
  if (commands.length > 0) await sink.commands(cid, commands, `forge publish: ${done.map(d => d.item.id).join(', ')}`)
  return out
}

// ---- the server's own routes, called in process ------------------------------------------------------------------

/** A request answered by the server's router without a socket: the same route a tool reaches over HTTP. */
async function inProcess (method: string, url: string, body?: Buffer, headers: Record<string, string> = {}): Promise<unknown> {
  const { handle } = await import('../http.ts')
  const req = Readable.from(body === undefined ? [] : [body]) as unknown as IncomingMessage
  Object.assign(req, { method, url, headers: { 'x-rigsmith-by': 'forge', 'x-rigsmith-schema': '4', ...headers } })
  return await new Promise((resolve, reject) => {
    let status = 200
    const chunks: Buffer[] = []
    const res = {
      headersSent: false,
      writeHead (s: number) { status = s; this.headersSent = true; return this },
      setHeader () { return this },
      write (d: string | Buffer) { chunks.push(Buffer.from(d)); return true },
      end (d?: string | Buffer) {
        if (d !== undefined) chunks.push(Buffer.from(d))
        const text = Buffer.concat(chunks).toString('utf8')
        let json: unknown = null
        try { json = text === '' ? null : JSON.parse(text) } catch { json = text }
        if (status >= 400) reject(new Error((json as { error?: string } | null)?.error ?? `${method} ${url} answered ${status}`))
        else resolve(json)
        return this
      },
    }
    handle(req, res as unknown as ServerResponse, () => { reject(new Error(`${url}: no route`)) }).catch(reject)
  })
}

export const routeSink: CharacterSink = {
  character: async id => await inProcess('GET', `/api/characters/${encodeURIComponent(id)}`) as Character,
  upload: async (id, file, name, from) => {
    const q = new URLSearchParams({ name, kind: 'skin', ...(from !== undefined ? { from } : {}) })
    await inProcess('POST', `/api/characters/${encodeURIComponent(id)}/garments?${q.toString()}`, await readFile(file), { 'content-type': 'application/octet-stream' })
  },
  commands: async (id, commands, what) => {
    await inProcess('POST', `/api/characters/${encodeURIComponent(id)}/commands`, Buffer.from(JSON.stringify({ commands, what })), { 'content-type': 'application/json' })
  },
  sourceFile: c => path.join(characterDir(c.id), c.source.file),
}
