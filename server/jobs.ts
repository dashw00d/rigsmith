// Background job queue. Jobs run Blender headless; progress streams to the browser over SSE.
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { ROOT } from './workspace.ts'

export const BLENDER = process.env.BLENDER ?? 'blender'
const CONCURRENCY = Number(process.env.RIGSMITH_JOBS ?? 3)

export type JobStatus = 'queued' | 'running' | 'done' | 'failed'

export interface Job {
  id: string
  kind: string
  label: string
  characterId?: string
  status: JobStatus
  progress: number
  message: string
  createdAt: number
  finishedAt?: number
  error?: string
}

type Runner = (job: Job, update: (patch: Partial<Job>) => void) => Promise<void>

export const events = new EventEmitter()
events.setMaxListeners(100)

const jobs = new Map<string, Job>()
const queue: Array<{ job: Job, run: Runner }> = []
let running = 0

export function listJobs (): Job[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100)
}

export function enqueue (kind: string, label: string, characterId: string | undefined, run: Runner): Job {
  const job: Job = { id: randomBytes(6).toString('hex'), kind, label, characterId, status: 'queued', progress: 0, message: 'Queued', createdAt: Date.now() }
  jobs.set(job.id, job)
  queue.push({ job, run })
  events.emit('job', job)
  pump()
  return job
}

function pump (): void {
  while (running < CONCURRENCY && queue.length > 0) {
    const { job, run } = queue.shift()!
    running++
    const update = (patch: Partial<Job>): void => {
      Object.assign(job, patch)
      events.emit('job', job)
    }
    update({ status: 'running', message: 'Starting' })
    run(job, update)
      .then(() => { update({ status: 'done', progress: 1, message: 'Done', finishedAt: Date.now() }) })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        update({ status: 'failed', message, error: message, finishedAt: Date.now() })
      })
      .finally(() => { running--; pump() })
  }
}

export interface BlenderResult { result: Record<string, unknown>, log: string }

/**
 * Run a script from blender/ headless. Scripts report with lines:
 *   @@PROGRESS {"progress": 0.5, "message": "..."}
 *   @@RESULT {...}
 */
export async function runBlender (script: string, args: string[], onProgress?: (progress: number, message: string) => void, timeoutMs = 10 * 60_000): Promise<BlenderResult> {
  const scriptPath = path.join(ROOT, 'blender', script)
  return await new Promise((resolve, reject) => {
    const child = spawn(BLENDER, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', scriptPath, '--', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    let result: Record<string, unknown> | null = null
    let buffer = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${script} timed out`)) }, timeoutMs)
    const onLine = (line: string): void => {
      if (line.startsWith('@@PROGRESS ')) {
        try {
          const p = JSON.parse(line.slice(11)) as { progress: number, message: string }
          onProgress?.(p.progress, p.message)
        } catch {}
      } else if (line.startsWith('@@RESULT ')) {
        result = JSON.parse(line.slice(9)) as Record<string, unknown>
      } else {
        log += line + '\n'
      }
    }
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      lines.forEach(onLine)
    })
    child.stderr.on('data', (chunk: Buffer) => { log += chunk.toString() })
    child.on('error', error => { clearTimeout(timer); reject(new Error(`Could not start Blender (${BLENDER}): ${error.message}`)) })
    child.on('close', code => {
      clearTimeout(timer)
      if (buffer !== '') onLine(buffer)
      if (code === 0 && result !== null) resolve({ result, log })
      else reject(new Error(lastError(log) ?? `${script} exited with code ${code}`))
    })
  })
}

function lastError (log: string): string | null {
  const lines = log.trim().split('\n').filter(l => /error|exception|Error:/i.test(l))
  return lines.length > 0 ? lines[lines.length - 1].trim().slice(0, 300) : null
}

/** Run the Codex CLI non-interactively in `dir` (it may write files there), with images attached. */
export async function runCodex (dir: string, prompt: string, images: string[], onMessage?: (message: string) => void, timeoutMs = 15 * 60_000): Promise<void> {
  const args = ['exec', '-C', dir, '--skip-git-repo-check', '--ephemeral', '-s', 'workspace-write', '--json']
  for (const image of images) args.push('-i', path.join(dir, image))
  // `-i` takes several files, so the prompt goes through stdin ('-') rather than as a trailing argument.
  args.push('-')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.CODEX ?? 'codex', args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin.end(prompt)
    let tail = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Codex timed out')) }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim() === '') continue
        tail = line
        try {
          const event = JSON.parse(line) as { type?: string, item?: { type?: string, text?: string } }
          if (event.item?.type === 'agent_message' && event.item.text !== undefined) onMessage?.(event.item.text.slice(0, 120))
          else if (event.type !== undefined) onMessage?.(`Codex: ${event.type.replace(/[._]/g, ' ')}`)
        } catch { /* not JSON */ }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => { tail = chunk.toString() })
    child.on('error', error => { clearTimeout(timer); reject(new Error(`Could not start Codex: ${error.message}`)) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`Codex exited with ${code}: ${tail.slice(0, 200)}`))
    })
  })
}
