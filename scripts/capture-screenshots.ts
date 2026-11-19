// Regenerates the README screenshots in docs/screenshots/ from a running Rigsmith, with headless Chrome. It drives the
// real app (nothing is mocked) and writes plain PNGs; with Pillow installed they are then scaled to 1280 px wide and
// palette-reduced to keep them small. `docs/screenshots/` also holds a few shots taken by hand (Huntress, Bearguard,
// Farmer): those are not made by this script.
//
//   RIGSMITH_WORKSPACE=<a COPY of a workspace> node scripts/capture-screenshots.ts [--url http://127.0.0.1:5190] [--out docs/screenshots]
//
// Run it on a copy of a workspace (and its server), never your live one: it only reads, but the app writes thumbnails
// and migrates old characters on open. It looks characters up by name (Archer, Knight, Healer, Folk V6, Horse Archer),
// so edit CASES for your own. `google-chrome` is used unless CHROME names another browser. The game repo path shows on
// Ship's page: point Settings at something neutral first.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { sleep, withChrome, type Page } from '../tools/lib/chrome.ts'

const root = path.resolve(import.meta.dirname, '..')
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}
const url = arg('url', 'http://127.0.0.1:5190').replace(/\/$/, '')
const out = path.resolve(root, arg('out', 'docs/screenshots'))
mkdirSync(out, { recursive: true })

const headers = { 'x-rigsmith': '1', 'x-rigsmith-schema': '2' }
const all = await (await fetch(`${url}/api/characters`, { headers })).json() as Array<{ id: string, name: string }>
const idOf = (name: string): string => {
  const c = all.find(c => c.name.toLowerCase() === name.toLowerCase())
  if (c === undefined) throw new Error(`No character named ${name} in this workspace`)
  return c.id
}

type Fn = (page: Page) => Promise<void>

async function open (step: string, who: string, size: [number, number], fn: Fn): Promise<void> {
  const id = idOf(who)
  await withChrome(async page => {
    await page.setViewport(size[0], size[1])
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.clear(); localStorage.setItem('rigsmith.selected', ${JSON.stringify(id)}); localStorage.setItem('rigsmith.step', ${JSON.stringify(step)})` })
    await page.navigate(`${url}/`)
    await page.until(`(() => { const r = window.__rigsmith; return r !== undefined && r.app.selectedId === ${JSON.stringify(id)} && r.app.selected !== null && r.app.step === ${JSON.stringify(step)} && !r.viewer.loading && r.app.busy === null })()`, 120_000, `the ${step} step`)
    await sleep(4000)
    await fn(page)
  })
}

/** Click the first visible control whose text, aria-label or title contains `text` (or the nth match of `selector`). */
async function click (page: Page, text: string, selector = 'button, [role=button], [role=tab]'): Promise<void> {
  const at = await page.value(`(() => { const want = ${JSON.stringify(text.toLowerCase())}; const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.offsetParent !== null && ((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.title || '')).toLowerCase().includes(want)); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2] })()`) as [number, number] | null
  if (at === null) throw new Error(`No control "${text}"`)
  await page.click(at[0], at[1])
  await sleep(800)
}
async function clickNth (page: Page, selector: string, n: number): Promise<void> {
  const at = await page.value(`(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${n}]; if (!e) return null; const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2] })()`) as [number, number] | null
  if (at === null) throw new Error(`No ${selector} #${n}`)
  await page.click(at[0], at[1])
  await sleep(800)
}
const setSelect = async (page: Page, from: string, to: string): Promise<void> => {
  await page.value(`(() => { const s = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.text.trim() === ${JSON.stringify(from)})); const o = [...s.options].find(o => o.text.trim() === ${JSON.stringify(to)}); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await sleep(2500)
}
/** Play slot number `n` of the Motion step's clip list, then stop on `frame` (30 fps). */
async function pauseOn (page: Page, frame: number): Promise<void> {
  await click(page, 'Pause')
  await page.value(`window.__rigsmith.animator.seek(${frame / 30})`)
  await sleep(1000)
}
async function drag (page: Page, from: [number, number], dx: number): Promise<void> {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from[0], y: from[1] })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from[0], y: from[1], button: 'left', clickCount: 1 })
  for (let i = 1; i <= 10; i++) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from[0] + dx * i / 10, y: from[1], button: 'left', buttons: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from[0] + dx, y: from[1], button: 'left', clickCount: 1 })
  await sleep(1000)
}
const shot = async (page: Page, name: string): Promise<void> => { await page.screenshot(path.join(out, name)); console.log(`wrote ${name}`) }
const W = 1440

// Rigging: the skeleton step.
await open('skeleton', 'Healer', [W, 900], async page => { await shot(page, 'skeleton-healer.png') })

// Look: clothes layers on the dynamic character.
await open('look', 'Folk V6 (dynamic)', [W, 900], async page => { await shot(page, 'look-clothes.png') })

// Gear: the bowstring pull, seen from the side at the draw, with the pull's panel.
await open('gear', 'Archer', [W, 1000], async page => {
  await setSelect(page, 'Rest', 'Attack')
  await pauseOn(page, 26)
  await clickNth(page, '[data-testid=gear-row]', 0)
  await drag(page, [700, 400], -160)
  await page.value(`(() => { const h = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && e.innerText && e.innerText.trim() === 'HANDLES'); h && h.scrollIntoView({ block: 'start' }) })()`)
  await sleep(800)
  await shot(page, 'gear-bow-pull.png')
})

// Motion: an event with its sound (the Release of the Attack clip).
await open('motion', 'Archer', [W, 1000], async page => {
  await clickNth(page, 'button[aria-label*=lay]', 4)
  await sleep(1500)
  await pauseOn(page, 28)
  await page.click(1023, 835)   // the Release event on the Events row
  await sleep(1200)
  await click(page, 'Frame the character')
  await sleep(1200)
  await shot(page, 'events-sound.png')
})

// Motion: the clip library, each card previewed on this character.
await open('motion', 'Archer', [W, 900], async page => {
  await click(page, 'Library')
  await page.value(`(() => { const i = document.querySelector('input[placeholder^="Search"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'bow'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await sleep(25000)
  await shot(page, 'motion-library.png')
})

// Mounted units: a rider on his horse, in Motion and in Ship (the game unit's companion and the Mount section).
await open('motion', 'Knight', [W, 1000], async page => {
  await clickNth(page, 'button[aria-label*=lay]', 2)
  await sleep(2000)
  await pauseOn(page, 20)
  await click(page, 'Frame the character')
  await sleep(1200)
  await shot(page, 'mounted-knight-motion.png')
})
await open('ship', 'Knight', [W, 1000], async page => { await sleep(3000); await shot(page, 'mounted-knight-ship.png') })

// Dynamic characters: the wardrobe and a crowd.
await open('gear', 'Folk V6 (dynamic)', [W, 1000], async page => {
  await click(page, 'Wardrobe')
  await sleep(4000)
  await shot(page, 'wardrobe-sets.png')
  await clickNth(page, 'button[aria-label*=lose]', 0)
  await click(page, 'Crowd')
  await sleep(9000)
  await shot(page, 'crowd-preview.png')
})

// The command line: real output of tools/rig.ts, set in a terminal-like page.
const rig = (...args: string[]): string => execFileSync(process.execPath, [path.join(root, 'tools', 'rig.ts'), ...args], { encoding: 'utf8', env: { ...process.env, RIGSMITH_URL: url } }).trimEnd().split('\n').slice(0, args[0] === 'show' ? 17 : 99).join('\n')
const commands = [['list'], ['show', 'Archer']]
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const body = commands.map(c => `<div class="p">$ node tools/rig.ts ${esc(c.join(' '))}</div><pre>${esc(rig(...c))}</pre>`).join('')
const dir = mkdtempSync(path.join(os.tmpdir(), 'rigsmith-cli-'))
try {
  const file = path.join(dir, 'cli.html')
  writeFileSync(file, `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; background: #0f1117; color: #d7dae0; font: 14px/1.5 'DejaVu Sans Mono', monospace; padding: 22px 26px; overflow: hidden; }
    .p { color: #8fd694; margin-top: 14px } pre { margin: 2px 0 0; white-space: pre-wrap } </style>${body}`)
  await withChrome(async page => {
    await page.setViewport(1280, 800)
    await page.navigate(pathToFileURL(file).href)
    await sleep(800)
    await shot(page, 'cli.png')
  })
} finally { rmSync(dir, { recursive: true, force: true }) }

// Scale to 1280 px wide and reduce to a palette (needs python3 with Pillow; skipped without it).
const files = ['skeleton-healer', 'look-clothes', 'gear-bow-pull', 'events-sound', 'motion-library', 'mounted-knight-motion', 'mounted-knight-ship', 'wardrobe-sets', 'crowd-preview', 'cli'].map(n => path.join(out, `${n}.png`))
try {
  execFileSync('python3', ['-c', 'import sys\nfrom PIL import Image\nfor f in sys.argv[1:]:\n    im = Image.open(f).convert("RGB")\n    if im.width > 1280: im = im.resize((1280, round(im.height * 1280 / im.width)), Image.LANCZOS)\n    im.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(f, optimize=True)', ...files])
} catch { console.log('Pillow not available: screenshots left at full size') }
console.log(readdirSync(out).join('\n'))
