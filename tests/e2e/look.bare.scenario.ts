import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'look.bare', step: 'look',
  async run (ui) {
    await ui.waitFor(r => r.viewer.shownId === r.app.selectedId, 60_000)
    const name = await ui.eval(r => r.app.selected?.look.skins?.[0]?.name ?? null)
    assert.ok(name, 'fixture needs a skin')
    const row = { testid: 'look-skin-row', id: name }
    const invalid = await ui.eval(async (r, skin) => fetch(`/api/characters/${encodeURIComponent(r.app.selected!.id)}/look/bare/${encodeURIComponent(skin)}`, { method: 'PUT', headers: { 'x-rigsmith': '1', 'x-rigsmith-schema': '5' }, body: 'not a png' }).then(x => x.status), name)
    assert.equal(invalid, 400, 'the bare route rejects non-PNG data')
    await ui.eval(async () => {
      await new Promise(resolve => setTimeout(resolve, 4000))
      const target = window as unknown as { bareTasks: number[], bareObserver: PerformanceObserver }
      target.bareTasks = []
      target.bareObserver = new PerformanceObserver(list => { target.bareTasks.push(...list.getEntries().map(e => e.duration)) })
      target.bareObserver.observe({ type: 'longtask' })
    })
    // Ensure this scene really has an occluded trouser region even when the currently worn boots do not hide one.
    await ui.eval(async r => {
      const body = r.viewer.character!.bodySkinned
      const { clothBody } = await import('/engine/folkview.ts')
      const field = clothBody(body)
      let offset = 0
      for (const mesh of body) {
        const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
        const full = (mesh.userData.fullIndex as typeof mesh.geometry.index | undefined) ?? mesh.geometry.index
        if (/trouser/i.test(material.name) && full !== null) {
          const id = field.list.find(region => /trouser/i.test(region.material))?.id
          if (id === undefined) throw new Error('No trouser region')
          const kept: number[] = []
          for (let i = 0; i + 2 < full.count; i += 3) if (field.regions[offset + full.getX(i)] !== id) kept.push(full.getX(i), full.getX(i + 1), full.getX(i + 2))
          if (kept.length === full.count) throw new Error('Trouser region belongs to another mesh')
          mesh.userData.fullIndex = full
          mesh.geometry.setIndex(kept)
          return
        }
        offset += mesh.geometry.getAttribute('position').count
      }
      throw new Error('No indexed trousers')
    })
    await ui.click({ role: 'button', name: 'Make bare', within: row })
    await ui.waitFor({ testid: 'look-bare-badge', within: row }, 60_000)
    const tasks = await ui.eval(async () => {
      await new Promise(resolve => setTimeout(resolve, 200))
      const target = window as unknown as { bareTasks: number[], bareObserver: PerformanceObserver }
      target.bareObserver.disconnect()
      return target.bareTasks
    })
    const result = await ui.eval(async r => {
      const c = r.app.selected!; const skin = c.look.skins![0]
      const original = await createImageBitmap(await (await fetch(r.assets.asset(c, skin.file)!)).blob())
      const madeResponse = await fetch(r.assets.asset(c, skin.bare!)!)
      if (!madeResponse.ok) throw new Error(`Bare file HTTP ${madeResponse.status}`)
      const made = await createImageBitmap(await madeResponse.blob())
      const canvas = document.createElement('canvas'); canvas.width = made.width; canvas.height = made.height
      const ctx = canvas.getContext('2d')!; ctx.drawImage(original, 0, 0); const before = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(made, 0, 0); const after = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      const body = r.viewer.character!.bodySkinned
      const { clothBody } = await import('/engine/folkview.ts')
      const bodyData = clothBody(body)
      const hiddenGroups = new Map<number, number[]>()
      let offset = 0
      for (const mesh of body) {
        const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
        const uv = mesh.geometry.getAttribute('uv')
        const full = (mesh.userData.fullIndex as typeof mesh.geometry.index | undefined) ?? mesh.geometry.index
        const shown = mesh.geometry.index
        const visible = new Set<string>()
        const key = (a: number, b: number, c: number) => `${a},${b},${c}`
        for (let i = 0; i + 2 < (shown?.count ?? uv.count); i += 3) visible.add(key(shown?.getX(i) ?? i, shown?.getX(i + 1) ?? i + 1, shown?.getX(i + 2) ?? i + 2))
        if (/trouser/i.test(material.name)) for (let i = 0; i + 2 < (full?.count ?? uv.count); i += 3) {
          const a = full?.getX(i) ?? i; const b = full?.getX(i + 1) ?? i + 1; const d = full?.getX(i + 2) ?? i + 2
          if (visible.has(key(a, b, d))) continue
          const x = Math.floor((uv.getX(a) + uv.getX(b) + uv.getX(d)) / 3 * canvas.width)
          const y = Math.floor((1 - (uv.getY(a) + uv.getY(b) + uv.getY(d)) / 3) * canvas.height)
          if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue
          const region = bodyData.regions[offset + a]
          const samples = hiddenGroups.get(region) ?? []; samples.push((y * canvas.width + x) * 4); hiddenGroups.set(region, samples)
        }
        offset += uv.count
      }
      const samples = (material: RegExp): number[] => {
        const out: number[] = []
        for (const mesh of body) {
          const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
          if (!material.test(m.name)) continue
          const uv = mesh.geometry.getAttribute('uv'); const index = (mesh.userData.fullIndex as typeof mesh.geometry.index | undefined) ?? mesh.geometry.index
          const n = index?.count ?? uv.count
          for (let i = 0; i + 2 < n; i += 3) {
            const a = index?.getX(i) ?? i; const b = index?.getX(i + 1) ?? i + 1; const d = index?.getX(i + 2) ?? i + 2
            const x = Math.floor((uv.getX(a) + uv.getX(b) + uv.getX(d)) / 3 * canvas.width)
            const y = Math.floor((1 - (uv.getY(a) + uv.getY(b) + uv.getY(d)) / 3) * canvas.height)
            if (x >= 0 && x < canvas.width && y >= 0 && y < canvas.height) out.push((y * canvas.width + x) * 4)
          }
        }
        return out
      }
      const face = samples(/face/i); const trousers = samples(/trousers/i)
      // Independent canvas mask of the face/skin triangles, to compare the filled tone with their median.
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = 'white'
      ctx.beginPath()
      for (const mesh of body) {
        const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
        if (!/^(face|skin)$/i.test(mat.name)) continue
        const uv = mesh.geometry.getAttribute('uv'); const idx = mesh.geometry.index; const n = idx?.count ?? uv.count
        for (let i = 0; i + 2 < n; i += 3) {
          for (let j = 0; j < 3; j++) {
            const v = idx?.getX(i + j) ?? i + j; const x = uv.getX(v) * canvas.width; const y = (1 - uv.getY(v)) * canvas.height
            if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
          }
          ctx.closePath()
        }
      }
      ctx.fill()
      const mask = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      const hist = Array.from({ length: 3 }, () => new Uint32Array(256)); let total = 0
      for (let p = 0; p < before.length; p += 4) if (mask[p + 3] === 255 && before[p + 3] > 0) {
        total++; for (let channel = 0; channel < 3; channel++) hist[channel][before[p + channel]]++
      }
      const median = hist.map(channel => { let n = 0; for (let i = 0; i < 256; i++) { n += channel[i]; if (n > total / 2) return i } return 0 })
      const fill = trousers.length ? Array.from(after.slice(trousers[0], trousers[0] + 3)) : []
      const unchanged = face.filter(p => before[p] === after[p] && before[p + 1] === after[p + 1] && before[p + 2] === after[p + 2]).length
      const changed = trousers.filter(p => before[p] !== after[p] || before[p + 1] !== after[p + 1] || before[p + 2] !== after[p + 2]).length
      const hidden = [...hiddenGroups].map(([id, pixels]) => ({ id, total: pixels.length, changed: pixels.filter(p => before[p] !== after[p] || before[p + 1] !== after[p + 1] || before[p + 2] !== after[p + 2]).length }))
      return { face: face.length, unchanged, trousers: trousers.length, changed, hidden, path: skin.bare, median, fill, total }
    })
    assert.ok(result.face > 0 && result.unchanged === result.face, 'face texels stay unchanged')
    assert.ok(result.trousers > 0 && result.changed > result.trousers / 2, 'trousers become skin toned')
    assert.ok(result.hidden.length > 0, 'fixture must hide some trousers under worn gear')
    assert.ok(result.hidden.every(region => region.changed > 0), `every hidden trouser region changes: ${JSON.stringify(result.hidden)}`)
    assert.ok(result.total > 0 && result.fill.every((v, i) => Math.abs(v - result.median[i]) <= 8), `trouser tone ${result.fill} differs from skin median ${result.median}`)
    await ui.shot('bare')
    await ui.press('ctrl+z')
    await ui.waitFor(r => r.app.selected?.look.skins?.[0]?.bare === undefined)
    assert.ok(result.path)
    const retained = await ui.eval(async (r, file) => (await fetch(r.assets.asset(r.app.selected!, file)!)).ok, result.path)
    assert.ok(retained, 'undo keeps the file')
    console.log(`look.bare main-thread tasks over 50 ms: ${tasks.length ? tasks.join(', ') : 'none'}`)
  },
} satisfies Scenario
