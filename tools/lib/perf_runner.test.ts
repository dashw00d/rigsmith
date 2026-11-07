// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The runner must not let Vite write its bundled config or cache through the shared node_modules link.
describe('perf runner isolation', () => {
  it('selects an isolated cache and a free, non-reserved port', () => {
    const source = readFileSync(new URL('../perf.ts', import.meta.url), 'utf8')
    expect(source).toContain("configLoader: 'runner'")
    expect(source).toContain("cacheDir: path.join(ROOT, '.work'")
    expect(source).toContain('await freePort()')
    expect(source).not.toContain('port: 5190')
  })
})
