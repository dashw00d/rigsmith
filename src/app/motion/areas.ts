// The areas whose items share the timeline's selection with the keys (src/app/motion/lanes.ts AreaItems): the timeline
// (src/state/timeline.svelte.ts) hands each its own items when Delete, Ctrl+D, the nudge or Ctrl+C / Ctrl+V act on the
// selection. Hand bars and the Time track's items are the timeline's own.
import type { AreaItems } from './lanes.ts'
import { eventItems } from './events/items.ts'
import { gearItems } from './gear/items.ts'

export const AREAS: readonly AreaItems[] = [eventItems, gearItems]
