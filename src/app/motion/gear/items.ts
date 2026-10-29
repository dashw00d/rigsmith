// The Gear strips' items in the timeline's cross-track selection (src/app/motion/lanes.ts AreaItems): Delete takes the
// selected Held-by boundaries out (each segment joins the one before) and shows the selected hidden spans again, as the
// strips' own Delete does (./GearLanes.svelte), whatever has the focus. One slot.gear.update a piece. Pure.
import type { Command } from '../../../model/command-types.ts'
import type { GearTrack } from '../../../model/types.ts'
import type { AreaItems, AreaView, SelectedItem } from '../lanes.ts'
import { unhide } from './strips.ts'

const pieceOf = (track: string): string | null => (track.startsWith('held:') ? track.slice(5) : track.startsWith('shown:') ? track.slice(6) : null)

export function removeGearItems (view: Pick<AreaView, 'slot'>, items: readonly SelectedItem[]): Command[] {
  const out: Command[] = []
  const pieces = [...new Set(items.map(s => pieceOf(s.track)).filter((g): g is string => g !== null))]
  for (const gear of pieces) {
    const track = view.slot.gear?.[gear]
    const boundaries = items.filter(s => s.track === `held:${gear}`).map(s => Number(s.id)).filter(i => Number.isInteger(i) && i >= 0)
    const hidden = items.filter(s => s.track === `shown:${gear}`).map(s => Number(s.id)).filter(i => Number.isInteger(i) && i >= 0)
    const patch: { heldBy?: GearTrack['heldBy'] | null, shown?: GearTrack['shown'] | null } = {}
    if (boundaries.length > 0 && (track?.heldBy ?? []).length > 0) {
      const held = (track?.heldBy ?? []).filter((_, i) => !boundaries.includes(i))
      patch.heldBy = held.length > 0 ? held : null
    }
    if (hidden.length > 0 && (track?.shown ?? []).length > 0) {
      const shown = [...new Set(hidden)].sort((a, b) => b - a).reduce((s, i) => unhide(s, i), track?.shown ?? [])
      patch.shown = shown.length > 0 ? shown : null
    }
    if (Object.keys(patch).length > 0) out.push({ type: 'slot.gear.update', slot: view.slot.id, gear, patch })
  }
  return out
}

export const gearItems: AreaItems = {
  owns: track => pieceOf(track) !== null,
  remove: removeGearItems,
}
