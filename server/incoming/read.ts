import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { WORKSPACE, readJson } from '../store.ts'
import type { Character } from '../../src/model/types.ts'
import { readState } from './state.ts'

export type PartType = 'piece' | 'hair' | 'beard' | 'clothes' | 'skin'
export interface IncomingPart {
  id: string, type: PartType, file: string, sha256: string, name: string, from?: string, preview?: string,
  set?: string, policy?: 'upper' | 'lower' | 'head', hideBody?: boolean, tags?: string[], role?: 'hair' | 'beard',
  swapSet?: string, hair?: string, slots?: string[]
}
export interface IncomingManifest { schema: number, id: string, at: string, tool: string, space: string, parts: IncomingPart[], sets?: Array<{ id: string, name: string, pieces: string[], tags?: string[] }> }
export interface PartView extends IncomingPart { status: 'pending' | 'accepted' | 'rejected', effect: 'new' | 'update' | 'same', damaged?: string }
export interface PackageView { id: string, at: string, tool: string, parts: PartView[] }
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const MAX = 200 * 1024 * 1024
export async function incomingDir (): Promise<string> {
  const settings = await readJson<{ incomingDir?: unknown }>(path.join(WORKSPACE, 'settings.json'), {})
  return typeof settings.incomingDir === 'string' && settings.incomingDir.trim() ? path.resolve(settings.incomingDir) : path.join(WORKSPACE, 'incoming')
}
/** Reject traversal and symlinks in every component, including the package directory. */
export async function safeFile (root: string, relative: string): Promise<string> {
  if (typeof relative !== 'string' || relative === '' || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe path')
  let current = root
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Symlink package')
  for (const part of relative.split('/')) {
    current = path.join(current, part)
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error('Symlink in path')
  }
  const info = await lstat(current)
  if (!info.isFile()) throw new Error('Not a file')
  if (info.size > MAX) throw new Error('File exceeds 200 MB')
  return current
}
const hashes = new Map<string, { signature: string, result: Promise<string> }>()
async function sha (file: string): Promise<string> {
  const info = await lstat(file)
  const signature = `${info.size}:${info.mtimeMs}:${info.ino}`
  const cached = hashes.get(file)
  if (cached?.signature === signature) return await cached.result
  const result = hashFile(file)
  hashes.set(file, { signature, result })
  if (hashes.size > 4096) hashes.delete(hashes.keys().next().value!)
  try { return await result } catch (error) {
    if (hashes.get(file)?.result === result) hashes.delete(file)
    throw error
  }
}
async function hashFile (file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
/** Validates a complete package; individual defects are reported on its parts. */
export async function readPackage (dir: string, options: { staging?: boolean } = {}): Promise<{ manifest: IncomingManifest, errors: Array<string | undefined> }> {
  const manifestFile = await safeFile(dir, 'manifest.json')
  const raw: unknown = JSON.parse(await readFile(manifestFile, 'utf8'))
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as IncomingManifest).parts) || (raw as IncomingManifest).parts.length === 0) throw new Error('Invalid manifest parts')
  const manifest = raw as IncomingManifest
  const name = path.basename(dir)
  const matches = manifest.id === name || (options.staging === true && name === `.${manifest.id}.partial`)
  const packageError = manifest.schema !== 1 ? 'Unknown schema' : !ID.test(manifest.id ?? '') || !matches ? 'Invalid package id' : manifest.space !== 'v6' ? 'Unknown space' : typeof manifest.at !== 'string' || !Number.isFinite(Date.parse(manifest.at)) || typeof manifest.tool !== 'string' ? 'Invalid package metadata' : undefined
  const seen = new Set<string>()
  const errors = await Promise.all(manifest.parts.map(async part => {
    try {
      if (packageError) throw new Error(packageError)
      if (!part || typeof part !== 'object' || !ID.test(part.id ?? '') || seen.has(part.id)) throw new Error('Invalid or duplicate part id')
      seen.add(part.id)
      if (!['piece', 'hair', 'beard', 'clothes', 'skin'].includes(part.type)) throw new Error('Unknown type')
      if (part.policy !== undefined && !['upper', 'lower', 'head'].includes(part.policy)) throw new Error('Unknown policy')
      if (typeof part.name !== 'string' || !part.name.trim()) throw new Error('Missing name')
      if (typeof part.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(part.sha256)) throw new Error('Invalid sha256')
      if (typeof part.file !== 'string' || !part.file.toLowerCase().endsWith(['piece', 'hair', 'beard'].includes(part.type) ? '.glb' : '.png')) throw new Error('Wrong file type')
      const file = await safeFile(dir, part.file)
      if (await sha(file) !== part.sha256.toLowerCase()) throw new Error('SHA256 mismatch')
      if (part.preview !== undefined) await safeFile(dir, part.preview)
      return undefined
    } catch (error) { return error instanceof Error ? error.message : String(error) }
  }))
  return { manifest, errors }
}
export async function listIncoming (character?: Character | null): Promise<{ packages: PackageView[], pending: number }> {
  const root = await incomingDir(); const state = await readState(); const packages: PackageView[] = []
  const names = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of names) {
    if (!entry.isDirectory() || !ID.test(entry.name)) continue
    const dir = path.join(root, entry.name)
    try {
      const { manifest, errors } = await readPackage(dir)
      const parts = manifest.parts.map((rawPart, i): PartView => {
        const part = rawPart && typeof rawPart === 'object' ? rawPart : { id: `invalid-${i}`, type: 'piece' as const, name: 'Invalid part', file: '', sha256: '' }
        const record = state[`${entry.name}/${part.id}`]
        const status = record?.sha === part.sha256 ? record.status : 'pending'
        const exists = part.from !== undefined && character?.gear.some(g => g.from === part.from)
        return { ...part, status, effect: status === 'accepted' ? 'same' : exists ? 'update' : 'new', ...(errors[i] ? { damaged: errors[i] } : {}) }
      })
      packages.push({ id: entry.name, at: typeof manifest.at === 'string' ? manifest.at : '', tool: typeof manifest.tool === 'string' ? manifest.tool : '', parts })
    } catch { /* no manifest or unreadable package is not published */ }
  }
  packages.sort((a, b) => b.at.localeCompare(a.at))
  return { packages, pending: packages.reduce((n, p) => n + p.parts.filter(x => x.status === 'pending').length, 0) }
}
