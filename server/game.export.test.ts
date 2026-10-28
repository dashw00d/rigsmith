// @vitest-environment node
// The export into the game against a temp workspace and a fake game repo whose build.sh does what it is told: a good
// build is trusted only with this run's record and a new model; a failed, untrusted or cancelled one puts the game's
// units.json back byte for byte; each outcome is kept and journaled on the character.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeRigged, makeSlot } from '../src/model/fixtures.ts'
import type { UnitSpec } from '../src/model/unit.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'rigsmith-export-'))
const workspace = path.join(dir, 'workspace')
const repo = path.join(dir, 'game')
process.env.RIGSMITH_WORKSPACE = workspace // read when store.ts is first imported
let game: typeof import('./game.ts')

const ID = 'tester-000001'
const UNIT: UnitSpec = { character: ID, height: 2, budget: 8000, clips: ['Idle'], draft: true }
const gameUnits = path.join(repo, 'tools', 'rigsmith', 'units.json')
const GAME_TEXT = '{\n "units": {\n  "other": {\n   "character": "x",\n   "height": 2,\n   "budget": 8000,\n   "clips": ["Idle"]\n  }\n }\n}\n'

// (what the fake build does is read from tools/rigsmith/mode)
const BUILD = `#!/bin/sh
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
mode=$(cat "$ROOT/tools/rigsmith/mode")
case "$mode" in
  ok)
    mkdir -p "$ROOT/.work/rigsmith/$1" "$ROOT/assets/models/units"
    printf '{"schema":2,"unit":"%s","run":"%s","walkStride":1.234,"runStride":2.5,"warnings":["no blow timing"]}' "$1" "$RIGSMITH_RUN" > "$ROOT/.work/rigsmith/$1/rigsmith.json"
    : > "$ROOT/assets/models/units/$1.glb"
    echo "warning: $1: no blow timing"
    echo "{\\"unit\\":\\"$1\\",\\"walkStride\\":1.234}"
    echo "HOLDS $1 Attack Weapons_RightHand FAIL sinks 0.04"
    ;;
  stale)
    mkdir -p "$ROOT/.work/rigsmith/$1"
    printf '{"schema":2,"unit":"%s","run":"an-older-run"}' "$1" > "$ROOT/.work/rigsmith/$1/rigsmith.json"
    ;;
  fail)
    echo "Traceback (most recent call last):"
    exit 3
    ;;
  hang)
    sleep 30
    ;;
esac
`

const mode = (m: string): void => { writeFileSync(path.join(repo, 'tools', 'rigsmith', 'mode'), m) }
const options = (signal = new AbortController().signal): Parameters<typeof game.exportUnits>[1] => ({ by: 'test', job: 'job-1', signal, update: () => {} })
const journal = (): Array<{ what: string, changes: string[] }> => {
  const file = path.join(workspace, 'characters', ID, 'journal.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { what: string, changes: string[] }) : []
}
const kept = (unit: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(workspace, 'game', 'builds', `${unit}.json`), 'utf8')) as Record<string, unknown>
const backup = path.join(workspace, 'game', 'export-backup.json')

beforeAll(async () => {
  mkdirSync(path.join(repo, 'tools', 'rigsmith'), { recursive: true })
  writeFileSync(gameUnits, GAME_TEXT)
  writeFileSync(path.join(repo, 'tools', 'rigsmith', 'build.sh'), BUILD)
  chmodSync(path.join(repo, 'tools', 'rigsmith', 'build.sh'), 0o755)
  mkdirSync(path.join(workspace, 'characters', ID), { recursive: true })
  mkdirSync(path.join(workspace, 'game'), { recursive: true })
  writeFileSync(path.join(workspace, 'settings.json'), JSON.stringify({ gameRepo: repo }))
  writeFileSync(path.join(workspace, 'characters', ID, 'character.json'), JSON.stringify(makeRigged({ id: ID, clips: [makeSlot()] })))
  writeFileSync(path.join(workspace, 'game', 'units.json'), JSON.stringify({ units: { tester: UNIT } }))
  game = await import('./game.ts')
})
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

describe('the export into the game', () => {
  it('refuses a unit whose clips its character lacks before touching the game', async () => {
    await game.updateUnits(s => { s.units.tester = { ...UNIT, clips: ['Idle', 'Run'] } })
    await expect(game.exportUnits(['tester'], options())).rejects.toThrow(/no clip named Run/)
    expect(readFileSync(gameUnits, 'utf8')).toBe(GAME_TEXT)
    expect(existsSync(backup)).toBe(false)
    await game.updateUnits(s => { s.units.tester = UNIT })
  })

  it("puts the game's units.json back when the build fails", async () => {
    mode('fail')
    await expect(game.exportUnits(['tester'], options())).rejects.toThrow(/exit 3.*back as it was/)
    expect(readFileSync(gameUnits, 'utf8')).toBe(GAME_TEXT)
    expect(existsSync(backup)).toBe(false)
    expect(kept('tester')).toMatchObject({ status: 'failed', restored: true })
    expect(journal().at(-1)).toMatchObject({ what: 'export' })
    expect(journal().at(-1)!.changes[0]).toContain("units.json is back as it was")
    // (still a draft here: it never reached the game)
    expect((await game.units()).units.tester.draft).toBe(true)
  })

  it('trusts a build only with this run\'s record', async () => {
    mode('stale')
    await expect(game.exportUnits(['tester'], options())).rejects.toThrow(/no record of this run/)
    expect(readFileSync(gameUnits, 'utf8')).toBe(GAME_TEXT)
  })

  it('takes a cancel as a failure: the build killed, the file back', async () => {
    mode('hang')
    const control = new AbortController()
    const run = game.exportUnits(['tester'], options(control.signal))
    setTimeout(() => { control.abort(new Error('Cancelled')) }, 300)
    const started = Date.now()
    await expect(run).rejects.toThrow(/Cancelled/)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(readFileSync(gameUnits, 'utf8')).toBe(GAME_TEXT)
    expect(kept('tester')).toMatchObject({ status: 'cancelled', restored: true })
  })

  it('exports a good build: the entry in the game, no longer a draft, its strides, holds and warnings kept', async () => {
    mode('ok')
    const [b] = await game.exportUnits(['tester'], options())
    expect(b).toMatchObject({ unit: 'tester', status: 'done', walkStride: 1.234, runStride: 2.5 })
    expect(b.holdsFailed).toEqual(['HOLDS tester Attack Weapons_RightHand FAIL sinks 0.04'])
    expect(b.warnings).toEqual(['no blow timing'])
    const text = readFileSync(gameUnits, 'utf8')
    expect(text.startsWith(GAME_TEXT.slice(0, GAME_TEXT.indexOf('\n }')))).toBe(true)
    const shipped = (JSON.parse(text) as { units: Record<string, UnitSpec> }).units.tester
    expect(shipped).toEqual({ character: ID, height: 2, budget: 8000, clips: ['Idle'] })
    expect((await game.units()).units.tester.draft).toBeUndefined()
    expect(existsSync(backup)).toBe(false)
    expect(journal().at(-1)!.changes[0]).toBe('exported to the game as tester (walk 1.234, run 2.5; 1 holds failed; 1 warning)')
    const view = await game.unitBuild('tester')
    expect(view.last?.status).toBe('done')
    expect(view.record?.run).toBe(view.last?.run)
    expect(view.glb?.file).toBe(path.join('assets', 'models', 'units', 'tester.glb'))
  })
})
