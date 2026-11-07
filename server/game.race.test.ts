// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'vitest'
const workspace = mkdtempSync(path.join(os.tmpdir(), 'rigsmith-game-race-'))
process.env.RIGSMITH_WORKSPACE = workspace
const game = await import('./game.ts')
afterAll(() => { rmSync(workspace, { recursive: true, force: true }) })

it('never reseeds and overwrites a malformed existing unit file', async () => {
  mkdirSync(path.dirname(game.UNITS_FILE), { recursive: true })
  writeFileSync(path.join(workspace, 'settings.json'), JSON.stringify({ gameRepo: path.join(workspace, 'fake-game') }))
  const broken = '{"units":{"saved":'
  writeFileSync(game.UNITS_FILE, broken)
  await expect(game.units()).rejects.toThrow()
  expect(readFileSync(game.UNITS_FILE, 'utf8')).toBe(broken)
})
