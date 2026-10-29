// Schema 2's slots (src/model/types.ts before schema 3), as old files and old build records hold them: what the
// migration (src/model/migrate.ts slotFromV2) and the restore of a schema 2 build read. Every phase in them (a key's
// `u`, a window) is a phase of the slot's clip as it played, after its speed, blow timing and pace; schema 3 stores
// them against the source clip instead (docs/motion-plan.md §1). Nothing writes these shapes any more.
import type { Character, ClipRef, HandPoseRef, Quat, Side, Vec3 } from './types.ts'

/** Phases [from, to] of the clip as it played. */
export type V2Window = [number, number]

export interface V2ClipKey { u: number, q: Quat, p?: Vec3 }

interface V2AdjustmentBase { id: string, enabled: boolean, note?: string }

export type V2Adjustment = V2AdjustmentBase & (
  | { kind: 'ground', lift: number }
  | { kind: 'blowTiming', at: number, blowU?: number, late?: 'cut' | 'hold', hand?: string, window?: number }
  | { kind: 'pace', like: string }
  | { kind: 'handPose', hand: Side, pose: HandPoseRef, windows?: V2Window[], gear?: string }
  | { kind: 'handleHold', gear: string, handle: string, windows: V2Window[] }
  | { kind: 'keys', bones?: Record<string, V2ClipKey[]>, gear?: Record<string, V2ClipKey[]> }
)

export type V2AdjustmentKind = V2Adjustment['kind']

export interface V2Slot {
  id: string
  name: string
  clip: ClipRef
  speed: number
  loop: boolean
  inPlace: boolean
  note?: string
  adjustments: V2Adjustment[]
}

/** A schema 2 character: schema 3's but for its slots. */
export type V2Character = Omit<Character, 'schema' | 'clips'> & { schema: 2, clips: V2Slot[] }
