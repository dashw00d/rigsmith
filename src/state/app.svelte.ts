// Global app state (Svelte 5 runes): one instance, imported where needed (DESIGN.md §4.3). The characters, the
// selection and the step are read here and changed only through do(), go() and select(): every change to a character
// is a command the server journals, and leaving a step or a character asks whoever registered a guard (an editor with
// unsaved work) first.
import { untrack } from 'svelte'
import { applyCommands } from '../model/commands.ts'
import { api, MODEL_FILE, type Character, type Command, type Job, type JournalEntry, type Settings } from './api.ts'
import { assets, type FilesChanged } from './assets.svelte.ts'
import { mark } from '../engine/perf.ts'
import { push, receive, settle, shown, type Track } from './pending.ts'

export type Step = 'import' | 'skeleton' | 'skin' | 'gear' | 'look' | 'motion' | 'ship'

export const STEPS: Array<{ id: Step, label: string, hint: string }> = [
  { id: 'import', label: 'Import', hint: 'Bring in models' },
  { id: 'skeleton', label: 'Skeleton', hint: 'Joints and markers' },
  { id: 'skin', label: 'Skin', hint: 'Weights and checks' },
  { id: 'gear', label: 'Gear', hint: 'What it wears and holds' },
  { id: 'look', label: 'Look', hint: 'Texture' },
  { id: 'motion', label: 'Motion', hint: 'Clips for the game' },
  { id: 'ship', label: 'Ship', hint: 'Export to the game' },
]

// (the step ids before the rebuild, as a browser may still have one stored)
const OLD_STEPS: Record<string, Step> = { rig: 'skeleton', outfit: 'gear', texture: 'look', animate: 'motion', export: 'ship' }

/** A step id, old or new, as a step (Import when unknown). */
export function stepOf (id: string | null | undefined): Step {
  if (id === null || id === undefined) return 'import'
  return STEPS.some(s => s.id === id) ? id as Step : OLD_STEPS[id] ?? 'import'
}

export type Drawer = 'library' | 'wardrobe' | 'incoming' | 'activity'
// (the step a drawer belongs to: it closes on leaving it; the activity drawer goes with every step)
const DRAWER_STEP: Partial<Record<Drawer, Step>> = { library: 'motion', wardrobe: 'gear' }

export interface Toast { id: number, kind: 'info' | 'ok' | 'error', text: string, action?: ToastAction }
/** A button on a toast (Undo what was just done for you). */
export interface ToastAction { label: string, run: () => void }
export interface ConfirmOptions { title: string, body?: string, confirm?: string, cancel?: string, danger?: boolean }
export interface Navigation { step?: Step, characterId?: string | null }
/** Asked before the step or the character changes; false (or a promise of it) keeps them as they are. */
export type Guard = (next: Navigation) => boolean | Promise<boolean>

const finished = (job: Job): boolean => job.status === 'done' || job.status === 'failed' || job.status === 'cancelled'
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
// (a cid only has to be told apart from this page's others and other pages')
const SESSION = Math.random().toString(16).slice(2, 10)

function remembered (key: string): string | null {
  try { return localStorage.getItem(`rigsmith.${key}`) } catch { return null }
}

function remember (key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(`rigsmith.${key}`)
    else localStorage.setItem(`rigsmith.${key}`, value)
  } catch { /* storage unavailable: nothing to remember */ }
}

class AppState {
  // (raw: a character is replaced whole by each copy, never changed in place, so it needn't be a deep proxy)
  private characters_ = $state.raw<Character[]>([])
  private selected_ = $state<string | null>(remembered('selected') || null)
  private step_ = $state<Step>(stepOf(remembered('step')))
  private confirms = $state.raw<Array<ConfirmOptions & { answer: (ok: boolean) => void }>>([])
  private busyTexts = $state.raw<Array<[string, string]>>([])

  /** Every character as this page shows it: the server's copy with this page's unanswered commands on top. Never
   * change one in place: use do(). */
  get characters (): readonly Character[] { return this.characters_ }
  get selectedId (): string | null { return this.selected_ }
  get step (): Step { return this.step_ }
  /** The question waiting for an answer (ConfirmDialog shows it). */
  get confirming (): (ConfirmOptions & { answer: (ok: boolean) => void }) | null { return this.confirms[0] ?? null }

  jobs = $state.raw<Job[]>([])
  toasts = $state.raw<Toast[]>([])
  settings = $state<Settings | null>(null)
  connected = $state(false)
  /** Bumped when any journal gains an entry (a write or a note): the activity drawer reads the journal again. */
  journalBeat = $state(0)
  /** Bumped when the game units change or an export finishes. */
  gameBeat = $state(0)
  drawer = $state<Drawer | null>(null)

  selected = $derived(this.characters_.find(c => c.id === this.selected_) ?? null)
  activeJobs = $derived(this.jobs.filter(j => !finished(j)))
  /** The viewport's one busy pill: the newest of what is working. */
  busy = $derived(this.busyTexts.at(-1)?.[1] ?? null)

  private tracks = new Map<string, Track<Character, Command>>()
  /** Per character, what tells its edits apart (not undos, not notes): the newest such entry seen and the batches this
   * page sent. */
  private edits = new Map<string, { seq: number, sent: number }>()
  private sending = new Map<string, Promise<unknown>>()
  private cids = 0
  private guards = new Set<Guard>()
  private navigation = 0
  private waiters = new Map<string, Array<(job: Job) => void>>()
  private source: EventSource | null = null
  private helloes = 0
  private toastId = 0

  async start (): Promise<void> {
    // (listening first: a change made while the list loads arrives as an event and the older list copy is ignored)
    this.listen()
    // (the selected character's files and the clip library's beside the list: its model loads by them at once)
    const selected = untrack(() => this.selected_)
    if (selected !== null) void assets.load(selected)
    void assets.loadLibrary()
    const [characters, settings] = await Promise.all([api.characters(), api.settings()])
    this.settings = settings
    this.load(characters)
    if (!this.characters_.some(c => c.id === this.selected_)) this.setSelected(this.characters_[0]?.id ?? null)
  }

  byId (id: string | null | undefined): Character | null {
    return this.characters_.find(c => c.id === id) ?? null
  }

  // ---- characters ----------------------------------------------------------------------------------------------

  /**
   * Change a character: the commands show at once and go to the server as one batch (one journal entry, one undo,
   * all or nothing); the server's copy then replaces this page's. Resolves to the journal entry, or null when the
   * server refused (the reason is toasted and the change taken back). One character's commands are sent one after
   * another, in the order given.
   */
  async do (id: string, command: Command | Command[], what?: string): Promise<JournalEntry | null> {
    const commands = Array.isArray(command) ? command : [command]
    const t = this.tracks.get(id)
    if (t === undefined || commands.length === 0) return null
    const cid = `${SESSION}-${++this.cids}`
    this.put(id, push(t, { cid, commands }))
    this.marked(id).sent++
    return await this.inTurn(id, async () => {
      try {
        const { character, entry } = await api.command(id, commands, cid, what)
        this.take(character, cid)
        this.edited(id, entry)
        return entry
      } catch (error) {
        const now = this.tracks.get(id)
        if (now !== undefined) this.put(id, settle(now, cid))
        this.toast('error', reason(error))
        return null
      }
    })
  }

  /** Take back a journal entry (default: the newest that can be); a redo names the undo's seq. Null when refused
   * (later changes touched the same things: the reason is toasted). */
  async undo (id: string, seq?: number): Promise<JournalEntry | null> {
    return await this.inTurn(id, async () => {
      try {
        const { character, entry } = await api.undo(id, seq)
        this.take(character, entry?.cid)
        return entry
      } catch (error) {
        this.toast('error', `Not undone: ${reason(error)}`)
        return null
      }
    })
  }

  /** A server copy of a character (a route's reply), with the entry that made it if any. A copy older than the one
   * held is ignored. */
  upsert (character: Character, entry?: JournalEntry | null): void {
    this.take(character, entry?.cid)
    this.edited(character.id, entry)
  }

  /** Changes whenever the character is edited (here or anywhere: a command, a job's change; not an undo or a note), so
   * whoever keeps undos to redo can tell something was done since (and redo nothing). */
  editMark (id: string): string {
    const e = this.edits.get(id)
    return e === undefined ? '' : `${e.seq}/${e.sent}`
  }

  private marked (id: string): { seq: number, sent: number } {
    let e = this.edits.get(id)
    if (e === undefined) { e = { seq: 0, sent: 0 }; this.edits.set(id, e) }
    return e
  }

  /** A journal entry seen (a reply, the server's event; the same one may come both ways): an edit moves the mark. */
  private edited (id: string, entry: JournalEntry | null | undefined): void {
    if (entry === null || entry === undefined || entry.undoes !== undefined || entry.note === true) return
    const e = this.marked(id)
    if (entry.seq > e.seq) e.seq = entry.seq
  }

  async importFiles (files: File[]): Promise<void> {
    const accepted = files.filter(f => MODEL_FILE.test(f.name))
    if (accepted.length < files.length) this.toast('error', 'Skipped files that are not FBX, GLB, OBJ, DAE or ZIP')
    for (const file of accepted) {
      try {
        const character = await api.upload(file)
        this.upsert(character)
        if (this.selected_ === null) this.setSelected(character.id)
      } catch (error) {
        this.toast('error', `${file.name}: ${reason(error)}`)
      }
    }
  }

  /** Delete a character (it goes to workspace/trash). Throws the server's refusal: an ApiError, 409 with `riders`,
   * `units` and `busy` while something depends on it, unless forced. */
  async remove (id: string, force = false): Promise<void> {
    await api.remove(id, force)
    this.forget(id)
  }

  /** Start rigging a character; null when the server refused (toasted). */
  async rig (id: string): Promise<Job | null> {
    try {
      const job = await api.rig(id)
      this.updateJob(job)
      return job
    } catch (error) {
      this.toast('error', reason(error))
      return null
    }
  }

  private take (character: Character, cid?: string): void {
    const t = this.tracks.get(character.id)
    const next = receive(t, character, cid)
    if (next !== t) this.put(character.id, next)
  }

  private put (id: string, t: Track<Character, Command>): void {
    const done = mark('app.put', id)
    try { this.putNow(id, t) } finally { done() }
  }

  private putNow (id: string, t: Track<Character, Command>): void {
    this.tracks.set(id, t)
    const shows = shown(t, (c, commands) => applyCommands($state.snapshot(c) as Character, commands).character)
    const list = untrack(() => this.characters_)
    const i = list.findIndex(c => c.id === id)
    if (i >= 0 && list[i] === shows) return
    this.characters_ = i >= 0 ? list.with(i, shows) : [...list, shows]
  }

  /** Drop a character that no longer exists (deleted here or elsewhere); never leave it selected. */
  private forget (id: string): void {
    this.tracks.delete(id)
    const list = untrack(() => this.characters_).filter(c => c.id !== id)
    this.characters_ = list
    if (untrack(() => this.selected_) === id) this.setSelected(list[0]?.id ?? null)
  }

  /** Every character as the server has it now (at start, and after the connection comes back). */
  private load (list: Character[]): void {
    const ids = new Set(list.map(c => c.id))
    for (const id of [...this.tracks.keys()]) if (!ids.has(id)) this.forget(id)
    for (const c of list) this.take(c)
  }

  /** Run `fn` after the character's earlier requests have been answered (so the server applies them in order). */
  private async inTurn<T> (id: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.sending.get(id) ?? Promise.resolve()).then(fn, fn)
    this.sending.set(id, run)
    const clear = (): void => { if (this.sending.get(id) === run) this.sending.delete(id) }
    run.then(clear, clear)
    return await run
  }

  // ---- navigation ----------------------------------------------------------------------------------------------

  /** Register a guard; returns its removal. */
  guard (fn: Guard): () => void {
    this.guards.add(fn)
    return () => { this.guards.delete(fn) }
  }

  /** Go to a step once every guard agrees; false when one didn't. */
  async go (step: Step): Promise<boolean> {
    if (step === untrack(() => this.step_)) return true
    if (!await this.allowed({ step })) return false
    this.setStep(step)
    return true
  }

  /** Select a character once every guard agrees; false when one didn't. */
  async select (id: string | null): Promise<boolean> {
    if (id === untrack(() => this.selected_)) return true
    if (!await this.allowed({ characterId: id })) return false
    this.setSelected(id)
    return true
  }

  toggleDrawer (drawer: Drawer): void {
    this.drawer = untrack(() => this.drawer) === drawer ? null : drawer
  }

  private async allowed (next: Navigation): Promise<boolean> {
    const ticket = ++this.navigation
    for (const guard of [...this.guards]) {
      let ok = true
      // (a guard that breaks doesn't hold the user in place)
      try { ok = await guard(next) } catch (error) { console.error('A navigation guard failed', error) }
      if (!ok) return false
    }
    // (a later navigation asked meanwhile: that one decides)
    return ticket === this.navigation
  }

  private setStep (step: Step): void {
    this.step_ = step
    remember('step', step)
    const drawer = untrack(() => this.drawer)
    if (drawer !== null && DRAWER_STEP[drawer] !== undefined && DRAWER_STEP[drawer] !== step) this.drawer = null
  }

  private setSelected (id: string | null): void {
    if (id !== null) void assets.load(id)
    this.selected_ = id
    remember('selected', id)
  }

  // ---- feedback ------------------------------------------------------------------------------------------------

  toast (kind: Toast['kind'], text: string, ms = kind === 'error' ? 8000 : 5000, action?: ToastAction): void {
    const id = ++this.toastId
    this.toasts = [...untrack(() => this.toasts), { id, kind, text, ...(action !== undefined ? { action } : {}) }]
    setTimeout(() => { this.dismiss(id) }, ms)
  }

  dismiss (id: number): void {
    this.toasts = untrack(() => this.toasts).filter(t => t.id !== id)
  }

  /** Ask before something that can't easily be taken back. Questions asked together are shown one at a time. */
  async confirm (o: ConfirmOptions): Promise<boolean> {
    return await new Promise<boolean>(resolve => { this.confirms = [...untrack(() => this.confirms), { ...o, answer: resolve }] })
  }

  /** The answer to the question showing (ConfirmDialog calls it). */
  answer (ok: boolean): void {
    const [head, ...rest] = untrack(() => this.confirms)
    if (head === undefined) return
    this.confirms = rest
    head.answer(ok)
  }

  /** Say what is working under `key` in the viewport's busy pill (null: done). */
  setBusy (key: string, text: string | null): void {
    const rest = untrack(() => this.busyTexts).filter(([k]) => k !== key)
    this.busyTexts = text === null ? rest : [...rest, [key, text]]
  }

  // ---- jobs and settings ---------------------------------------------------------------------------------------

  jobFor (characterId: string): Job | undefined {
    return this.jobs.find(j => j.characterId === characterId && !finished(j))
  }

  async cancelJob (id: string): Promise<void> {
    try {
      this.updateJob(await api.cancelJob(id))
    } catch (error) {
      this.toast('error', `Not cancelled: ${reason(error)}`)
    }
  }

  /** Resolves once the job is done, failed or cancelled. */
  async jobDone (id: string): Promise<Job> {
    const job = untrack(() => this.jobs).find(j => j.id === id)
    if (job !== undefined && finished(job)) return job
    return await new Promise<Job>(resolve => { this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]) })
  }

  async saveSettings (patch: Partial<Settings>): Promise<void> {
    this.settings = await api.saveSettings(patch)
  }

  private updateJob (job: Job): void {
    const list = untrack(() => this.jobs)
    const i = list.findIndex(j => j.id === job.id)
    if (job.status === 'failed' && list[i]?.status !== 'failed') this.toast('error', `${job.label} failed: ${job.error ?? 'unknown error'}`)
    this.jobs = i >= 0 ? list.with(i, job) : [job, ...list]
    if (finished(job)) this.wake(job)
  }

  private wake (job: Job): void {
    const waiting = this.waiters.get(job.id)
    this.waiters.delete(job.id)
    for (const resolve of waiting ?? []) resolve(job)
  }

  // ---- the server's events -------------------------------------------------------------------------------------

  private listen (): void {
    if (this.source !== null) return
    const source = new EventSource('/api/events?schema=2')
    this.source = source
    const data = <T>(e: Event): T => JSON.parse((e as MessageEvent<string>).data) as T
    source.addEventListener('hello', (e) => {
      const jobs = data<Job[]>(e)
      this.connected = true
      this.jobs = jobs
      for (const id of [...this.waiters.keys()]) {
        const job = jobs.find(j => j.id === id)
        // (a job the server no longer knows was lost with a restart)
        if (job === undefined) this.wake({ id, kind: '', label: '', status: 'failed', progress: 0, message: '', createdAt: 0, error: 'The server restarted' })
        else if (finished(job)) this.wake(job)
      }
      // (back after a drop: whatever changed meanwhile came with no event)
      if (this.helloes++ > 0) {
        void api.characters().then(list => { this.load(list) }, () => { /* gone again: the next hello retries */ })
        assets.reloadAll()
      }
    })
    source.addEventListener('job', (e) => { this.updateJob(data<Job>(e)) })
    source.addEventListener('character', (e) => {
      const { character, entry } = data<{ character: Character, entry?: JournalEntry | null }>(e)
      this.upsert(character, entry)
      if (entry !== undefined && entry !== null) this.journalBeat++
    })
    source.addEventListener('journal', () => { this.journalBeat++ })
    source.addEventListener('game', () => { this.gameBeat++ })
    source.addEventListener('removed', (e) => { const id = data<string>(e); this.forget(id); assets.forget(id) })
    // (before the character event that names them: the store tells the files a write made first)
    source.addEventListener('files', (e) => { assets.receive(data<FilesChanged>(e)) })
    source.onerror = () => { this.connected = false }
  }
}

export const app = new AppState()
