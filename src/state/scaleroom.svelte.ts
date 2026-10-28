// The scale room (src/app/ship/ScaleRoom.svelte): a covering viewer overlay while open (the stage rests under it), for
// the unit it sizes, or for its companion's height when the character shown is the companion. It sets the character
// on stage beside the game's own models, so it closes when that view goes (another character, a reload) or the step
// changes.
import type { CharacterView } from '../engine/CharacterView.ts'
import ScaleRoom from '../app/ship/ScaleRoom.svelte'
import { app } from './app.svelte.ts'
import { viewer } from './viewer.svelte.ts'

const KEY = 'scale-room'

class ScaleRoomState {
  open = $state(false)
  unit = $state<string | null>(null)
  /** It sizes the unit's companion (the character shown is its horse or pony). */
  companion = $state(false)
  /** What the room is loading, in words (also the viewport's busy pill); null when idle. */
  busy = $state<string | null>(null)
  private view: CharacterView | null = null

  constructor () {
    viewer.onLoad(view => () => { if (this.view === view) this.close() }, 40)
    viewer.onSync((_view, _c, step) => { if (step !== 'ship' && this.open) this.close() })
  }

  /** Open it on the character on stage. False when none is loaded. */
  show (unit: string, companion: boolean): boolean {
    const view = viewer.character
    if (view === null) return false
    this.unit = unit
    this.companion = companion
    this.view = view
    this.open = true
    viewer.setOverlay(KEY, { component: ScaleRoom, props: { view, unit, companion }, covers: true, blocksInput: true })
    return true
  }

  close (): void {
    if (!this.open && this.view === null) return
    this.open = false
    this.view = null
    viewer.setOverlay(KEY, null)
    this.setBusy(null)
  }

  setBusy (text: string | null): void {
    this.busy = text
    app.setBusy(KEY, text)
  }
}

export const scaleRoom = new ScaleRoomState()
