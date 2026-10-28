// Pushing an arm out of the body, plainly, before anything cleverer is tried (the clip editor's Solve body,
// src/state/clipedit.svelte.ts): for each arm segment inside another body part (bodycollide.ts selfPenetration, past
// what the pair may overlap), the way straight out of what it is in (Contact.normal), and the arm moved that way a little
// at a time until it is clear: a free hand carried out along it by IK (its turn kept), the elbow swung round the
// shoulder-to-wrist line toward it (the hand staying where it is: a hand on a handle only swings its elbow). The first
// step that clears is kept, so the arm moves no further than it must (the designer, 2026-10-28: "it is doing god knows
// what, failing, and then sending the arm flying behind the character, when all it had to do is move 1 inch to the
// right"). Nothing clears within reach: the step that left it least deep is kept, if it is less deep than it was.
import * as THREE from 'three'
import type { Contact } from './bodycollide.ts'
import { reach, type NameOf } from './ik.ts'
import type { JointLimits } from './limits.ts'

type Side = 'Left' | 'Right'

/** What the push asks of the body: its overlapping pairs, and one pair's contact (bodycollide.ts CharacterCollider). */
export interface Contacts {
  selfPenetration (): { worst: number, pairs: Array<[string, string, number]> }
  contact (a: string, b: string): Contact | null
}

/** Each step a hand is carried out (a share of the body's height: about a centimetre on a person) and how far at most; each
 * step an elbow swings (degrees) and how far at most; how many overlaps are taken in turn. */
export const PUSH = { step: 0.006, reach: 0.2, swing: 4, swingMax: 120, rounds: 8 }

/** Overlaps shallower than this (metres) are clear. */
const CLEAR = 1e-4

const ARM = ['Arm', 'ForeArm', 'Hand'] as const

/** The arm a segment is part of (by segment name), or null (a leg, the trunk, the head). */
function armSide (segment: string): Side | null {
  for (const side of ['Left', 'Right'] as const) if (ARM.some(p => segment === `${side}${p}`)) return side
  return null
}

/**
 * Push each arm that is inside the body straight out of it, in steps (see the header). `held`: the hands on handles
 * (their wrists stay; only their elbows swing). Writes the bones; returns the bones it moved and how deep the deepest
 * overlap left is (metres).
 */
export function pushClear (bones: Map<string, THREE.Bone>, body: Contacts, o: { height: number, limits: JointLimits | null, nameOf: NameOf, held?: ReadonlySet<Side> }): { moved: Set<string>, worst: number } {
  const moved = new Set<string>()
  const given = new Set<string>()
  const held = o.held ?? new Set<Side>()
  const limits = o.limits ?? undefined
  for (let round = 0; round < PUSH.rounds; round++) {
    // (the deepest overlap of an arm not yet given up on; an arm against the other arm moves a free one)
    const pick = body.selfPenetration().pairs.map(([a, b]) => orient(a, b, held)).find(p => p !== null && !given.has(`${p.segment}|${p.other}`))
    if (pick == null) break
    const { segment, other, side } = pick
    const upper = bones.get(`${side}Arm`); const lower = bones.get(`${side}ForeArm`); const end = bones.get(`${side}Hand`)
    const out = body.contact(segment, other)
    if (upper === undefined || lower === undefined || end === undefined || out === null) { given.add(`${segment}|${other}`); continue }
    const limb = { upper, lower, end }
    const depth = (): number => armDepth(body, side)
    const start = [upper.quaternion.clone(), lower.quaternion.clone(), end.quaternion.clone()]
    const put = (q: THREE.Quaternion[]): void => { upper.quaternion.copy(q[0]); lower.quaternion.copy(q[1]); end.quaternion.copy(q[2]); upper.updateMatrixWorld(true) }
    const was = depth()
    upper.updateMatrixWorld(true)
    const S = upper.getWorldPosition(new THREE.Vector3()); const E = lower.getWorldPosition(new THREE.Vector3()); const H = end.getWorldPosition(new THREE.Vector3())
    // (the hand carried straight out; the elbow swung round the shoulder-to-wrist line, the way that takes it out)
    const carry = (k: number): void => { reach(limb, H.clone().addScaledVector(out.normal, k * PUSH.step * o.height), { limits, nameOf: o.nameOf, keepEnd: true }) }
    const line = H.clone().sub(S).normalize()
    const off = E.clone().sub(S).addScaledVector(line, -E.clone().sub(S).dot(line))
    const sign = off.lengthSq() < 1e-10 ? 1 : Math.sign(line.clone().cross(off).dot(out.normal)) || 1
    const swing = (deg: number): void => {
      const pole = (off.lengthSq() < 1e-10 ? out.normal.clone() : off.clone()).applyAxisAngle(line, THREE.MathUtils.degToRad(deg))
      reach(limb, H, { limits, nameOf: o.nameOf, pole, keepEnd: true })
    }
    const tries: Array<() => void> = []
    const steps = Math.ceil(PUSH.reach / PUSH.step); const swings = Math.ceil(PUSH.swingMax / PUSH.swing)
    const carries = held.has(side) ? [] : Array.from({ length: steps }, (_, i) => () => { carry(i + 1) })
    const swingsOut = Array.from({ length: swings }, (_, i) => () => { swing(sign * (i + 1) * PUSH.swing) })
    const swingsBack = Array.from({ length: swings }, (_, i) => () => { swing(-sign * (i + 1) * PUSH.swing) })
    // (a hand in something is carried out first; an upper arm or forearm swings its elbow out first)
    if (segment.endsWith('Hand')) tries.push(...carries, ...swingsOut, ...swingsBack)
    else tries.push(...swingsOut, ...carries, ...swingsBack)
    let best = { d: was, q: start }
    let cleared = false
    for (const go of tries) {
      put(start)
      go()
      const d = depth()
      if (d < best.d - CLEAR) best = { d, q: [upper.quaternion.clone(), lower.quaternion.clone(), end.quaternion.clone()] }
      if (d <= CLEAR) { cleared = true; break }
    }
    put(best.q)
    if (best.q !== start) for (const b of [upper, lower, end]) moved.add(b.name)
    if (!cleared) given.add(`${segment}|${other}`)
  }
  return { moved, worst: body.selfPenetration().worst }
}

/** An overlapping pair as the arm segment to move and what it is in (null: no arm in it). An arm in the other arm: the
 * pair's first, unless that hand is held and the other's isn't. */
function orient (a: string, b: string, held: ReadonlySet<Side>): { segment: string, other: string, side: Side } | null {
  const sa = armSide(a); const sb = armSide(b)
  if (sa !== null && sb !== null && held.has(sa) && !held.has(sb)) return { segment: b, other: a, side: sb }
  if (sa !== null) return { segment: a, other: b, side: sa }
  if (sb !== null) return { segment: b, other: a, side: sb }
  return null
}

/** How deep `side`'s arm is into the rest of the body, all its overlaps together (metres). */
function armDepth (body: Contacts, side: Side): number {
  return body.selfPenetration().pairs.filter(([a, b]) => armSide(a) === side || armSide(b) === side).reduce((s, p) => s + p[2], 0)
}
