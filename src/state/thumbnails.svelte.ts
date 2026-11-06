// Keeps every character's list thumbnail present: renders missing ones offscreen (src/engine/ThumbnailRenderer.ts),
// one at a time, whether or not the character has been opened. The picture is of the file the viewer would show
// (src/app/status.ts shownFile). The server clears a thumbnail when that file changes, so a fresh one follows.
import { shownFile } from '../app/status.ts'
import { ThumbnailRenderer } from '../engine/ThumbnailRenderer.ts'
import { api, type Character } from './api.ts'
import { app } from './app.svelte.ts'
import { asset, assets } from './assets.svelte.ts'

class Thumbnails {
  private renderer: ThumbnailRenderer | null = null
  private readonly pending = new Set<string>()
  // (characters whose file failed to render, by id and the file's URL (its hash): tried again once the file changes)
  private readonly failed = new Set<string>()
  private running = false

  /** Queue every character whose model exists but has no thumbnail yet. */
  ensure (characters: readonly Character[]): void {
    for (const c of characters) {
      if (c.files.thumbnail === undefined && shownFile(c) !== undefined && !this.failed.has(`${c.id}:${this.urlOf(c)}`)) this.pending.add(c.id)
    }
    void this.pump()
  }

  /** The file it would picture, by its hash when its manifest is in (null: none). */
  private urlOf (c: Character): string | null {
    return assets.ready(c.id) ? asset(c, shownFile(c)) : null
  }

  private async pump (): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.pending.size > 0) {
        const id = this.pending.values().next().value as string
        this.pending.delete(id)
        const c = app.byId(id)
        if (c === null || c.files.thumbnail !== undefined) continue
        await assets.load(id)
        const url = asset(c, shownFile(c))
        if (url === null) continue
        try {
          this.renderer ??= new ThumbnailRenderer()
          const blob = await this.renderer.render(url)
          app.upsert(await api.thumbnail(id, blob))
        } catch {
          // (cosmetic: not tried again until the character's files change)
          this.failed.add(`${id}:${url}`)
        }
      }
    } finally {
      this.running = false
    }
  }
}

export const thumbnails = new Thumbnails()
