// The Rig step's marker board (src/app/rig/MarkerBoard.svelte): open or not, the marker picked, mirroring, and the
// set and skeleton of the character it is for (a person's Mixamo hierarchy, a creature template's own).
import type { Character } from './api.ts'
import { hierarchy, type FingerLevel } from '../engine/mixamo.ts'
import { markerSets, type MarkerSet } from '../engine/markers.ts'
import { loadTemplate } from '../engine/templates.ts'

class MarkerBoardState {
  open = $state(false)
  selected = $state<string | null>(null)
  mirror = $state(true)
  /** The set and skeleton loaded for `forId`, or why there are none. */
  forId = $state<string | null>(null)
  setName = $state<string | null>(null)
  set = $state<MarkerSet | null>(null)
  parents = $state<Record<string, string | null> | null>(null)
  missing = $state<string | null>(null)

  async load (c: Character): Promise<void> {
    const name = c.template ?? 'human'
    const key = `${c.id}|${name}|${c.fingers ?? 'full'}`
    if (this.forId === key) return
    this.forId = key
    const sets = await markerSets()
    const set = sets[name]
    if (set === undefined) {
      this.set = null; this.parents = null; this.setName = null
      this.missing = `No markers for the ${name} body yet: drag its joints instead.`
      return
    }
    this.parents = name === 'human'
      ? Object.fromEntries(hierarchy((c.fingers ?? 'full') as FingerLevel))
      : (await loadTemplate(name)).parents
    this.set = set; this.setName = name; this.missing = null
  }
}

export const markerBoard = new MarkerBoardState()
