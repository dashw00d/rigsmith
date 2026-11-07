import { afterEach, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import { Group } from 'three'
import { makeCharacter, makeGear } from '../../model/fixtures.ts'
import type { CharacterView } from '../../engine/CharacterView.ts'
import { app } from '../../state/app.svelte.ts'
import { gear } from '../../state/gear.svelte.ts'
import { wardrobe } from './wardrobe.svelte.ts'
import GearList from './GearList.svelte'

let mounted: ReturnType<typeof mount> | undefined
afterEach(async () => {
  if (mounted !== undefined) await unmount(mounted)
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

it('keeps a row selection made while that character is loading', () => {
  const c = makeCharacter({ id: 'test-gear-load', gear: [makeGear({ id: 'test-axe' })] })
  app.upsert(c)
  ;(app as unknown as { selected_: string }).selected_ = c.id
  gear.select(null)
  wardrobe.update(c.id, { selected: null })
  const target = document.createElement('div')
  document.body.appendChild(target)
  mounted = mount(GearList, { target, props: { character: c } })
  flushSync()
  const row = target.querySelector<HTMLButtonElement>('button.row')!
  const trace: Array<string | null> = []
  const select = vi.spyOn(gear, 'select')
  row.click()
  flushSync()
  trace.push(gear.selected)
  const internals = gear as unknown as { load: (view: CharacterView, character: typeof c) => () => void }
  const cleanup = internals.load({ rest: null, root: new Group(), skinned: [] } as unknown as CharacterView, c)
  flushSync()
  trace.push(gear.selected)
  expect(select).toHaveBeenCalledWith('test-axe')
  expect(trace).toEqual(['test-axe', 'test-axe'])
  cleanup()
})

it('allows a restored selection to be deselected immediately', () => {
  const c = makeCharacter({ id: 'test-gear-restore', gear: [makeGear({ id: 'test-spear' })] })
  app.upsert(c)
  ;(app as unknown as { selected_: string }).selected_ = c.id
  gear.select(null)
  wardrobe.update(c.id, { selected: 'test-spear' })
  const target = document.createElement('div')
  document.body.appendChild(target)
  mounted = mount(GearList, { target, props: { character: c } })
  flushSync()
  expect(gear.selected).toBe('test-spear')
  target.querySelector<HTMLButtonElement>('button.row')!.click()
  flushSync()
  expect(gear.selected).toBeNull()
  expect(wardrobe.view(c.id).selected).toBeNull()
})
