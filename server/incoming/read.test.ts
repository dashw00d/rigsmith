import { createHash } from 'node:crypto'
import { cp, mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
const workspace = await mkdtemp(path.join(tmpdir(), 'rigsmith-incoming-'))
process.env.RIGSMITH_WORKSPACE = workspace
const { readPackage, listIncoming } = await import('./read.ts')
const { changeState } = await import('./state.ts')
const { startIncomingWatch, stopIncomingWatch } = await import('./watch.ts')
const { events } = await import('../store.ts')
const root = path.join(workspace, 'incoming')
const content = Buffer.from('test glb')
const sha = createHash('sha256').update(content).digest('hex')
const manifest = { schema: 1, id: 'delivery', at: '2026-11-07T12:00:00Z', tool: 'test', space: 'v6', parts: [{ id: 'piece', type: 'piece', file: 'parts/x.glb', sha256: sha, name: 'Piece' }] }
async function writeManifest (data: unknown): Promise<void> { await writeFile(path.join(root, 'delivery', 'manifest.json'), JSON.stringify(data)) }
beforeAll(async () => {
  await mkdir(path.join(root, 'delivery', 'parts'), { recursive: true })
  await mkdir(path.join(root, '.partial'), { recursive: true })
  await mkdir(path.join(root, 'no-manifest'), { recursive: true })
  await writeFile(path.join(root, 'delivery', 'parts', 'x.glb'), content); await writeManifest(manifest)
})
afterAll(async () => { stopIncomingWatch(); await rm(workspace, { recursive: true, force: true }) })
describe('incoming packages', () => {
  it('validates a staged partial before publishing', async () => {
    const staged = path.join(root, '.delivery.partial')
    await cp(path.join(root, 'delivery'), staged, { recursive: true })
    const result = await promisify(execFile)(process.execPath, ['tools/incoming.ts', 'validate', staged])
    expect(result.stdout).toContain('OK delivery')
    expect((await listIncoming()).packages.map(p => p.id)).toEqual(['delivery'])
  })
  it('reads published packages and ignores partials and unpublished folders', async () => {
    const list = await listIncoming(); expect(list.packages.map(p => p.id)).toEqual(['delivery']); expect(list.pending).toBe(1)
    expect(list.packages[0].parts[0].damaged).toBeUndefined()
  })
  it('reports invalid sha, traversal, symlinks and unknown schema', async () => {
    for (const change of [{ sha256: '0'.repeat(64) }, { file: '../x.glb' }, { file: 'parts/link.glb' }]) {
      await writeManifest({ ...manifest, parts: [{ ...manifest.parts[0], ...change }] })
      if (change.file === 'parts/link.glb') await symlink('x.glb', path.join(root, 'delivery', 'parts', 'link.glb'))
      expect((await readPackage(path.join(root, 'delivery'))).errors[0]).toBeTruthy()
    }
    await writeManifest({ ...manifest, schema: 99 }); expect((await readPackage(path.join(root, 'delivery'))).errors[0]).toMatch(/schema/i)
    await writeManifest(manifest)
  })
  it('persists rejection and restores pending; a new hash is pending', async () => {
    await changeState(s => { s['delivery/piece'] = { status: 'rejected', sha, at: 'now' } })
    expect((await listIncoming()).pending).toBe(0)
    await changeState(s => { s['delivery/piece'].sha = 'different' }); expect((await listIncoming()).pending).toBe(1)
    await changeState(s => { delete s['delivery/piece'] }); expect((await listIncoming()).packages[0].parts[0].status).toBe('pending')
  })
  it('emits incoming when a package is published', async () => {
    await startIncomingWatch()
    const event = new Promise<unknown>((resolve, reject) => { const timer = setTimeout(() => { events.off('incoming', handler); reject(new Error('No incoming event')) }, 3000); const handler = (value: unknown) => { clearTimeout(timer); events.off('incoming', handler); resolve(value) }; events.on('incoming', handler) })
    await mkdir(path.join(root, '.new.partial')); await rename(path.join(root, '.new.partial'), path.join(root, 'new'))
    expect(await event).toMatchObject({ pending: 1 })
  })
})
