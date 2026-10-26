// Library browsing state: category, search, pagination.
import { api, type LibraryPage } from './api.ts'

const PAGE_SIZE = 24

class LibraryState {
  category = $state('')
  /** Only the clips made here (source custom), or every clip (''). */
  source = $state('')
  query = $state('')
  /** Skeleton the library is showing clips for ('human' or a creature template). */
  rig = $state('human')
  page = $state(0)
  data = $state<LibraryPage | null>(null)
  loading = $state(false)
  error = $state<string | null>(null)
  private token = 0
  private debounce: ReturnType<typeof setTimeout> | undefined

  async load (): Promise<void> {
    const token = ++this.token
    this.loading = true
    try {
      const data = await api.library({ category: this.category, q: this.query, page: this.page, size: PAGE_SIZE, rig: this.rig, source: this.source })
      if (token !== this.token) return
      this.data = data
      this.page = data.page
      this.error = null
    } catch (error) {
      if (token === this.token) this.error = (error as Error).message
    } finally {
      if (token === this.token) this.loading = false
    }
  }

  setCategory (category: string): void {
    this.category = category
    this.page = 0
    void this.load()
  }

  /** Show only the clips made here (or all again). */
  setSource (source: string): void {
    this.source = source
    this.page = 0
    void this.load()
  }

  /** Load the page again (a clip was saved). */
  reload (): void { void this.load() }

  setQuery (query: string): void {
    this.query = query
    this.page = 0
    clearTimeout(this.debounce)
    this.debounce = setTimeout(() => { void this.load() }, 180)
  }

  setRig (rig: string): void {
    if (rig === this.rig && this.data !== null) return
    this.rig = rig
    this.category = ''
    this.page = 0
    void this.load()
  }

  go (page: number): void {
    const pages = this.data?.pages ?? 1
    this.page = Math.max(0, Math.min(page, pages - 1))
    void this.load()
  }
}

export const library = new LibraryState()
