import { expect, it, vi } from 'vitest'
import { makeCharacter, makeGear } from '../../model/fixtures.ts'
import { app } from '../../state/app.svelte.ts'
import { gear } from '../../state/gear.svelte.ts'

it('cancels the fit with exactly one command batch', async () => {
  const piece = makeGear({ id: 'fit-coat', attach: { kind: 'skin', policy: 'body', place: { position: [0, 1, 0], rotation: [0, 0, 0], scale: 1 } } })
  const c = makeCharacter({ id: 'test-fit', gear: [piece] })
  app.upsert(c)
  ;(app as unknown as { selected_: string }).selected_ = c.id
  gear.fit(piece.id)
  expect(gear.fitStart?.place).toEqual(piece.attach.place)
  const moved = { ...piece, attach: { ...piece.attach, place: { ...piece.attach.place, scale: 2 } } }
  app.upsert({ ...c, version: c.version + 1, gear: [moved] })
  const send = vi.spyOn(app, 'do').mockResolvedValue({} as NonNullable<Awaited<ReturnType<typeof app.do>>>)
  await gear.cancelFit()
  expect(send).toHaveBeenCalledOnce()
  expect(send.mock.calls[0][1]).toEqual([{ type: 'gear.place', id: piece.id, place: piece.attach.place }])
  expect(gear.fitting).toBeNull()
  expect(gear.fitStart).toBeNull()
  send.mockRestore()
})
