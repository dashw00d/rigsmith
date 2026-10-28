// The clip library's search (server/library.ts): GET /api/library?q=&category=&source=&rig=&page=&size=. Clips only;
// which of a character's slots play a clip is the character's own business (and the editor's usage route).
import { route, send } from '../http.ts'
import { queryLibrary } from '../library.ts'

route('GET', /^\/api\/library$/, async (req, res, _, url) => {
  const text = (k: string): string | undefined => url.searchParams.get(k) ?? undefined
  const whole = (k: string, fallback: number): number => {
    const n = Number(url.searchParams.get(k) ?? fallback)
    return Number.isFinite(n) ? Math.floor(n) : fallback
  }
  send(res, 200, await queryLibrary({
    category: text('category'),
    query: text('q'),
    source: text('source'),
    rig: text('rig'),
    page: whole('page', 0),
    pageSize: whole('size', 24),
  }))
})
