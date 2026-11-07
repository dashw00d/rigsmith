// The Forge's store on disk: sets of items, and per item each stage's attempts, never overwritten.
//
//   <store>/<set>/set.json
//   <store>/<set>/<item>/item.json
//   <store>/<set>/<item>/<stage>/selected.json           the attempt picked (and approved, where the gate asks)
//   <store>/<set>/<item>/<stage>/<attempt>/              a001, a002... (<attempt>.partial: cut off by a restart)
//       work/  out/ (read-only once done)  manifest.json  job.json  log.txt
//
// An attempt's key is the hash of what made it: the stage's version and command, its params and seed, the item's
// spec, each input (an earlier stage's picked attempt and its outputs' hashes, or a repo file's hash) and each code
// file the stage lists. So whether an attempt still follows from what is picked now and the code there is now is
// worked out (staleness), never guessed; a deterministic stage with `cache` reuses an attempt of the same key.
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ID } from './config.ts'
import type { AttemptView, ForgeConfig, ForgeItem, ForgePipeline, ForgeSet, ForgeStage, ItemView, Manifest, Selection, SetView, StageView } from './types.ts'

// ---- hashing ----------------------------------------------------------------------------------------------------

export function stableJson (x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(stableJson).join(',')}]`
  if (typeof x === 'object' && x !== null) {
    return `{${Object.keys(x).filter(k => (x as Record<string, unknown>)[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stableJson((x as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(x) ?? 'null'
}

export const hashText = (text: string): string => createHash('sha256').update(text).digest('hex')

export async function hashFile (file: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => { resolve(h.digest('hex')) })
  })
}

/** Every file under dir (links followed) by its path there ('/'-separated), with its sha256. */
export async function hashTree (dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const rel of await filesUnder(dir)) out[rel] = await hashFile(path.join(dir, rel))
  return out
}

/** The files under dir, '/'-separated, sorted; links followed. */
export async function filesUnder (dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (rel: string): Promise<void> => {
    const at = path.join(dir, rel)
    for (const e of await readdir(at, { withFileTypes: true })) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`
      const s = e.isSymbolicLink() ? await stat(path.join(at, e.name)).catch(() => null) : null
      if (e.isDirectory() || s?.isDirectory() === true) await walk(r)
      else if (e.isFile() || s?.isFile() === true) out.push(r)
    }
  }
  if (existsSync(dir)) await walk('')
  return out.sort()
}

/** What an attempt's key is made of. */
export interface KeyParts {
  version: string
  cmd: string[]
  params: Record<string, unknown>
  seed: number
  spec: string
  inputs: Manifest['inputs']
  code: Record<string, string>
}

export const attemptKey = (k: KeyParts): string => hashText(stableJson(k)).slice(0, 32)

// ---- files ------------------------------------------------------------------------------------------------------

async function readJsonFile<T> (file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T } catch { return null }
}

/** Written beside, then moved over: a reader never sees half a file. */
export async function writeJsonFile (file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 1) + '\n')
  await rename(tmp, file)
}

/** A folder and everything in it made read-only (files 444, folders 555); links left alone. */
export async function makeReadOnly (dir: string): Promise<void> {
  const walk = async (at: string): Promise<void> => {
    for (const e of await readdir(at, { withFileTypes: true })) {
      const p = path.join(at, e.name)
      if (e.isDirectory()) { await walk(p); await chmod(p, 0o555) } else if (e.isFile()) await chmod(p, 0o444)
    }
  }
  if (!existsSync(dir)) return
  await walk(dir)
  await chmod(dir, 0o555)
}

/** The opposite, so a folder can be moved, emptied or deleted. */
export async function makeWritable (dir: string): Promise<void> {
  const walk = async (at: string): Promise<void> => {
    const info = await lstat(at)
    if (info.isSymbolicLink()) return
    if (info.isDirectory()) {
      await chmod(at, 0o755)
      for (const e of await readdir(at)) await walk(path.join(at, e))
    } else await chmod(at, 0o644)
  }
  if (existsSync(dir)) await walk(dir)
}

const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'set'
const ATTEMPT = /^a(\d{3,})(\.partial)?$/

// ---- the store --------------------------------------------------------------------------------------------------

export class ForgeStore {
  root: string
  constructor (root: string) { this.root = root }

  setDir (set: string): string { return path.join(this.root, checked(set)) }
  itemDir (set: string, item: string): string { return path.join(this.setDir(set), checked(item)) }
  stageDir (set: string, item: string, stage: string): string { return path.join(this.itemDir(set, item), checked(stage)) }
  attemptDir (set: string, item: string, stage: string, attempt: string): string {
    if (!ATTEMPT.test(attempt)) throw new Error(`No attempt is called ${attempt}`)
    return path.join(this.stageDir(set, item, stage), attempt)
  }

  async sets (): Promise<ForgeSet[]> {
    if (!existsSync(this.root)) return []
    const out: ForgeSet[] = []
    for (const e of await readdir(this.root, { withFileTypes: true })) {
      if (!e.isDirectory() || !ID.test(e.name)) continue
      const s = await readJsonFile<ForgeSet>(path.join(this.root, e.name, 'set.json'))
      if (s !== null) out.push(s)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  async getSet (id: string): Promise<ForgeSet | null> {
    return ID.test(id) ? await readJsonFile<ForgeSet>(path.join(this.setDir(id), 'set.json')) : null
  }

  /** A new set (its id from its name unless given; a taken one gets a number). */
  async createSet (o: { id?: string, name: string, pipeline: string, note?: string }): Promise<ForgeSet> {
    const id = await this.freeId(this.root, o.id ?? slug(o.name))
    const set: ForgeSet = { id, name: o.name, pipeline: o.pipeline, createdAt: Date.now(), ...(o.note !== undefined ? { note: o.note } : {}) }
    await writeJsonFile(path.join(this.setDir(id), 'set.json'), set)
    return set
  }

  async items (set: string): Promise<ForgeItem[]> {
    const dir = this.setDir(set)
    if (!existsSync(dir)) return []
    const out: ForgeItem[] = []
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || !ID.test(e.name)) continue
      const item = await readJsonFile<ForgeItem>(path.join(dir, e.name, 'item.json'))
      if (item !== null) out.push(item)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  async getItem (set: string, item: string): Promise<ForgeItem | null> {
    return ID.test(set) && ID.test(item) ? await readJsonFile<ForgeItem>(path.join(this.itemDir(set, item), 'item.json')) : null
  }

  async createItem (set: string, o: { id?: string, name: string, spec?: Record<string, unknown> }): Promise<ForgeItem> {
    if (await this.getSet(set) === null) throw new Error(`No set is called ${set}`)
    const id = await this.freeId(this.setDir(set), o.id ?? slug(o.name))
    const item: ForgeItem = { id, name: o.name, createdAt: Date.now(), spec: o.spec ?? {} }
    await writeJsonFile(path.join(this.itemDir(set, id), 'item.json'), item)
    return item
  }

  async updateItem (set: string, item: string, fn: (i: ForgeItem) => void): Promise<ForgeItem> {
    const i = await this.getItem(set, item)
    if (i === null) throw new Error(`No item ${set}/${item}`)
    fn(i)
    await writeJsonFile(path.join(this.itemDir(set, item), 'item.json'), i)
    return i
  }

  private async freeId (dir: string, wanted: string): Promise<string> {
    const base = checked(wanted)
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base.slice(0, 60)}_${n}`
      if (!existsSync(path.join(dir, id))) return id
    }
  }

  /** The stage's attempts, oldest first (partial ones included). */
  async attemptIds (set: string, item: string, stage: string): Promise<string[]> {
    const dir = this.stageDir(set, item, stage)
    if (!existsSync(dir)) return []
    return (await readdir(dir)).filter(f => ATTEMPT.test(f)).sort((a, b) => Number(ATTEMPT.exec(a)![1]) - Number(ATTEMPT.exec(b)![1]) || a.length - b.length)
  }

  /** A new attempt's folder, made (work/ and out/ in it): the next number, never one used before. */
  async newAttempt (set: string, item: string, stage: string): Promise<{ id: string, dir: string }> {
    const ids = await this.attemptIds(set, item, stage)
    let n = ids.reduce((m, id) => Math.max(m, Number(ATTEMPT.exec(id)![1])), 0)
    for (;;) {
      n++
      const id = `a${String(n).padStart(3, '0')}`
      const dir = this.attemptDir(set, item, stage, id)
      try {
        await mkdir(path.dirname(dir), { recursive: true })
        await mkdir(dir)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
      await mkdir(path.join(dir, 'work'))
      await mkdir(path.join(dir, 'out'))
      return { id, dir }
    }
  }

  async manifest (set: string, item: string, stage: string, attempt: string): Promise<Manifest | null> {
    return await readJsonFile<Manifest>(path.join(this.attemptDir(set, item, stage, attempt), 'manifest.json'))
  }

  async writeManifest (m: Manifest): Promise<void> {
    await writeJsonFile(path.join(this.attemptDir(m.set, m.item, m.stage, m.attempt), 'manifest.json'), m)
  }

  async manifests (set: string, item: string, stage: string): Promise<Manifest[]> {
    const out: Manifest[] = []
    for (const id of await this.attemptIds(set, item, stage)) {
      const m = await this.manifest(set, item, stage, id)
      if (m !== null) out.push({ ...m, attempt: id, status: id.endsWith('.partial') ? 'interrupted' : m.status })
    }
    return out
  }

  async selection (set: string, item: string, stage: string): Promise<Selection | null> {
    return await readJsonFile<Selection>(path.join(this.stageDir(set, item, stage), 'selected.json'))
  }

  /** Pick an attempt (it must have finished); `approved` for a gate that asks for it. */
  async select (set: string, item: string, stage: string, attempt: string, by: string, approved?: boolean): Promise<Selection> {
    const m = await this.manifest(set, item, stage, attempt)
    if (m === null || attempt.endsWith('.partial')) throw new Error(`${stage} has no attempt ${attempt}`)
    if (m.status !== 'done') throw new Error(`${stage} ${attempt} didn't finish (${m.status}): it can't be picked`)
    const s: Selection = { attempt, at: Date.now(), by, ...(approved === true ? { approved: true } : {}) }
    await writeJsonFile(path.join(this.stageDir(set, item, stage), 'selected.json'), s)
    return s
  }

  async clearSelection (set: string, item: string, stage: string): Promise<void> {
    await rm(path.join(this.stageDir(set, item, stage), 'selected.json'), { force: true })
  }

  /** An attempt's folder renamed <attempt>.partial (a restart cut it off); its manifest says interrupted. */
  async markPartial (set: string, item: string, stage: string, attempt: string): Promise<string> {
    const dir = this.attemptDir(set, item, stage, attempt)
    if (!existsSync(dir)) return attempt
    const m = await this.manifest(set, item, stage, attempt)
    if (m !== null) await this.writeManifest({ ...m, status: 'interrupted', finishedAt: Date.now() })
    const partial = `${attempt}.partial`
    await makeWritable(path.join(dir, 'out'))
    await rename(dir, this.attemptDir(set, item, stage, partial))
    return partial
  }
}

function checked (id: string): string {
  if (!ID.test(id)) throw new Error(`${JSON.stringify(id)} isn't an id (lowercase letters, digits, - and _)`)
  return id
}

// ---- what follows from what ---------------------------------------------------------------------------------------

/** A stage's inputs as they are now: the attempt picked upstream and its outputs' hash, or the repo file's hash; and
 * where each is on disk. Not ok when one isn't ready (nothing picked, not approved, a file missing). */
export type InputsNow =
  | { ok: true, inputs: Manifest['inputs'], sources: Record<string, { dir: string } | { file: string, as: string }> }
  | { ok: false, why: string }

export function isReady (stage: ForgeStage, sel: Selection | null, m: Manifest | null): boolean {
  if (sel === null || m === null || m.status !== 'done') return false
  return stage.gate === undefined || stage.gate === 'pick' || sel.approved === true
}

export async function inputsNow (store: ForgeStore, config: ForgeConfig, pipeline: ForgePipeline, set: string, item: string, stage: ForgeStage): Promise<InputsNow> {
  const inputs: Manifest['inputs'] = {}
  const sources: Record<string, { dir: string } | { file: string, as: string }> = {}
  for (const [name, input] of Object.entries(stage.inputs ?? {})) {
    if ('stage' in input) {
      const up = pipeline.stages.find(s => s.id === input.stage)!
      const sel = await store.selection(set, item, up.id)
      const m = sel === null ? null : await store.manifest(set, item, up.id, sel.attempt)
      if (!isReady(up, sel, m)) {
        const why = sel === null ? (up.gate === 'pick' ? 'nothing picked yet' : 'it has not run yet')
          : m?.status !== 'done' ? `its attempt ${sel.attempt} didn't finish` : `${sel.attempt} isn't approved yet`
        return { ok: false, why: `${up.label}: ${why}` }
      }
      inputs[name] = { stage: up.id, attempt: sel!.attempt, hash: hashText(stableJson(m!.outputs)) }
      sources[name] = { dir: path.join(store.attemptDir(set, item, up.id, sel!.attempt), 'out') }
    } else {
      const file = path.resolve(config.repo, input.file)
      if (!existsSync(file)) return { ok: false, why: `${input.file} is missing from the game's repo` }
      inputs[name] = { file: input.file, hash: await hashFile(file) }
      sources[name] = { file, as: input.as ?? path.basename(input.file) }
    }
  }
  return { ok: true, inputs, sources }
}

/** The hashes of the code files a stage lists, as they are now (a missing one hashes as 'missing'). */
export async function codeHashes (config: ForgeConfig, stage: ForgeStage): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const f of stage.code ?? []) {
    const file = path.resolve(config.repo, f)
    out[f] = existsSync(file) ? await hashFile(file) : 'missing'
  }
  return out
}

export const versionOf = (stage: ForgeStage): string => String(stage.version ?? 1)
export const specHash = (item: ForgeItem): string => hashText(stableJson(item.spec)).slice(0, 32)

/** Why an attempt no longer follows from what is picked now and the code now (empty: it does). */
export function staleness (m: Manifest, stage: ForgeStage, item: ForgeItem, now: InputsNow, code: Record<string, string>): string[] {
  const why: string[] = []
  if (m.version !== versionOf(stage)) why.push(`the stage's version changed (${m.version} to ${versionOf(stage)})`)
  if (stableJson(m.cmd) !== stableJson(stage.cmd)) why.push('its command changed')
  if (m.spec !== specHash(item)) why.push(`the spec of ${item.name} changed`)
  if (!now.ok) why.push(now.why)
  else {
    for (const [name, was] of Object.entries(m.inputs)) {
      const is = now.inputs[name]
      if (is === undefined) why.push(`input ${name} is no longer used`)
      else if ('stage' in was && 'stage' in is && was.attempt !== is.attempt) why.push(`${is.stage}: made from ${was.attempt}, ${is.attempt} is picked now`)
      else if (was.hash !== is.hash) why.push('stage' in is ? `${is.stage}: its outputs changed` : `${is.file} changed`)
    }
    for (const name of Object.keys(now.inputs)) if (m.inputs[name] === undefined) why.push(`it has a new input, ${name}`)
  }
  for (const [file, hash] of Object.entries(code)) {
    if (m.code[file] === undefined) why.push(`${file} is new to its code`)
    else if (m.code[file] !== hash) why.push(`${file} changed`)
  }
  for (const file of Object.keys(m.code)) if (code[file] === undefined) why.push(`${file} is no longer listed`)
  return why
}

/** The board's view of a set: every item's stages, attempts (with why each is stale), what is picked and ready. */
export async function setView (store: ForgeStore, config: ForgeConfig, set: ForgeSet): Promise<SetView> {
  const pipeline = config.pipelines[set.pipeline]
  const items: ItemView[] = []
  for (const item of await store.items(set.id)) {
    const stages: StageView[] = []
    for (const stage of pipeline?.stages ?? []) {
      const now = await inputsNow(store, config, pipeline, set.id, item.id, stage)
      const code = await codeHashes(config, stage)
      const sel = await store.selection(set.id, item.id, stage.id)
      const attempts: AttemptView[] = (await store.manifests(set.id, item.id, stage.id)).map(m => ({
        id: m.attempt, status: m.status, startedAt: m.startedAt, seed: m.seed, outputs: Object.keys(m.outputs),
        stale: m.status === 'done' ? staleness(m, stage, item, now, code) : [],
        ...(m.finishedAt !== undefined ? { finishedAt: m.finishedAt } : {}),
        ...(m.error !== undefined ? { error: m.error } : {}),
        ...(m.result !== undefined ? { result: m.result } : {}),
      }))
      const picked = sel === null ? null : await store.manifest(set.id, item.id, stage.id, sel.attempt)
      stages.push({ id: stage.id, attempts, selected: sel, ready: isReady(stage, sel, picked), blocked: now.ok ? null : now.why })
    }
    items.push({ ...item, stages })
  }
  return { ...set, items }
}
