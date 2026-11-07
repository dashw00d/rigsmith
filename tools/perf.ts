// npm run perf: the app's dev server started on a workspace (RIGSMITH_WORKSPACE, required: the run may write
// thumbnails into it, so point it at a copy), tests/perf/scenarios.ts run in headless Chrome (tools/lib/profile.ts), and
// each scenario's longest main-thread task held to tests/perf/budget.json. Exits 1 when one is over.
//   node tools/perf.ts [--character=<id>] [--only=<name part>] [--out=<report.json>]
// The character defaults to the first dynamic one (with outfits), else the first.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const kv = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || 'true'] }))

async function main (): Promise<number> {
  if (process.env.RIGSMITH_WORKSPACE === undefined) {
    console.error('perf: set RIGSMITH_WORKSPACE to a workspace copy (the run may write thumbnails into it)')
    return 2
  }
  const { createServer } = await import('vite')
  const { profile, describe } = await import('./lib/profile.ts')
  const { scenarios } = await import('../tests/perf/scenarios.ts')
  const budget = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'perf', 'budget.json'), 'utf8')) as { click: number, load: number }
  const server = await createServer({ configFile: path.join(ROOT, 'vite.config.ts'), server: { port: 5190, strictPort: false, open: false }, logLevel: 'warn' })
  try {
    await server.listen()
    const url = (server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5190/').replace(/\/$/, '')
    const only = typeof kv.only === 'string' ? kv.only.toLowerCase() : null
    const chosen = scenarios.filter(s => only === null || s.name.toLowerCase().includes(only))
    console.log(`perf: ${chosen.length} scenario${chosen.length === 1 ? '' : 's'} at ${url}`)
    const { character, results } = await profile(url, chosen, budget, {
      ...(typeof kv.character === 'string' ? { character: kv.character } : {}), log: line => { console.log(`  ${line}`) },
    })
    for (const line of describe(results)) console.log(line)
    if (typeof kv.out === 'string') writeFileSync(kv.out, JSON.stringify({ at: new Date().toISOString(), character, budget, results }, null, 1))
    return results.every(r => r.ok) ? 0 : 1
  } finally {
    await server.close()
  }
}

process.exitCode = await main()
