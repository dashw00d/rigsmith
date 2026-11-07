// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeWorkspace } from './e2e_workspace.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture (): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rigsmith-e2e-test-')); dirs.push(root)
  for (const [id, folk] of [['folk', true], ['base', false], ['extra', false]] as const) {
    mkdirSync(path.join(root, 'characters', id), { recursive: true })
    writeFileSync(path.join(root, 'characters', id, 'character.json'), JSON.stringify({ id, ...(folk ? { folk: {} } : {}) }))
  }
  mkdirSync(path.join(root, 'library', 'clips'), { recursive: true })
  mkdirSync(path.join(root, 'library', 'sources'), { recursive: true })
  writeFileSync(path.join(root, 'library', 'clips', 'walk.glb'), 'clip')
  writeFileSync(path.join(root, 'library', 'sources', 'secret'), 'source')
  writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ gameRepo: '/real/game' }))
  return root
}
describe('e2e workspace', () => {
  it('copies the two selected characters, excludes sources and hard-links the library', () => {
    const src = fixture(); const ws = makeWorkspace(src); dirs.push(ws.dir)
    expect(ws.characters).toEqual(['folk', 'base'])
    const srcClip = path.join(src, 'library/clips/walk.glb'); const dstClip = path.join(ws.dir, 'library/clips/walk.glb')
    expect(statSync(srcClip).ino).toBe(statSync(dstClip).ino)
    expect(() => statSync(path.join(ws.dir, 'library/sources'))).toThrow()
    expect(JSON.parse(readFileSync(path.join(ws.dir, 'settings.json'), 'utf8')).gameRepo).toBe(path.join(ws.dir, 'game-repo'))
    writeFileSync(path.join(ws.dir, 'characters/folk/character.json'), 'changed')
    expect(readFileSync(path.join(src, 'characters/folk/character.json'), 'utf8')).not.toBe('changed')
    expect(() => ws.verify()).not.toThrow()
    ws.cleanup()
  })
  it('allows atomic replacement in the copy without changing its source', () => {
    const src = fixture(); const ws = makeWorkspace(src); dirs.push(ws.dir)
    const dest = path.join(ws.dir, 'library/clips/walk.glb')
    writeFileSync(`${dest}.tmp`, 'replacement')
    renameSync(`${dest}.tmp`, dest)
    expect(readFileSync(path.join(src, 'library/clips/walk.glb'), 'utf8')).toBe('clip')
    expect(() => ws.verify()).not.toThrow()
  })
  it('refuses symlinks in copied trees', () => {
    const src = fixture()
    symlinkSync('/outside', path.join(src, 'characters/folk/link'))
    expect(() => makeWorkspace(src)).toThrow(/refuses symlink/)
  })
  it('detects an in-place library write and rejects unsafe or missing character ids', () => {
    const src = fixture(); const ws = makeWorkspace(src, 'extra'); dirs.push(ws.dir)
    writeFileSync(path.join(ws.dir, 'library/clips/walk.glb'), 'changed')
    expect(() => ws.verify()).toThrow(/Source library changed/)
    expect(() => makeWorkspace(src, '../folk')).toThrow(/Unknown E2E character/)
  })
})

it('keeps Incoming data and settings inside each scenario workspace', () => {
  const src = fixture()
  mkdirSync(path.join(src, 'incoming', 'delivery'), { recursive: true })
  writeFileSync(path.join(src, 'incoming', 'delivery', 'manifest.json'), '{}')
  writeFileSync(path.join(src, 'incoming-state.json'), '{"delivery/part":{"status":"rejected"}}')
  writeFileSync(path.join(src, 'settings.json'), JSON.stringify({ gameRepo: '/real/game', incomingDir: '/real/incoming' }))
  const ws = makeWorkspace(src); dirs.push(ws.dir)
  const settings = JSON.parse(readFileSync(path.join(ws.dir, 'settings.json'), 'utf8'))
  expect(settings.incomingDir).toBe(path.join(ws.dir, 'incoming'))
  expect(readFileSync(path.join(ws.dir, 'incoming', 'delivery', 'manifest.json'), 'utf8')).toBe('{}')
  expect(readFileSync(path.join(ws.dir, 'incoming-state.json'), 'utf8')).toContain('rejected')
})
