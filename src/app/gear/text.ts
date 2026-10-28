// What the Gear step says about a piece: where it is worn, where it came from, how the list groups it, which bones it
// can ride, and which slots hold its pulls. Pure, so it is tested apart from the panel.
import { handSide, hierarchyOf } from '../../model/select.ts'
import type { Character, Gear, Handle, SkinPolicy, Slot, Window } from '../../model/types.ts'
import { windowsText } from '../motion/rules.ts'

export const POLICY_LABEL: Record<SkinPolicy, string> = {
  body: 'Follows body', upper: 'Upper body', lower: 'Lower body', cape: 'Cape / cloak', skirt: 'Skirt / robe', head: 'Head',
}

/** The game's own part (tools/game_import.py): the game names it, so it can't be renamed. */
export const fromGame = (g: Pick<Gear, 'from'>): boolean => g.from?.startsWith('emberhold:') === true

/** Where it came from, in a word: the game, the catalog, or an upload. */
export function originOf (g: Pick<Gear, 'from' | 'catalog'>): 'game' | 'catalog' | 'upload' {
  if (fromGame(g)) return 'game'
  return g.catalog !== undefined || g.from?.startsWith('catalog:') === true ? 'catalog' : 'upload'
}

/** How it is worn, short: "on RightHand", "on the skin · Cape / cloak", "pinned to a spot · plays Spin". */
export function wearText (g: Pick<Gear, 'attach' | 'painted'>): string {
  const a = g.attach
  if (a.kind === 'bone') return `on ${a.bone}`
  if (a.kind === 'skin') return `on the skin · ${POLICY_LABEL[a.policy]}${(g.painted ?? 0) > 0 ? ' · painted' : ''}`
  return `pinned to ${a.anchor !== undefined ? 'a spot' : 'the nearest skin'}${a.animation !== undefined ? ` · plays ${a.animation}` : ''}`
}

/** The list's groups: pieces in no swap set first, then each swap set in the order its first piece comes. */
export function swapGroups (gear: readonly Gear[]): Array<{ set: string | null, gear: Gear[] }> {
  const out: Array<{ set: string | null, gear: Gear[] }> = []
  const loose = gear.filter(g => g.swapSet === undefined)
  if (loose.length > 0) out.push({ set: null, gear: loose })
  for (const g of gear) {
    if (g.swapSet === undefined) continue
    const group = out.find(x => x.set === g.swapSet)
    if (group === undefined) out.push({ set: g.swapSet, gear: [g] })
    else group.gear.push(g)
  }
  return out
}

/** Every swap set named on the character, in order. */
export const swapSets = (gear: readonly Gear[]): string[] => [...new Set(gear.flatMap(g => (g.swapSet === undefined ? [] : [g.swapSet])))]

/** The bones gear can ride, the hands first (where most of it goes), then the rest as the skeleton orders them; `keep`
 * (its bone now) kept even when the skeleton no longer has it. */
export function boneChoices (c: Pick<Character, 'skeleton'>, keep?: string): string[] {
  const all = hierarchyOf(c).map(([j]) => j)
  // (the right hand first: most weapons and tools go there)
  const hands = ['RightHand', 'LeftHand'].filter(j => all.includes(j))
  const out = [...hands, ...all.filter(j => !hands.includes(j))]
  return keep !== undefined && !out.includes(keep) ? [keep, ...out] : out
}

/** A bone's name for a person: "Right hand" for the hands, else the bone itself. */
export function boneLabel (bone: string): string {
  const side = handSide(bone)
  return side !== null ? `${side} hand` : bone
}

/** The slots that hold a pull handle (their handleHold adjustments on it), with when, and when in words (as parts of
 * the clip, the way Motion shows a window: another slot's frames aren't known here). */
export function holdsOf (c: Pick<Character, 'clips'>, gear: string, handle: string): Array<{ slot: Slot, adjustment: string, windows: Window[], when: string, enabled: boolean }> {
  return c.clips.flatMap(slot => slot.adjustments.flatMap(a => (a.kind === 'handleHold' && a.gear === gear && a.handle === handle
    ? [{ slot, adjustment: a.id, windows: a.windows, when: windowsText(a.windows, null), enabled: a.enabled }]
    : [])))
}

/** The handles in the order the panel lists them: carry, grips, pulls. */
export function handlesInOrder (g: Pick<Gear, 'handles'>): Handle[] {
  const rank = { carry: 0, grip: 1, pull: 2 }
  return [...g.handles].sort((a, b) => rank[a.kind] - rank[b.kind])
}

/** A handle name not taken on the piece: `base`, else `base 2`, ... */
export function freeHandleName (g: Pick<Gear, 'handles'>, base: string): string {
  if (!g.handles.some(h => h.name === base)) return base
  for (let i = 2; ; i++) if (!g.handles.some(h => h.name === `${base} ${i}`)) return `${base} ${i}`
}
