// hands.*: the character's named hand poses and the hands held in every clip.
import type { Command } from '../command-types.ts'
import type { Character, HandPose, HandPoseRef, Side } from '../types.ts'
import { conflict, handPoseRef, id, missing, name, num, obj, opt, patchOf, quat, record, refText, same, side, str, unknown } from './common.ts'

export type HandsCommand = Extract<Command, { type: `hands.${string}` }>

const from = (v: unknown): HandPose['from'] => {
  const f = obj(v, 'from')
  return { clip: str(f.clip, 'from.clip'), at: num(f.at, 'from.at', { min: 0 }) }
}

function handPose (v: unknown): HandPose {
  const p = obj(v, 'pose')
  const f = opt(p.from, from)
  return { id: id(p.id, 'pose.id'), name: name(p.name, 'pose.name'), side: side(p.side, 'pose.side'), joints: record(p.joints, 'pose.joints', quat), ...(f !== undefined ? { from: f } : {}) }
}

const refersTo = (ref: HandPoseRef | undefined, poseId: string): boolean => typeof ref === 'object' && 'pose' in ref && ref.pose === poseId

export function reduceHands (c: Character, cmd: HandsCommand): string[] {
  const hands = c.hands
  switch (cmd.type) {
    case 'hands.pose.add': {
      const p = handPose(cmd.pose)
      if (hands.poses.some(x => x.id === p.id)) conflict(`A hand pose ${p.id} exists already`)
      hands.poses.push(p)
      return [`hand pose ${p.name}: added${p.from !== undefined ? ` (from ${p.from.clip} at ${p.from.at.toFixed(2)} s)` : ''}`]
    }
    case 'hands.pose.update': {
      const p = hands.poses.find(x => x.id === cmd.id) ?? missing(`No hand pose ${cmd.id}`)
      const patch = patchOf(cmd.patch, ['name', 'side', 'joints', 'from'])
      const out: string[] = []
      if (patch.name !== undefined) {
        const next = name(patch.name, 'name')
        if (next !== p.name) { out.push(`hand pose ${p.name}: renamed ${next}`); p.name = next }
      }
      if (patch.side !== undefined) {
        const next = side(patch.side, 'side')
        if (next !== p.side) { p.side = next; out.push(`hand pose ${p.name}: made on the ${next} hand`) }
      }
      if (patch.joints !== undefined) {
        const next = record(patch.joints, 'joints', quat)
        if (!same(next, p.joints)) { p.joints = next; out.push(`hand pose ${p.name}: changed`) }
      }
      if (patch.from !== undefined) {
        const next = opt(patch.from, from)
        if (!same(next ?? null, p.from ?? null)) {
          if (next === undefined) delete p.from
          else p.from = next
          out.push(`hand pose ${p.name}: ${next === undefined ? 'source forgotten' : `from ${next.clip} at ${next.at.toFixed(2)} s`}`)
        }
      }
      return out
    }
    case 'hands.pose.remove': {
      const p = hands.poses.find(x => x.id === cmd.id) ?? missing(`No hand pose ${cmd.id}`)
      hands.poses = hands.poses.filter(x => x !== p)
      const out = [`hand pose ${p.name}: removed`]
      // What used it falls back to the default fist, and says so.
      for (const g of c.gear) {
        for (const h of g.handles) {
          if (!refersTo(h.pose, p.id)) continue
          h.pose = 'default'
          out.push(`gear ${g.name}: ${h.name} back in the default fist (${p.name} was removed)`)
        }
      }
      for (const s of c.clips) {
        for (const a of s.adjustments) {
          if (a.kind !== 'handPose' || !refersTo(a.pose, p.id)) continue
          a.pose = 'default'
          out.push(`clip ${s.name}: ${a.hand} hand back in the default fist (${p.name} was removed)`)
        }
      }
      for (const [hand, ref] of Object.entries(hands.hold ?? {})) {
        if (!refersTo(ref, p.id)) continue
        hands.hold![hand as Side] = 'default'
        out.push(`${hand} hand: held in the default fist (${p.name} was removed)`)
      }
      return out
    }
    case 'hands.hold': {
      const hand = side(cmd.side, 'side')
      const ref = cmd.pose === null ? null : handPoseRef(cmd.pose, 'pose')
      if (same(hands.hold?.[hand] ?? null, ref)) return []
      if (ref === null) {
        delete hands.hold![hand]
        if (Object.keys(hands.hold!).length === 0) delete hands.hold
        return [`${hand} hand: no longer held`]
      }
      hands.hold = { ...hands.hold, [hand]: ref }
      return [`${hand} hand: held ${refText(c, ref)} in every clip`]
    }
  }
  return unknown(cmd)
}
