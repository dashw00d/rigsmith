// Browsing the clip library (server/library.ts): the rig it shows clips for, the filters (category, source, search)
// and the page. Another rig starts from no filters: a category or a search of one rig's clips means nothing for another.
import { untrack } from 'svelte'
import { app } from './app.svelte.ts'
import { api, call, type LibraryPage } from './api.ts'
import type { LibraryIndexRow } from '../../server/library.ts'
import { defaultView, viewOf, type ViewState } from '../app/motion/libraryView.ts'

const PAGE_SIZE = 24
const SEARCH_AFTER = 180

class LibraryState {
  category = $state('')
  /** Only the clips made here (source custom), or every clip (''). */
  source = $state('')
  query = $state('')
  /** The skeleton it shows clips for: 'human' or a creature template. */
  rig = $state('human')
  page = $state(0)
  data = $state.raw<LibraryPage | null>(null)
  loading = $state(false)
  error = $state<string | null>(null)
  index = $state.raw<LibraryIndexRow[]>([])
  uses = $state.raw<Record<string, number>>({})
  options = $state<ViewState>(readPreferences())
  get rows () { return viewOf(this.index, this.uses, { ...this.options, query: this.query, rig: this.rig }) }

  setViewOptions (change: Partial<ViewState>): void {
    this.options = { ...this.options, ...change }
    try { localStorage.setItem('rigsmith.library.view', JSON.stringify({ view: this.options.view, sort: this.options.sort, direction: this.options.direction, group: this.options.group })) } catch { /* storage unavailable */ }
  }
  async refreshIndex (): Promise<void> {
    this.index = await call<LibraryIndexRow[]>('GET', '/api/library/index')
  }
  private usesToken = 0
  async refreshUses (): Promise<void> {
    const token = ++this.usesToken
    const uses = await call<Record<string, number>>('GET', '/api/library/uses')
    if (token === this.usesToken) this.uses = uses
  }
  constructor () {
    $effect.root(() => {
      $effect(() => {
        if (app.drawer !== 'library') return
        untrack(() => { void this.refreshIndex().catch(error => { this.error = String(error) }) })
      })
      $effect(() => {
        if (app.drawer !== 'library') return
        void app.journalBeat
        untrack(() => { void this.refreshUses().catch(error => { this.error = String(error) }) })
      })
    })
  }
  private token = 0
  private debounce: ReturnType<typeof setTimeout> | undefined

  /** Some filter narrows what shows. */
  get filtered (): boolean { return this.category !== '' || this.source !== '' || this.query.trim() !== '' }

  async load (): Promise<void> {
    clearTimeout(this.debounce)
    const token = ++this.token
    this.loading = true
    try {
      const data = await api.library({ category: this.category, q: this.query, page: this.page, size: PAGE_SIZE, rig: this.rig, source: this.source })
      if (token !== this.token) return
      this.data = data
      this.page = data.page
      this.error = null
    } catch (error) {
      if (token === this.token) this.error = error instanceof Error ? error.message : String(error)
    } finally {
      if (token === this.token) this.loading = false
    }
  }

  setCategory (category: string): void {
    this.category = category
    this.page = 0
    void this.load()
  }

  /** Only the clips made here (or all again). */
  setSource (source: string): void {
    this.source = source
    this.page = 0
    void this.load()
  }

  /** The page again (a clip was saved). */
  reload (): void { void this.load() }

  setQuery (query: string): void {
    this.query = query
    this.page = 0
    clearTimeout(this.debounce)
    // (a stale answer is dropped by the token; this only spares the server one request per key)
    this.debounce = setTimeout(() => { void this.load() }, SEARCH_AFTER)
  }

  resetFilters (): void {
    this.query = ''
    this.category = ''
    this.source = ''
    this.page = 0
    void this.load()
  }

  /** Show another rig's clips, from no filters (loads the first time even for the same rig). */
  setRig (rig: string): void {
    if (rig === this.rig && this.data !== null) return
    this.rig = rig
    this.resetFilters()
  }

  go (page: number): void {
    const pages = this.data?.pages ?? 1
    this.page = Math.max(0, Math.min(page, pages - 1))
    void this.load()
  }
}

function readPreferences (): ViewState {
  const defaults = defaultView()
  try {
    const saved = JSON.parse(localStorage.getItem('rigsmith.library.view') ?? '{}') as Partial<ViewState>
    if (saved.view === 'grid' || saved.view === 'list') defaults.view = saved.view
    if (saved.sort && ['name', 'length', 'recent', 'used'].includes(saved.sort)) defaults.sort = saved.sort
    if (saved.direction === 'asc' || saved.direction === 'desc') defaults.direction = saved.direction
    if (saved.group && ['none', 'category', 'source'].includes(saved.group)) defaults.group = saved.group
  } catch { /* storage unavailable or malformed */ }
  return defaults
}
export const library = new LibraryState()
