import { afterEach, expect, it, vi } from 'vitest'
import { createRawSnippet, flushSync, mount, unmount } from 'svelte'
import VirtualList from './VirtualList.svelte'

let instance: ReturnType<typeof mount> | undefined
afterEach(async () => { if (instance) await unmount(instance); document.body.replaceChildren(); vi.unstubAllGlobals() })

it('windows thousands of rows and tracks scrolling', () => {
  vi.stubGlobal('ResizeObserver', class { observe () {} disconnect () {} })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(450)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300)
  const target = document.createElement('div'); document.body.append(target)
  const snippet = createRawSnippet<[unknown[], number]>((getRow) => ({ render: () => `<span data-value="${getRow()[0]}">${getRow()[0]}</span>` }))
  instance = mount(VirtualList, { target, props: { items: Array.from({ length: 2600 }, (_, i) => i), rowHeight: 30, children: snippet } })
  flushSync()
  expect(target.querySelectorAll('[data-value]').length).toBeLessThan(20)
  expect(target.querySelector('[data-value="0"]')).not.toBeNull()
  const viewport = target.firstElementChild as HTMLElement
  viewport.scrollTop = 30000; viewport.dispatchEvent(new Event('scroll')); flushSync()
  expect(target.querySelector('[data-value="1000"]')).not.toBeNull()
  expect(target.querySelector('[data-value="0"]')).toBeNull()
})
