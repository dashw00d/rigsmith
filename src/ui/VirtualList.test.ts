import { afterEach, expect, it, vi } from 'vitest'
import { createRawSnippet, flushSync, mount, unmount } from 'svelte'
import VirtualList from './VirtualList.svelte'

let instance: ReturnType<typeof mount> | undefined
afterEach(async () => { if (instance) await unmount(instance); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

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

it('packs grid cells while keeping headers on their own row', () => {
  vi.stubGlobal('ResizeObserver', class { observe () {} disconnect () {} })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(450)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
  const target = document.createElement('div'); document.body.append(target)
  const snippet = createRawSnippet<[unknown[], number]>((getRow, getColumns) => ({ render: () => `<span data-columns="${getColumns()}">${getRow().join(',')}</span>` }))
  instance = mount(VirtualList, { target, props: { items: ['header', 'a', 'b', 'c', 'd'], rowHeight: 100, headerHeight: 30, minColumnWidth: 150, isHeader: (item: unknown) => item === 'header', children: snippet } })
  flushSync()
  // Raw snippets render once; row count and the newly mounted last row show the repacking after measurement.
  expect([...target.querySelectorAll('[data-columns]')].map(e => e.textContent)).toEqual(['header', 'a', 'd'])
  expect(target.querySelectorAll('[data-columns]')[2].getAttribute('data-columns')).toBe('3')
  expect((target.querySelector('[data-columns]')?.parentElement as HTMLElement).style.height).toBe('30px')
})

it('sizes grid rows from measured column width', () => {
  vi.stubGlobal('ResizeObserver', class { observe () {} disconnect () {} })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(548)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500)
  const target = document.createElement('div'); document.body.append(target)
  const snippet = createRawSnippet<[unknown[], number]>(() => ({ render: () => '<span>card</span>' }))
  instance = mount(VirtualList, { target, props: { items: [1, 2, 3, 4], rowHeight: (width: number, columns: number) => Math.ceil((width - 8 - 4 * (columns - 1)) / columns) + 80, minColumnWidth: 145, children: snippet } })
  flushSync()
  const rows = target.querySelectorAll('.row')
  expect((rows[0] as HTMLElement).style.height).toBe('258px')
  expect((rows[1] as HTMLElement).style.top).toBe('258px')
})
