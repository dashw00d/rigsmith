import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'look.empty-slots', character: 'folk-v6-0ba482', step: 'look',
  async run (ui) {
    const setup = await ui.eval(async r => {
      const c = r.app.selected!; const skin = c.look.skins!.find(s => s.name === r.dress.worn(c).skin)!
      const { bare } = await import('/state/bare.svelte.ts')
      await bare.make(c, [skin])
      const live = r.app.selected!; const skinNow = live.look.skins!.find(s => s.name === skin.name)!
      if (!skinNow.bare) throw new Error('Make bare did not attach the image')
      const { clothBody } = await import('/engine/folkview.ts')
      const body = clothBody(r.viewer.character!.bodySkinned)
      const legs = body.list.filter(x => /trouser/i.test(x.material)).map(x => x.id)
      const source = live.look.cloth!.find(l => /long_blue/.test(l.name))!
      const layer = { ...source, id: 'e2e50001', name: 'E2E Shorts', slots: ['bottom' as const], cut: { below: [{ regions: legs, y: 0.35, feather: 0 }] } }
      const entry = await r.app.do(live.id, { type: 'look.cloth.add', layer })
      if (!entry) throw new Error('Could not add shorts')
      const mesh = r.viewer.character!.bodySkinned[0]
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
      ;(window as unknown as { previousMap: unknown }).previousMap = (material as { map?: unknown }).map
      r.dress.setLayer(r.app.selected!, 'bottom', layer.id)
      r.dress.setLayer(r.app.selected!, 'top', null)
      r.dress.setLayer(r.app.selected!, 'over', null)
      return { skin: skin.name, layer: layer.id }
    })
    await ui.waitFor(r => {
      const mesh = r.viewer.character?.bodySkinned[0]
      if (!mesh) return false
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
      return (material as { map?: unknown }).map !== (window as unknown as { previousMap: unknown }).previousMap
    }, 60_000)
    const result = await ui.eval(async (r, info) => {
      const c = r.app.selected!; const skin = c.look.skins!.find(s => s.name === info.skin)!
      const layer = c.look.cloth!.find(l => l.id === info.layer)!
      const { clothBody } = await import('/engine/folkview.ts')
      const body = clothBody(r.viewer.character!.bodySkinned)
      const { bodyField, composeSlots } = await import('/engine/clothcut.ts')
      const image = async (url: string) => await createImageBitmap(await (await fetch(url)).blob())
      const bare = await image(r.assets.asset(c, skin.bare!)!)
      const cloth = await image(r.assets.asset(c, layer.file)!)
      const painted = await image(r.assets.asset(c, skin.file)!)
      const canvas = document.createElement('canvas'); canvas.width = bare.width; canvas.height = bare.height
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      const read = (pic: CanvasImageSource) => { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(pic, 0, 0, canvas.width, canvas.height); return ctx.getImageData(0, 0, canvas.width, canvas.height).data }
      const barePixels = read(bare); const clothPixels = read(cloth); const paintedPixels = read(painted)
      const mesh = r.viewer.character!.bodySkinned[0]; const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
      const actual = read((material as unknown as { map: { image: CanvasImageSource } }).map.image)
      const field = bodyField(body.geometry, body.regions, r.viewer.character!.height, { width: canvas.width, height: canvas.height })
      const pixels = (rgba: Uint8ClampedArray) => ({ rgba, width: canvas.width, height: canvas.height })
      const composed = composeSlots({ base: pixels(paintedPixels), bare: pixels(barePixels), field, regions: body.list,
        layers: [{ ...pixels(clothPixels), id: layer.id, slots: layer.slots, cut: layer.cut }] }).rgba
      const geom = body.geometry; const legIds = new Set(body.list.filter(x => /trouser/i.test(x.material)).map(x => x.id))
      let sole = Infinity
      for (let i = 1; i < geom.positions.length; i += 3) sole = Math.min(sole, geom.positions[i])
      let low: number[] | null = null; let high: number[] | null = null
      const shirtIds = new Set(body.list.filter(x => /shirt/i.test(x.material)).map(x => x.id))
      let shirt: number[] | null = null
      for (let i = 0; i + 2 < geom.index.length; i += 3) {
        const a = geom.index[i]; const b = geom.index[i + 1]; const d = geom.index[i + 2]
        if (!legIds.has(body.regions[a]) && !shirtIds.has(body.regions[a])) continue
        const y = ((geom.positions[a * 3 + 1] + geom.positions[b * 3 + 1] + geom.positions[d * 3 + 1]) / 3 - sole) / r.viewer.character!.height
        const x = Math.floor((geom.uv[a * 2] + geom.uv[b * 2] + geom.uv[d * 2]) / 3 * canvas.width)
        const v = Math.floor(((geom.uv[a * 2 + 1] + geom.uv[b * 2 + 1] + geom.uv[d * 2 + 1]) / 3) * canvas.height)
        if (x < 0 || v < 0 || x >= canvas.width || v >= canvas.height) continue
        const p = (v * canvas.width + x) * 4
        if (shirtIds.has(body.regions[a])) {
          if ([0, 1, 2].some(i => Math.abs(paintedPixels[p + i] - barePixels[p + i]) > 20)) shirt ??= [actual[p], actual[p + 1], actual[p + 2], paintedPixels[p], paintedPixels[p + 1], paintedPixels[p + 2], barePixels[p], barePixels[p + 1], barePixels[p + 2], clothPixels[p], clothPixels[p + 1], clothPixels[p + 2], clothPixels[p + 3], composed[p], composed[p + 1], composed[p + 2]]
          continue
        }
        if (clothPixels[p + 3] < 250) continue
        const row = [actual[p], actual[p + 1], actual[p + 2], barePixels[p], barePixels[p + 1], barePixels[p + 2], clothPixels[p], clothPixels[p + 1], clothPixels[p + 2], composed[p], composed[p + 1], composed[p + 2]]
        if (y < 0.25 && low === null) low = row
        if (y > 0.45 && high === null) high = row
        if (low && high && shirt) break
      }
      return { low, high, shirt }
    }, setup)
    assert.ok(result.low && result.high, 'fixture must have opaque cloth above and below the cut')
    assert.ok(result.low.slice(9, 12).every((v, i) => Math.abs(v - result.low![i + 3]) <= 3), `slot composite reveals bare shin: ${result.low}`)
    assert.ok(result.high.slice(9, 12).every((v, i) => Math.abs(v - result.high![i + 6]) <= 3), `slot composite retains cloth thigh: ${result.high}`)
    assert.ok(result.low.slice(0, 3).every((v, i) => Math.abs(v - result.low![i + 3]) <= 3), `shin is bare: ${result.low}`)
    assert.ok(result.high.slice(0, 3).every((v, i) => Math.abs(v - result.high![i + 6]) <= 3), `thigh wears cloth: ${result.high}`)
    assert.ok(result.shirt, 'fixture must have a painted shirt distinct from bare skin')
    assert.ok(result.shirt.slice(13, 16).every((v, i) => Math.abs(v - result.shirt![i + 3]) <= 3), `slot composite preserves painted shirt: ${result.shirt}`)
    assert.ok(result.shirt.slice(0, 3).every((v, i) => Math.abs(v - result.shirt![i + 3]) <= 3), `empty top retains painted shirt: ${result.shirt}`)
    await ui.shot('empty-top')
  },
} satisfies Scenario
