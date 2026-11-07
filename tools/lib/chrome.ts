// Headless Chrome driven through its debugging protocol, for the tools that open the app's pages: one frame of a
// character (tools/lib/shot.ts) and the timing scenarios (tools/lib/profile.ts). CHROME names the browser (default
// google-chrome). Software GL (SwiftShader), so it runs on a machine with no display; a fresh profile each time, removed
// after.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const sleep = async (ms: number): Promise<void> => { await new Promise(resolve => setTimeout(resolve, ms)) }

interface Reply { result?: { result?: { value?: unknown, description?: string }, exceptionDetails?: { text?: string, exception?: { description?: string } } }, error?: { message?: string } }

/** One page of headless Chrome. */
export interface Page {
  /** A protocol command (`Page.navigate`, `Runtime.evaluate`...). */
  send: (method: string, params?: object) => Promise<Reply>
  /** An expression's value in the page (a promise awaited); throws what it threw. */
  value: (expression: string) => Promise<unknown>
  /** Open a URL. */
  navigate: (url: string) => Promise<void>
  /** Wait until `expression` is true in the page (polling), or throw after `timeout` ms saying `what`. */
  until: (expression: string, timeout: number, what: string) => Promise<void>
  /** What the page logged to its console since it opened. */
  console: string[]
}

/** Run `fn` on a page of a fresh headless Chrome, which goes when it is done (or fails). */
export async function withChrome<T> (fn: (page: Page) => Promise<T>, o: { args?: string[] } = {}): Promise<T> {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'rigsmith-chrome-'))
  const port = 9300 + Math.floor(Math.random() * 600)
  const chrome = spawn(process.env.CHROME ?? 'google-chrome', ['--headless=new', '--no-sandbox', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...(o.args ?? []), 'about:blank'], { stdio: 'ignore' })
  try {
    let socket: WebSocket | undefined
    for (let i = 0; i < 100 && socket === undefined; i++) {
      try {
        const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Array<{ type: string, webSocketDebuggerUrl: string }>
        const page = pages.find(p => p.type === 'page')
        if (page !== undefined) socket = new WebSocket(page.webSocketDebuggerUrl)
      } catch { /* (not up yet) */ }
      if (socket === undefined) await sleep(100)
    }
    if (socket === undefined) throw new Error('Chrome did not start')
    const ws = socket
    await new Promise(resolve => { ws.addEventListener('open', resolve) })
    let id = 0
    const waiting = new Map<number, (m: Reply) => void>()
    const logged: string[] = []
    ws.addEventListener('message', e => {
      const m = JSON.parse(String(e.data)) as { id?: number, method?: string, params?: { type?: string, args?: Array<{ value?: unknown, description?: string }> } }
      if (m.id !== undefined) { waiting.get(m.id)?.(m as Reply); waiting.delete(m.id) }
      if (m.method === 'Runtime.consoleAPICalled') logged.push(`${m.params?.type ?? 'log'}: ${(m.params?.args ?? []).map(a => a.value ?? a.description ?? '').join(' ')}`)
    })
    const send = async (method: string, params: object = {}): Promise<Reply> =>
      await new Promise(resolve => { const i = ++id; waiting.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })) })
    const value = async (expression: string): Promise<unknown> => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      const thrown = r.result?.exceptionDetails
      if (thrown !== undefined) throw new Error(thrown.exception?.description ?? thrown.text ?? 'the page threw')
      if (r.error !== undefined) throw new Error(r.error.message ?? 'protocol error')
      return r.result?.result?.value
    }
    await send('Runtime.enable')
    const page: Page = {
      send,
      value,
      console: logged,
      navigate: async (url) => { await send('Page.navigate', { url }) },
      until: async (expression, timeout, what) => {
        const started = Date.now()
        while (Date.now() - started < timeout) {
          try { if (await value(expression) === true) return } catch { /* (the page is still loading) */ }
          await sleep(100)
        }
        throw new Error(`${what}: not after ${Math.round(timeout / 1000)} s`)
      },
    }
    try {
      return await fn(page)
    } finally {
      ws.close()
    }
  } finally {
    chrome.kill()
    rmSync(profile, { recursive: true, force: true })
  }
}
