import { afterEach, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import { makeCharacter } from '../../model/fixtures.ts'
import type { LibraryIndexRow } from '../../../server/library.ts'
const mocks = vi.hoisted(() => ({ sprite: vi.fn(async () => null) }))
vi.mock('../../state/animator.svelte.ts', () => ({ animator: { previewVersion: 0, playing: null, sprite: mocks.sprite } }))
vi.mock('../../state/slots.svelte.ts', () => ({ slots: { names: [], armed: null } }))
vi.mock('../../ui/contextmenu.ts', () => ({ contextMenu: () => ({}) }))
import LibraryCard from './LibraryCard.svelte'
let instance: ReturnType<typeof mount>
afterEach(async () => { await unmount(instance); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.clearAllMocks() })
it('does not render a sprite for a clip with an incompatible rig', async () => {
  vi.stubGlobal('IntersectionObserver', class {
    private callback: IntersectionObserverCallback
    constructor (callback: IntersectionObserverCallback) { this.callback = callback }
    observe () { this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
    disconnect () {}
  })
  const target = document.createElement('div'); document.body.append(target)
  const clip = { id: 'horse', name: 'Horse', rig: 'horse', duration: 1, nameSource: 'source', loop: true, url: '/horse.glb' } as LibraryIndexRow
  instance = mount(LibraryCard, { target, props: { clip, character: makeCharacter(), resolve: async () => clip as never } }); flushSync()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(mocks.sprite).not.toHaveBeenCalled()
})
