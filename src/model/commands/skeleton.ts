// skeleton.*: the user's side of the skeleton (DESIGN.md §2.2). Generators (import, finger trace, template fit, the
// rig job) write `detected` from server jobs; these commands write only the overrides, markers, set-aside overrides
// and the bone map.
import type { Command } from '../command-types.ts'
import { hierarchyOf } from '../skeletons.ts'
import type { Character, MarkerBoardState, StaleOverride, Vec3 } from '../types.ts'
import { bad, conflict, list, missing, names, obj, oneOf, plural, record, same, str, unknown, vec3 } from './common.ts'

export type SkeletonCommand = Extract<Command, { type: `skeleton.${string}` }>

/** Closer than this to the detected joint, a placement is no override. */
const SAME = 1e-6
const near = (a: Vec3, b: Vec3): boolean => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= SAME

function markers (v: unknown): MarkerBoardState | null {
  if (v === null) return null
  const m = obj(v, 'markers')
  return { set: str(m.set, 'markers.set'), base: record(m.base, 'markers.base', vec3), positions: record(m.positions, 'markers.positions', vec3) }
}

function setMarkers (c: Character, next: MarkerBoardState | null): string[] {
  const s = c.skeleton
  if (same(s.markers ?? null, next)) return []
  if (next === null) { delete s.markers; return ['markers cleared'] }
  s.markers = next
  return [`markers placed (${next.set})`]
}

/** Put a joint where it was placed: an override, or none when that is where it was detected. True if it changed. */
function place (c: Character, joint: string, p: Vec3): boolean {
  const s = c.skeleton
  const detected = s.detected?.[joint]
  if (detected !== undefined && near(detected, p)) {
    if (s.overrides[joint] === undefined) return false
    delete s.overrides[joint]
    return true
  }
  if (s.overrides[joint] !== undefined && same(s.overrides[joint], p)) return false
  s.overrides[joint] = p
  return true
}

/** Where a set-aside override was made, against where the skeleton is now. */
function madeWhere (c: Character, o: StaleOverride): string {
  return o.template !== c.skeleton.template ? `on the ${o.template} skeleton` : `at finger level ${o.level}`
}

export function reduceSkeleton (c: Character, cmd: SkeletonCommand): string[] {
  const s = c.skeleton
  switch (cmd.type) {
    case 'skeleton.place': {
      const known = new Set(hierarchyOf(c).map(([j]) => j))
      const joints = record(cmd.joints, 'joints', vec3)
      for (const j of Object.keys(joints)) if (!known.has(j)) bad(`${j} isn't a joint of this skeleton`)
      const next = cmd.markers === undefined ? undefined : markers(cmd.markers)
      const placed: string[] = []
      const back: string[] = []
      for (const [j, p] of Object.entries(joints)) {
        if (!place(c, j, p)) continue
        if (s.overrides[j] === undefined) back.push(j)
        else placed.push(j)
      }
      const out: string[] = []
      if (placed.length > 0) out.push(`skeleton: placed ${names(placed)}`)
      if (back.length > 0) out.push(`skeleton: ${names(back)} back where detected`)
      if (next !== undefined) out.push(...setMarkers(c, next))
      return out
    }
    case 'skeleton.unplace': {
      const back = list(cmd.joints, 'joints', str).filter(j => s.overrides[j] !== undefined)
      for (const j of back) delete s.overrides[j]
      return back.length > 0 ? [`skeleton: ${names(back)} back where detected`] : []
    }
    case 'skeleton.reset': {
      const cleared = [
        ...(Object.keys(s.overrides).length > 0 ? [plural(Object.keys(s.overrides).length, 'placed joint')] : []),
        ...(s.markers !== undefined ? ['the markers'] : []),
        ...((s.stale?.length ?? 0) > 0 ? [plural(s.stale!.length, 'set-aside placement')] : []),
      ]
      s.overrides = {}
      delete s.markers
      delete s.stale
      return cleared.length > 0 ? [`skeleton: back to detected (${names(cleared)} cleared)`] : []
    }
    case 'skeleton.markers':
      return setMarkers(c, markers(cmd.markers))
    case 'skeleton.stale': {
      const action = oneOf(cmd.action, ['restore', 'discard'] as const, 'action')
      const stale = s.stale ?? []
      const wanted = cmd.joints === undefined ? null : new Set(list(cmd.joints, 'joints', str))
      for (const j of wanted ?? []) if (!stale.some(o => o.joint === j)) missing(`No set-aside placement of ${j}`)
      const picked = stale.filter(o => wanted === null || wanted.has(o.joint))
      if (picked.length === 0) return []
      const jointsOf = (os: StaleOverride[]): string[] => [...new Set(os.map(o => o.joint))]
      const tidy = (left: StaleOverride[]): void => { if (left.length > 0) s.stale = left; else delete s.stale }
      if (action === 'discard') {
        tidy(stale.filter(o => !picked.includes(o)))
        return [`skeleton: set-aside placements of ${names(jointsOf(picked))} discarded`]
      }
      // Only where they were made: the template, and for a person the finger level (an index chain means a mitten's
      // middle below full).
      const fits = (o: StaleOverride): boolean => o.template === s.template && (s.template !== 'human' || o.level === s.fingerLevel)
      const now = picked.filter(fits)
      const kept = picked.filter(o => !fits(o))
      if (now.length === 0) return conflict(`Those placements were made ${madeWhere(c, kept[0])}; switch back to restore them`)
      for (const o of now) place(c, o.joint, [...o.at])   // (in the order they were set aside: the latest wins)
      tidy(stale.filter(o => !now.includes(o)))
      const out = [`skeleton: restored ${names(jointsOf(now))}`]
      if (kept.length > 0) out.push(`skeleton: ${names(jointsOf(kept))} still set aside (made ${madeWhere(c, kept[0])})`)
      return out
    }
    case 'skeleton.boneMap': {
      const next = cmd.boneMap === null ? null : record(cmd.boneMap, 'boneMap', str)
      if (same(s.boneMap ?? null, next)) return []
      if (next === null) { delete s.boneMap; return ['bone map cleared'] }
      s.boneMap = next
      return [`bone map changed (${plural(Object.keys(next).length, 'bone')})`]
    }
  }
  return unknown(cmd)
}
