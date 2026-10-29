// The HTTP plumbing every route module shares: a router of [method, pattern, handler], errors as JSON, bodies, who
// made a request, and the two rules that keep other web pages out (a mutating request must carry a header a plain
// cross-site form or fetch can't send without a CORS preflight; /files serves only what the app loads).
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

export const MAX_UPLOAD = 512 * 1024 * 1024
export const CONTENT_TYPES: Record<string, string> = {
  '.glb': 'model/gltf-binary', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.fbx': 'application/octet-stream',
}

/** An error with the HTTP status it answers with; `body` adds fields beside `error` (409 `{ conflicts }`). */
export class HttpError extends Error {
  status: number
  body?: Record<string, unknown>
  constructor (status: number, message: string, body?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.body = body
  }
}

/** Who made a change: a tool names itself in the x-rigsmith-by header (an agent: "agent"); the app sends none. */
export const by = (req: IncomingMessage): string => {
  const h = req.headers['x-rigsmith-by']
  const who = (Array.isArray(h) ? h[0] : h)?.trim()
  return who !== undefined && /^[\w .:-]{1,40}$/.test(who) ? who : 'app'
}

export const header = (req: IncomingMessage, name: string): string | undefined => {
  const h = req.headers[name]
  return Array.isArray(h) ? h[0] : h
}

export function send (res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export async function readBody (req: IncomingMessage, limit = MAX_UPLOAD): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, 'Upload too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

export async function readJsonBody<T> (req: IncomingMessage): Promise<T> {
  const body = await readBody(req, 4 * 1024 * 1024)
  try {
    return JSON.parse(body.toString('utf8') || '{}') as T
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
}

// ---- routing --------------------------------------------------------------------------------------------------

/** What a handler answers to leave the request to the next route that matches (the v1 layer's wrappers). */
export const NEXT = Symbol('next route')
export type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], url: URL) => Promise<void | typeof NEXT>
const routes: Array<[string, RegExp, Handler]> = []

/** Route modules register at import (server/api.ts imports them all). Patterns are anchored, so order rarely matters. */
export const route = (method: string, pattern: RegExp, handler: Handler): void => { routes.push([method, pattern, handler]) }

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Changes need `x-rigsmith: 1` or `x-rigsmith-by`: both are custom headers, so a page on another site can't send
 * them without a CORS preflight, which Vite answers only for local origins. */
export const allowedWrite = (req: IncomingMessage): boolean =>
  !MUTATING.has(req.method ?? 'GET') || header(req, 'x-rigsmith') === '1' || (header(req, 'x-rigsmith-by') ?? '').trim() !== ''

/** What /files may serve, by its path inside the workspace: the characters' files the app loads (not their records,
 * journals or painted-weight records) and the clip library. */
const PRIVATE = new Set(['journal.jsonl', 'character.json', 'character.v1.json', 'character.v2.json', 'character.v3.json', 'weight_edits.json'])
export function servable (relative: string): boolean {
  const parts = relative.split(/[\\/]+/)
  if (parts.some(p => p === '..' || p === '')) return false
  if (parts[0] === 'library') return parts.length > 1
  return parts[0] === 'characters' && parts.length > 2 && !PRIVATE.has(path.basename(relative))
}

export async function handle (req: IncomingMessage, res: ServerResponse, next?: () => void): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://local')
  if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/files/')) {
    next?.()
    return
  }
  if (!allowedWrite(req)) {
    send(res, 403, { error: 'Changes need the x-rigsmith: 1 header (or x-rigsmith-by naming the tool)' })
    return
  }
  for (const [method, pattern, handler] of routes) {
    const match = pattern.exec(url.pathname)
    if (match !== null && req.method === method) {
      try {
        if (await handler(req, res, match.slice(1), url) === NEXT) continue
      } catch (error) {
        // (a model CommandError carries its status too)
        const status = (error as { status?: unknown }).status
        const code = typeof status === 'number' && status >= 400 && status < 600 ? status : 500
        if (code === 500) console.error(error)
        if (!res.headersSent) send(res, code, { error: (error as Error).message, ...(error instanceof HttpError ? error.body : {}) })
        else res.end()
      }
      return
    }
  }
  send(res, 404, { error: 'Unknown endpoint' })
}
