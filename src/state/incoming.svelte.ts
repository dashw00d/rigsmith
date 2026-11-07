import type { PackageView } from '../../server/incoming/read.ts'
import { api } from './api.ts'
import { app } from './app.svelte.ts'

class Incoming {
  packages = $state.raw<PackageView[]>([])
  pending = $state(0)
  error = $state<string | null>(null)
  loadedFor = $state<string | null>(null)
  busy = $state<string | null>(null)
  private turn = 0
  private source: EventSource | null = null

  start (): () => void {
    if (this.source !== null) return () => {}
    const source = new EventSource('/api/events?schema=2')
    this.source = source
    source.addEventListener('incoming', () => { void this.refresh() })
    source.addEventListener('hello', () => { void this.refresh() })
    void this.refresh()
    return () => { if (this.source === source) { source.close(); this.source = null; this.turn++ } }
  }
  async refresh (): Promise<void> {
    const turn = ++this.turn
    const character = app.selectedId
    try {
      const data = await api.incoming(character ?? undefined)
      if (turn !== this.turn || app.selectedId !== character) return
      this.packages = data.packages; this.pending = data.pending; this.error = null; this.loadedFor = character
    } catch (error) {
      if (turn === this.turn) this.error = error instanceof Error ? error.message : String(error)
    }
  }
  async change (action: 'accept' | 'reject' | 'restore', packageId: string, part: string): Promise<void> {
    if (this.busy !== null) return
    this.busy = `${packageId}/${part}`
    try {
      if (action === 'accept') {
        const character = app.selectedId
        if (character === null) throw new Error('Select a dynamic character first')
        if (this.loadedFor !== character) throw new Error('The Incoming list is still refreshing for this character')
        const job = await api.acceptIncoming({ package: packageId, parts: [part], character })
        const done = await app.jobDone(job.id)
        if (done.status !== 'done') throw new Error(done.error ?? done.message ?? 'Import did not finish')
        app.toast('ok', 'Incoming part accepted')
      } else if (action === 'reject') await api.rejectIncoming(packageId, [part])
      else await api.restoreIncoming(packageId, [part])
      await this.refresh()
    } catch (error) { app.toast('error', error instanceof Error ? error.message : String(error)); await this.refresh() }
    finally { this.busy = null }
  }
}
export const incoming = new Incoming()
