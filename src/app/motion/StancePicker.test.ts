import { afterEach, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import { makeCharacter, makeGear } from '../../model/fixtures.ts'
vi.mock('../../state/app.svelte.ts', () => ({ app: { do: vi.fn() } }))
vi.mock('../../state/stance.svelte.ts', () => ({ stance: { current: () => null, select: vi.fn() } }))
import StancePicker from './StancePicker.svelte'
let instance: ReturnType<typeof mount>
afterEach(async () => { await unmount(instance); document.body.replaceChildren() })
it('offers stance editing only for dynamic characters', async () => {
  const target = document.createElement('div'); document.body.append(target)
  instance = mount(StancePicker, { target, props: { character: makeCharacter() } }); flushSync()
  expect(target.querySelector('[aria-label="New stance name"]')).toBeNull()
  await unmount(instance)
  instance = mount(StancePicker, { target, props: { character: makeCharacter({ gear: [makeGear({ outfit: 'mail' })] }) } }); flushSync()
  expect(target.querySelector('[aria-label="New stance name"]')).not.toBeNull()
})
