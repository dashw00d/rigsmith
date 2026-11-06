// The Forge's queue, kept in <store>/queue.json so it outlives the server. Two lanes: 'gpu' (stages that declare a
// GPU need, one at a time here and each taking its turn on the shared GPU lane, jobs.ts gpuTurn) and 'cpu' (a few
// alongside). Order is first come first served, and reorderable. After a restart a job that was running is
// interrupted: its attempt renamed <attempt>.partial, and run again (in that work) when its stage is resumable.
// A job that finishes picks its attempt when the stage has no pick gate, and with `through` queues the next stage.
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { withGpu } from '../jobs.ts'
import { findStage } from './config.ts'
import { runStage, type RunOptions, type RunResult } from './runner.ts'
import { type ForgeStore, isReady, writeJsonFile } from './store.ts'
import type { ForgeConfig, ForgeEvent, QueueJob } from './types.ts'

export interface QueueOptions {
  store: ForgeStore
  config: () => Promise<ForgeConfig>
  /** CPU stages at once (default 2). */
  cpu?: number
  emit?: (e: ForgeEvent) => void
  /** (tests) */
  run?: (o: RunOptions) => Promise<RunResult>
  gpu?: typeof withGpu
  /** Least time between two events of a job (ms, default 250: about 4 a second). */
  throttleMs?: number
}

export interface RunRequest {
  set: string
  item: string
  stage: string
  params?: Record<string, unknown>
  /** Attempts to make (default the stage's variants). */
  variants?: number
  through?: string
  by?: string
}

interface Live { controller: AbortController, tail: string[], last: number, timer: ReturnType<typeof setTimeout> | null }

const KEEP = 300
const active = (j: QueueJob): boolean => j.status === 'queued' || j.status === 'running'

export class ForgeQueue {
  jobs: QueueJob[] = []
  private o: QueueOptions
  private live = new Map<string, Live>()
  private saving: Promise<void> = Promise.resolve()
  private loaded = false

  constructor (o: QueueOptions) { this.o = o }

  private get file (): string { return path.join(this.o.store.root, 'queue.json') }

  /** Read the queue (once): jobs a restart cut off are interrupted, their attempts set aside, resumable ones queued
   * again; then the queue runs. */
  async load (): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    let saved: { jobs?: QueueJob[] } = {}
    try { if (existsSync(this.file)) saved = JSON.parse(await readFile(this.file, 'utf8')) as typeof saved } catch (error) {
      console.error('rigsmith: forge queue.json could not be read, starting empty:', error)
    }
    this.jobs = Array.isArray(saved.jobs) ? saved.jobs : []
    const config = await this.o.config().catch(() => null)
    for (const job of [...this.jobs]) {
      if (job.status !== 'running') continue
      Object.assign(job, { status: 'interrupted', message: 'Cut off by a restart', finishedAt: Date.now() })
      let partial: string | undefined
      if (job.attempt !== undefined) {
        try { partial = await this.o.store.markPartial(job.set, job.item, job.stage, job.attempt) } catch (error) {
          console.error(`rigsmith: could not set aside forge attempt ${job.set}/${job.item}/${job.stage}/${job.attempt}:`, error)
        }
      }
      const set = await this.o.store.getSet(job.set)
      const stage = config === null || set === null ? undefined : findStage(config, set.pipeline, job.stage)
      if (stage?.resumable === true) {
        job.message = `Cut off by a restart; queued again${partial !== undefined ? ` (carrying on in ${partial})` : ''}`
        this.jobs.push(this.fresh({ ...job, ...(partial !== undefined ? { resume: partial } : {}) }))
      }
    }
    await this.save()
    this.pump()
  }

  private fresh (from: Omit<QueueJob, 'id' | 'status' | 'createdAt' | 'progress' | 'message'> & Partial<QueueJob>): QueueJob {
    return {
      id: randomBytes(6).toString('hex'), set: from.set, item: from.item, stage: from.stage, label: from.label, lane: from.lane,
      params: from.params, variant: from.variant, status: 'queued', createdAt: Date.now(), progress: 0, message: 'Queued',
      ...(from.resume !== undefined ? { resume: from.resume } : {}), ...(from.through !== undefined ? { through: from.through } : {}),
    }
  }

  list (): QueueJob[] { return this.jobs }

  /** Queue a stage of an item: one job per attempt asked for. */
  async enqueue (r: RunRequest): Promise<QueueJob[]> {
    await this.load()
    const config = await this.o.config()
    const set = await this.o.store.getSet(r.set)
    if (set === null) throw new Error(`No set is called ${r.set}`)
    const item = await this.o.store.getItem(r.set, r.item)
    if (item === null) throw new Error(`${set.name} has no item ${r.item}`)
    const stage = findStage(config, set.pipeline, r.stage)
    if (stage === undefined) throw new Error(`The ${set.pipeline} pipeline has no stage ${r.stage}`)
    const n = r.variants ?? stage.variants ?? 1
    if (!Number.isInteger(n) || n < 1 || n > 32) throw new Error('Attempts: 1 to 32')
    const made: QueueJob[] = []
    for (let v = 0; v < n; v++) {
      const job = this.fresh({
        set: r.set, item: r.item, stage: r.stage, label: `${stage.label} · ${item.name}${n > 1 ? ` (${v + 1}/${n})` : ''}`,
        lane: stage.gpu !== undefined ? 'gpu' : 'cpu', params: r.params ?? {}, variant: v,
        ...(r.through !== undefined ? { through: r.through } : {}),
      })
      this.jobs.push(job)
      made.push(job)
      this.notify(job, true)
    }
    this.trim()
    await this.save()
    this.pump()
    return made
  }

  /** The queued jobs named first, in that order; the others keep theirs after them. */
  async reorder (ids: string[]): Promise<QueueJob[]> {
    const queued = this.jobs.filter(j => j.status === 'queued')
    const named = ids.map(id => queued.find(j => j.id === id)).filter((j): j is QueueJob => j !== undefined)
    const order = [...new Set([...named, ...queued])]
    let k = 0
    this.jobs = this.jobs.map(j => (j.status === 'queued' ? order[k++] : j))
    await this.save()
    for (const j of order) this.notify(j, true)
    return this.jobs
  }

  /** A queued job never starts; a running one is stopped (its process group killed). Null when neither. */
  async cancel (id: string): Promise<QueueJob | null> {
    const job = this.jobs.find(j => j.id === id)
    if (job === undefined || !active(job)) return null
    if (job.status === 'queued') {
      Object.assign(job, { status: 'cancelled', message: 'Cancelled', finishedAt: Date.now() })
      this.notify(job, true)
      await this.save()
      this.pump()
    } else {
      job.message = 'Cancelling'
      this.notify(job, true)
      this.live.get(id)?.controller.abort(new Error('Cancelled'))
    }
    return job
  }

  /** Resolves when nothing is queued or running (tests, shutdown). */
  async idle (): Promise<void> {
    while (this.jobs.some(active)) await new Promise(resolve => setTimeout(resolve, 10))
    await this.saving
  }

  private pump (): void {
    const running = (lane: string): number => this.jobs.filter(j => j.status === 'running' && j.lane === lane).length
    for (const job of this.jobs) {
      if (job.status !== 'queued') continue
      if (job.lane === 'gpu' ? running('gpu') >= 1 : running('cpu') >= (this.o.cpu ?? 2)) continue
      void this.start(job)
    }
  }

  private async start (job: QueueJob): Promise<void> {
    const controller = new AbortController()
    this.live.set(job.id, { controller, tail: [], last: 0, timer: null })
    Object.assign(job, { status: 'running', startedAt: Date.now(), message: 'Starting', progress: 0 })
    this.notify(job, true)
    await this.save()
    const { store } = this.o
    let reused = false
    try {
      const config = await this.o.config()
      const set = await store.getSet(job.set)
      if (set === null) throw new Error(`The set ${job.set} is gone`)
      const pipeline = config.pipelines[set.pipeline]
      const stage = findStage(config, set.pipeline, job.stage)
      if (pipeline === undefined || stage === undefined) throw new Error(`The ${set.pipeline} pipeline has no stage ${job.stage} any more`)
      const run = this.o.run ?? runStage
      const go = async (): Promise<RunResult> => await run({
        store, config, pipeline, set: job.set, item: job.item, stage, params: job.params, variant: job.variant, signal: controller.signal,
        ...(job.resume !== undefined ? { resume: job.resume } : {}),
        onAttempt: attempt => { job.attempt = attempt; void this.save() },
        onProgress: (progress, message) => { this.progress(job, progress, message) },
        onLog: line => {
          const l = this.live.get(job.id)
          if (l === undefined) return
          l.tail.push(line)
          if (l.tail.length > 20) l.tail.shift()
          this.notify(job)
        },
      })
      const r = stage.gpu !== undefined
        ? await (this.o.gpu ?? withGpu)({ label: job.label }, stage.gpu, controller.signal, go, { onWait: why => { this.progress(job, job.progress, why) } })
        : await go()
      reused = r.reused
      job.attempt = r.manifest.attempt
      if (stage.gate !== 'pick') await store.select(job.set, job.item, stage.id, r.manifest.attempt, 'forge')
      Object.assign(job, { status: 'done', progress: 1, message: reused ? `Reused ${r.manifest.attempt} (same inputs and code)` : `Made ${r.manifest.attempt}`, finishedAt: Date.now() })
      // (on to the next stage when this one is ready and nothing else of it is still to come)
      if (job.through !== undefined && job.through !== stage.id) {
        const sel = await store.selection(job.set, job.item, stage.id)
        const m = sel === null ? null : await store.manifest(job.set, job.item, stage.id, sel.attempt)
        const more = this.jobs.some(j => j !== job && active(j) && j.set === job.set && j.item === job.item && j.stage === stage.id)
        const next = pipeline.stages[pipeline.stages.indexOf(stage) + 1]
        if (isReady(stage, sel, m) && !more && next !== undefined) {
          await this.enqueue({ set: job.set, item: job.item, stage: next.id, through: job.through })
        }
      }
    } catch (error) {
      const stopped = controller.signal.aborted
      const message = stopped ? 'Cancelled' : error instanceof Error ? error.message : String(error)
      Object.assign(job, { status: stopped ? 'cancelled' : 'failed', message, finishedAt: Date.now(), ...(stopped ? {} : { error: message }) })
    } finally {
      this.notify(job, true)
      const l = this.live.get(job.id)
      if (l?.timer !== null && l?.timer !== undefined) clearTimeout(l.timer)
      this.live.delete(job.id)
      this.trim()
      await this.save()
      this.pump()
    }
  }

  private progress (job: QueueJob, progress: number, message: string): void {
    if (!active(job)) return
    job.progress = progress
    if (message !== '') job.message = message
    this.notify(job)
  }

  /** The job's event, at most every throttleMs (the last one always sent); `now` for a change of state. */
  private notify (job: QueueJob, now = false): void {
    const emit = this.o.emit
    if (emit === undefined) return
    const l = this.live.get(job.id)
    const send = (): void => {
      if (l !== undefined) { l.last = Date.now(); l.timer = null }
      emit({ job: { ...job }, progress: job.progress, eta: this.eta(job), logTail: l?.tail.slice(-12) ?? [] })
    }
    if (l === undefined || now) { if (l?.timer != null) clearTimeout(l.timer); send(); return }
    const wait = (this.o.throttleMs ?? 250) - (Date.now() - l.last)
    if (wait <= 0) { send(); return }
    l.timer ??= setTimeout(send, wait)
  }

  /** Seconds left: from its progress once it has some, else from how long this stage took before; null unknown. */
  eta (job: QueueJob): number | null {
    if (job.status !== 'running' || job.startedAt === undefined) return null
    const elapsed = (Date.now() - job.startedAt) / 1000
    if (job.progress >= 0.05 && job.progress < 1) return Math.round(elapsed * (1 - job.progress) / job.progress)
    const took = this.jobs.filter(j => j.stage === job.stage && j.status === 'done' && j.startedAt !== undefined && j.finishedAt !== undefined)
      .map(j => (j.finishedAt! - j.startedAt!) / 1000).sort((a, b) => a - b)
    if (took.length === 0) return null
    return Math.max(0, Math.round(took[Math.floor(took.length / 2)] - elapsed))
  }

  private trim (): void {
    const done = this.jobs.filter(j => !active(j))
    if (done.length <= KEEP) return
    const drop = new Set(done.sort((a, b) => a.createdAt - b.createdAt).slice(0, done.length - KEEP))
    this.jobs = this.jobs.filter(j => !drop.has(j))
  }

  private async save (): Promise<void> {
    const write = async (): Promise<void> => { await writeJsonFile(this.file, { jobs: this.jobs }) }
    this.saving = this.saving.then(write, write)
    await this.saving
  }
}
