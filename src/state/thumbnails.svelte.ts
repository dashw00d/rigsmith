// Keeps every character's list thumbnail present: renders missing ones offscreen, one at a time,
// whether or not the character has been opened.
import { ThumbnailRenderer } from '../engine/ThumbnailRenderer.ts'
import { api, fileUrl, type Character } from './api.ts'
import { app } from './app.svelte.ts'

class Thumbnails {
  private renderer: ThumbnailRenderer | null = null
  private readonly pending = new Set<string>()
  private readonly failed = new Set<string>()
  private running = false

  /** Queue every character whose model exists but has no thumbnail yet. */
  ensure (characters: Character[]): void {
    for (const c of characters) {
      const file = c.files.rigged ?? c.files.model
      if (c.files.thumbnail === undefined && file !== undefined && !this.failed.has(`${c.id}:${c.revision ?? 0}`)) this.pending.add(c.id)
    }
    void this.pump()
  }

  private async pump (): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.pending.size > 0) {
        const id = this.pending.values().next().value as string
        this.pending.delete(id)
        const c = app.characters.find(x => x.id === id)
        const file = c?.files.rigged ?? c?.files.model
        if (c === undefined || file === undefined || c.files.thumbnail !== undefined) continue
        try {
          this.renderer ??= new ThumbnailRenderer()
          const url = fileUrl(c, file)
          if (url === null) continue
          const blob = await this.renderer.render(url)
          app.upsert(await api.thumbnail(id, blob))
        } catch {
          // Cosmetic: don't retry until the character changes.
          this.failed.add(`${id}:${c.revision ?? 0}`)
        }
      }
    } finally {
      this.running = false
    }
  }
}

export const thumbnails = new Thumbnails()
