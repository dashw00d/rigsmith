// The timeline's rows as plain functions (no Svelte, no stage): the Body track's limb groups and which bones show in
// them, the Hands track's bars (hand poses, pulls held, hands on handles), the Time track's markers and holds where
// they play, and the ruler's ticks. Every position is a played phase of one cycle (the slot's time map).
import type { Character, Side, Slot, Window } from '../../model/types.ts'
import { windowsToPlayed, type TimeMap } from '../../model/timemap.ts'
import { prettyBone } from '../../engine/mixamo.ts'

/** A limb group of the Body track. */
export interface BodyGroup { id: string, label: string, bones: string[] }

const GROUPS: Array<{ id: string, label: string, test: (b: string) => boolean }> = [
  { id: 'torso', label: 'Hips and spine', test: b => /^(Hips|Spine\d*|hips|spine.*|chest.*|root)$/i.test(b) },
  { id: 'head', label: 'Head', test: b => /^(Neck|Head|HeadTop_End)$|neck|head|jaw|ear|mouth|nose|eye/i.test(b) },
  { id: 'armL', label: 'Left arm', test: b => /^Left(Shoulder|Arm|ForeArm|Hand)$/.test(b) },
  { id: 'handL', label: 'Left fingers', test: b => /^LeftHand.+/.test(b) },
  { id: 'armR', label: 'Right arm', test: b => /^Right(Shoulder|Arm|ForeArm|Hand)$/.test(b) },
  { id: 'handR', label: 'Right fingers', test: b => /^RightHand.+/.test(b) },
  { id: 'legL', label: 'Left leg', test: b => /^Left(UpLeg|Leg|Foot|ToeBase|Toe_End)$|_l$/.test(b) && !/front_leg/.test(b) },
  { id: 'legR', label: 'Right leg', test: b => /^Right(UpLeg|Leg|Foot|ToeBase|Toe_End)$|_r$/.test(b) && !/front_leg/.test(b) },
  { id: 'frontL', label: 'Left foreleg', test: b => /^front_leg_.*_l$/.test(b) },
  { id: 'frontR', label: 'Right foreleg', test: b => /^front_leg_.*_r$/.test(b) },
  { id: 'tail', label: 'Tail', test: b => /tail/i.test(b) },
]

/** The skeleton's bones in limb groups, in skeleton order (a bone no group takes goes in Other). */
export function bodyGroups (bones: readonly string[]): BodyGroup[] {
  const out = GROUPS.map(g => ({ id: g.id, label: g.label, bones: [] as string[] }))
  const other: string[] = []
  for (const b of bones) {
    const i = GROUPS.findIndex(g => g.test(b))
    if (i >= 0) out[i].bones.push(b)
    else other.push(b)
  }
  return [...out, { id: 'other', label: 'Other', bones: other }].filter(g => g.bones.length > 0)
}

/** The group a bone is in. */
export function groupOf (groups: readonly BodyGroup[], bone: string): BodyGroup | undefined {
  return groups.find(g => g.bones.includes(bone))
}

/** A bone as a row label: its side and its name in words ("L Forearm"). */
export function boneLabel (bone: string): string {
  const side = /^Left/.test(bone) || /_l$/.test(bone) ? 'L ' : /^Right/.test(bone) || /_r$/.test(bone) ? 'R ' : ''
  return `${side}${prettyBone(bone).replace(/_/g, ' ')}`
}

/** A bar of the Hands track: what it sets, where it plays (played windows, one entry a stored window, so an edge drag
 * writes that window), and how a drag of it is written. */
export interface HandsBar {
  /** The selection's track: `hands:<adjustment id>`, or `hands:ik:<hand>` for a hand kept on a handle. */
  track: string
  label: string
  title: string
  side: Side | null
  /** Played windows (each stored window's); a bar with no windows covers the whole clip. */
  windows: Window[]
  whole: boolean
  kind: 'pose' | 'pull' | 'ik'
}

/** The Hands track's bars for a slot: its hand poses (and a hand let go of a piece), pulls held and hands on handles. */
export function handsBars (c: Pick<Character, 'gear' | 'hands'>, slot: Slot, map: TimeMap): HandsBar[] {
  const gearName = (id: string): string => c.gear.find(g => g.id === id)?.name ?? 'gear'
  const handleName = (gid: string, hid: string): string => c.gear.find(g => g.id === gid)?.handles.find(h => h.id === hid)?.name ?? 'handle'
  const poseName = (p: unknown): string => {
    if (p === 'clip') return 'open (as the clip)'
    if (p === 'default') return 'fist'
    if (typeof p === 'object' && p !== null && 'pose' in p) return c.hands.poses.find(x => x.id === (p as { pose: string }).pose)?.name ?? 'a pose'
    if (typeof p === 'object' && p !== null && 'fist' in p) return String((p as { fist: string }).fist).replace(/^mixamo-/, '').replace(/_/g, ' ')
    return 'a pose'
  }
  const out: HandsBar[] = []
  for (const a of slot.adjustments) {
    if (a.kind === 'handPose') {
      const label = a.gear !== undefined && a.pose === 'clip' ? `${a.hand} hand lets go of ${gearName(a.gear)}` : `${a.hand} hand ${poseName(a.pose)}`
      out.push({ track: `hands:${a.id}`, label, title: label + (a.enabled ? '' : ' (off)'), side: a.hand, windows: windowsToPlayed(map, a.windows ?? []), whole: a.windows === undefined, kind: 'pose' })
    } else if (a.kind === 'handleHold') {
      const label = `${gearName(a.gear)} · ${handleName(a.gear, a.handle)} held`
      out.push({ track: `hands:${a.id}`, label, title: label + (a.enabled ? '' : ' (off)'), side: null, windows: windowsToPlayed(map, a.windows), whole: false, kind: 'pull' })
    }
  }
  for (const h of slot.ik?.hands ?? []) {
    const label = `${h.hand} hand on ${gearName(h.gear)} · ${handleName(h.gear, h.handle)}`
    out.push({ track: `hands:ik:${h.hand}`, label, title: `${label} (kept there by IK)`, side: h.hand, windows: windowsToPlayed(map, h.windows ?? []), whole: h.windows === undefined, kind: 'ik' })
  }
  return out
}

/** A window moved by `dv` (`edge`: only that end), kept in the clip and at least a frame long, snapped to frames. */
export function dragWindow (w: Window, edge: 'start' | 'end' | 'body', dv: number, frames: number, free = false): Window {
  const snap = (v: number): number => (free ? v : Math.round(v * frames) / frames)
  const min = 1 / Math.max(1, frames)
  if (edge === 'body') {
    const len = w[1] - w[0]
    const from = Math.min(1 - len, Math.max(0, snap(w[0] + dv)))
    return [from, from + len]
  }
  if (edge === 'start') return [Math.max(0, Math.min(w[1] - min, snap(w[0] + dv))), w[1]]
  return [w[0], Math.min(1, Math.max(w[0] + min, snap(w[1] + dv)))]
}

/** The ruler's ticks for `frames` frames over [from, to] of the clip drawn `width` px wide: every `step` frames, a
 * label every `label` frames. */
export function rulerTicks (frames: number, from: number, to: number, width: number): { step: number, label: number, ticks: number[] } {
  const perFrame = width / Math.max(1e-6, (to - from) * frames)
  const steps = [1, 2, 5, 10, 15, 30, 60, 150, 300]
  const step = steps.find(s => s * perFrame >= 7) ?? 300
  const label = steps.find(s => s >= step && s * perFrame >= 42) ?? 300
  const first = Math.ceil(from * frames / step) * step
  const ticks: number[] = []
  for (let f = first; f <= Math.floor(to * frames) && ticks.length < 1000; f += step) ticks.push(f)
  return { step, label, ticks }
}
