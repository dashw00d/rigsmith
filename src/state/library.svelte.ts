// Browsing the clip library (server/library.ts): the rig it shows clips for, the filters (category, source, search)
// and the page. Another rig starts from no filters: a category or a search of one rig's clips means nothing for another.
import { api, type LibraryPage } from './api.ts'

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

export const library = new LibraryState()
