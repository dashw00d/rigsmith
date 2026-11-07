// The Forge board's state (docs/dressing-plan.md Phase 4): open or not (a top-bar mode beside the steps: it is about a
// set, not a character), the board as the server has it (GET /api/forge), each running job's live progress, ETA and
// log tail and the GPU lane (SSE on /api/forge/events), the set shown and the card the keyboard is on. Every write
// goes through api.ts's call; after one, and when a job ends, the board is read again.
import type { ForgeEvent, ForgePipeline, ForgeView, QueueJob, SetView } from '../../server/forge/types.ts'
import type { GpuState, Job } from '../../server/jobs.ts'
import { type Focus, moved, moveFocus } from '../app/forge/board.ts'
import { call } from './api.ts'
import { app } from './app.svelte.ts'

export type { ForgeEvent, ForgePipeline, ForgeView, QueueJob, SetView }
export type Board = ForgeView & { gpu: GpuState, problems?: string[] }

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const enc = encodeURIComponent

class ForgeState {
  open = $state(false)
  board = $state.raw<Board | null>(null)
  loading = $state(false)
  error = $state<string | null>(null)
  /** Each job's last event (progress, ETA, log tail), by job id. */
  live = $state.raw<Record<string, ForgeEvent>>({})
  gpu = $state.raw<GpuState | null>(null)
  setId = $state<string | null>(null)
  focus = $state<Focus | null>(null)
  queueOpen = $state(false)
  /** The job whose log is shown. */
  logJob = $state<string | null>(null)
  private source: EventSource | null = null
  private reloadTimer: ReturnType<typeof setTimeout> | null = null

  get set (): SetView | null {
    const sets = this.board?.sets ?? []
    return sets.find(s => s.id === this.setId) ?? sets.at(-1) ?? null
  }

  get pipeline (): ForgePipeline | null {
    const set = this.set
    return set === null ? null : this.board?.config?.pipelines[set.pipeline] ?? null
  }

  /** The queue's jobs for one card. */
  jobsFor (item: string, stage: string): QueueJob[] {
    const set = this.set
    return (this.board?.queue ?? []).filter(j => j.set === set?.id && j.item === item && j.stage === stage)
  }

  toggle (): void {
    this.open = !this.open
    if (this.open) { void this.load(); this.connect() } else this.disconnect()
  }

  async load (): Promise<void> {
    this.loading = true
    try {
      const board = await call<Board>('GET', '/api/forge')
      this.board = board
      this.gpu = board.gpu
      this.error = board.config === null ? (board.error ?? 'The game has no Forge') : null
      if (this.setId === null || !board.sets.some(s => s.id === this.setId)) this.setId = board.sets.at(-1)?.id ?? null
    } catch (error) {
      this.error = reason(error)
    } finally {
      this.loading = false
    }
  }

  /** Read the board again soon (several jobs ending at once read it once). */
  private reloadSoon (): void {
    if (this.reloadTimer !== null) return
    this.reloadTimer = setTimeout(() => { this.reloadTimer = null; void this.load() }, 300)
  }

  private connect (): void {
    if (this.source !== null) return
    const source = new EventSource('/api/forge/events')
    source.addEventListener('forge', (e: MessageEvent<string>) => {
      const event = JSON.parse(e.data) as ForgeEvent
      const before = this.live[event.job.id]?.job.status
      this.live = { ...this.live, [event.job.id]: event }
      const board = this.board
      if (board !== null) {
        const queue = board.queue.some(j => j.id === event.job.id) ? board.queue.map(j => (j.id === event.job.id ? event.job : j)) : [...board.queue, event.job]
        this.board = { ...board, queue }
      }
      if (before !== event.job.status && event.job.status !== 'running' && event.job.status !== 'queued') this.reloadSoon()
    })
    source.addEventListener('gpu', (e: MessageEvent<string>) => { this.gpu = JSON.parse(e.data) as GpuState })
    this.source = source
  }

  private disconnect (): void {
    this.source?.close()
    this.source = null
  }

  private async write<T> (method: string, url: string, body?: object, done?: string): Promise<T | null> {
    try {
      const out = await call<T>(method, url, body)
      if (done !== undefined) app.toast('ok', done)
      this.reloadSoon()
      return out
    } catch (error) {
      app.toast('error', reason(error))
      return null
    }
  }

  async createSet (name: string, pipeline: string, items: Array<{ name: string, spec?: Record<string, unknown> }> = []): Promise<void> {
    const set = await this.write<SetView>('POST', '/api/forge/sets', { name, pipeline, items })
    if (set !== null) this.setId = set.id
  }

  async addItem (name: string, spec: Record<string, unknown> = {}): Promise<void> {
    const set = this.set
    if (set !== null) await this.write('POST', `/api/forge/sets/${enc(set.id)}/items`, { name, spec })
  }

  async run (item: string, stage: string, o: { variants?: number, through?: string, params?: Record<string, unknown> } = {}): Promise<void> {
    const set = this.set
    if (set !== null) await this.write('POST', `/api/forge/sets/${enc(set.id)}/items/${enc(item)}/run`, { stage, ...o })
  }

  /** The stage for every item of the set (a batch: through to the first gate). */
  async runAll (stage: string, through = 'gate'): Promise<void> {
    const set = this.set
    if (set !== null) await this.write('POST', `/api/forge/sets/${enc(set.id)}/run`, { stage, through }, `Queued ${stage} for ${set.items.length} items`)
  }

  async pick (item: string, stage: string, attempt: string): Promise<void> {
    const set = this.set
    if (set !== null) await this.write('POST', `/api/forge/sets/${enc(set.id)}/items/${enc(item)}/pick`, { stage, attempt })
  }

  async approve (item: string, stage: string, attempt?: string): Promise<void> {
    const set = this.set
    if (set !== null) await this.write('POST', `/api/forge/sets/${enc(set.id)}/items/${enc(item)}/approve`, { stage, ...(attempt !== undefined ? { attempt } : {}) })
  }

  async publish (items?: string[]): Promise<void> {
    const set = this.set
    if (set !== null) await this.write<Job>('POST', `/api/forge/sets/${enc(set.id)}/publish`, items !== undefined ? { items } : {}, `Publishing ${set.name}: Activity shows it`)
  }

  async cancel (id: string): Promise<void> { await this.write('POST', `/api/forge/queue/${enc(id)}/cancel`) }

  /** Move a queued job up (-1) or down (+1) in the line. */
  async nudge (id: string, by: number): Promise<void> {
    await this.write('POST', '/api/forge/queue/reorder', { ids: moved(this.board?.queue ?? [], id, by) })
  }

  /** An attempt's file (its out/ path, or log.txt / manifest.json). */
  fileUrl (item: string, stage: string, attempt: string, rel: string): string {
    const set = this.set
    const file = rel === 'log.txt' || rel === 'manifest.json' ? rel : `out/${rel.split('/').map(enc).join('/')}`
    return `/files/forge/${enc(set?.id ?? '')}/${enc(item)}/${enc(stage)}/${enc(attempt)}/${file}`
  }

  // ---- the keyboard: J/K items, H/L (or arrows) stages, 1-4 pick, R run, A approve ----------------------------------

  move (dItem: number, dStage: number): void {
    this.focus = moveFocus(this.focus, this.set?.items.length ?? 0, this.pipeline?.stages.length ?? 0, dItem, dStage)
  }

  private focused (): { item: string, stage: string } | null {
    const f = this.focus
    const set = this.set, pipeline = this.pipeline
    if (f === null || set === null || pipeline === null) return null
    const item = set.items[f.item], stage = pipeline.stages[f.stage]
    return item === undefined || stage === undefined ? null : { item: item.id, stage: stage.id }
  }

  async pickNth (n: number): Promise<void> {
    const at = this.focused()
    if (at === null) return
    const view = this.set?.items.find(i => i.id === at.item)?.stages.find(s => s.id === at.stage)
    const done = view?.attempts.filter(a => a.status === 'done') ?? []
    const a = done[n - 1]
    if (a !== undefined) await this.pick(at.item, at.stage, a.id)
  }

  async runFocused (): Promise<void> {
    const at = this.focused()
    if (at !== null) await this.run(at.item, at.stage)
  }

  async approveFocused (): Promise<void> {
    const at = this.focused()
    if (at !== null) await this.approve(at.item, at.stage)
  }
}

export const forge = new ForgeState()
