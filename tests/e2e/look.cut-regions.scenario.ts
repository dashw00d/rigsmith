import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'look.cut-regions', character: 'folk-v6-0ba482', step: 'look',
  async run (ui) {
    await ui.eval(async r => {
      const c = r.app.selected!; const skin = c.look.skins!.find(s => s.name === r.dress.worn(c).skin)!
      const { bare } = await import('/state/bare.svelte.ts')
      await bare.make(c, [skin])
      if (!r.app.selected!.look.skins!.find(s => s.name === skin.name)?.bare) throw new Error('No bare skin')
      const { clothBody } = await import('/engine/folkview.ts')
      const body = clothBody(r.viewer.character!.bodySkinned)
      const regions = body.list.filter(x => /trouser/i.test(x.material)).map(x => x.id)
      const layer = r.app.selected!.look.cloth!.find(l => l.name === 'long_blue')!
      const added = { ...layer, id: 'e2e52001', name: 'E2E cut legs', slots: ['bottom'], cut: { below: [{ regions, y: 0.35, feather: 0 }] } }
      if (!await r.app.do(c.id, { type: 'look.cloth.add', layer: added })) throw new Error('Could not create layer')
      const mesh = r.viewer.character!.bodySkinned[0]; const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
      ;(window as unknown as { cutPrevious: unknown }).cutPrevious = (m as { map: unknown }).map
      r.dress.setLayer(r.app.selected!, 'bottom', added.id)
    })
    await ui.waitFor(r => {
      const mesh = r.viewer.character?.bodySkinned[0]
      if (!mesh) return false
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
      return (mat as { map: unknown }).map !== (window as unknown as { cutPrevious: unknown }).cutPrevious
    }, 60_000)
    const counts = await ui.eval(async r => {
      const c = r.app.selected!; const view = r.viewer.character!
      const skin = c.look.skins!.find(s => s.name === r.dress.worn(c).skin)!
      const layer = c.look.cloth!.find(l => l.id === 'e2e52001')!
      const { clothBody } = await import('/engine/folkview.ts')
      const { bodyField } = await import('/engine/clothcut.ts')
      const body = clothBody(view.bodySkinned)
      const load = async (url: string) => await createImageBitmap(await (await fetch(url)).blob())
      const bare = await load(r.assets.asset(c, skin.bare!)!); const cloth = await load(r.assets.asset(c, layer.file)!)
      const canvas = document.createElement('canvas'); canvas.width = bare.width; canvas.height = bare.height
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      const pixels = (image: CanvasImageSource) => { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height); return ctx.getImageData(0, 0, canvas.width, canvas.height).data }
      const a = pixels(bare); const b = pixels(cloth)
      const mesh = view.bodySkinned[0]; const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
      const actual = pixels((material as { map: { image: CanvasImageSource } }).map.image)
      const field = bodyField(body.geometry, body.regions, view.height, { width: canvas.width, height: canvas.height })
      const sides = new Map(body.list.filter(x => /trouser/i.test(x.material)).map(x => [x.id, x.x < 0 ? 'left' : 'right']))
      const out = { left: { low: 0, lowBad: 0, high: 0, highBad: 0 }, right: { low: 0, lowBad: 0, high: 0, highBad: 0 } }
      for (let p = 0; p < field.region.length; p++) {
        const side = sides.get(field.region[p]); if (!side || b[p * 4 + 3] !== 255) continue
        const low = field.y[p] < 0.30; const high = field.y[p] > 0.40
        if (!low && !high) continue
        const target = low ? a : b; const o = out[side]
        const bad = [0, 1, 2].some(i => Math.abs(actual[p * 4 + i] - target[p * 4 + i]) > 3)
        if (low) { o.low++; if (bad) o.lowBad++ } else { o.high++; if (bad) o.highBad++ }
      }
      // Independently sample glTF triangle centroids in the source image's top-left UV convention.
      const physical = { left: { low: 0, lowBad: 0, high: 0, highBad: 0 }, right: { low: 0, lowBad: 0, high: 0, highBad: 0 } }
      const g = body.geometry
      let sole = Infinity
      for (let i = 1; i < g.positions.length; i += 3) sole = Math.min(sole, g.positions[i])
      for (let i = 0; i + 2 < g.index.length; i += 3) {
        const x = g.index[i]; const y = g.index[i + 1]; const z = g.index[i + 2]
        const side = sides.get(body.regions[x]); if (!side) continue
        const height = ((g.positions[x * 3 + 1] + g.positions[y * 3 + 1] + g.positions[z * 3 + 1]) / 3 - sole) / view.height
        const px = Math.floor((g.uv[x * 2] + g.uv[y * 2] + g.uv[z * 2]) / 3 * canvas.width)
        const py = Math.floor((g.uv[x * 2 + 1] + g.uv[y * 2 + 1] + g.uv[z * 2 + 1]) / 3 * canvas.height)
        if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue
        const p = (py * canvas.width + px) * 4
        if (b[p + 3] !== 255) continue
        const low = height < 0.30; const high = height > 0.40
        if (!low && !high) continue
        const target = low ? a : b; const o = physical[side]
        const bad = [0, 1, 2].some(channel => Math.abs(actual[p + channel] - target[p + channel]) > 3)
        if (low) { o.low++; if (bad) o.lowBad++ } else { o.high++; if (bad) o.highBad++ }
      }
      return { field: out, physical }
    })
    for (const side of ['left', 'right'] as const) {
      const c = counts.physical[side]
      assert.ok(c.low > 20 && c.high > 20, `${side} needs samples on each side of the hem: ${JSON.stringify(c)}`)
      assert.ok(c.lowBad / c.low < 0.01 && c.highBad / c.high < 0.01, `${side} cut pixels differ: ${JSON.stringify(c)}`)
    }
    await ui.shot('both-legs')
  },
} satisfies Scenario
