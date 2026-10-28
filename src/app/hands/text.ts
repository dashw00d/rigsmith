// The words and keys the Hands panel shows: what a hand layer is, when it applies and where it is changed; where a pose
// came from and what uses it; the hand pose picker's keys. Pure (no app state), so it is tested on its own.
import type { Adjustment, Character, HandPose, HandPoseRef, Side, Slot } from '../../model/types.ts'
import { FISTS, refLabel, type HandLayer } from '../../engine/hands.ts'
import { windowsText } from '../motion/rules.ts'

export const SIDES: Side[] = ['Left', 'Right']

/** Where a "change it there" link goes: a gear piece's handle (the Gear step) or a slot's adjustment (Motion). That
 * step shows it and clears the request (src/state/hands.svelte.ts `focus`). */
export type HandFocus = { step: 'gear', gear: string, handle?: string } | { step: 'motion', slot: string, adjustment: string }

/** A pose reference as the picker's key: '' unset, 'default', 'clip', 'pose:<id>', 'fist:<clip id>'. */
export function refKey (ref: HandPoseRef | undefined): string {
  if (ref === undefined) return ''
  if (ref === 'default' || ref === 'clip') return ref
  return 'pose' in ref ? `pose:${ref.pose}` : `fist:${ref.fist}`
}

/** The reference a picker key stands for (undefined: unset, or a key it doesn't know). */
export function refOf (key: string): HandPoseRef | undefined {
  if (key === 'default' || key === 'clip') return key
  if (key.startsWith('pose:') && key.length > 5) return { pose: key.slice(5) }
  if (key.startsWith('fist:') && key.length > 5) return { fist: key.slice(5) }
  return undefined
}

const SOURCE: Record<HandLayer['source'], string> = { carry: 'Carry', hold: 'Every clip', pull: 'Pull', slot: 'This slot' }

/** A layer's source as a short word. */
export const sourceLabel = (layer: HandLayer): string => SOURCE[layer.source]

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** What a layer row says: why it is there, the pose it gives (null when the reason says it already), and when it applies
 * (null: always), as Motion shows a window: in `frames` of the clip as it plays when they are known, else as parts of it. */
export function layerText (c: Character, layer: HandLayer, shared?: HandPose[], frames: number | null = null): { reason: string, pose: string | null, when: string | null } {
  // (a slot's own pose belongs to a carry handle when it names gear: "open while it carries GearBow")
  const gear = layer.source === 'slot' && layer.gear !== undefined ? c.gear.find(g => g.id === layer.gear)?.name : undefined
  return {
    reason: capital(layer.reason) + (gear === undefined ? '' : `, carrying ${gear}`),
    pose: layer.source === 'slot' ? null : refLabel(c, layer.ref, shared),
    when: layer.source === 'slot' || layer.source === 'pull' ? windowsText(layer.windows, frames) : null,
  }
}

/** Where a layer is changed: the gear handle that poses it (Gear), the adjustment that times it on the slot playing
 * (Motion; none without one). hands.hold has no link: it is changed in the panel itself. */
export function layerLinks (layer: HandLayer, slotId: string | null): Array<{ label: string, hint: string, to: HandFocus }> {
  const out: Array<{ label: string, hint: string, to: HandFocus }> = []
  if ((layer.source === 'carry' || layer.source === 'pull') && layer.gear !== undefined) {
    out.push({ label: 'Gear', hint: layer.source === 'carry' ? 'Its pose is the carry handle\'s, in Gear' : 'Its pose is the pull handle\'s, in Gear', to: { step: 'gear', gear: layer.gear, handle: layer.handle } })
  }
  if ((layer.source === 'pull' || layer.source === 'slot') && layer.adjustment !== undefined && slotId !== null) {
    out.push({ label: 'Motion', hint: layer.source === 'pull' ? 'When it is held: the slot\'s handle hold, in Motion' : 'The slot\'s hand pose, in Motion', to: { step: 'motion', slot: slotId, adjustment: layer.adjustment } })
  }
  return out
}

const FINGER_ORDER = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']
const FINGER_BONE = /^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)\d$/

/** The fingers of `side`'s hand a slot's enabled keys adjustment turns (keys come after every hand layer in the bake,
 * so they win over all of them), in finger order; null when it keys none. */
export function fingerKeys (slot: Pick<Slot, 'adjustments'> | null | undefined, side: Side): { adjustment: string, fingers: string[] } | null {
  const keys = slot?.adjustments.find((a): a is Extract<Adjustment, { kind: 'keys' }> => a.kind === 'keys' && a.enabled)
  if (keys === undefined) return null
  const keyed = new Set<string>()
  for (const [bone, ks] of Object.entries(keys.bones ?? {})) {
    const m = FINGER_BONE.exec(bone)
    if (m !== null && m[1] === side && ks.length > 0) keyed.add(m[2])
  }
  const fingers = FINGER_ORDER.filter(f => keyed.has(f))
  return fingers.length === 0 ? null : { adjustment: keys.id, fingers }
}

/** `base`, or `base 2`, `base 3`… : the first no pose is called. */
export function nextName (poses: readonly HandPose[], base: string): string {
  const taken = new Set(poses.map(p => p.name))
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`
}

/** Where a pose came from, in words: "from Idle at 0.40 s", "from the Great sword fist", "made by hand". */
export function sourceText (c: Pick<Character, 'clips'>, pose: HandPose): string {
  const from = pose.from
  if (from === undefined) return 'made by hand'
  const fist = FISTS.find(([id]) => id === from.clip)
  if (fist !== undefined) return `the ${fist[1]} fist`
  const slot = c.clips.find(s => s.id === from.clip)
  return `from ${slot?.name ?? from.clip.replace(/^mixamo-/, '')} at ${from.at.toFixed(2)} s`
}

const names = (ref: HandPoseRef | undefined, id: string): boolean => typeof ref === 'object' && 'pose' in ref && ref.pose === id

/** What closes a hand into pose `id`, in words: its handles, the slots that pose a hand in it, the hands held in it. */
export function poseUses (c: Pick<Character, 'gear' | 'clips' | 'hands'>, id: string): string[] {
  const out: string[] = []
  for (const g of c.gear) for (const h of g.handles) if (names(h.pose, id)) out.push(`${g.name} · ${h.name}`)
  for (const s of c.clips) {
    for (const a of s.adjustments) if (a.kind === 'handPose' && names(a.pose, id)) out.push(`${s.name} (${a.hand.toLowerCase()} hand)`)
  }
  for (const side of SIDES) if (names(c.hands.hold?.[side], id)) out.push(`the ${side.toLowerCase()} hand in every clip`)
  return out
}

/** A list in words: "a", "a and b", "a, b and c". */
export function listText (items: readonly string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}
