// @vitest-environment node
import { mkdtemp, rm, utimes, writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
const streams = vi.hoisted(() => ({ count: 0 }))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, createReadStream: (...args: Parameters<typeof fs.createReadStream>) => { streams.count++; return fs.createReadStream(...args) } }
})
const workspace = await mkdtemp(path.join(tmpdir(), 'incoming-cache-'))
process.env.RIGSMITH_WORKSPACE = workspace
const { incomingFixture } = await import('./fixture.ts')
const { readPackage } = await import('./read.ts')
afterAll(async () => { await rm(workspace, { recursive: true, force: true }) })
it('hashes unchanged files once and invalidates for mtime or inode changes', async () => {
  const dir = await incomingFixture(workspace)
  await Promise.all([readPackage(dir), readPackage(dir)])
  await readPackage(dir)
  expect(streams.count).toBe(1)
  const file = path.join(dir, 'parts', 'piece.glb')
  await utimes(file, new Date(1000000000), new Date(1000000000))
  await readPackage(dir)
  expect(streams.count).toBe(2)
  const bytes = await (await import('node:fs/promises')).readFile(file)
  const replacement = `${file}.new`
  await writeFile(replacement, bytes)
  await utimes(replacement, new Date(1000000000), new Date(1000000000))
  await rename(replacement, file)
  await readPackage(dir)
  expect(streams.count).toBe(3)
  await writeFile(file, Buffer.concat([bytes, Buffer.from('extra')]))
  await utimes(file, new Date(1000000000), new Date(1000000000))
  expect((await readPackage(dir)).errors[0]).toMatch(/SHA256 mismatch/)
  expect(streams.count).toBe(4)
})
it('rehashes same-size content changed with its mtime restored', async () => {
  const dir = await incomingFixture(workspace, 'ctime')
  const file = path.join(dir, 'parts', 'piece.glb')
  const time = new Date(1000000000)
  await utimes(file, time, time)
  expect((await readPackage(dir)).errors[0]).toBeUndefined()
  const bytes = await (await import('node:fs/promises')).readFile(file)
  bytes[bytes.length - 1] ^= 1
  await writeFile(file, bytes)
  await utimes(file, time, time)
  expect((await readPackage(dir)).errors[0]).toMatch(/SHA256 mismatch/)
})
