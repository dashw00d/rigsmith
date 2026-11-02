// One frame of a character in the viewer's own renderer, saved as a PNG: src/shot/ (served by the app's dev server)
// opened in headless Chrome through its debugging protocol, the canvas read back when the page says DONE. For
// `node tools/rig.ts shot`; CHROME names the browser (default google-chrome).
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sleep = async (ms: number): Promise<void> => { await new Promise(resolve => setTimeout(resolve, ms)) }

export async function shot (server: string, query: Record<string, string>, out: string, timeout = 120_000): Promise<void> {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'rigsmith-shot-'))
  const port = 9300 + Math.floor(Math.random() * 600)
  const chrome = spawn(process.env.CHROME ?? 'google-chrome', ['--headless=new', '--no-sandbox', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
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
    const waiting = new Map<number, (m: { result?: { result?: { value?: unknown } } }) => void>()
    ws.addEventListener('message', e => {
      const m = JSON.parse(String(e.data)) as { id?: number }
      if (m.id !== undefined) { waiting.get(m.id)?.(m as never); waiting.delete(m.id) }
    })
    const send = async (method: string, params: object = {}): Promise<{ result?: { result?: { value?: unknown } } }> =>
      await new Promise(resolve => { const i = ++id; waiting.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })) })
    const value = async (expression: string): Promise<unknown> => (await send('Runtime.evaluate', { expression })).result?.result?.value
    await send('Page.navigate', { url: `${server}/shot/?${new URLSearchParams(query).toString()}` })
    const started = Date.now()
    let title = ''
    while (Date.now() - started < timeout) {
      await sleep(250)
      title = String(await value('document.title'))
      if (title === 'DONE' || title.startsWith('FAILED')) break
    }
    if (title !== 'DONE') throw new Error(title.startsWith('FAILED') ? title : 'The shot timed out')
    const data = String(await value("document.getElementById('shot').toDataURL('image/png')"))
    writeFileSync(out, Buffer.from(data.split(',')[1], 'base64'))
    ws.close()
  } finally {
    chrome.kill()
    rmSync(profile, { recursive: true, force: true })
  }
}
