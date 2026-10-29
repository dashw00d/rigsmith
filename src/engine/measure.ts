// What moving a schema 2 slot into source time needs to know of its clip (docs/motion-plan.md §5): the source's length
// and, where its blow timing measured the blow (the hand's fastest moment), that blow, measured exactly as the bake
// measures it (src/engine/timing.ts blowCut: on the clip at the slot's speed, on the character's posable copy). The
// migration (src/model/migrate.ts) is pure; tools/migrate.ts calls this in its own process and the server through
// tools/measure_clips.ts.
import { cutMoves, type ClipTimes } from '../model/migrate.ts'
import type { V2Adjustment, V2Character, V2Slot } from '../model/v2.ts'
import type { BakeContext } from './bake.ts'
import { blowTime, retime, saveBones } from './timing.ts'

/** Per slot id, its clip's times; `all`: every slot with a blow timing, not only those whose phases move. Slots whose
 * clip won't load are left out and said in `problems`. */
export async function measureClipTimes (c: Pick<V2Character, 'clips'>, ctx: BakeContext, o: { all?: boolean } = {}): Promise<{ times: Record<string, ClipTimes>, problems: string[] }> {
  const times: Record<string, ClipTimes> = {}
  const problems: string[] = []
  for (const s of c.clips) {
    const blow = blowOf(s)
    if (blow === undefined || (o.all !== true && !cutMoves(s))) continue
    try {
      const raw = await ctx.clips.get(s.clip, { inPlace: s.inPlace, fps: ctx.fps })
      const t: ClipTimes = { seconds: raw.duration }
      if (blow.blowU === undefined) {
        const restore = saveBones(ctx.posable)
        t.blow = blowTime(ctx.posable, retime(raw, s.speed), blow.hand ?? 'RightHand')
        restore()
      }
      times[s.id] = t
    } catch (error) {
      problems.push(`clip ${s.name}: ${(error as Error).message}`)
    }
  }
  return { times, problems }
}

/** Whether a schema 2 character has a slot whose phases need its clip measured to move into source time. */
export const needsMeasure = (c: Pick<V2Character, 'clips'>): boolean => c.clips.some(s => cutMoves(s))

function blowOf (s: V2Slot): Extract<V2Adjustment, { kind: 'blowTiming' }> | undefined {
  return s.adjustments.find((a): a is Extract<V2Adjustment, { kind: 'blowTiming' }> => a.kind === 'blowTiming')
}
