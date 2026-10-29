// What moving a schema 2 slot into source time needs to know of its clip (docs/motion-plan.md §5): the source's length
// and, where its blow timing measured the blow (the hand's fastest moment), that blow, measured exactly as the bake
// measures it (src/engine/timing.ts blowCut: on the clip at the slot's speed, on the character's posable copy); and
// what making a schema 3 slot's holds pieces needs (§11.5): its source's length. The
// migration (src/model/migrate.ts) is pure; tools/migrate.ts calls this in its own process and the server through
// tools/measure_clips.ts.
import { cutMoves, type ClipTimes, type MeasuredTimes } from '../model/migrate.ts'
import type { V2Adjustment, V2Character, V2Slot } from '../model/v2.ts'
import type { V3Character } from '../model/v3.ts'
import type { BakeContext } from './bake.ts'
import { blowTime, retime, saveBones } from './timing.ts'

/** The code of an error a clip source throws for a clip that doesn't exist (as against one that failed to load). */
export const NO_CLIP = 'ENOCLIP'
export const noClip = (message: string): Error => Object.assign(new Error(message), { code: NO_CLIP })
const isNoClip = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === NO_CLIP

/** Per slot id, its clip's times; `all`: every slot with a blow timing, not only those whose phases move. Slots whose
 * clip won't load are left out and said in `problems` (and in `missing` when the clip doesn't exist). */
export async function measureClipTimes (c: Pick<V2Character, 'clips'>, ctx: BakeContext, o: { all?: boolean } = {}): Promise<Required<MeasuredTimes>> {
  const times: Record<string, ClipTimes> = {}
  const problems: string[] = []
  const missing: string[] = []
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
      if (isNoClip(error)) missing.push(s.id)
    }
  }
  return { times, problems, missing }
}

/** Per schema 3 slot id with holds (every slot: `all`), its clip's length; as measureClipTimes for those that won't
 * load. */
export async function measureHeld (c: Pick<V3Character, 'clips'>, ctx: BakeContext, o: { all?: boolean } = {}): Promise<Required<MeasuredTimes>> {
  const times: Record<string, ClipTimes> = {}
  const problems: string[] = []
  const missing: string[] = []
  for (const s of c.clips) {
    if (o.all !== true && !(s.time?.holds ?? []).some(h => h.seconds > 0)) continue
    try {
      times[s.id] = { seconds: (await ctx.clips.get(s.clip, { inPlace: s.inPlace, fps: ctx.fps })).duration }
    } catch (error) {
      problems.push(`clip ${s.name}: ${(error as Error).message}`)
      if (isNoClip(error)) missing.push(s.id)
    }
  }
  return { times, problems, missing }
}

/** Whether a schema 2 character has a slot whose phases need its clip measured to move into source time. */
export const needsMeasure = (c: Pick<V2Character, 'clips'>): boolean => c.clips.some(s => cutMoves(s))

function blowOf (s: V2Slot): Extract<V2Adjustment, { kind: 'blowTiming' }> | undefined {
  return s.adjustments.find((a): a is Extract<V2Adjustment, { kind: 'blowTiming' }> => a.kind === 'blowTiming')
}
