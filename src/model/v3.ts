// Schema 3's slots (src/model/types.ts before schema 4), as old files and old build records hold them: what the
// migration (src/model/migrate.ts piecesFromHolds) and the restore of a schema 3 build read. Schema 3 had no pieces and
// had holds: the pose at source `u` held `seconds` (source seconds), no time of its own (docs/motion-plan.md §2.2 as it
// was); schema 4 makes each a hold piece (§11.5). Nothing writes these shapes any more.
import type { Character, Slot, SlotTime, SourceU } from './types.ts'

export interface V3Hold { id: string, u: SourceU, seconds: number }
export type V3SlotTime = SlotTime & { holds?: V3Hold[] }
export type V3Slot = Omit<Slot, 'time' | 'pieces'> & { time?: V3SlotTime }
/** A schema 3 character: schema 4's but for its slots. */
export type V3Character = Omit<Character, 'schema' | 'clips'> & { schema: 3, clips: V3Slot[] }
