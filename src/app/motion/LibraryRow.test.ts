import { afterEach, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import { makeCharacter } from '../../model/fixtures.ts'
import type { LibraryIndexRow } from '../../../server/library.ts'
const mocks = vi.hoisted(() => ({ play: vi.fn(), add: vi.fn() }))
vi.mock('../../state/animator.svelte.ts', () => ({ animator: { playLibrary: mocks.play } }))
vi.mock('../../state/slots.svelte.ts', () => ({ slots: { names: [], armed: null, addTrial: mocks.add } }))
vi.mock('../../ui/contextmenu.ts', () => ({ contextMenu: () => ({}) }))
import LibraryRow from './LibraryRow.svelte'
const character = makeCharacter()
const clip = { id: 'walk', name: 'Walk', category: 'walk', duration: 1, loop: true, rig: character.skeleton.template ?? 'human' } as LibraryIndexRow
let instance: ReturnType<typeof mount>
let second: ReturnType<typeof mount> | undefined
afterEach(async () => { await unmount(instance); if (second) { await unmount(second); second = undefined }; document.body.replaceChildren(); vi.clearAllMocks() })
it('leaves Enter and Space on the add button for native activation', async () => {
  const target = document.createElement('div'); document.body.append(target)
  instance = mount(LibraryRow, { target, props: { clip, character, uses: 0, resolve: async () => clip as never } })
  flushSync()
  const button = target.querySelector('button')!
  for (const key of ['Enter', ' ']) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    button.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  }
  expect(mocks.play).not.toHaveBeenCalled()
  button.click(); await vi.waitFor(() => expect(mocks.add).toHaveBeenCalledOnce())
})
it('plays the most recently hovered row when lookups finish out of order', async () => {
  const target = document.createElement('div'); document.body.append(target)
  let resolveFirst!: (value: never) => void
  const first = new Promise<never>(resolve => { resolveFirst = resolve })
  const other = { ...clip, id: 'run', name: 'Run' }
  instance = mount(LibraryRow, { target, props: { clip, character, uses: 0, resolve: () => first } })
  second = mount(LibraryRow, { target, props: { clip: other, character, uses: 0, resolve: async () => other as never } })
  flushSync()
  const rows = target.querySelectorAll('[data-testid="lib-clip"]')
  rows[0].dispatchEvent(new Event('pointerenter'))
  rows[1].dispatchEvent(new Event('pointerenter'))
  await vi.waitFor(() => expect(mocks.play).toHaveBeenCalledWith(other))
  resolveFirst(clip as never)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(mocks.play).toHaveBeenCalledTimes(1)
})
