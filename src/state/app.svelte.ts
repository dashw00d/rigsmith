// Global app state (Svelte 5 runes). One instance, imported where needed.
import { api, type Character, type Job, type Settings } from './api.ts'

export type Step = 'import' | 'rig' | 'outfit' | 'texture' | 'animate' | 'export'

export const STEPS: Array<{ id: Step, label: string, hint: string }> = [
  { id: 'import', label: 'Import', hint: 'Bring in models' },
  { id: 'rig', label: 'Rig', hint: 'Skeleton and weights' },
  { id: 'outfit', label: 'Outfit', hint: 'Clothes, accessories, props' },
  { id: 'texture', label: 'Texture', hint: 'Project new paint' },
  { id: 'animate', label: 'Animate', hint: 'Pick animations' },
  { id: 'export', label: 'Export', hint: 'Ship to Godot' },
]

export interface Toast { id: number, kind: 'info' | 'ok' | 'error', text: string }

function remembered<T extends string> (key: string, fallback: T): T {
  try { return (localStorage.getItem(`rigsmith.${key}`) as T | null) ?? fallback } catch { return fallback }
}

function remember (key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(`rigsmith.${key}`)
    else localStorage.setItem(`rigsmith.${key}`, value)
  } catch { /* storage unavailable: nothing to remember */ }
}

class AppState {
  characters = $state<Character[]>([])
  private selected_ = $state<string | null>(remembered<string>('selected', '') || null)
  private step_ = $state<Step>(remembered<Step>('step', 'import'))

  get selectedId (): string | null { return this.selected_ }
  set selectedId (id: string | null) { this.selected_ = id; remember('selected', id) }
  get step (): Step { return this.step_ }
  set step (step: Step) { this.step_ = step; remember('step', step) }
  jobs = $state<Job[]>([])
  toasts = $state<Toast[]>([])
  settings = $state<Settings | null>(null)
  connected = $state(false)
  /** Bumped when a character's journal gains a note (its changes come with the character itself). */
  journalBeat = $state(0)

  selected = $derived(this.characters.find(c => c.id === this.selectedId) ?? null)
  activeJobs = $derived(this.jobs.filter(j => j.status === 'queued' || j.status === 'running'))

  private toastId = 0

  async start (): Promise<void> {
    this.characters = await api.characters()
    this.settings = await api.settings()
    if (!this.characters.some(c => c.id === this.selectedId)) this.selectedId = this.characters[0]?.id ?? null
    this.listen()
  }

  private listen (): void {
    const source = new EventSource('/api/events')
    source.addEventListener('hello', (e) => {
      this.connected = true
      this.jobs = JSON.parse((e as MessageEvent).data) as Job[]
    })
    source.addEventListener('job', (e) => {
      const job = JSON.parse((e as MessageEvent).data) as Job
      const index = this.jobs.findIndex(j => j.id === job.id)
      if (index >= 0) this.jobs[index] = job
      else this.jobs = [job, ...this.jobs]
      if (job.status === 'failed') this.toast('error', `${job.label} failed: ${job.error ?? 'unknown error'}`)
    })
    source.addEventListener('character', (e) => { this.upsert(JSON.parse((e as MessageEvent).data) as Character) })
    source.addEventListener('journal', () => { this.journalBeat++ })
    source.addEventListener('removed', (e) => { this.forget(JSON.parse((e as MessageEvent).data) as string) })
    source.onerror = () => { this.connected = false }
  }

  upsert (character: Character): void {
    const index = this.characters.findIndex(c => c.id === character.id)
    if (index >= 0) this.characters[index] = character
    else this.characters = [...this.characters, character]
  }

  jobFor (characterId: string): Job | undefined {
    return this.jobs.find(j => j.characterId === characterId && (j.status === 'queued' || j.status === 'running'))
  }

  async importFiles (files: File[]): Promise<void> {
    const accepted = files.filter(f => /\.(fbx|glb|gltf|obj|dae|zip)$/i.test(f.name))
    if (accepted.length < files.length) this.toast('error', 'Skipped files that are not FBX, GLB, OBJ, DAE or ZIP')
    for (const file of accepted) {
      try {
        const character = await api.upload(file)
        this.upsert(character)
        this.selectedId ??= character.id
      } catch (error) {
        this.toast('error', `${file.name}: ${(error as Error).message}`)
      }
    }
  }

  async update (id: string, patch: Partial<Character>): Promise<void> {
    const local = this.characters.find(c => c.id === id)
    if (local !== undefined) Object.assign(local, patch)
    this.upsert(await api.update(id, patch))
  }

  async remove (id: string): Promise<void> {
    await api.remove(id)
    this.forget(id)
  }

  /** Drop a character that no longer exists (deleted here or elsewhere); never leave it selected. */
  forget (id: string): void {
    this.characters = this.characters.filter(c => c.id !== id)
    if (this.selectedId === id) this.selectedId = this.characters[0]?.id ?? null
  }

  async rig (id: string): Promise<void> {
    try {
      await api.rig(id)
      const c = this.characters.find(x => x.id === id)
      if (c !== undefined) c.status = 'rigging'
    } catch (error) {
      this.toast('error', (error as Error).message)
    }
  }

  async saveSettings (patch: Partial<Settings>): Promise<void> {
    this.settings = await api.saveSettings(patch)
  }

  toast (kind: Toast['kind'], text: string, ms = 5000): void {
    const id = ++this.toastId
    this.toasts = [...this.toasts, { id, kind, text }]
    setTimeout(() => { this.toasts = this.toasts.filter(t => t.id !== id) }, ms)
  }
}

export const app = new AppState()
