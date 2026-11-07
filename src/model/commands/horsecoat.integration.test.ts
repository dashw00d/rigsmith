// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'

const dir = mkdtempSync(path.join(tmpdir(), 'rigsmith-coat-'))
process.env.RIGSMITH_WORKSPACE = dir
let store: typeof import('../../../server/store.ts')
let commands: typeof import('../../../server/commands.ts')
beforeAll(async () => {
  store = await import('../../../server/store.ts')
  commands = await import('../../../server/commands.ts')
  await store.ensureWorkspace()
})
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

it.fails('renames a horse coat and every matching rider together, then undoes and redoes together', async () => {
  const horse = (await store.createCharacter('Horse.glb', Buffer.from('horse'))).id
  const rider = (await store.createCharacter('Rider.glb', Buffer.from('rider'))).id
  const other = (await store.createCharacter('Other.glb', Buffer.from('other'))).id
  await store.updateCharacter(horse, c => { c.look.skins = [{ name: 'bay', file: 'skins/bay.png' }]; c.look.skin = 'bay' })
  await store.updateCharacter(rider, c => { c.mount = { character: horse, bone: 'Spine', position: [0, 1, 0], rotation: [0, 0, 0], freeze: [], pose: {}, skin: 'bay' } })
  await store.updateCharacter(other, c => { c.mount = { character: 'different-horse', bone: 'Spine', position: [0, 1, 0], rotation: [0, 0, 0], freeze: [], pose: {}, skin: 'bay' } })
  const done = await commands.runCommands(horse, [{ type: 'look.skin.update', name: 'bay', patch: { name: 'bay_dark' } }])
  expect((await store.getCharacter(horse))!.look.skin).toBe('bay_dark')
  expect((await store.getCharacter(rider))!.mount!.skin).toBe('bay_dark')
  expect((await store.getCharacter(other))!.mount!.skin).toBe('bay')
  const undone = await commands.undo(horse, done.entry!.seq)
  expect((await store.getCharacter(horse))!.look.skin).toBe('bay')
  expect((await store.getCharacter(rider))!.mount!.skin).toBe('bay')
  await commands.undo(horse, undone.entry!.seq)
  expect((await store.getCharacter(horse))!.look.skin).toBe('bay_dark')
  expect((await store.getCharacter(rider))!.mount!.skin).toBe('bay_dark')
})
