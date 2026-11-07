// Timing scenarios on the real app in headless Chrome (tools/lib/chrome.ts): each scenario's action run in the page
// (through window.__rigsmith, set in dev by src/main.ts), the page left to settle, and the long tasks it caused read
// back from src/engine/perf.ts with the timing marks each one held. A click scenario fails on any task over the click
// budget, a load scenario on one over the load budget (tests/perf/budget.json; `npm run perf`, tools/perf.ts).
import { writeFileSync } from 'node:fs'
import path from 'node:path'
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

export interface Run { longTasks: LongTask[], wall: number, marks: Array<{ name: string, count: number, total: number, max: number }>, hot?: Hot[] }
/** A function's own time in a CPU profile (no callees), most first. */
export interface Hot { fn: string, ms: number }

interface CpuNode { id: number, callFrame: { functionName: string, url: string, lineNumber: number }, children?: number[] }
interface CpuProfile { nodes: CpuNode[], samples: number[], timeDeltas: number[] }

/** The functions that took the most of a CPU profile's time themselves. */
export function hottest (p: CpuProfile, n = 12): Hot[] {
  const by = new Map<number, CpuNode>(p.nodes.map(x => [x.id, x]))
  const own = new Map<string, number>()
  for (let i = 0; i < p.samples.length; i++) {
    const node = by.get(p.samples[i])
    if (node === undefined) continue
    const f = node.callFrame
    if (f.functionName === '(idle)' || f.functionName === '(program)') continue
    const where = f.url === '' ? '' : ` ${f.url.replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '')}:${f.lineNumber + 1}`
    const key = `${f.functionName || '(anonymous)'}${where}`
    own.set(key, (own.get(key) ?? 0) + (p.timeDeltas[i] ?? 0) / 1000)
  }
  return [...own].sort((a, b) => b[1] - a[1]).slice(0, n).map(([fn, ms]) => ({ fn, ms: Math.round(ms) }))
}
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

/** A CPU profile of the page started (with `cpu`), and the function that stops it, saving it as `<cpu>/<name>.cpuprofile`
 * and answering its hottest functions. */
async function profiling (page: Page, cpu: string | undefined, name: string): Promise<() => Promise<Hot[] | undefined>> {
  if (cpu === undefined) return async () => undefined
  await page.send('Profiler.enable')
  await page.send('Profiler.setSamplingInterval', { interval: 250 })
  await page.send('Profiler.start')
  return async () => {
    const r = await page.send('Profiler.stop') as { result?: { profile?: CpuProfile } }
    const p = r.result?.profile
    if (p === undefined) return undefined
    writeFileSync(path.join(cpu, `${name.replace(/[^\w.-]+/g, '_')}.cpuprofile`), JSON.stringify(p))
    return hottest(p)
  }
}

async function measure (page: Page, action: string | undefined, cpu?: string, name = 'run'): Promise<Run> {
  await page.value('window.__rigsmith.perf.clear()')
  const stop = await profiling(page, cpu, name)
  const t0 = Date.now()
  if (action !== undefined) await page.value(inPage(action))
  await settle(page)
  const wall = Date.now() - t0
  const hot = await stop()
  const report = await page.value('window.__rigsmith.perf.report()') as { spans: Span[], longTasks: LongTask[] }
  return { longTasks: report.longTasks, wall, marks: summary(report.spans), ...(hot !== undefined ? { hot } : {}) }
}

/** Run the scenarios on the app at `server` with `character` selected (left out: the first dynamic character, with
 * outfits, else the first). Answers the results and the character they ran on. */
export async function profile (server: string, scenarios: readonly Scenario[], budget: Budget,
  o: { character?: string, step?: string, log?: (line: string) => void, cpu?: string } = {}): Promise<{ character: string | null, results: Result[] }> {
  const log = o.log ?? (() => {})
  let character = o.character ?? null
  return await withChrome(async page => {
    const results: Result[] = []
    // (the page's own storage: the character and the step it opens on)
    const open = async (cpu?: string): Promise<(() => Promise<Hot[] | undefined>) | null> => {
      await page.navigate(`${server}/`)
      await page.until('document.readyState === "complete"', 60_000, 'the page loading')
      await page.value(`(() => { localStorage.clear(); ${character !== null ? `localStorage.setItem('rigsmith.selected', ${JSON.stringify(character)});` : ''} localStorage.setItem('rigsmith.step', ${JSON.stringify(o.step ?? 'gear')}) })()`)
      const stop = cpu === undefined ? null : await profiling(page, cpu, 'first load')
      await page.navigate(`${server}/`)
      await page.until(ready, 120_000, 'the app starting')
      if (character === null) {
        character = await page.value(inPage(`const folk = r.app.characters.find(x => x.gear.some(g => g.outfit !== undefined)) ?? r.app.characters[0]
          await r.app.select(folk.id); return folk.id`)) as string
        log(`on ${character}`)
      }
      return stop
    }
    for (const s of scenarios) {
      const limit = s.kind === 'load' ? budget.load : budget.click
      const result: Result = { name: s.name, kind: s.kind, budget: limit, runs: [], worst: 0, ok: true }
      try {
        log(`${s.name}...`)
        if (s.kind === 'load') {
          const t0 = Date.now()
          const stop = await open(o.cpu)
          await settle(page)
          const hot = await stop?.()
          const report = await page.value('window.__rigsmith.perf.report()') as { spans: Span[], longTasks: LongTask[] }
          result.runs.push({ longTasks: report.longTasks, wall: Date.now() - t0, marks: summary(report.spans), ...(hot !== undefined ? { hot } : {}) })
          if (s.action !== undefined) result.runs.push(await measure(page, s.action, o.cpu, `${s.name} action`))
        } else {
          if (results.length === 0) { await open(); await settle(page) }
          if (s.setup !== undefined) { await page.value(inPage(s.setup)); await settle(page) }
          for (let i = 0; i < (s.times ?? 1); i++) result.runs.push(await measure(page, s.action, o.cpu, `${s.name} ${i + 1}`))
        }
      } catch (error) {
        result.error = (error as Error).message
        result.ok = false
      }
      result.worst = Math.max(0, ...result.runs.flatMap(r => r.longTasks.map(t => t.ms)))
      if (result.worst > limit) result.ok = false
      results.push(result)
    }
    return { character, results }
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
    const hot = new Map<string, number>()
    for (const h of r.runs.flatMap(x => x.hot ?? [])) hot.set(h.fn, (hot.get(h.fn) ?? 0) + h.ms)
    if (hot.size > 0) lines.push(`       cpu: ${[...hot].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([fn, ms]) => `${fn} ${ms} ms`).join('; ')}`)
  }
  return lines
}
