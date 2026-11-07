// A skin piece's derived data (docs/dressing-plan.md Phase 0 §4, src/engine/workers/derive.ts): its weights from the
// body under it and how much of each body region it covers, worked out once in the page's worker and kept in the
// character's folder, garments/<gid>/derived/<meshes>-<body>-<policy>-v<algo>.bin. The name holds every input (a hash
// of the piece's meshes as placed, of the body, the policy, the algorithm's version), so a file is never stale: a
// change is another name. Housekeeping: not a command, not journaled, not in the files index (server/files.ts ignores
// derived/), and only the newest KEEP per piece are kept.
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gearById } from '../../src/model/select.ts'
import { HttpError, readBody, route } from '../http.ts'
import { getCharacter, paths } from '../store.ts'

/** The file names derive.ts writes (DERIVED_NAME there). */
const NAME = /^[0-9a-f]{16}-[0-9a-f]{16}-[a-z]+-v\d+\.bin$/
const LIMIT = 256 * 1024 * 1024
/** Derived files kept per piece (each placement, body or algorithm is one). */
const KEEP = 12

async function folder (id: string, gid: string, name: string): Promise<string> {
  if (!NAME.test(name)) throw new HttpError(400, 'Not a derived file name')
  const c = await getCharacter(id)
  if (c === null) throw new HttpError(404, 'No such character')
  if (gearById(c, gid) === undefined) throw new HttpError(404, 'No such gear')
  return path.join(paths(id).garment(gid), 'derived')
}

route('GET', /^\/api\/characters\/([a-z0-9-]+)\/garments\/([A-Za-z0-9_-]+)\/derived\/([^/]+)$/, async (req, res, [id, gid, name]) => {
  const file = path.join(await folder(id, gid, name), name)
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
    res.end('Not derived yet')
    return
  }
  const bytes = await readFile(file)
  // (named by its content's inputs: the same name never holds other bytes)
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length, 'cache-control': 'private, max-age=31536000, immutable' })
  res.end(bytes)
})

route('PUT', /^\/api\/characters\/([a-z0-9-]+)\/garments\/([A-Za-z0-9_-]+)\/derived\/([^/]+)$/, async (req, res, [id, gid, name]) => {
  const dir = await folder(id, gid, name)
  const bytes = await readBody(req, LIMIT)
  if (bytes.length < 16 || bytes.length % 4 !== 0) throw new HttpError(400, 'Not derived data')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, bytes)
  await rename(temp, file)
  await prune(dir)
  res.writeHead(204, { 'cache-control': 'no-store' })
  res.end()
})

/** The newest KEEP derived files of a piece kept, the rest deleted (they are worked out again if ever needed). */
async function prune (dir: string): Promise<void> {
  const names = (await readdir(dir)).filter(n => NAME.test(n))
  if (names.length <= KEEP) return
  const dated = await Promise.all(names.map(async n => ({ n, at: (await stat(path.join(dir, n)).catch(() => null))?.mtimeMs ?? 0 })))
  dated.sort((a, b) => b.at - a.at)
  for (const { n } of dated.slice(KEEP)) await rm(path.join(dir, n), { force: true })
}
