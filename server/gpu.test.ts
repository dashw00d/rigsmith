// @vitest-environment node
// The GPU lane (jobs.ts gpuTurn): one holder at a time in order, reordering, ComfyUI told to free its models before a
// job that isn't its own, the wait for the declared VRAM (said, never timed out), cancelling a waiter. nvidia-smi is a
// script reading a file; fetch is stubbed.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dir = mkdtempSync(path.join(tmpdir(), 'rigsmith-gpu-'))
process.env.RIGSMITH_WORKSPACE = dir
const FREE = path.join(dir, 'free.txt')
const SMI = path.join(dir, 'nvidia-smi')
writeFileSync(SMI, `#!/bin/sh\ncat "${FREE}"\n`)
chmodSync(SMI, 0o755)
process.env.NVIDIA_SMI = SMI
process.env.COMFY_URL = 'http://comfy.test:8188'

let jobs: typeof import('./jobs.ts')
const freed: string[] = []
const setFree = (mib: number): void => { writeFileSync(FREE, `${mib}\n`) }

beforeAll(async () => {
  jobs = await import('./jobs.ts')
  jobs.gpuConfig.pollMs = 10
})
afterAll(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) })
beforeEach(() => {
  setFree(16000)
  freed.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    freed.push(`${init?.method ?? 'GET'} ${url} ${String(init?.body)}`)
    return new Response('{}', { status: 200 })
  }))
})

const torch = { vram: 4000, family: 'torch' }
const comfy = { vram: 8000, family: 'comfy' }

describe('the GPU lane', () => {
  it('gives the GPU to one at a time, first come first served', async () => {
    const order: string[] = []
    const a = await jobs.gpuTurn({ label: 'A' }, torch)
    const b = jobs.gpuTurn({ label: 'B' }, torch).then(t => { order.push('b'); return t })
    const c = jobs.gpuTurn({ label: 'C' }, torch).then(t => { order.push('c'); return t })
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(order).toEqual([])
    expect(jobs.gpuState().holder?.label).toBe('A')
    expect(jobs.gpuState().waiting.map(w => w.label)).toEqual(['B', 'C'])
    expect(jobs.gpuState().waiting[1].why).toMatch(/A has it, 1 ahead/)
    a.release()
    ;(await b).release()
    ;(await c).release()
    expect(order).toEqual(['b', 'c'])
    expect(jobs.gpuState().holder).toBeNull()
  })

  it('takes the line in a new order', async () => {
    const order: string[] = []
    const a = await jobs.gpuTurn({ label: 'A' }, torch)
    const b = jobs.gpuTurn({ label: 'B' }, torch).then(t => { order.push('b'); t.release() })
    const c = jobs.gpuTurn({ label: 'C' }, torch).then(t => { order.push('c'); t.release() })
    const cid = jobs.gpuState().waiting.find(w => w.label === 'C')!.id
    expect(jobs.reorderGpu([cid]).waiting.map(w => w.label)).toEqual(['C', 'B'])
    a.release()
    await Promise.all([b, c])
    expect(order).toEqual(['c', 'b'])
  })

  it("frees ComfyUI's models before a job that isn't ComfyUI's, and keeps them between ComfyUI jobs", async () => {
    await jobs.withGpu({ label: 'paint 1' }, comfy, undefined, async () => {})
    freed.length = 0
    // (after ComfyUI, ComfyUI again: its models stay, and what it holds isn't counted against it)
    setFree(100)
    await jobs.withGpu({ label: 'paint 2' }, comfy, undefined, async () => {})
    expect(freed).toEqual([])
    setFree(16000)
    await jobs.withGpu({ label: 'hunyuan' }, torch, undefined, async () => {})
    expect(freed).toEqual(['POST http://comfy.test:8188/free {"unload_models":true,"free_memory":true}'])
    freed.length = 0
    await jobs.withGpu({ label: 'torch again' }, torch, undefined, async () => {})
    expect(freed).toEqual([])
  })

  it('waits for the VRAM it declared, saying why, until it is free', async () => {
    setFree(2048)
    const said: string[] = []
    let got = false
    const turn = jobs.gpuTurn({ label: 'big' }, { vram: 12000, family: 'hunyuan' }, undefined, { onWait: why => { said.push(why) } })
      .then(t => { got = true; return t })
    await vi.waitFor(() => { expect(said.some(s => /2\.0 GB free, needs 11\.7 GB/.test(s))).toBe(true) })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(got).toBe(false)
    expect(jobs.gpuState().waiting[0].why).toMatch(/needs 11\.7 GB/)
    setFree(13000)
    ;(await turn).release()
    expect(said.at(-1)).toBe('Has the GPU')
  })

  it('asks ComfyUI once to let go when the VRAM is short and it may hold models', async () => {
    await jobs.withGpu({ label: 'paint' }, comfy, undefined, async () => {})
    freed.length = 0
    setFree(1000)
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => { freed.push(`${init?.method} ${url}`); setFree(15000); return new Response('{}') })
    vi.stubGlobal('fetch', fetchMock)
    // (the free before a non-ComfyUI job is the one ask; the VRAM is then there)
    await jobs.withGpu({ label: 'torch' }, torch, undefined, async () => {})
    expect(freed).toEqual(['POST http://comfy.test:8188/free'])
  })

  it('drops a waiter whose signal aborts and lets the next one on', async () => {
    const a = await jobs.gpuTurn({ label: 'A' }, torch)
    const controller = new AbortController()
    const b = jobs.gpuTurn({ label: 'B' }, torch, controller.signal)
    const c = jobs.gpuTurn({ label: 'C' }, torch)
    controller.abort(new Error('Cancelled'))
    await expect(b).rejects.toThrow('Cancelled')
    expect(jobs.gpuState().waiting.map(w => w.label)).toEqual(['C'])
    a.release()
    ;(await c).release()
    await expect(jobs.gpuTurn({ label: 'D' }, torch, controller.signal)).rejects.toThrow('Cancelled')
  })

  it('stops waiting for the VRAM when the head is cancelled', async () => {
    setFree(10)
    const controller = new AbortController()
    const big = jobs.gpuTurn({ label: 'big' }, { vram: 12000, family: 'torch' }, controller.signal)
    await vi.waitFor(() => { expect(jobs.gpuState().waiting[0]?.why).toMatch(/needs/) })
    controller.abort(new Error('Cancelled'))
    await expect(big).rejects.toThrow('Cancelled')
    setFree(16000)
    ;(await jobs.gpuTurn({ label: 'small' }, torch)).release()
  })

  it('says so and goes on when nvidia-smi cannot be read', async () => {
    process.env.NVIDIA_SMI = path.join(dir, 'missing-smi')
    const said: string[] = []
    try {
      ;(await jobs.gpuTurn({ label: 'x' }, torch, undefined, { onWait: why => { said.push(why) } })).release()
    } finally {
      process.env.NVIDIA_SMI = SMI
    }
    expect(said.some(s => /nvidia-smi failed/.test(s))).toBe(true)
  })

  it("tells a job's own line why it waits", async () => {
    const a = await jobs.gpuTurn({ label: 'A' }, torch)
    let seen = ''
    const job = jobs.enqueue('forge', 'Build', undefined, async (job, update, signal) => {
      await jobs.withGpu(job, torch, signal, async () => {})
    }, { lock: 'none' })
    await vi.waitFor(() => { seen = job.message; expect(job.message).toMatch(/Waiting for the GPU: A has it/) })
    a.release()
    await vi.waitFor(() => { expect(job.status).toBe('done') })
    expect(seen).toMatch(/A has it/)
  })
})
