// Background jobs: Blender, Codex, PyTorch and the game build run here, never in a request. Progress streams to the
// browser over SSE ('job' events). A job that rewrites a character's files (`lock: 'files'`, the default for a
// character's job) waits for that character's other such jobs; jobs sharing an `exclusive` key ('game-export') run one
// at a time across characters. Cancelling aborts the job's signal: the processes it spawned are killed (their whole
// process group) and the runner takes its failure path, which rolls back what it had changed.
import { type ChildProcess, execFile, spawn, type SpawnOptions } from 'node:child_process'
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
/** A running job's update, so the GPU lane can say why it waits on the job's own line. */
const updaters = new Map<string, Update>()

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
  updaters.set(job.id, update)
  const end = (patch: Partial<Job>): void => {
    updaters.delete(job.id)
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

// ---- the GPU lane -----------------------------------------------------------------------------------------------
//
// One holder of the GPU at a time, whatever asked for it (a Forge stage, the skin optimizer, the Qwen painter): the
// others wait in order (first come first served; reorderGpu moves them). The head of the line gets the GPU when it is
// ready for it: ComfyUI is told to let go of its models first when ComfyUI had the GPU last and this job isn't
// ComfyUI's (it keeps them loaded for the next prompt otherwise), and nvidia-smi must show the VRAM the job declared
// free. Whoever waits is told why (its job's message, `onWait` and the 'gpu' event), and nobody gives up on a timer:
// a turn ends when it is released or its signal aborts.

/** What a GPU job needs: MiB of VRAM free before it starts, and whose models it loads ('comfy' for ComfyUI's). */
export interface GpuNeed { vram: number, family: string }
export interface GpuWaiter { id: string, jobId?: string, label: string, need: GpuNeed, since: number, why: string }
export interface GpuState { holder: GpuWaiter | null, waiting: GpuWaiter[], last: string | null }
export interface GpuTurn { id: string, release: () => void }
export interface GpuTurnOptions { onWait?: (why: string) => void }

/** How the lane looks at the machine: replaced in tests. pollMs: how often a short GPU is looked at again. */
export const gpuConfig: { pollMs: number, comfyUrl?: string, settingsComfy?: () => Promise<string | undefined> } = {
  pollMs: Number(process.env.RIGSMITH_GPU_POLL_MS ?? 5000),
}

/** Where ComfyUI is: $COMFY_URL, else the settings', else the game's forge.json (set by the Forge), else its default. */
export async function comfyUrl (): Promise<string> {
  return (process.env.COMFY_URL ?? (await gpuConfig.settingsComfy?.().catch(() => undefined)) ?? gpuConfig.comfyUrl ?? 'http://127.0.0.1:8188').replace(/\/+$/, '')
}

interface Waiter extends GpuWaiter {
  grant: (turn: GpuTurn) => void
  onWait?: (why: string) => void
  signal?: AbortSignal
}

const lane = {
  holder: null as Waiter | null,
  waiting: [] as Waiter[],
  /** The family that had the GPU last (null: none since the server started). */
  last: null as string | null,
  /** ComfyUI may hold models: it had the GPU since it was last told to free them, or it was there before we started. */
  comfyMayHold: true,
  /** The head of the line being readied (ComfyUI freed, VRAM looked at); one at a time. */
  readying: false,
  /** Cuts the readying's wait between looks short (the line changed). */
  wake: null as (() => void) | null,
}

const view = (w: Waiter): GpuWaiter => ({ id: w.id, ...(w.jobId !== undefined ? { jobId: w.jobId } : {}), label: w.label, need: w.need, since: w.since, why: w.why })

export function gpuState (): GpuState {
  return { holder: lane.holder === null ? null : view(lane.holder), waiting: lane.waiting.map(view), last: lane.last }
}

const gib = (mib: number): string => `${(mib / 1024).toFixed(1)} GB`
const minutes = (ms: number): string => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`

function say (w: Waiter, why: string): void {
  if (w.why === why) return
  w.why = why
  w.onWait?.(why)
  if (w.jobId !== undefined) updaters.get(w.jobId)?.({ message: why })
}

function announce (): void {
  for (const [i, w] of lane.waiting.entries()) {
    if (i === 0 && (lane.readying || lane.holder === null)) continue
    const ahead = lane.holder !== null ? lane.holder.label : lane.waiting[0].label
    say(w, i === 0 ? `Waiting for the GPU: ${ahead} has it` : `Waiting for the GPU: ${ahead} has it, ${i} ahead in line`)
  }
  events.emit('gpu', gpuState())
}

/** MiB free on the first GPU by nvidia-smi ($NVIDIA_SMI), or why it couldn't be read. */
export async function freeVram (): Promise<{ free: number } | { error: string }> {
  const smi = process.env.NVIDIA_SMI ?? 'nvidia-smi'
  return await new Promise(resolve => {
    execFile(smi, ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { timeout: 15_000 }, (error, stdout) => {
      if (error !== null) { resolve({ error: `nvidia-smi failed: ${error.message.split('\n')[0]}` }); return }
      const free = parseInt(String(stdout).trim().split('\n')[0], 10)
      resolve(Number.isFinite(free) ? { free } : { error: `nvidia-smi said ${JSON.stringify(String(stdout).trim().slice(0, 60))}` })
    })
  })
}

/** Ask ComfyUI to unload its models and free its memory. False when it couldn't be reached (then it holds nothing). */
export async function freeComfy (): Promise<{ ok: boolean, why?: string }> {
  const url = await comfyUrl()
  try {
    const r = await fetch(`${url}/free`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }) })
    return r.ok ? { ok: true } : { ok: false, why: `ComfyUI answered ${r.status}` }
  } catch (error) {
    return { ok: false, why: `ComfyUI not reached at ${url}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** A wait between looks at the GPU, cut short by the signal or a change to the line. */
const sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  await new Promise<void>(resolve => {
    const t = setTimeout(done, ms)
    function done (): void { clearTimeout(t); signal?.removeEventListener('abort', done); lane.wake = null; resolve() }
    lane.wake = done
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** Ready the head of the line and hand it the GPU. Reordering or a cancel meanwhile readies whoever is head then. */
async function advance (): Promise<void> {
  if (lane.readying || lane.holder !== null) return
  lane.readying = true
  try {
    while (lane.holder === null && lane.waiting.length > 0) {
      const w = lane.waiting[0]
      const comfy = w.need.family === 'comfy'
      // (ComfyUI after ComfyUI keeps its loaded models: what it holds is what this one needs)
      const check = !(comfy && lane.last === 'comfy')
      if (lane.last === 'comfy' && !comfy && lane.comfyMayHold) {
        say(w, "Freeing ComfyUI's models for it")
        const r = await freeComfy()
        lane.comfyMayHold = false
        if (!r.ok) say(w, `Could not free ComfyUI's models (${r.why}); looking at the GPU`)
      }
      let ready = !check
      let freedOnce = false
      while (!ready && lane.waiting[0] === w && w.signal?.aborted !== true) {
        const v = await freeVram()
        if ('error' in v) { say(w, `${v.error}: starting without checking the VRAM`); ready = true; break }
        if (v.free >= w.need.vram) { ready = true; break }
        if (lane.comfyMayHold && !freedOnce) {
          // (ComfyUI may sit on models from before: a job of its own reloads what it needs)
          freedOnce = true
          say(w, `Freeing ComfyUI's models: ${gib(v.free)} free, needs ${gib(w.need.vram)}`)
          const r = await freeComfy()
          lane.comfyMayHold = false
          if (r.ok) continue
        }
        say(w, `Waiting for the GPU to free up: ${gib(v.free)} free, needs ${gib(w.need.vram)} (waiting ${minutes(Date.now() - w.since)}; something outside Rigsmith may hold it)`)
        events.emit('gpu', gpuState())
        await sleep(gpuConfig.pollMs, w.signal)
      }
      if (lane.waiting[0] !== w || w.signal?.aborted === true) continue
      lane.waiting.shift()
      lane.holder = w
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        if (lane.holder === w) lane.holder = null
        lane.last = w.need.family
        if (w.need.family === 'comfy') lane.comfyMayHold = true
        announce()
        void advance()
      }
      say(w, 'Has the GPU')
      w.grant({ id: w.id, release })
      announce()
    }
  } finally {
    lane.readying = false
  }
}

let turns = 0

/**
 * Wait for the GPU. `job`: the jobs.ts job it is for (its message says why it waits) or just a label. Resolves with
 * the turn, to `release()` when the GPU work is done (withGpu does it); rejects when `signal` aborts first.
 */
export async function gpuTurn (job: { id?: string, label: string } | undefined, need: GpuNeed, signal?: AbortSignal, o: GpuTurnOptions = {}): Promise<GpuTurn> {
  if (signal?.aborted === true) throw cancelled(signal)
  return await new Promise<GpuTurn>((resolve, reject) => {
    const id = `gpu-${++turns}`
    const jobId = job?.id !== undefined && jobs.has(job.id) ? job.id : undefined
    const w: Waiter = {
      id, label: job?.label ?? 'A GPU job', need, since: Date.now(), why: '', onWait: o.onWait, signal,
      ...(jobId !== undefined ? { jobId } : {}),
      grant: turn => { signal?.removeEventListener('abort', onAbort); resolve(turn) },
    }
    function onAbort (): void {
      const i = lane.waiting.indexOf(w)
      if (i < 0) return
      lane.waiting.splice(i, 1)
      reject(cancelled(signal))
      lane.wake?.()
      announce()
      void advance()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    lane.waiting.push(w)
    announce()
    void advance()
  })
}

/** fn with the GPU, released after it whatever happens. */
export async function withGpu<T> (job: { id?: string, label: string } | undefined, need: GpuNeed, signal: AbortSignal | undefined, fn: () => Promise<T>, o: GpuTurnOptions = {}): Promise<T> {
  const turn = await gpuTurn(job, need, signal, o)
  try {
    return await fn()
  } finally {
    turn.release()
  }
}

/** Put the waiting turns (or jobs, by job id) named first, in that order; the rest keep theirs after them. */
export function reorderGpu (ids: string[]): GpuState {
  const named = ids.flatMap(id => lane.waiting.filter(w => w.id === id || w.jobId === id))
  const rest = lane.waiting.filter(w => !named.includes(w))
  lane.waiting.splice(0, lane.waiting.length, ...new Set([...named, ...rest]))
  lane.wake?.()
  announce()
  return gpuState()
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

/** What the Qwen painter asks of the GPU lane: ComfyUI's, about 10 GB ($RIGSMITH_QWEN_VRAM MiB). */
export const QWEN_GPU: GpuNeed = { vram: Number(process.env.RIGSMITH_QWEN_VRAM ?? 10_000), family: 'comfy' }

/** Paint a Look capture's views with Qwen Image 2.1 in the local ComfyUI (tools/paint_capture.py): each view's masked
 * area cropped, painted at 512 px, laid back in its place as result-N.png. Progress from its @@PROGRESS lines. It
 * waits its turn on the GPU lane (`job`: the job it is for, whose message says why it waits); the timeout counts from
 * when it has the GPU. */
export async function runQwenPaint (dir: string, onProgress?: (progress: number, message: string) => void, o: ProcessOptions & { job?: { id?: string, label: string } } = {}): Promise<void> {
  await withGpu(o.job ?? { label: 'The Qwen painter' }, QWEN_GPU, o.signal, async () => { await qwenPaintNow(dir, onProgress, o) }, { onWait: why => { onProgress?.(0, why) } })
}

async function qwenPaintNow (dir: string, onProgress: ((progress: number, message: string) => void) | undefined, o: ProcessOptions): Promise<void> {
  const timeoutMs = o.timeoutMs ?? 15 * 60_000
  await new Promise<void>((resolve, reject) => {
    const child = spawnJob(process.env.PYTHON ?? 'python3', [path.join(ROOT, 'tools', 'paint_capture.py'), dir], { stdio: ['ignore', 'pipe', 'pipe'] }, o.signal)
    let log = ''
    let buffer = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; killGroup(child, 'SIGKILL') }, timeoutMs)
    const onLine = (line: string): void => {
      if (line.startsWith('@@PROGRESS ')) {
        try {
          const p = JSON.parse(line.slice(11)) as { progress: number, message: string }
          onProgress?.(p.progress, p.message)
        } catch { /* (a line that only looked like progress) */ }
      } else log += line + '\n'
    }
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      lines.forEach(onLine)
    })
    child.stderr!.on('data', (chunk: Buffer) => { log += chunk.toString() })
    child.on('error', error => { clearTimeout(timer); reject(new Error(`Could not start the Qwen painter: ${error.message}`)) })
    child.on('close', code => {
      clearTimeout(timer)
      if (buffer !== '') onLine(buffer)
      if (o.signal?.aborted === true) reject(cancelled(o.signal))
      else if (timedOut) reject(new Error('The Qwen painter timed out'))
      else if (code === 0) resolve()
      else reject(new Error(lastError(log) ?? log.trim().split('\n').pop()?.slice(0, 300) ?? `The Qwen painter exited with ${code}`))
    })
  })
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
