// Small read-side fixture; the minimal GLB has no mesh and is not an import/accept fixture.
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { IncomingManifest } from './read.ts'
export async function incomingFixture (root: string, id = 'fixture'): Promise<string> {
  const dir = path.join(root, id)
  await mkdir(path.join(dir, 'parts'), { recursive: true })
  const glb = Buffer.from('676c5446020000000c000000', 'hex')
  await writeFile(path.join(dir, 'parts', 'piece.glb'), glb)
  const manifest: IncomingManifest = { schema: 1, id, at: '2026-11-07T12:00:00Z', tool: 'fixture', space: 'v6', parts: [{ id: 'piece', type: 'piece', name: 'Piece', file: 'parts/piece.glb', sha256: createHash('sha256').update(glb).digest('hex') }] }
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return dir
}
