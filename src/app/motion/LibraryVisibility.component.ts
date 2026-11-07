import { expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import type { LibraryIndexRow } from '../../../server/library.ts'
import type { LibraryClip } from '../../state/api.ts'
import { makeCharacter } from '../../model/fixtures.ts'
import { animator } from '../../state/animator.svelte.ts'
import LibraryCard from './LibraryCard.svelte'

it.fails('cancels the sprite request when its card leaves view', async () => {
  let notify!: (visible: boolean) => void
  vi.stubGlobal('IntersectionObserver', class {
    constructor (callback: IntersectionObserverCallback) { notify = visible => callback([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
    observe (): void {} disconnect (): void {}
  })
  const sprite = vi.spyOn(animator, 'sprite').mockImplementation(async () => await new Promise<string | null>(() => {}))
  const clip: LibraryIndexRow = { id: 'clip', name: 'Walk', category: 'walk', source: 'mixamo', rig: 'human', duration: 1, loop: true, inPlace: true, tags: [], url: '/walk.glb', addedAt: 0 }
  const target = document.createElement('div'); document.body.append(target)
  const component = mount(LibraryCard, { target, props: { clip, character: makeCharacter(), resolve: async () => ({} as LibraryClip) } }); flushSync()
  notify(true); flushSync()
  expect(sprite).toHaveBeenCalledOnce()
  const signal = (sprite.mock.calls as unknown as Array<[string, AbortSignal | undefined]>)[0][1]
  expect(signal).toBeDefined()
  notify(false); flushSync()
  expect(signal?.aborted).toBe(true)
  await unmount(component); target.remove(); sprite.mockRestore(); vi.unstubAllGlobals()
})
