// Background jobs: Blender, Codex, PyTorch and the game build run here, never in a request. Progress streams to the
// browser over SSE ('job' events). A job that rewrites a character's files (`lock: 'files'`, the default for a
// character's job) waits for that character's other such jobs; jobs sharing an `exclusive` key ('game-export') run one
// at a time across characters. Cancelling aborts the job's signal: the processes it spawned are killed (their whole
// process group) and the runner takes its failure path, which rolls back what it had changed.
import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { Job } from '../src/model/types.ts'
import { events, ROOT } from './store.ts'

export type { Job, JobStatus } from '../src/model/types.ts'
export { events }

export const BLENDER = process.env.BLENDER ?? 'blender'
const CONCURRENCY = Number(process.env.RIGSMITH_JOBS ?? 3)

export type Update = (patch: Partial<Job>) => void
export type Runner = (job: Job, update: Update, signal: AbortSignal) => Promise<void>
export interface JobOptions {
  /** 'files' (the default when the job has a character): one at a time per character. 'none': Codex, library saves. */
  lock?: 'files' | 'none'
  /** Jobs with the same key run one at a time, whatever their character. */
  exclusive?: string
}

interface Entry { job: Job, run: Runner, lock: 'files' | 'none', exclusive?: string, controller: AbortController }

const jobs = new Map<string, Job>()
const queue: Entry[] = []
const running = new Map<string, Entry>()

export function listJobs (): Job[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100)
}

export const getJob = (id: string): Job | undefined => jobs.get(id)

const active = (job: Job): boolean => job.status === 'queued' || job.status === 'running'

/** The character's running job, else its first queued one (with `lock: 'files'`, only those that rewrite its files):
 * what a caller is told to wait for. */
export function busy (characterId: string, lock?: 'files'): Job | undefined {
  return [...running.values(), ...queue].find(e => e.job.characterId === characterId && active(e.job) && (lock === undefined || e.lock === 'files'))?.job
}

export function enqueue (kind: string, label: string, characterId: string | undefined, run: Runner, o: JobOptions = {}): Job {
  const job: Job = { id: randomBytes(6).toString('hex'), kind, label, characterId, status: 'queued', progress: 0, message: 'Queued', createdAt: Date.now() }
  jobs.set(job.id, job)
  // (the oldest finished ones go, so the list stays short)
  if (jobs.size > 200) for (const old of [...jobs.values()].filter(j => !active(j)).sort((a, b) => a.createdAt - b.createdAt).slice(0, jobs.size - 200)) jobs.delete(old.id)
  queue.push({ job, run, lock: o.lock ?? (characterId !== undefined ? 'files' : 'none'), exclusive: o.exclusive, controller: new AbortController() })
  events.emit('job', job)
  pump()
  return job
}

/** Stop a job: a queued one never starts; a running one has its signal aborted. Null when it isn't queued or running. */
export function cancel (id: string): Job | null {
  const i = queue.findIndex(e => e.job.id === id)
  if (i >= 0) {
    const [entry] = queue.splice(i, 1)
    Object.assign(entry.job, { status: 'cancelled', message: 'Cancelled', finishedAt: Date.now() })
    events.emit('job', entry.job)
    pump()
    return entry.job
  }
  const entry = running.get(id)
  if (entry === undefined) return null
  entry.job.message = 'Cancelling'
  events.emit('job', entry.job)
  entry.controller.abort(new Error('Cancelled'))
  return entry.job
}

function blocked (e: Entry): boolean {
  for (const r of running.values()) {
    if (e.lock === 'files' && r.lock === 'files' && r.job.characterId === e.job.characterId) return true
    if (e.exclusive !== undefined && r.exclusive === e.exclusive) return true
  }
  return false
}

function pump (): void {
  for (let i = 0; i < queue.length && running.size < CONCURRENCY;) {
    const entry = queue[i]
    if (blocked(entry)) { i++; continue }
    queue.splice(i, 1)
    start(entry)
  }
}

function start (entry: Entry): void {
  const { job, run, controller } = entry
  running.set(job.id, entry)
  const finished = (): boolean => !active(job)
  const update: Update = patch => {
    if (finished()) return
    Object.assign(job, patch)
    events.emit('job', job)
  }
  update({ status: 'running', message: 'Starting' })
  const end = (patch: Partial<Job>): void => {
    Object.assign(job, patch, { finishedAt: Date.now() })
    events.emit('job', job)
  }
  // (in a microtask: a runner that throws at once fails its job, not the queue)
  Promise.resolve().then(async () => { await run(job, update, controller.signal) })
    .then(() => { end({ status: 'done', progress: 1, message: 'Done' }) })
    .catch((error: unknown) => {
      if (controller.signal.aborted) { end({ status: 'cancelled', message: 'Cancelled' }); return }
      const message = error instanceof Error ? error.message : String(error)
      end({ status: 'failed', message, error: message })
    })
    .finally(() => { running.delete(job.id); pump() })
}

// ---- processes --------------------------------------------------------------------------------------------------

/** Children still running, killed with the server: each leads its own process group (so a cancel reaches what it
 * spawned too), which also means the terminal's Ctrl-C no longer reaches them. */
const children = new Set<ChildProcess>()
let exitHook = false

function killGroup (child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch { /* (gone) */ } }
}

/** Spawn a job's process in its own process group. When `signal` aborts (the job is cancelled) the group gets SIGTERM,
 * then SIGKILL 3 s later if it is still there. For runners that spawn their own tools (the torch runs, the build). */
export function spawnJob (command: string, args: string[], options: SpawnOptions = {}, signal?: AbortSignal): ChildProcess {
  if (!exitHook) {
    exitHook = true
    process.on('exit', () => { for (const c of children) killGroup(c, 'SIGKILL') })
  }
  const child = spawn(command, args, { ...options, detached: true })
  children.add(child)
  const abort = (): void => {
    killGroup(child)
    setTimeout(() => { killGroup(child, 'SIGKILL') }, 3000).unref()
  }
  if (signal?.aborted === true) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  child.on('close', () => { children.delete(child); signal?.removeEventListener('abort', abort) })
  child.on('error', () => { children.delete(child) })
  return child
}

const cancelled = (signal: AbortSignal | undefined): Error => (signal?.reason instanceof Error ? signal.reason : new Error('Cancelled'))

export interface BlenderResult { result: Record<string, unknown>, log: string }
export interface ProcessOptions { signal?: AbortSignal, timeoutMs?: number }

/**
 * Run a script from blender/ headless. Scripts report with lines:
 *   @@PROGRESS {"progress": 0.5, "message": "..."}
 *   @@RESULT {...}
 */
export async function runBlender (script: string, args: string[], onProgress?: (progress: number, message: string) => void, o: ProcessOptions = {}): Promise<BlenderResult> {
  const scriptPath = path.join(ROOT, 'blender', script)
  const timeoutMs = o.timeoutMs ?? 10 * 60_000
  return await new Promise((resolve, reject) => {
    const child = spawnJob(BLENDER, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', scriptPath, '--', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }, o.signal)
    let log = ''
    let result: Record<string, unknown> | null = null
    let buffer = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; killGroup(child, 'SIGKILL') }, timeoutMs)
    const onLine = (line: string): void => {
      if (line.startsWith('@@PROGRESS ')) {
        try {
          const p = JSON.parse(line.slice(11)) as { progress: number, message: string }
          onProgress?.(p.progress, p.message)
        } catch { /* (a line that only looked like progress) */ }
      } else if (line.startsWith('@@RESULT ')) {
        result = JSON.parse(line.slice(9)) as Record<string, unknown>
      } else {
        log += line + '\n'
      }
    }
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      lines.forEach(onLine)
    })
    child.stderr!.on('data', (chunk: Buffer) => { log += chunk.toString() })
    child.on('error', error => { clearTimeout(timer); reject(new Error(`Could not start Blender (${BLENDER}): ${error.message}`)) })
    child.on('close', code => {
      clearTimeout(timer)
      if (buffer !== '') onLine(buffer)
      if (o.signal?.aborted === true) reject(cancelled(o.signal))
      else if (timedOut) reject(new Error(`${script} timed out`))
      else if (code === 0 && result !== null) resolve({ result, log })
      else reject(new Error(lastError(log) ?? `${script} exited with code ${code}`))
    })
  })
}

function lastError (log: string): string | null {
  const lines = log.trim().split('\n').filter(l => /error|exception|Error:/i.test(l))
  return lines.length > 0 ? lines[lines.length - 1].trim().slice(0, 300) : null
}

/** Run the Codex CLI non-interactively in `dir` (it may write files there), with images attached. */
export async function runCodex (dir: string, prompt: string, images: string[], onMessage?: (message: string) => void, o: ProcessOptions = {}): Promise<void> {
  // (low reasoning: the work is one image edit a view, so a long think first only costs time; $CODEX_EFFORT overrides)
  const effort = process.env.CODEX_EFFORT ?? 'low'
  const timeoutMs = o.timeoutMs ?? 15 * 60_000
  const args = ['exec', '-C', dir, '--skip-git-repo-check', '--ephemeral', '-s', 'workspace-write', '--json', '-c', `model_reasoning_effort="${effort}"`]
  for (const image of images) args.push('-i', path.join(dir, image))
  // `-i` takes several files, so the prompt goes through stdin ('-') rather than as a trailing argument.
  args.push('-')
  await new Promise<void>((resolve, reject) => {
    const child = spawnJob(process.env.CODEX ?? 'codex', args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] }, o.signal)
    child.stdin!.end(prompt)
    let tail = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; killGroup(child, 'SIGKILL') }, timeoutMs)
    child.stdout!.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim() === '') continue
        tail = line
        try {
          const event = JSON.parse(line) as { type?: string, item?: { type?: string, text?: string } }
          if (event.item?.type === 'agent_message' && event.item.text !== undefined) onMessage?.(event.item.text.slice(0, 120))
          else if (event.type !== undefined) onMessage?.(`Codex: ${event.type.replace(/[._]/g, ' ')}`)
        } catch { /* not JSON */ }
      }
    })
    child.stderr!.on('data', (chunk: Buffer) => { tail = chunk.toString() })
    child.on('error', error => { clearTimeout(timer); reject(new Error(`Could not start Codex: ${error.message}`)) })
    child.on('close', code => {
      clearTimeout(timer)
      if (o.signal?.aborted === true) reject(cancelled(o.signal))
      else if (timedOut) reject(new Error('Codex timed out'))
      else if (code === 0) resolve()
      else reject(new Error(`Codex exited with ${code}: ${tail.slice(0, 200)}`))
    })
  })
}
