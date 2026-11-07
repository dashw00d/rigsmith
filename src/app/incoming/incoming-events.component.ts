import { expect, it, vi } from 'vitest'
import { api } from '../../state/api.ts'
import { app } from '../../state/app.svelte.ts'
import { assets } from '../../state/assets.svelte.ts'
import { incoming } from '../../state/incoming.svelte.ts'

it('shares the app event stream and refreshes Incoming on its events', async () => {
  const sources: FakeEventSource[] = []
  class FakeEventSource {
    listeners = new Map<string, Array<(event: Event) => void>>()
    onerror: (() => void) | null = null
    constructor () { sources.push(this) }
    addEventListener (name: string, listener: (event: Event) => void): void {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
    }
    close (): void {}
    emit (name: string, data = ''): void {
      for (const listener of this.listeners.get(name) ?? []) listener(new MessageEvent(name, { data }))
    }
  }
  vi.stubGlobal('EventSource', FakeEventSource)
  const characters = vi.spyOn(api, 'characters').mockResolvedValue([])
  const settings = vi.spyOn(api, 'settings').mockResolvedValue({ gameRepo: '' })
  const library = vi.spyOn(assets, 'loadLibrary').mockResolvedValue()
  const listing = vi.spyOn(api, 'incoming').mockResolvedValue({ packages: [], pending: 1 })
  let stop = (): void => {}
  try {
    await app.start()
    stop = incoming.start()
    expect(sources).toHaveLength(1)
    const before = listing.mock.calls.length
    sources[0].emit('incoming')
    expect(listing).toHaveBeenCalledTimes(before + 1)
    stop()
    sources[0].emit('incoming')
    expect(listing).toHaveBeenCalledTimes(before + 1)
  } finally {
    stop(); characters.mockRestore(); settings.mockRestore(); library.mockRestore(); listing.mockRestore(); vi.unstubAllGlobals()
  }
})
