// Every character's files by what they hold (docs/dressing-plan.md Phase 0): the server's manifest per character
// (path inside its folder -> content hash, GET /api/characters/:id/files) and the clip library's, kept current by the
// SSE `files` event (app.svelte.ts hands it over). `asset(c, path)` is a file's URL with its hash, so whatever loads it
// (and every cache keyed by that URL) gets the new bytes the moment they change on disk, from a job, a tool or a
// paint program, and never re-downloads what didn't change. Reactive per character: an effect that asked for a
// character's file runs again when that character's files change.
import { SvelteMap } from 'svelte/reactivity'
import { characterFileUrl, parseFilesUrl, setAssetResolver, withHash } from '../engine/assetUrls.ts'
import { call } from './api.ts'

export type Manifest = Readonly<Record<string, string>>
/** The server's `files` event. */
export interface FilesChanged { character: string | null, changed: Record<string, string | null> }

const encodeId = encodeURIComponent

class Assets {
  /** Per character, the manifest as last heard (replaced whole on a change, so readers of one character's files run
   * again only for that character). */
  private readonly manifests = new SvelteMap<string, Manifest>()
  private readonly loading = new Map<string, Promise<void>>()
  /** The clip library's (not reactive: clips are looked up as they load; `libraryBeat` says when it changed). */
  private library: Record<string, string> | null = null
  private libraryLoading: Promise<void> | null = null
  /** Bumped when a library file changes. */
  libraryBeat = $state(0)
  /** Every character's list picture's hash (GET /api/thumbnails), for characters whose manifest isn't in. */
  private readonly thumbs = new SvelteMap<string, string>()
  private thumbsLoading: Promise<void> | null = null

  constructor () {
    setAssetResolver(url => this.versioned(url))
  }

  /** A character's file's URL with its content hash (null: no file). Before its manifest is in (it is asked for
   * then), or for a file it doesn't list yet, the URL has none: the server sends that one fresh every time. */
  asset (c: { id: string } | string, file: string | undefined | null): string | null {
    if (file === undefined || file === null || file === '') return null
    const id = typeof c === 'string' ? c : c.id
    const m = this.manifests.get(id)
    if (m === undefined) void this.load(id)
    return characterFileUrl(id, file, m?.[file])
  }

  /** A character's list picture (`file`: its files.thumbnail) by its hash, without asking for its whole manifest. */
  thumbnail (c: { id: string, files: { thumbnail?: string } }): string | null {
    const file = c.files.thumbnail
    if (file === undefined) return null
    const m = this.manifests.get(c.id)
    if (m !== undefined) return characterFileUrl(c.id, file, m[file])
    if (this.thumbsLoading === null && this.thumbs.size === 0) void this.loadThumbnails()
    return characterFileUrl(c.id, file, this.thumbs.get(c.id))
  }

  async loadThumbnails (): Promise<void> {
    this.thumbsLoading ??= call<Record<string, string>>('GET', '/api/thumbnails')
      .then(all => { for (const [id, hash] of Object.entries(all)) this.thumbs.set(id, hash) })
      .catch((error: unknown) => { console.error('assets: the thumbnails\' hashes didn\'t load', error) })
    await this.thumbsLoading
  }

  /** The character's manifest (reactive), undefined until it is in. */
  manifestOf (id: string): Manifest | undefined {
    return this.manifests.get(id)
  }

  /** Whether the character's manifest is in (reactive). */
  ready (id: string): boolean {
    return this.manifests.has(id)
  }

  /** The character's manifest asked for (once; again with `fresh`). */
  async load (id: string, fresh = false): Promise<void> {
    if (!fresh && this.manifests.has(id)) return
    let pending = this.loading.get(id)
    if (pending === undefined || fresh) {
      pending = call<Record<string, string>>('GET', `/api/characters/${encodeId(id)}/files`)
        .then(m => { this.manifests.set(id, m) })
        .catch((error: unknown) => { console.error(`assets: ${id}'s files didn't load`, error) })
        .finally(() => { if (this.loading.get(id) === pending) this.loading.delete(id) })
      this.loading.set(id, pending)
    }
    await pending
  }

  /** The library's clip hashes asked for (once). */
  async loadLibrary (): Promise<void> {
    if (this.library !== null) return
    this.libraryLoading ??= call<Record<string, string>>('GET', '/api/library/files')
      .then(m => { this.library = m; this.libraryBeat++ })
      .catch((error: unknown) => { console.error('assets: the library\'s files didn\'t load', error) })
      .finally(() => { this.libraryLoading = null })
    await this.libraryLoading
  }

  /** A '/files/...' URL with its hash, when known (src/engine/assetUrls.ts versioned). */
  versioned (url: string): string {
    const at = parseFilesUrl(url)
    if (at === null) return url
    if (at.character === null) {
      if (this.library === null) void this.loadLibrary()
      return withHash(url, this.library?.[at.file])
    }
    const m = this.manifests.get(at.character)
    if (m === undefined) void this.load(at.character)
    return withHash(url, m?.[at.file])
  }

  /** The server's `files` event. */
  receive (e: FilesChanged): void {
    if (e.character === null) {
      if (this.library === null) return
      for (const [file, hash] of Object.entries(e.changed)) {
        if (hash === null) delete this.library[file]
        else this.library[file] = hash
      }
      this.libraryBeat++
      return
    }
    const thumb = e.changed['thumbnail.webp']
    if (thumb !== undefined) { if (thumb === null) this.thumbs.delete(e.character); else this.thumbs.set(e.character, thumb) }
    const m = this.manifests.get(e.character)
    // (not asked for yet: it comes whole when it is)
    if (m === undefined) return
    const next: Record<string, string> = { ...m }
    let changed = false
    for (const [file, hash] of Object.entries(e.changed)) {
      if (hash === null) { if (file in next) { delete next[file]; changed = true } } else if (next[file] !== hash) { next[file] = hash; changed = true }
    }
    if (changed) this.manifests.set(e.character, next)
  }

  /** A character gone. */
  forget (id: string): void {
    this.manifests.delete(id)
    this.thumbs.delete(id)
  }

  /** Back after a drop: every manifest asked for again (whatever changed meanwhile came with no event). */
  reloadAll (): void {
    for (const id of [...this.manifests.keys()]) void this.load(id, true)
    this.thumbsLoading = null
    void this.loadThumbnails()
    if (this.library !== null) {
      this.library = null
      void this.loadLibrary()
    }
  }
}

export const assets = new Assets()

/** A character's file's URL with its content hash (assets.asset). */
export function asset (c: { id: string } | string, file: string | undefined | null): string | null {
  return assets.asset(c, file)
}
