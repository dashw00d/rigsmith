import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'look.bare', step: 'look',
  async run (ui) {
    await ui.waitFor(r => r.viewer.shownId === r.app.selectedId, 60_000)
    const name = await ui.eval(r => r.app.selected?.look.skins?.[0]?.name ?? null)
    assert.ok(name, 'fixture needs a skin')
    const row = { testid: 'look-skin-row', id: name }
    await ui.click({ role: 'button', name: 'Make bare', within: row })
    await ui.waitFor({ testid: 'look-bare-badge', within: row }, 60_000)
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
      const samples = (material: RegExp): number[] => {
        const out: number[] = []
        for (const mesh of body) {
          const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
          if (!material.test(m.name)) continue
          const uv = mesh.geometry.getAttribute('uv'); const index = mesh.geometry.index
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
      const unchanged = face.filter(p => before[p] === after[p] && before[p + 1] === after[p + 1] && before[p + 2] === after[p + 2]).length
      const changed = trousers.filter(p => before[p] !== after[p] || before[p + 1] !== after[p + 1] || before[p + 2] !== after[p + 2]).length
      return { face: face.length, unchanged, trousers: trousers.length, changed, path: skin.bare }
    })
    assert.ok(result.face > 0 && result.unchanged === result.face, 'face texels stay unchanged')
    assert.ok(result.trousers > 0 && result.changed > result.trousers / 2, 'trousers become skin toned')
    await ui.shot('bare')
    await ui.press('ctrl+z')
    await ui.waitFor(r => r.app.selected?.look.skins?.[0]?.bare === undefined)
    assert.ok(result.path)
    const retained = await ui.eval(async (r, file) => (await fetch(r.assets.asset(r.app.selected!, file)!)).ok, result.path)
    assert.ok(retained, 'undo keeps the file')
  },
} satisfies Scenario
