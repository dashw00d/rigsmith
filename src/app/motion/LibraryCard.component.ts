import { expect, it, vi } from 'vitest'
import { mount, unmount, flushSync } from 'svelte'
import type { LibraryIndexRow } from '../../../server/library.ts'
import type { LibraryClip } from '../../state/api.ts'
import LibraryCard from './LibraryCard.svelte'

it('keeps variant and candidate names in the card hint', async () => {
  vi.stubGlobal('IntersectionObserver', class { observe (): void {} disconnect (): void {} })
  const row: LibraryIndexRow & Pick<LibraryClip, 'variant' | 'candidates'> = { id: 'clip', name: 'Walk', category: 'walk', source: 'mixamo', rig: 'human', duration: 1, loop: true, inPlace: true, tags: [], url: '/walk.glb', addedAt: 0, nameSource: 'motion-candidate', variant: 'Left turn', candidates: [{ name: 'Stride' }] }
  const resolve = vi.fn(async () => ({ ...row, file: 'walk.glb', fps: 30, frames: 30 } as LibraryClip))
  const target = document.createElement('div'); document.body.append(target)
  const component = mount(LibraryCard, { target, props: { clip: row, character: null, resolve } }); flushSync()
  target.querySelector('.label')!.dispatchEvent(new Event('pointerenter'))
  await new Promise(r => setTimeout(r, 500)); flushSync()
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Left turn')
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Stride')
  await unmount(component); target.remove(); vi.unstubAllGlobals()
})
