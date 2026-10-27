// Pose-optimized skin weights (tools/skin_opt): pose the fresh rig through a few hundred library poses,
// fit the weights on the GPU for minimal stretch, volume loss and limb wobble, and write them back into
// the GLB. Needs a Python with PyTorch (the repo's .venv, or RIGSMITH_TORCH_PYTHON); skipped without one.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ROOT } from './workspace.ts'

const TOOLS = path.join(ROOT, 'tools', 'skin_opt')
// The repo's .venv (npm run setup:python), else an explicit override, else any older install.
const CANDIDATES = [process.env.RIGSMITH_TORCH_PYTHON, path.join(ROOT, '.venv', 'bin', 'python'), path.join(os.homedir(), 'dev/ml/make-it-animatable/.venv/bin/python')]
let found: string | null | undefined

export function torchPython (): string | null {
  if (found !== undefined) return found
  found = CANDIDATES.find(p => p !== undefined && p !== '' && existsSync(p) && spawnSync(p, ['-c', 'import torch'], { stdio: 'ignore' }).status === 0) ?? null
  return found
}

async function run (command: string, args: string[], onLine?: (line: string) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    let pending = ''
    child.stdout.on('data', (d: Buffer) => {
      pending += d.toString()
      const lines = pending.split('\n'); pending = lines.pop() ?? ''
      for (const line of lines) if (line.trim() !== '') onLine?.(line)
    })
    child.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-4000) })
    child.on('error', reject)
    child.on('close', code => {
      if (pending.trim() !== '') onLine?.(pending)
      if (code === 0) resolve()
      else reject(new Error(`${path.basename(args[0] ?? command)} failed: ${err.trim().split('\n').slice(-3).join(' ')}`))
    })
  })
}

/** Keep previous weights when the new skin regresses on the rig's deformation
 * tests. The comparison uses the new skeleton, so joint edits always take effect. */
export async function validateSkin (candidate: string, previous: string, template: string): Promise<{ compared: boolean, retained: boolean }> {
  let result: { compared: boolean, retained: boolean } | undefined
  await run(process.execPath, [path.join(TOOLS, 'validate.ts'), candidate, previous, template], line => {
    if (line.startsWith('{')) result = JSON.parse(line) as typeof result
  })
  if (result === undefined) throw new Error('No skin validation result')
  return result
}

// One optimization at a time: they share the GPU (and fall back to the CPU when it's full).
let queue: Promise<unknown> = Promise.resolve()

/** Optimize the skin of a rigged GLB in place. Returns false when no PyTorch is available. */
/** clips: train on this GLB's own animations (creature templates) instead of the humanoid library. always: library
 * clip ids trained on whatever the draw (the unit's own clips, the Rig step's tests). */
export async function optimizeSkin (glb: string, onProgress: (progress: number, message: string) => void, clips?: string, always: string[] = []): Promise<boolean> {
  const python = torchPython()
  if (python === null) return false
  onProgress(0, 'Waiting for the GPU')
  const turn = queue.then(async () => await optimizeNow(python, glb, onProgress, clips, always))
  queue = turn.catch(() => {})
  return await turn
}

async function optimizeNow (python: string, glb: string, onProgress: (progress: number, message: string) => void, clips?: string, always: string[] = []): Promise<boolean> {
  const work = path.join(os.tmpdir(), 'rigsmith-skinopt', path.basename(path.dirname(glb)) + '-' + Date.now())
  await mkdir(work, { recursive: true })
  const prefix = path.join(work, 'skin')
  try {
    onProgress(0, clips === undefined ? 'Posing the rig through 256 library poses' : 'Posing the rig through its animations')
    await run(process.execPath, [path.join(TOOLS, 'pose_set.ts'), glb, prefix, '--poses', '256', ...(clips === undefined ? [] : ['--from', clips]), ...(clips === undefined && always.length > 0 ? ['--with', always.join(',')] : [])])
    onProgress(0.3, 'Optimizing weights on the GPU')
    let device = 'GPU'
    await run(python, [path.join(TOOLS, 'optimize.py'), prefix, '--iters', '300'], line => {
      if (line.includes('using the CPU')) device = 'CPU'
      const m = /^it\s+(\d+)/.exec(line)
      if (m !== null) onProgress(0.3 + 0.6 * Number(m[1]) / 300, `Optimizing weights on the ${device}`)
    })
    onProgress(0.95, 'Writing weights')
    await run(process.execPath, [path.join(TOOLS, 'apply.ts'), glb, prefix])
    return true
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
