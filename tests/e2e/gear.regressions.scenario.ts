import assert from 'node:assert/strict'
import type { Mesh } from 'three'
import type { UI } from './gear-ui.ts'

export default {
  name: 'gear.regressions',
  step: 'gear',
  async run (ui: UI): Promise<void> {
    await ui.waitFor({ testid: 'gear-row' })
    await ui.waitFor(r => r.app.selected?.gear.some(g => g.attach.kind === 'skin' && r.gear.isWorn(g.id)) === true, 60_000)
    // A ready, shown skin piece exercises selection, the preview eye and fitting on the actual fixture.
    const piece = await ui.eval(r => {
      const c = r.app.selected
      if (c === null) return null
      const ids = [...document.querySelectorAll<HTMLElement>('[data-testid="gear-row"]')].map(e => e.dataset.id)
      const g = c.gear.find(x => ids.includes(x.id) && x.attach.kind === 'skin' && x.status === 'ready' && r.gear.isWorn(x.id))
      return g === undefined ? null : { id: g.id, name: g.name }
    })
    assert.ok(piece, 'fixture must have a shown, ready skin piece')
    const row = { testid: 'gear-row', id: piece.id }
    const eye = { testid: 'gear-eye', id: piece.id }
    await ui.click(row)
    assert.equal(await ui.eval(r => r.gear.selected), piece.id)
    await ui.waitFor({ role: 'heading', name: piece.name })
    // Deselecting immediately must not be undone by the restore effect.
    await ui.click(row)
    assert.equal(await ui.eval(r => r.gear.selected), null)
    await ui.click(row)
    assert.equal(await ui.eval(r => r.gear.selected), piece.id)

    // Find an actual projected triangle whose ray picks this piece. Then use CDP to click it.
    const point = await ui.eval((r, id) => {
      const stage = r.viewer.stage
      const internals = r.gear as unknown as { rider: { pieces: Map<string, { worn: { meshes: Mesh[] } | null }> } | null }
      const meshes = internals.rider?.pieces.get(id)?.worn?.meshes ?? []
      if (stage === null) return null
      const canvas = stage.renderer.domElement
      const rect = canvas.getBoundingClientRect()
      stage.camera.updateMatrixWorld()
      const v = stage.camera.position.clone()
      const a = v.clone(); const b = v.clone(); const c = v.clone()
      for (const mesh of meshes) {
        mesh.updateWorldMatrix(true, false)
        const pos = mesh.geometry.getAttribute('position')
        if (pos === undefined) continue
        const index = mesh.geometry.index
        const triangles = Math.floor((index?.count ?? pos.count) / 3)
        const count = Math.min(triangles, 240)
        for (let n = 0; n < count; n++) {
          const at = Math.floor(n * triangles / count) * 3
          const vertex = (i: number): number => index === null ? at + i : index.getX(at + i)
          mesh.getVertexPosition(vertex(0), a); mesh.getVertexPosition(vertex(1), b); mesh.getVertexPosition(vertex(2), c)
          v.copy(a).add(b).add(c).multiplyScalar(1 / 3).applyMatrix4(mesh.matrixWorld).project(stage.camera)
          if (Math.abs(v.x) >= 1 || Math.abs(v.y) >= 1 || Math.abs(v.z) >= 1) continue
          const x = (v.x + 1) * rect.width / 2; const y = (1 - v.y) * rect.height / 2
          r.gear.pickAt({ clientX: rect.left + x, clientY: rect.top + y })
          if (r.gear.selected === id) return { x, y }
        }
      }
      return null
    }, piece.id)
    assert.ok(point, 'a visible triangle must be pickable in the viewport')
    await ui.eval(r => { r.gear.select(null) })
    await ui.clickAt({ testid: 'viewport-canvas' }, point.x, point.y)
    assert.equal(await ui.eval(r => r.gear.selected), piece.id, 'a canvas click selects the visible piece')

    await ui.click(eye)
    await ui.eval(async (r, id) => {
      for (let i = 0; i < 100; i++) { if (!r.gear.isWorn(id)) return; await new Promise(resolve => setTimeout(resolve, 50)) }
      throw new Error('piece remained visible after Hide')
    }, piece.id)
    assert.ok(await ui.exists(row), 'hidden folk piece remains in the list')
    assert.equal(await ui.eval((_, id) => document.querySelector(`[data-testid="gear-row"][data-id="${CSS.escape(id)}"]`)?.getAttribute('data-hidden'), piece.id), 'true')
    await ui.click(eye)
    await ui.eval(async (r, id) => {
      for (let i = 0; i < 200; i++) { if (r.gear.isWorn(id)) return; await new Promise(resolve => setTimeout(resolve, 50)) }
      throw new Error('piece did not return after Show')
    }, piece.id)

    const before = await ui.eval((r, id) => r.app.selected!.gear.find(g => g.id === id)!.attach.place, piece.id)
    await ui.click({ role: 'button', name: 'Place it' })
    assert.equal(await ui.eval(r => r.gear.fitting), piece.id)
    const position = { role: 'spinbutton', name: 'Position X' }
    await ui.fill(position, String(before.position[0] + 0.2))
    await ui.key('Enter')
    await ui.click({ testid: 'fit-cancel' })
    await ui.eval(async (r, id) => {
      for (let i = 0; i < 200; i++) { if (r.gear.fitting === null) return; await new Promise(resolve => setTimeout(resolve, 50)) }
      throw new Error(`fit cancellation did not finish for ${id}`)
    }, piece.id)
    assert.deepEqual(await ui.eval((r, id) => r.app.selected!.gear.find(g => g.id === id)!.attach.place, piece.id), before)

    await ui.click({ role: 'button', name: 'Place it' })
    await ui.fill(position, String(before.position[0] + 0.3))
    await ui.key('Enter')
    await ui.click({ testid: 'fit-bind' })
    assert.equal(await ui.eval(r => r.gear.fitting), null)
    assert.notDeepEqual(await ui.eval((r, id) => r.app.selected!.gear.find(g => g.id === id)!.attach.place, piece.id), before, 'Bind keeps the edit')
    await ui.shot('gear-regressions')
  },
}
