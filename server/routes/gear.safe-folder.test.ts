import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

let root = ''
afterEach(async () => { vi.unstubAllEnvs(); vi.resetModules(); if (root) await rm(root, { recursive: true, force: true }) })

describe('safeCharacterFolder', () => {
  it('accepts a workspace symlink but rejects symlinks inside it', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rigsmith-safe-folder-'))
    const workspace = path.join(root, 'workspace')
    await mkdir(path.join(workspace, 'characters', 'alice'), { recursive: true })
    await symlink(workspace, path.join(root, 'link'))
    vi.stubEnv('RIGSMITH_WORKSPACE', path.join(root, 'link'))
    vi.resetModules()
    const { safeCharacterFolder } = await import('./gear.ts')
    await expect(safeCharacterFolder('alice', 'garments')).resolves.toBe(path.join(root, 'link', 'characters', 'alice', 'garments'))
    await symlink(root, path.join(workspace, 'characters', 'alice', 'escape'))
    await expect(safeCharacterFolder('alice', 'escape')).rejects.toThrow()
    await symlink(root, path.join(workspace, 'characters', 'bob'))
    await expect(safeCharacterFolder('bob', 'garments')).rejects.toThrow()
  })
})
