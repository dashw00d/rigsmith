// The scenario-facing API. Selectors use real accessible names or stable testids, never CSS classes.
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { sleep, type Page } from '../../tools/lib/chrome.ts'
import type { app } from '../../src/state/app.svelte.ts'
import type { gear } from '../../src/state/gear.svelte.ts'
import type { dress } from '../../src/state/dress.svelte.ts'
import type { viewer } from '../../src/state/viewer.svelte.ts'
import type { animator } from '../../src/state/animator.svelte.ts'
import type { assets } from '../../src/state/assets.svelte.ts'
import type { ship } from '../../src/state/ship.svelte.ts'
import type { wardrobe } from '../../src/app/gear/wardrobe.svelte.ts'

export interface Rigsmith { app: typeof app, gear: typeof gear, dress: typeof dress, viewer: typeof viewer, animator: typeof animator, assets: typeof assets, ship: typeof ship, wardrobe: typeof wardrobe }
export type Selector = { testid: string, id?: string, within?: Selector } | { role: string, name: string, within?: Selector }
export interface Scenario { name: string, character?: string, step?: string, allowErrors?: boolean, run: (ui: UI) => Promise<void> }
interface AXNode { backendDOMNodeId?: number, role?: { value?: string }, name?: { value?: string }, ignored?: boolean }
interface DomReply { result?: { root?: { nodeId: number }, nodeIds?: number[], nodeId?: number, object?: { objectId?: string }, nodes?: AXNode[], result?: { value?: unknown } }, error?: { message?: string } }

/** Human-readable locator for failure reports. */
export function selectorDescription (selector: Selector): string {
  const own = 'testid' in selector ? `testid=${JSON.stringify(selector.testid)}${selector.id === undefined ? '' : ` data-id=${JSON.stringify(selector.id)}`}` : `role=${JSON.stringify(selector.role)} name=${JSON.stringify(selector.name)}`
  return selector.within === undefined ? own : `${own} within (${selectorDescription(selector.within)})`
}

export class UI {
  private readonly page: Page
  private readonly shots: string
  private readonly scenario: string
  constructor (page: Page, shots: string, scenario: string) { this.page = page; this.shots = shots; this.scenario = scenario }

  private async send (method: string, params: object = {}): Promise<DomReply> {
    const r = await this.page.send(method, params) as unknown as DomReply
    if (r.error !== undefined) throw new Error(`${method}: ${r.error.message ?? 'protocol error'}`)
    return r
  }
  private async document (): Promise<number> {
    const doc = await this.send('DOM.getDocument', { depth: 0, pierce: true })
    if (doc.result?.root === undefined) throw new Error('No document')
    return doc.result.root.nodeId
  }
  private async call (nodeId: number, fn: string): Promise<unknown> {
    const resolved = await this.send('DOM.resolveNode', { nodeId })
    const objectId = resolved.result?.object?.objectId
    if (objectId === undefined) throw new Error('Element no longer exists')
    try {
      const reply = await this.send('Runtime.callFunctionOn', { objectId, functionDeclaration: fn, returnByValue: true, awaitPromise: true })
      return reply.result?.result?.value
    } finally { await this.send('Runtime.releaseObject', { objectId }) }
  }
  private async nodes (selector: Selector): Promise<number[]> {
    const root = selector.within === undefined ? await this.document() : await this.one(selector.within)
    if ('testid' in selector) {
      const css = `[data-testid=${JSON.stringify(selector.testid)}]${selector.id === undefined ? '' : `[data-id=${JSON.stringify(selector.id)}]`}`
      const result = await this.send('DOM.querySelectorAll', { nodeId: root, selector: css })
      return result.result?.nodeIds ?? []
    }
    const result = await this.send('Accessibility.queryAXTree', { nodeId: root, role: selector.role, accessibleName: selector.name })
    const ax = (result.result?.nodes ?? []).filter(n => !n.ignored && n.role?.value === selector.role && n.name?.value === selector.name && n.backendDOMNodeId !== undefined)
    if (ax.length === 0) return []
    const pushed = await this.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: ax.map(n => n.backendDOMNodeId) })
    return (pushed.result?.nodeIds ?? []).filter(n => n !== 0)
  }
  private async candidates (selector: Selector): Promise<string> {
    if ('testid' in selector) {
      const all = await this.page.value(`Array.from(document.querySelectorAll('[data-testid]'), e => e.getAttribute('data-testid')).filter((x, i, a) => a.indexOf(x) === i).slice(0, 40)`)
      return `available testids: ${JSON.stringify(all)}`
    }
    const result = await this.send('Accessibility.queryAXTree', { nodeId: await this.document(), role: selector.role })
    const names = (result.result?.nodes ?? []).filter(n => !n.ignored && n.role?.value === selector.role).map(n => n.name?.value).filter(Boolean).slice(0, 30)
    return `available ${selector.role} names: ${JSON.stringify(names)}`
  }
  private async one (selector: Selector): Promise<number> {
    const nodes = await this.nodes(selector)
    if (nodes.length !== 1) throw new Error(`${selectorDescription(selector)}: expected one match, found ${nodes.length}; ${await this.candidates(selector)}`)
    return nodes[0]
  }
  private async point (selector: Selector, x?: number, y?: number): Promise<{ x: number, y: number }> {
    const id = await this.one(selector)
    await this.send('DOM.scrollIntoViewIfNeeded', { nodeId: id })
    const rect = await this.call(id, 'function () { const r = this.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height } }') as { x: number, y: number, width: number, height: number }
    if (rect.width === 0 || rect.height === 0) throw new Error(`${selectorDescription(selector)} is not visible`)
    const dx = x ?? rect.width / 2; const dy = y ?? rect.height / 2
    if (dx < 0 || dy < 0 || dx >= rect.width || dy >= rect.height) throw new Error(`Point (${dx}, ${dy}) is outside ${selectorDescription(selector)}`)
    return { x: rect.x + dx, y: rect.y + dy }
  }
  async click (selector: Selector): Promise<void> { const p = await this.point(selector); await this.page.click(p.x, p.y) }
  /** Click coordinates relative to the selected element's top left (CSS pixels). */
  async clickAt (selector: Selector, x: number, y: number): Promise<void> { const p = await this.point(selector, x, y); await this.page.click(p.x, p.y) }
  async rightClick (selector: Selector): Promise<void> { const p = await this.point(selector); await this.page.click(p.x, p.y, 'right') }
  async fill (selector: Selector, text: string): Promise<void> { await this.click(selector); await this.press('ctrl+a'); await this.page.type(text) }
  async key (key: string): Promise<void> { await this.page.key(key) }
  async press (combination: string): Promise<void> {
    const parts = combination.split('+'); const key = parts.pop()
    if (key === undefined || key === '') throw new Error(`Invalid key combination ${combination}`)
    let modifiers = 0
    for (const part of parts) {
      const flag = ({ alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 } as Record<string, number>)[part.toLowerCase()]
      if (flag === undefined) throw new Error(`Unknown key modifier ${part}`)
      modifiers |= flag
    }
    await this.page.key(key, modifiers)
  }
  async exists (selector: Selector): Promise<boolean> { return (await this.nodes(selector)).length > 0 }
  async count (selector: Selector): Promise<number> { return (await this.nodes(selector)).length }
  async text (selector: Selector): Promise<string> { return String(await this.call(await this.one(selector), 'function () { return this.textContent ?? "" }')) }
  /** Execute a self-contained function in the page with the dev hook as its first argument. Arguments must be JSON values. */
  async eval<T, A extends unknown[] = []> (fn: (r: Rigsmith, ...args: A) => T | Promise<T>, ...args: A): Promise<Awaited<T>> {
    return await this.page.value(`(${fn.toString()})(window.__rigsmith, ...${JSON.stringify(args)})`) as Awaited<T>
  }
  /** A serializable snapshot of app selection, characters, step and drawer. For live state use eval. */
  async app (): Promise<Pick<typeof app, 'selected' | 'selectedId' | 'characters' | 'step' | 'drawer'>> {
    return await this.eval(r => ({ selected: r.app.selected, selectedId: r.app.selectedId, characters: r.app.characters, step: r.app.step, drawer: r.app.drawer }))
  }
  async waitFor (target: Selector | ((r: Rigsmith) => boolean | Promise<boolean>), ms = 10_000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < ms) {
      try { if (typeof target === 'function' ? await this.eval(target) : await this.exists(target)) return } catch { /* DOM may be replaced */ }
      await sleep(100)
    }
    throw new Error(typeof target === 'function' ? `Condition not met within ${ms} ms` : `${selectorDescription(target)} not found within ${ms} ms; ${await this.candidates(target)}`)
  }
  async shot (label: string): Promise<string> {
    mkdirSync(this.shots, { recursive: true })
    const safe = (s: string): string => s.replace(/[^a-zA-Z0-9._-]+/g, '-')
    const file = path.join(this.shots, `${safe(this.scenario)}-${safe(label)}.png`)
    await this.page.screenshot(file)
    return file
  }
}
