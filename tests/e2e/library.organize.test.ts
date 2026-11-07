import { expect, it } from 'vitest'
import { openLibraryAfterReload } from './library.organize.scenario.ts'
import type { UI } from './ui.ts'
it('waits for the Motion inspector after reload before clicking Library', async () => {
  const calls: unknown[] = []
  const ui = {
    waitFor: async (selector: unknown) => { calls.push(selector) },
    click: async (selector: unknown) => { calls.push(selector) },
  } as unknown as UI
  await openLibraryAfterReload(ui)
  expect(calls.slice(1)).toEqual([{ role: 'button', name: 'Library' }, { role: 'button', name: 'Library' }])
})
