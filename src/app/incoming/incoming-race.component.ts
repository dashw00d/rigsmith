import { expect, it, vi } from 'vitest'
import { api } from '../../state/api.ts'
import { app } from '../../state/app.svelte.ts'
import { incoming } from '../../state/incoming.svelte.ts'

it('does not accept using a listing from the previous character', async () => {
  let selected = 'first'
  const selection = vi.spyOn(app, 'selectedId', 'get').mockImplementation(() => selected)
  const listing = vi.spyOn(api, 'incoming').mockResolvedValue({ packages: [], pending: 1 })
  const accept = vi.spyOn(api, 'acceptIncoming').mockRejectedValue(new Error('sent with stale listing'))
  const toast = vi.spyOn(app, 'toast').mockImplementation(() => {})
  try {
    await incoming.refresh()
    selected = 'second'
    await incoming.change('accept', 'package', 'part')
    expect(accept).not.toHaveBeenCalled()
  } finally { selection.mockRestore(); listing.mockRestore(); accept.mockRestore(); toast.mockRestore() }
})
