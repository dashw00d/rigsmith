// Isolated, fresh-page UI scenarios. Run `npm run e2e -- --only=part [--keep]` with RIGSMITH_WORKSPACE set.
import { readdirSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeWorkspace } from './lib/e2e_workspace.ts'
import { withChrome } from './lib/chrome.ts'
import { UI, type Scenario } from '../tests/e2e/ui.ts'

const root = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const only = args.find(a => a.startsWith('--only='))?.slice('--only='.length).toLowerCase()
const keep = args.includes('--keep')
const shots = path.join(root, '.work', 'e2e', new Date().toISOString().replace(/[:.]/g, '-') + `-${process.pid}`)
const prohibited = new Set([5180, 5181, 5190])

async function freePort (): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr === null || typeof addr === 'string') { server.close(); reject(new Error('Cannot obtain free port')); return }
        server.close(error => { if (error !== undefined) reject(error); else resolve(addr.port) })
      })
    })
    if (!prohibited.has(port)) return port
  }
}

async function deadline<T> (promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error(`${what} timed out after ${ms / 1000} s`)) }, ms) })]) } finally { clearTimeout(timer) }
}

async function main (): Promise<number> {
  const source = process.env.RIGSMITH_WORKSPACE
  if (source === undefined) throw new Error('Set RIGSMITH_WORKSPACE to a workspace copy')
  const workspace = makeWorkspace(source, process.env.E2E_CHARACTERS)
  const oldWorkspace = process.env.RIGSMITH_WORKSPACE
  process.env.RIGSMITH_WORKSPACE = workspace.dir
  let exit = 0
  let server: Awaited<ReturnType<typeof import('vite')['createServer']>> | undefined
  const started = Date.now()
  try {
    const files = readdirSync(path.join(root, 'tests/e2e')).filter(f => f.endsWith('.scenario.ts')).sort()
    const scenarios: Scenario[] = []
    for (const file of files) {
      const module = await import(pathToFileURL(path.join(root, 'tests/e2e', file)).href) as { default: Scenario }
      if (module.default?.name === undefined || typeof module.default.run !== 'function') throw new Error(`Invalid scenario: ${file}`)
      if (only === undefined || module.default.name.toLowerCase().includes(only) || file.toLowerCase().includes(only)) scenarios.push(module.default)
    }
    if (scenarios.length === 0) throw new Error(`No scenarios match ${only ?? '(all)'}`)
    const { createServer } = await import('vite')
    const port = await freePort()
    server = await createServer({ configLoader: 'runner', configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(root, '.work', 'e2e-vite-cache'), server: { host: '127.0.0.1', port, strictPort: true, open: false }, logLevel: 'warn' })
    await server.listen()
    const url = `http://127.0.0.1:${port}/`
    console.log(`e2e: ${scenarios.length} scenarios at ${url}; workspace ${workspace.dir}; shots ${shots}`)
    for (const scenario of scenarios) {
      const begin = Date.now()
      const remaining = 600_000 - (begin - started)
      if (remaining <= 0) { console.error('FAIL total: timed out after 600 s'); exit = 1; break }
      try {
        await withChrome(async page => {
          await deadline((async () => {
            await page.setViewport(1280, 800)
            const character = scenario.character ?? workspace.characters[0]
            if (!workspace.characters.includes(character)) throw new Error(`Scenario character ${character} not copied; add it to E2E_CHARACTERS`)
            const step = scenario.step ?? 'gear'
            if (!['import', 'skeleton', 'skin', 'gear', 'look', 'motion', 'ship'].includes(step)) throw new Error(`Unknown scenario step ${step}`)
            // (fresh storage once per scenario: a reload inside it keeps what the page saved, so persistence can be tested)
            await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `if (sessionStorage.getItem('e2e.fresh') === null) { sessionStorage.setItem('e2e.fresh', '1'); localStorage.clear(); localStorage.setItem('rigsmith.selected', ${JSON.stringify(character)}); localStorage.setItem('rigsmith.step', ${JSON.stringify(step)}); }` })
            await page.navigate(url)
            await page.until(`(() => { const r = window.__rigsmith; return r !== undefined && r.app.selectedId === ${JSON.stringify(character)} && r.app.selected !== null && r.app.step === ${JSON.stringify(step)} && !r.viewer.loading && (r.viewer.shownId === ${JSON.stringify(character)} || (r.app.selected.files.model === undefined && r.app.selected.files.rigged === undefined)) && r.app.busy === null })()`, 75_000, 'selected character loading')
            const ui = new UI(page, shots, scenario.name)
            await scenario.run(ui)
            // Allow immediate event-handler errors and unhandled rejections to reach CDP before deciding the result.
            await new Promise(resolve => setTimeout(resolve, 200))
            if (page.errors.length > 0 && scenario.allowErrors !== true) throw new Error(`Browser errors:\n${page.errors.join('\n')}`)
          })(), Math.min(90_000, remaining), scenario.name).catch(error => {
            const log = page.console.length === 0 ? '(no browser console messages)' : page.console.join('\n')
            throw new Error(`${(error as Error).message}\nBrowser console:\n${log}`)
          })
        })
        console.log(`ok ${scenario.name} (${Date.now() - begin} ms)`)
      } catch (error) {
        exit = 1
        console.error(`FAIL ${scenario.name} (${Date.now() - begin} ms): ${(error as Error).message}`)
      }
    }
  } finally {
    try { await server?.close() } catch (error) { console.error(`FAIL server cleanup: ${(error as Error).message}`); exit = 1 }
    try { workspace.verify() } catch (error) { console.error(`FAIL workspace guard: ${(error as Error).message}`); exit = 1 }
    if (keep) console.log(`e2e: kept workspace ${workspace.dir}`)
    else workspace.cleanup()
    process.env.RIGSMITH_WORKSPACE = oldWorkspace
  }
  return exit
}

// Vite's workspace watchers outlive server.close. Exit only after the cleanup above has run.
try { process.exit(await main()) } catch (error) { console.error(`FAIL e2e: ${(error as Error).stack ?? String(error)}`); process.exit(1) }
