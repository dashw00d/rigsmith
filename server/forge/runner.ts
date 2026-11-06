// One attempt of one stage: a new attempt folder, the inputs staged into its work/ (links to what is picked upstream,
// copies for a stage that changes them), the command run in the game's repo in its own process group (a cancel kills
// all of it), its @@PROGRESS and @@RESULT lines read, its log kept, the outputs it declares checked and moved into
// out/, hashed, and out/ made read-only. The manifest records what the attempt's key was made of.
import { randomInt } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, copyFile, cp, lstat, mkdir, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnJob } from '../jobs.ts'
import {
  attemptKey, codeHashes, filesUnder, type ForgeStore, hashFile, inputsNow, makeReadOnly, makeWritable, specHash, versionOf, writeJsonFile,
} from './store.ts'
import type { ForgeConfig, ForgeItem, ForgePipeline, ForgeStage, Manifest } from './types.ts'

export interface RunOptions {
  store: ForgeStore
  config: ForgeConfig
  pipeline: ForgePipeline
  set: string
  item: string
  stage: ForgeStage
  params?: Record<string, unknown>
  variant?: number
  seed?: number
  /** A partial attempt (<attempt>.partial) whose work/ this one carries on in. */
  resume?: string
  signal?: AbortSignal
  /** The attempt made (before the command starts). */
  onAttempt?: (attempt: string) => void
  onProgress?: (progress: number, message: string) => void
  onLog?: (line: string) => void
}

export interface RunResult { manifest: Manifest, reused: boolean }

const TAIL = 40
const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true
const cancelled = (signal: AbortSignal | undefined): Error => (signal?.reason instanceof Error ? signal.reason : new Error('Cancelled'))

/** A word of a command with its placeholders filled in. */
export function fill (word: string, values: Record<string, string>): string {
  return word.replace(/\{([a-z]+(?:\.[A-Za-z0-9_-]+)?)\}/g, (m, name: string) => values[name] ?? m)
}

/** The seed an attempt is made with: the one asked for, else a new one for a generation, else the item's own. */
export function seedOf (stage: ForgeStage, item: ForgeItem, params: Record<string, unknown>, given?: number): number {
  if (given !== undefined) return given
  if (typeof params.seed === 'number') return params.seed
  if (generative(stage)) return randomInt(1, 2 ** 31 - 1)
  return typeof item.spec.seed === 'number' ? item.spec.seed : 0
}

export const generative = (stage: ForgeStage): boolean => stage.generative ?? stage.gpu !== undefined

/** Files and folders matching an output path (its last part may hold '*') under root. */
async function matches (root: string, rel: string): Promise<string[]> {
  const dir = path.posix.dirname(rel), base = path.posix.basename(rel)
  if (!base.includes('*')) return existsSync(path.join(root, rel)) ? [rel] : []
  const at = path.join(root, dir)
  if (!existsSync(at)) return []
  const re = new RegExp(`^${base.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return (await readdir(at)).filter(f => re.test(f)).sort().map(f => (dir === '.' ? f : `${dir}/${f}`))
}

/** Move a file or folder from work/ into out/: a link is replaced by what it points at (out/ holds real files). */
async function moveOut (src: string, dst: string): Promise<void> {
  await mkdir(path.dirname(dst), { recursive: true })
  const info = await lstat(src)
  if (info.isSymbolicLink()) {
    const real = await realpath(src)
    await cp(real, dst, { recursive: true, dereference: true })
    await makeWritable(dst)
    await rm(src, { force: true })
  } else {
    await rename(src, dst)
  }
}

/** Stage an input into work/: each file of an earlier attempt's out/ at its own path (folders made real, so the
 * command can write beside them), or a repo file at its name; linked, or copied (writable) when the stage mutates. */
async function stage (src: string, dst: string, copy: boolean): Promise<void> {
  if (existsSync(dst)) return
  await mkdir(path.dirname(dst), { recursive: true })
  if (copy) {
    await copyFile(src, dst)
    await chmod(dst, 0o644)
  } else await symlink(src, dst)
}

/** Run one attempt of a stage. Resolves with its manifest (status done), or with an attempt of the same key reused
 * (a deterministic stage with `cache`); rejects when it failed or was cancelled, its manifest saying which. */
export async function runStage (o: RunOptions): Promise<RunResult> {
  const { store, config, pipeline, set, stage: st } = o
  const item = await store.getItem(set, o.item)
  if (item === null) throw new Error(`No item ${set}/${o.item}`)
  if (o.signal?.aborted === true) throw cancelled(o.signal)
  const now = await inputsNow(store, config, pipeline, set, item.id, st)
  if (!now.ok) throw new Error(`${st.label} can't run yet: ${now.why}`)
  const params = o.params ?? {}
  const seed = seedOf(st, item, params, o.seed)
  const code = await codeHashes(config, st)
  const parts = { version: versionOf(st), cmd: st.cmd, params, seed, spec: specHash(item), inputs: now.inputs, code }
  const key = attemptKey(parts)
  if (st.cache === true && !generative(st)) {
    const same = (await store.manifests(set, item.id, st.id)).filter(m => m.status === 'done' && m.key === key).at(-1)
    if (same !== undefined) return { manifest: same, reused: true }
  }

  const { id: attempt, dir } = await store.newAttempt(set, item.id, st.id)
  const work = path.join(dir, 'work'), out = path.join(dir, 'out')
  const startedAt = Date.now()
  const manifest: Manifest = {
    schema: 1, set, item: item.id, stage: st.id, attempt, key, status: 'running', version: parts.version, cmd: st.cmd, params, seed,
    variant: o.variant ?? 0, inputs: now.inputs, spec: parts.spec, code, outputs: {}, startedAt,
    ...(o.resume !== undefined ? { resumed: o.resume } : {}),
  }
  await store.writeManifest(manifest)
  o.onAttempt?.(attempt)
  const log = createWriteStream(path.join(dir, 'log.txt'), { flags: 'a' })
  const finish = async (patch: Partial<Manifest>): Promise<void> => {
    Object.assign(manifest, patch, { finishedAt: Date.now() })
    await store.writeManifest(manifest)
    await writeJsonFile(path.join(dir, 'job.json'), { stage: st.id, params, seed, status: manifest.status, startedAt, finishedAt: manifest.finishedAt, ...(manifest.error !== undefined ? { error: manifest.error } : {}) })
    await new Promise<void>(resolve => { log.end(resolve) })
  }

  try {
    // (carry on in the partial attempt's work/: the command skips what it did there)
    if (o.resume !== undefined) {
      const partial = path.join(store.attemptDir(set, item.id, st.id, o.resume), 'work')
      if (existsSync(partial)) {
        await rm(work, { recursive: true, force: true })
        await rename(partial, work)
        log.write(`(carried on from ${o.resume}'s work)\n`)
      }
    }
    const values: Record<string, string> = {
      work, out, spec: path.join(dir, 'spec.json'), seed: String(seed), item: item.id, set, attempt, repo: config.repo,
    }
    for (const [name, src] of Object.entries(now.sources)) {
      if ('dir' in src) {
        const files = await filesUnder(src.dir)
        for (const rel of files) await stage(path.join(src.dir, rel), path.join(work, rel), st.mutates === true)
        const up = now.inputs[name] as { stage: string, attempt: string }
        const first = Object.keys((await store.manifest(set, item.id, up.stage, up.attempt))?.outputs ?? {})[0] ?? files[0] ?? ''
        values[`in.${name}`] = path.join(work, first)
      } else {
        await stage(src.file, path.join(work, src.as), st.mutates === true)
        values[`in.${name}`] = path.join(work, src.as)
      }
    }
    const inputs = Object.fromEntries(Object.keys(now.sources).map(name => [name, values[`in.${name}`]]))
    await writeFile(values.spec, JSON.stringify({
      set, item: item.id, stage: st.id, attempt, seed, variant: o.variant ?? 0, params, spec: item.spec, name: item.name,
      repo: config.repo, ...(config.body !== undefined ? { body: path.resolve(config.repo, config.body) } : {}), work, out, inputs,
    }, null, 1) + '\n')
    await writeJsonFile(path.join(dir, 'job.json'), { stage: st.id, params, seed, status: 'running', startedAt })

    const cmd = st.cmd.map(w => fill(w, values))
    log.write(`+ ${cmd.join(' ')}\n`)
    const result = await runCommand(cmd, {
      cwd: config.repo,
      env: {
        ...process.env, ...Object.fromEntries(Object.entries(st.env ?? {}).map(([k, v]) => [k, fill(v, values)])),
        FORGE_WORK: work, FORGE_OUT: out, FORGE_SPEC: values.spec, FORGE_SEED: String(seed), FORGE_REPO: config.repo, PYTHONUNBUFFERED: '1',
      },
      timeoutMs: (st.timeout ?? 3600) * 1000,
      signal: o.signal,
      onLine: line => { log.write(line + '\n'); o.onLog?.(line) },
      onProgress: o.onProgress,
    })

    // what it declared, from out/ (written there) or work/ (moved over)
    const written: string[] = []
    const missing: string[] = []
    for (const raw of st.outputs) {
      const optional = raw.startsWith('?')
      const rel = fill(raw.replace(/^\?/, ''), values).replace(/\/+$/, '')
      let found = await matches(out, rel)
      if (found.length === 0) {
        found = await matches(work, rel)
        for (const f of found) await moveOut(path.join(work, f), path.join(out, f))
      }
      if (found.length === 0 && !optional) missing.push(rel)
      written.push(...found)
    }
    if (missing.length > 0) throw new Error(`${st.label} finished without writing ${missing.join(', ')}`)
    // (in the order declared, then anything else it put in out/)
    const outputs: Record<string, string> = {}
    const all = await filesUnder(out)
    const ordered = [...written.flatMap(w => all.filter(f => f === w || f.startsWith(w + '/'))), ...all]
    for (const f of ordered) if (outputs[f] === undefined) outputs[f] = await hashFile(path.join(out, f))
    if (st.splits === true && Array.isArray(result?.pieces)) {
      const pieces = (result.pieces as unknown[]).filter((p): p is string => typeof p === 'string')
      await store.updateItem(set, item.id, i => { i.pieces = pieces })
    }
    if (st.scratch === true) await rm(work, { recursive: true, force: true })
    await makeReadOnly(out)
    await finish({ status: 'done', outputs, ...(result !== null ? { result } : {}) })
    return { manifest, reused: false }
  } catch (error) {
    // (read again: it may have aborted while it ran)
    const aborted = isAborted(o.signal)
    const message = aborted ? 'Cancelled' : error instanceof Error ? error.message : String(error)
    log.write(`!! ${message}\n`)
    await finish({ status: aborted ? 'cancelled' : 'failed', error: message })
    throw aborted ? cancelled(o.signal) : error
  }
}

export interface CommandOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
  onLine?: (line: string) => void
  onProgress?: (progress: number, message: string) => void
}

/** Run a command in its own process group; its @@PROGRESS {progress, message} lines go to onProgress, its last
 * @@RESULT {json} is what it resolves with (null without one), every other line (stdout and stderr) to onLine. */
export async function runCommand (cmd: string[], o: CommandOptions): Promise<Record<string, unknown> | null> {
  if (o.signal?.aborted === true) throw cancelled(o.signal)
  return await new Promise((resolve, reject) => {
    const child = spawnJob(cmd[0], cmd.slice(1), { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'] }, o.signal)
    let result: Record<string, unknown> | null = null
    const tail: string[] = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }, o.timeoutMs)
    const onLine = (line: string): void => {
      if (line.startsWith('@@PROGRESS ')) {
        try {
          const p = JSON.parse(line.slice(11)) as { progress?: number, message?: string }
          o.onProgress?.(typeof p.progress === 'number' ? Math.max(0, Math.min(1, p.progress)) : 0, typeof p.message === 'string' ? p.message : '')
          return
        } catch { /* (only looked like progress: logged) */ }
      } else if (line.startsWith('@@RESULT ')) {
        try {
          const r = JSON.parse(line.slice(9)) as unknown
          if (typeof r === 'object' && r !== null && !Array.isArray(r)) { result = r as Record<string, unknown>; return }
        } catch { /* (logged) */ }
      }
      tail.push(line)
      if (tail.length > TAIL) tail.shift()
      o.onLine?.(line)
    }
    const reader = (): ((chunk: Buffer) => void) => {
      let buffer = ''
      const read = (chunk: Buffer): void => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        lines.forEach(onLine)
      }
      read.flush = (): void => { if (buffer !== '') onLine(buffer); buffer = '' }
      readers.push(read)
      return read
    }
    const readers: Array<((chunk: Buffer) => void) & { flush?: () => void }> = []
    child.stdout!.on('data', reader())
    child.stderr!.on('data', reader())
    child.on('error', error => { clearTimeout(timer); reject(new Error(`Could not start ${cmd[0]}: ${error.message}`)) })
    child.on('close', code => {
      clearTimeout(timer)
      for (const r of readers) r.flush?.()
      if (o.signal?.aborted === true) reject(cancelled(o.signal))
      else if (timedOut) reject(new Error(`${path.basename(cmd[0])} timed out after ${Math.round(o.timeoutMs / 1000)} s`))
      else if (code === 0) resolve(result)
      else {
        const errors = tail.filter(l => /error|exception|traceback|failed/i.test(l))
        reject(new Error(`${path.basename(cmd.slice(0, 2).join(' '))} exited with ${code}${(errors.at(-1) ?? tail.at(-1)) !== undefined ? `: ${(errors.at(-1) ?? tail.at(-1))!.trim().slice(0, 300)}` : ''}`))
      }
    })
  })
}
