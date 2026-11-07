import { afterEach, expect, it, vi } from 'vitest'
import { mount, unmount, flushSync } from 'svelte'
import { makeCharacter } from '../../model/fixtures.ts'
import { app } from '../../state/app.svelte.ts'
import ClassPools from '../gear/ClassPools.svelte'

const mounts: Array<ReturnType<typeof mount>> = []
afterEach(async () => { for (const component of mounts.splice(0)) await unmount(component); document.body.replaceChildren(); vi.restoreAllMocks() })
it('copies a shared default pool and edits its items through commands', async () => {
  const character = makeCharacter({ look: { skins: [{ name: 'A', file: 'a.png' }, { name: 'B', file: 'b.png' }] }, folk: {
    sets: [], pools: [{ id: 'skins', name: 'Skins', kind: 'skin', items: [{ ref: 'A' }, { ref: 'B', weight: 2 }] }],
    kinds: [{ id: 'one', name: 'One', tags: [], sets: { query: [] } }, { id: 'two', name: 'Two', tags: [], sets: { query: [] } }], stances: [],
  } })
  const send = vi.spyOn(app, 'do').mockResolvedValue(null)
  const target = document.createElement('div'); document.body.append(target)
  mounts.push(mount(ClassPools, { target, props: { character, kind: character.folk!.kinds[0] } }))
  flushSync()
  target.querySelector<HTMLButtonElement>('[data-testid="class-pool-expand-skin"]')!.click(); flushSync()
  expect(target.textContent).toContain('Shared with Two')
  const copy = [...target.querySelectorAll('button')].find(b => b.textContent?.includes('Make a copy for One'))!
  copy.click()
  expect(send.mock.calls[0][1]).toMatchObject([{ type: 'folk.pool.add', pool: { id: 'skins-copy' } }, { type: 'folk.kind.update', id: 'one', patch: { pools: { skin: 'skins-copy' } } }])
  const checkbox = target.querySelector<HTMLInputElement>('[data-testid="class-pool-item"][data-id="A"]')!
  checkbox.click()
  expect(send.mock.calls[1][1]).toEqual({ type: 'folk.pool.items', id: 'skins', items: [{ ref: 'B', weight: 2 }] })
})
