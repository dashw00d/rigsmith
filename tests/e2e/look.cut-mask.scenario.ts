import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default { name: 'look.cut-mask', character: 'folk-v6-0ba482', step: 'look', async run (ui) {
  const setup = await ui.eval(async r => {
    const c = r.app.selected!; const skin = c.look.skins!.find(s => s.name === r.dress.worn(c).skin)!
    const { bare } = await import('/state/bare.svelte.ts'); await bare.make(c, [skin])
    const live = r.app.selected!; const source = live.look.cloth!.find(l => l.name === 'long_blue')!
    const layer = { ...source, id: 'e2emask01', name: 'Brush test', slots: ['bottom' as const], cut: {} }
    if (!await r.app.do(live.id, { type: 'look.cloth.add', layer })) throw new Error('Could not create mask test layer')
    r.dress.setLayer(r.app.selected!, 'bottom', layer.id)
    return layer.id
  })
  const row = { testid: 'look-cloth-row', id: setup }
  await ui.click({ testid: 'look-cloth-edit', within: row })
  assert.ok(await ui.exists({ testid: 'look-mask-canvas', within: row }), 'cut editor exposes a UV brush canvas')
  await ui.click({ testid: 'look-mask-open', within: row })
  await ui.waitFor({ testid: 'look-mask-ready', within: row }, 30_000)
  const point = await ui.eval(async (r, id) => {
    const c = r.app.selected!; const layer = c.look.cloth!.find(l => l.id === id)!
    const skin = c.look.skins!.find(s => s.name === r.dress.worn(c).skin)!
    const { clothBody } = await import('/engine/folkview.ts'); const { bodyField } = await import('/engine/clothcut.ts')
    const body = clothBody(r.viewer.character!.bodySkinned)
    const field = bodyField(body.geometry, body.regions, r.viewer.character!.height, 2048)
    const canvas = document.createElement('canvas'); canvas.width = field.width; canvas.height = field.height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    const read = async (url: string) => { const img = await createImageBitmap(await (await fetch(url)).blob()); ctx.drawImage(img, 0, 0); img.close(); return ctx.getImageData(0, 0, canvas.width, canvas.height).data }
    const cloth = await read(r.assets.asset(c, layer.file)!); const barePixels = await read(r.assets.asset(c, skin.bare!)!)
    const regions = new Set(body.list.filter(x => /trouser/i.test(x.material)).map(x => x.id))
    for (let p = 0; p < field.region.length; p++) {
      const x = p % field.width; const y = Math.floor(p / field.width); const i = p * 4
      if (x < 80 || y < 80 || x > field.width - 80 || y > field.height - 80 || !regions.has(field.region[p]) || cloth[i + 3] !== 255 || field.y[p] < 0.4) continue
      if (![0, 1, 2].some(k => Math.abs(cloth[i + k] - barePixels[i + k]) > 45)) continue
      return { x, y, width: field.width, height: field.height, bare: [...barePixels.slice(i, i + 3)] }
    }
    throw new Error('No distinct opaque trouser texel')
  }, setup)
  await ui.eval((_r, value) => { (window as unknown as { maskPoint: typeof value }).maskPoint = value }, point)
  const canvas = { testid: 'look-mask-canvas', within: row }
  const bounds = await ui.eval((_r, id) => {
    const el = document.querySelector(`[data-testid="look-cloth-row"][data-id="${id}"] [data-testid="look-mask-canvas"]`)!
    const rect = el.getBoundingClientRect(); return { width: rect.width, height: rect.height }
  }, setup)
  await ui.clickAt(canvas, (point.x + 0.5) / point.width * bounds.width, (point.y + 0.5) / point.height * bounds.height)
  await ui.click({ role: 'button', name: 'Save mask', within: row })
  await ui.waitFor(r => !!r.app.selected?.look.cloth?.find(l => l.id === 'e2emask01')?.cut?.mask, 30_000)
  const first = await ui.eval(r => r.app.selected!.look.cloth!.find(l => l.id === 'e2emask01')!.cut!.mask!)
  await ui.eval((_r, path) => { (window as unknown as { firstMask: string }).firstMask = path }, first)
  assert.match(first, /^cloth\/e2emask01\.mask\.[0-9a-f]{8}\.png$/)
  await ui.waitFor(async r => {
    const c = r.app.selected!; const skin = c.look.skins!.find(s => s.name === r.dress.worn(c).skin)!
    const mesh = r.viewer.character!.bodySkinned[0]; const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    const image = (m as unknown as { map: { image: CanvasImageSource } }).map.image
    const canvas = document.createElement('canvas'); canvas.width = 2048; canvas.height = 2048
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!; ctx.drawImage(image, 0, 0)
    const target = (window as unknown as { maskPoint?: { x: number, y: number, bare: number[] } }).maskPoint
    if (!skin.bare || !target) return false
    const rgb = ctx.getImageData(target.x, target.y, 1, 1).data
    return target.bare.every((value, i) => Math.abs(value - rgb[i]) <= 3)
  }, 30_000)
  await ui.shot('painted-mask')
  await ui.click({ role: 'button', name: 'Erase', within: row })
  await ui.clickAt(canvas, (point.x + 0.5) / point.width * bounds.width, (point.y + 0.5) / point.height * bounds.height)
  await ui.click({ role: 'button', name: 'Save mask', within: row })
  await ui.waitFor(r => {
    const mask = r.app.selected?.look.cloth?.find(l => l.id === 'e2emask01')?.cut?.mask
    return typeof mask === 'string' && mask !== (window as unknown as { firstMask?: string }).firstMask
  }, 30_000)
  const second = await ui.eval(r => r.app.selected!.look.cloth!.find(l => l.id === 'e2emask01')!.cut!.mask!)
  await ui.eval((_r, path) => { (window as unknown as { secondMask: string }).secondMask = path }, second)
  assert.notEqual(second, first)
  const both = await ui.eval(async (r, paths) => await Promise.all(paths.map(async path => (await fetch(r.assets.asset(r.app.selected!, path)!)).ok)), [first, second])
  assert.deepEqual(both, [true, true])
  await ui.eval((_r, id) => { (document.querySelector(`[data-testid="look-cloth-row"][data-id="${id}"] [data-testid="look-mask-canvas"]`) as HTMLElement).focus() }, setup)
  await ui.press('ctrl+z')
  try { await ui.waitFor(r => r.app.selected?.look.cloth?.find(l => l.id === 'e2emask01')?.cut?.mask === (window as unknown as { firstMask?: string }).firstMask) }
  catch { throw new Error(`Undo did not restore ${first}; current ${await ui.eval(r => r.app.selected!.look.cloth!.find(l => l.id === 'e2emask01')?.cut?.mask)}`) }
  await ui.waitFor(() => document.body.textContent?.includes('Undone:') === true)
  await ui.eval((_r, id) => { (document.querySelector(`[data-testid="look-cloth-row"][data-id="${id}"] [data-testid="look-mask-canvas"]`) as HTMLElement).focus() }, setup)
  await ui.press('ctrl+y')
  try { await ui.waitFor(r => r.app.selected?.look.cloth?.find(l => l.id === 'e2emask01')?.cut?.mask === (window as unknown as { secondMask?: string }).secondMask) }
  catch { throw new Error(`Redo did not restore ${second}; current ${await ui.eval(r => r.app.selected!.look.cloth!.find(l => l.id === 'e2emask01')?.cut?.mask)}`) }
} } satisfies Scenario
