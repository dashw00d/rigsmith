import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'look.long-sleeves', character: 'folk-v6-0ba482', step: 'look',
  async run (ui) {
    await ui.eval(r => {
      const c = r.app.selected!
      const layer = c.look.cloth!.find(l => l.name === 'long_blue')!
      if (!layer) throw new Error('The v6 fixture needs long_blue')
      const mesh = r.viewer.character!.bodySkinned[0]
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
      ;(window as unknown as { beforeSleeves: unknown }).beforeSleeves = (material as unknown as { map: unknown }).map
      r.dress.wearOutfit(c, null)
      r.dress.setLayer(c, 'top', layer.id)
    })
    await ui.waitFor(r => {
      const mesh = r.viewer.character?.bodySkinned[0]
      if (!mesh) return false
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
      return (material as unknown as { map: unknown }).map !== (window as unknown as { beforeSleeves: unknown }).beforeSleeves
    }, 60_000)
    const result = await ui.eval(async r => {
      const c = r.app.selected!; const view = r.viewer.character!
      const skin = c.look.skins!.find(s => s.name === r.dress.worn(c).skin)!
      const layer = c.look.cloth!.find(l => l.name === 'long_blue')!
      const { clothBody } = await import('/engine/folkview.ts')
      const body = clothBody(view.bodySkinned)
      const load = async (url: string) => await createImageBitmap(await (await fetch(url)).blob())
      const base = await load(r.assets.asset(c, skin.file)!)
      const cloth = await load(r.assets.asset(c, layer.file)!)
      const canvas = document.createElement('canvas'); canvas.width = cloth.width; canvas.height = cloth.height
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      const pixels = (image: CanvasImageSource) => { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height); return ctx.getImageData(0, 0, canvas.width, canvas.height).data }
      const barePixels = pixels(base); const clothPixels = pixels(cloth)
      const mesh = view.bodySkinned[0]; const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
      const actual = pixels((material as unknown as { map: { image: CanvasImageSource } }).map.image)
      // V6 forearms are Skin islands 7 and 11, independent of the shirt-region classification under test.
      const forearms = new Map([[7, { samples: 0, bad: 0 }], [11, { samples: 0, bad: 0 }]])
      const g = body.geometry
      for (let i = 0; i + 2 < g.index.length; i += 3) {
        const a = g.index[i]; const b = g.index[i + 1]; const d = g.index[i + 2]
        const out = forearms.get(body.regions[a]); if (!out) continue
        const x = Math.floor((g.uv[a * 2] + g.uv[b * 2] + g.uv[d * 2]) / 3 * canvas.width)
        const y = Math.floor((g.uv[a * 2 + 1] + g.uv[b * 2 + 1] + g.uv[d * 2 + 1]) / 3 * canvas.height)
        if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue
        const p = (y * canvas.width + x) * 4
        if (clothPixels[p + 3] !== 255 || ![0, 1, 2].some(j => Math.abs(clothPixels[p + j] - barePixels[p + j]) > 20)) continue
        out.samples++
        if ([0, 1, 2].some(j => Math.abs(actual[p + j] - clothPixels[p + j]) > 3)) out.bad++
      }
      return Object.fromEntries(forearms)
    })
    for (const [id, arm] of Object.entries(result)) {
      assert.ok(arm.samples > 10, `forearm ${id} needs visible sleeve samples: ${JSON.stringify(arm)}`)
      assert.ok(arm.bad / arm.samples < 0.02, `forearm ${id} must display the sleeve: ${JSON.stringify(arm)}`)
    }
    await ui.shot('long-sleeves')
  },
} satisfies Scenario
