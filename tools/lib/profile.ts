// Timing scenarios on the real app in headless Chrome (tools/lib/chrome.ts): each scenario's action run in the page
// (through window.__rigsmith, set in dev by src/main.ts), the page left to settle, and the long tasks it caused read
// back from src/engine/perf.ts with the timing marks each one held. A click scenario fails on any task over the click
// budget, a load scenario on one over the load budget (tests/perf/budget.json; `npm run perf`, tools/perf.ts).
import { sleep, withChrome, type Page } from './chrome.ts'

/** One thing done in the page. `setup` and `action` are statements run in an async function with `r` (the app's
 * window.__rigsmith) and `c` (the character selected, as the app has it now) in scope. */
export interface Scenario {
  name: string
  /** 'load': the page opened afresh on the character (the action, if any, after); 'click': the action as a click. */
  kind: 'click' | 'load'
  setup?: string
  action?: string
  /** How many times the action runs (each measured on its own). */
  times?: number
}

export interface Budget { click: number, load: number }

interface Span { name: string, detail?: string, start: number, ms: number }
interface LongTask { start: number, ms: number, marks: string[] }

export interface Run { longTasks: LongTask[], wall: number, marks: Array<{ name: string, count: number, total: number, max: number }> }
export interface Result { name: string, kind: Scenario['kind'], budget: number, runs: Run[], worst: number, ok: boolean, error?: string }

const ready = `(() => { const r = window.__rigsmith; return r !== undefined && r.app.characters.length > 0 })()`
const settled = `(() => { const r = window.__rigsmith; return r !== undefined && !r.viewer.loading && r.app.busy === null })()`

const inPage = (body: string): string =>
  `(async () => { const r = window.__rigsmith; const c = r.app.selected; ${body}\n})()`

/** The marks of a run, summed by name (most time first). */
function summary (spans: Span[]): Run['marks'] {
  const by = new Map<string, { name: string, count: number, total: number, max: number }>()
  for (const s of spans) {
    const m = by.get(s.name) ?? { name: s.name, count: 0, total: 0, max: 0 }
    m.count++; m.total += s.ms; m.max = Math.max(m.max, s.ms)
    by.set(s.name, m)
  }
  return [...by.values()].sort((a, b) => b.total - a.total)
}

/** Wait until the page has nothing loading and no new long task for `quiet` ms (at most `timeout`). */
async function settle (page: Page, quiet = 600, timeout = 60_000): Promise<void> {
  await page.until(settled, timeout, 'the page settling')
  const started = Date.now()
  let seen = -1
  let since = Date.now()
  while (Date.now() - started < timeout) {
    const n = Number(await page.value('window.__rigsmith.perf.report().longTasks.length'))
    const busy = await page.value(settled) !== true
    if (n !== seen || busy) { seen = n; since = Date.now() }
    if (Date.now() - since >= quiet) return
    await sleep(100)
  }
}

async function measure (page: Page, action: string | undefined): Promise<Run> {
  await page.value('window.__rigsmith.perf.clear()')
  const t0 = Date.now()
  if (action !== undefined) await page.value(inPage(action))
  await settle(page)
  const wall = Date.now() - t0
  const report = await page.value('window.__rigsmith.perf.report()') as { spans: Span[], longTasks: LongTask[] }
  return { longTasks: report.longTasks, wall, marks: summary(report.spans) }
}

/** Run the scenarios on the app at `server` with `character` selected (null: whichever the app picks). */
export async function profile (server: string, scenarios: readonly Scenario[], budget: Budget,
  o: { character?: string | null, step?: string, log?: (line: string) => void } = {}): Promise<Result[]> {
  const log = o.log ?? (() => {})
  return await withChrome(async page => {
    const results: Result[] = []
    // (the page's own storage: the character and the step it opens on)
    const open = async (): Promise<void> => {
      await page.navigate(`${server}/`)
      await page.until('document.readyState === "complete"', 60_000, 'the page loading')
      await page.value(`(() => { localStorage.clear(); ${o.character != null ? `localStorage.setItem('rigsmith.selected', ${JSON.stringify(o.character)});` : ''} localStorage.setItem('rigsmith.step', ${JSON.stringify(o.step ?? 'gear')}) })()`)
      await page.navigate(`${server}/`)
      await page.until(ready, 120_000, 'the app starting')
    }
    for (const s of scenarios) {
      const limit = s.kind === 'load' ? budget.load : budget.click
      const result: Result = { name: s.name, kind: s.kind, budget: limit, runs: [], worst: 0, ok: true }
      try {
        log(`${s.name}...`)
        if (s.kind === 'load') {
          const t0 = Date.now()
          await open()
          await settle(page)
          const report = await page.value('window.__rigsmith.perf.report()') as { spans: Span[], longTasks: LongTask[] }
          result.runs.push({ longTasks: report.longTasks, wall: Date.now() - t0, marks: summary(report.spans) })
          if (s.action !== undefined) result.runs.push(await measure(page, s.action))
        } else {
          if (results.length === 0) { await open(); await settle(page) }
          if (s.setup !== undefined) { await page.value(inPage(s.setup)); await settle(page) }
          for (let i = 0; i < (s.times ?? 1); i++) result.runs.push(await measure(page, s.action))
        }
      } catch (error) {
        result.error = (error as Error).message
        result.ok = false
      }
      result.worst = Math.max(0, ...result.runs.flatMap(r => r.longTasks.map(t => t.ms)))
      if (result.worst > limit) result.ok = false
      results.push(result)
    }
    return results
  })
}

/** The results as lines: each scenario's worst task against its budget, and what the long tasks held. */
export function describe (results: readonly Result[]): string[] {
  const lines: string[] = []
  for (const r of results) {
    const walls = r.runs.map(x => x.wall)
    lines.push(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}: worst task ${r.worst.toFixed(0)} ms (budget ${r.budget}), ${r.runs.length} run${r.runs.length === 1 ? '' : 's'}` +
      (walls.length > 0 ? `, settled in ${Math.min(...walls)}-${Math.max(...walls)} ms` : '') + (r.error !== undefined ? `; ${r.error}` : ''))
    const tasks = r.runs.flatMap(x => x.longTasks).filter(t => t.ms > r.budget).sort((a, b) => b.ms - a.ms).slice(0, 5)
    for (const t of tasks) lines.push(`       ${t.ms.toFixed(0)} ms: ${t.marks.join(', ') || 'no marks'}`)
    const marks = summary(r.runs.flatMap(x => x.marks.map(m => ({ name: m.name, start: 0, ms: m.total })))).slice(0, 4)
    if (marks.length > 0) lines.push(`       marks: ${marks.map(m => `${m.name} ${m.total.toFixed(0)} ms`).join(', ')}`)
  }
  return lines
}
