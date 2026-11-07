// One frame of a character in the viewer's own renderer, saved as a PNG: src/shot/ (served by the app's dev server)
// opened in headless Chrome (tools/lib/chrome.ts), the canvas read back when the page says DONE. For
// `node tools/rig.ts shot`; CHROME names the browser (default google-chrome).
import { writeFileSync } from 'node:fs'
import { sleep, withChrome } from './chrome.ts'

export async function shot (server: string, query: Record<string, string>, out: string, timeout = 120_000): Promise<void> {
  await withChrome(async page => {
    await page.navigate(`${server}/shot/?${new URLSearchParams(query).toString()}`)
    const started = Date.now()
    let title = ''
    while (Date.now() - started < timeout) {
      await sleep(250)
      title = String(await page.value('document.title').catch(() => ''))
      if (title === 'DONE' || title.startsWith('FAILED')) break
    }
    if (title !== 'DONE') throw new Error(title.startsWith('FAILED') ? title : 'The shot timed out')
    const data = String(await page.value("document.getElementById('shot').toDataURL('image/png')"))
    writeFileSync(out, Buffer.from(data.split(',')[1], 'base64'))
  })
}
