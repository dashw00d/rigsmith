// Headless Chrome over CDP. Each invocation owns a profile and browser, and leaves neither running afterwards.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const sleep = async (ms: number): Promise<void> => { await new Promise(resolve => setTimeout(resolve, ms)) }
interface Reply { result?: { result?: { value?: unknown, description?: string }, exceptionDetails?: { text?: string, exception?: { description?: string } } }, error?: { message?: string } }

export interface Page {
  send: (method: string, params?: object) => Promise<Reply>
  value: (expression: string) => Promise<unknown>
  navigate: (url: string) => Promise<void>
  until: (expression: string, timeout: number, what: string) => Promise<void>
  click: (x: number, y: number) => Promise<void>
  type: (text: string) => Promise<void>
  key: (key: string, modifiers?: number) => Promise<void>
  screenshot: (file: string) => Promise<void>
  setViewport: (width: number, height: number) => Promise<void>
  console: string[]
  errors: string[]
}

/** A fresh Chrome page for fn. */
export async function withChrome<T> (fn: (page: Page) => Promise<T>, o: { args?: string[] } = {}): Promise<T> {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'rigsmith-chrome-'))
  // Port 0 makes Chrome choose its own debugger port, recorded in this profile. Never connect to someone else's Chrome.
  const chrome = spawn(process.env.CHROME ?? 'google-chrome', ['--headless=new', '--no-sandbox', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--remote-debugging-port=0', `--user-data-dir=${profile}`, ...(o.args ?? []), 'about:blank'], { stdio: 'ignore' })
  let spawnError: Error | undefined
  chrome.on('error', error => { spawnError = error })
  try {
    const portFile = path.join(profile, 'DevToolsActivePort')
    let socket: WebSocket | undefined
    for (let i = 0; i < 150 && socket === undefined; i++) {
      if (spawnError !== undefined) throw spawnError
      if (chrome.exitCode !== null) throw new Error(`Chrome exited with ${chrome.exitCode}`)
      try {
        if (existsSync(portFile)) {
          const port = Number(readFileSync(portFile, 'utf8').split('\n')[0])
          const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Array<{ type: string, webSocketDebuggerUrl: string }>
          const page = pages.find(p => p.type === 'page')
          if (page !== undefined) socket = new WebSocket(page.webSocketDebuggerUrl)
        }
      } catch { /* starting */ }
      if (socket === undefined) await sleep(100)
    }
    if (socket === undefined) throw new Error('Chrome did not start')
    const ws = socket
    await new Promise<void>((resolve, reject) => { ws.addEventListener('open', () => { resolve() }, { once: true }); ws.addEventListener('error', () => { reject(new Error('Chrome websocket failed')) }, { once: true }) })
    let id = 0
    const waiting = new Map<number, { resolve: (reply: Reply) => void, reject: (error: Error) => void }>()
    const logged: string[] = []
    const errors: string[] = []
    ws.addEventListener('close', () => { for (const w of waiting.values()) w.reject(new Error('Chrome connection closed')); waiting.clear() })
    ws.addEventListener('message', e => {
      const m = JSON.parse(String(e.data)) as { id?: number, method?: string, params?: { type?: string, args?: Array<{ value?: unknown, description?: string }>, exceptionDetails?: { text?: string, exception?: { description?: string } } } }
      if (m.id !== undefined) { waiting.get(m.id)?.resolve(m as Reply); waiting.delete(m.id) }
      if (m.method === 'Runtime.consoleAPICalled') {
        const line = `${m.params?.type ?? 'log'}: ${(m.params?.args ?? []).map(a => a.value ?? a.description ?? '').join(' ')}`
        logged.push(line)
        if (m.params?.type === 'error') errors.push(line)
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params?.exceptionDetails
        const line = `exception: ${d?.exception?.description ?? d?.text ?? 'uncaught exception'}`
        logged.push(line); errors.push(line)
      }
    })
    const send = async (method: string, params: object = {}): Promise<Reply> => await new Promise((resolve, reject) => {
      const i = ++id; waiting.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params }))
    })
    const command = async (method: string, params: object = {}): Promise<Reply> => {
      const result = await send(method, params)
      if (result.error !== undefined) throw new Error(`${method}: ${result.error.message ?? 'protocol error'}`)
      return result
    }
    const value = async (expression: string): Promise<unknown> => {
      const r = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      const thrown = r.result?.exceptionDetails
      if (thrown !== undefined) throw new Error(thrown.exception?.description ?? thrown.text ?? 'the page threw')
      return r.result?.result?.value
    }
    await command('Runtime.enable')
    await command('Page.enable')
    const page: Page = {
      send, value, console: logged, errors,
      navigate: async url => { await command('Page.navigate', { url }) },
      until: async (expression, timeout, what) => {
        const started = Date.now()
        while (Date.now() - started < timeout) {
          try { if (await value(expression) === true) return } catch { /* navigating */ }
          await sleep(100)
        }
        throw new Error(`${what}: not after ${Math.round(timeout / 1000)} s`)
      },
      click: async (x, y) => {
        await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
        await command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
        await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      },
      type: async text => { await command('Input.insertText', { text }) },
      key: async (key, modifiers = 0) => {
        const codes: Record<string, number> = { Escape: 27, Enter: 13, Tab: 9, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, ' ': 32 }
        const vk = codes[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0)
        const code = key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key
        const params = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
        await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
        await command('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
      },
      screenshot: async file => {
        const r = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }) as unknown as { result?: { data?: string } }
        if (r.result?.data === undefined) throw new Error('Chrome returned no screenshot')
        writeFileSync(file, Buffer.from(r.result.data, 'base64'))
      },
      setViewport: async (width, height) => { await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }) },
    }
    try { return await fn(page) } finally { ws.close() }
  } finally {
    await stop(chrome)
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch (error) {
      console.warn(`chrome: left its profile at ${profile}: ${(error as Error).message}`)
    }
  }
}

async function stop (chrome: ChildProcess): Promise<void> {
  if (chrome.exitCode !== null || chrome.signalCode !== null || chrome.pid === undefined) return
  const exited = new Promise<void>(resolve => { chrome.once('exit', () => { resolve() }) })
  chrome.kill('SIGTERM')
  if (await Promise.race([exited.then(() => false), sleep(5000).then(() => true)])) {
    chrome.kill('SIGKILL'); await Promise.race([exited, sleep(2000)])
  }
}
