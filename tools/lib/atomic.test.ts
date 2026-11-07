// @vitest-environment node
// A build's files written whole and only when they change (tools/lib/atomic.ts): the same bytes leave the file (and
// its mtime) alone, new ones replace it through a rename, a copy does the same, and no temp file is left behind.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { copyIfChanged, writeIfChanged } from './atomic.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'rigsmith-atomic-'))
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

describe('writeIfChanged', () => {
  it('writes a new file, leaves the same bytes alone, replaces changed ones', () => {
    const f = path.join(dir, 'unit.glb')
    expect(writeIfChanged(f, 'one')).toBe(true)
    utimesSync(f, new Date(2000, 0, 1), new Date(2000, 0, 1))
    const before = statSync(f)
    expect(writeIfChanged(f, Buffer.from('one'))).toBe(false)
    expect(statSync(f).mtimeMs).toBe(before.mtimeMs)
    expect(writeIfChanged(f, 'two')).toBe(true)
    expect(readFileSync(f, 'utf8')).toBe('two')
    // (renamed over: a new inode, so a reader that had the old one open keeps reading it whole)
    expect(statSync(f).ino).not.toBe(before.ino)
    expect(readdirSync(dir).filter(n => n.endsWith('.tmp'))).toEqual([])
  })

  it('copies the same way', () => {
    const a = path.join(dir, 'skin.png')
    const b = path.join(dir, 'copy.png')
    writeFileSync(a, 'pixels')
    expect(copyIfChanged(a, b)).toBe(true)
    expect(copyIfChanged(a, b)).toBe(false)
    expect(readFileSync(b, 'utf8')).toBe('pixels')
  })
})
