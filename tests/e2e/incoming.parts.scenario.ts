import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Scenario } from './ui.ts'

export default { name: 'incoming.parts', character: 'folk-v6-0ba482', async run (ui) {
  const gear = await ui.eval(r => {
    const c = r.app.selected!
    const g = c.gear.find(x => x.from && x.model && !x.painted && x.attach.kind === 'skin')!
    return { id: g.id, from: g.from!, model: g.model!, attach: g.attach }
  })
  const workspace = process.env.RIGSMITH_WORKSPACE!
  const partial = path.join(workspace, 'incoming', '.ui-fixture.partial')
  const ready = path.join(workspace, 'incoming', 'ui-fixture')
  await mkdir(partial, { recursive: true })
  const model = await readFile(path.join(workspace, 'characters', 'folk-v6-0ba482', gear.model))
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64')
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
  await writeFile(path.join(partial, 'update.glb'), model)
  await writeFile(path.join(partial, 'damaged.glb'), model)
  await writeFile(path.join(partial, 'new.png'), png)
  await writeFile(path.join(partial, 'preview.png'), png)
  await writeFile(path.join(partial, 'manifest.json'), JSON.stringify({ schema: 1, id: 'ui-fixture', at: new Date().toISOString(), tool: 'e2e', space: 'v6', parts: [
    { id: 'update', name: 'Update coat', type: 'piece', file: 'update.glb', sha256: sha(model), from: gear.from, preview: 'preview.png' },
    { id: 'new', name: 'New skin', type: 'skin', file: 'new.png', sha256: sha(png), preview: 'preview.png' },
    { id: 'damaged', name: 'Damaged coat', type: 'piece', file: 'damaged.glb', sha256: '0'.repeat(64) },
  ] }))
  await rename(partial, ready)
  await ui.waitFor(async () => (await (await fetch('/api/incoming')).json()).pending === 3, 15000)
  await ui.waitFor({ testid: 'bar-incoming' })
  await ui.click({ testid: 'bar-incoming' })
  await ui.waitFor({ testid: 'incoming-package', id: 'ui-fixture' })
  const row = (id: string) => ({ testid: 'incoming-part', id, within: { testid: 'incoming-package', id: 'ui-fixture' } })
  assert.match(await ui.text(row('update')), /Update/)
  assert.match(await ui.text(row('new')), /New/)
  assert.match(await ui.text(row('damaged')), /Damaged/)
  assert.equal(await ui.text({ testid: 'incoming-count' }), '3')
  await ui.eval((_r, id) => { (window as unknown as { incomingGearId: string }).incomingGearId = id }, gear.id)
  await ui.click({ role: 'button', name: 'Accept', within: row('update') })
  await ui.waitFor(r => r.app.selected?.gear.find(g => g.id === (window as unknown as { incomingGearId: string }).incomingGearId)?.model?.includes('incoming-') === true, 60000)
  const updated = await ui.eval((r, id) => r.app.selected!.gear.find(g => g.id === id)!, gear.id)
  assert.deepEqual(updated.attach, gear.attach)
  await ui.waitFor(async () => (await (await fetch('/api/incoming')).json()).pending === 2, 15000)
  await ui.click({ role: 'button', name: 'Reject', within: row('new') })
  await ui.waitFor({ role: 'button', name: 'Restore', within: row('new') })
  assert.equal(await ui.text({ testid: 'incoming-count' }), '1')
  await ui.click({ role: 'button', name: 'Restore', within: row('new') })
  await ui.waitFor({ role: 'button', name: 'Reject', within: row('new') })
  assert.equal(await ui.text({ testid: 'incoming-count' }), '2')
  await ui.shot('parts')
} } satisfies Scenario
