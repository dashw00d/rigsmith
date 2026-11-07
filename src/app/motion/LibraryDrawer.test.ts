import { afterEach, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'
import { makeCharacter } from '../../model/fixtures.ts'
import { defaultView } from './libraryView.ts'
const selected = new SvelteMap<string, unknown>()
const app = { drawer: 'library', get selected () { return selected.get('character') }, toast: vi.fn() }
const library = { options: defaultView(), index: [], uses: {}, rows: [], query: '', rig: 'human', error: null,
  setRig: vi.fn((rig: string) => { library.rig = rig; library.query = '' }), setViewOptions: vi.fn(), setQuery: vi.fn() }
vi.mock('../../state/app.svelte.ts', () => ({ app }))
vi.mock('../../state/library.svelte.ts', () => ({ library }))
vi.mock('../../state/animator.svelte.ts', () => ({ animator: { cancelSprites: vi.fn() } }))
vi.mock('../../state/slots.svelte.ts', () => ({ slots: { armed: null, load: vi.fn() } }))
vi.mock('../../state/api.ts', () => ({ api: { library: vi.fn() } }))
const { default: LibraryDrawer } = await import('./LibraryDrawer.svelte')
let instance: ReturnType<typeof mount>
afterEach(async () => { await unmount(instance); document.body.replaceChildren(); vi.unstubAllGlobals() })
it('keeps rig and search when the selected character document changes', () => {
  vi.stubGlobal('ResizeObserver', class { observe () {} disconnect () {} })
  const c = makeCharacter(); selected.set('character', c)
  const target = document.createElement('div'); document.body.append(target)
  instance = mount(LibraryDrawer, { target }); flushSync()
  library.rig = 'all'; library.query = 'attack'; library.setRig.mockClear()
  selected.set('character', { ...c, name: 'Updated' }); flushSync()
  expect(library.setRig).not.toHaveBeenCalled()
  expect(library.rig).toBe('all'); expect(library.query).toBe('attack')
  selected.set('character', { ...c, id: 'other' }); flushSync()
  expect(library.setRig).toHaveBeenCalledWith(c.skeleton.template ?? 'human')
})
