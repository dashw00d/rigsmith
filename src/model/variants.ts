// A game clip's variants (docs/motion-plan.md §6, §9 C2): more than one Attack (or Die, or any clip the game plays),
// one picked at random each time. A variant is an ordinary slot named after its clip and a number, `Attack 2`,
// `Attack 3`...; the unit export plays it as `Attack_2`... and lists them in the events file
// (`"variants": {"Attack": ["Attack", "Attack_2"]}`), so the game knows which clips stand for one. There is nothing
// else to manage: adding one is copying the clip's slot under the next free name (slot.copy), removing one is removing
// its slot. Pure: the app, the server and the export ask here.
import type { Character, Slot } from './types.ts'

const NUMBERED = /^(.+) ([2-9]|[1-9]\d)$/

/** The game clip a slot name is a variant of, and its number (2 on), or null: `name` is `<clip> <n>` for one of the
 * game's clip names. */
export function variantOf (name: string, gameNames: readonly string[]): { base: string, n: number } | null {
  const m = NUMBERED.exec(name)
  return m !== null && gameNames.includes(m[1]) ? { base: m[1], n: Number(m[2]) } : null
}

/** The slot name of a game clip's `n`th variant. */
export const variantName = (base: string, n: number): string => `${base} ${n}`

/** The name a slot plays under in the game: a variant's `<clip>_<n>`, any other its own. */
export function exportName (name: string, gameNames: readonly string[]): string {
  const v = variantOf(name, gameNames)
  return v === null ? name : `${v.base}_${v.n}`
}

/** The game clip an exported clip name stands for: `Attack_2`'s is Attack; any other name its own. */
export function gameNameOf (exported: string, gameNames: readonly string[]): string {
  const m = /^(.+)_(\d+)$/.exec(exported)
  return m !== null && gameNames.includes(m[1]) && !gameNames.includes(exported) ? m[1] : exported
}

/** A game clip's variants among the slots, by number. */
export function variantsOf (c: Pick<Character, 'clips'>, base: string, gameNames: readonly string[]): Slot[] {
  return c.clips.map(s => ({ s, v: variantOf(s.name, gameNames) })).filter(x => x.v?.base === base).sort((a, b) => a.v!.n - b.v!.n).map(x => x.s)
}

/** The name the next variant of a game clip takes: the first number from 2 no slot has. */
export function nextVariantName (c: Pick<Character, 'clips'>, base: string): string {
  for (let n = 2; ; n++) if (!c.clips.some(s => s.name === variantName(base, n))) return variantName(base, n)
}

/** The game's clips as the export plays them: each slot of `gameNames` followed by its variants. */
export function withVariants (c: Pick<Character, 'clips'>, gameNames: readonly string[]): Slot[] {
  return gameNames.flatMap(n => {
    const s = c.clips.find(x => x.name === n)
    return s === undefined ? [] : [s, ...variantsOf(c, n, gameNames)]
  })
}

/** The events file's `variants`: each game clip that has variants, with every name it plays as (itself first). Unset
 * when none has any. */
export function variantsField (c: Pick<Character, 'clips'>, gameNames: readonly string[]): Record<string, string[]> | undefined {
  const out: Record<string, string[]> = {}
  for (const n of gameNames) {
    const vs = variantsOf(c, n, gameNames)
    if (vs.length > 0 && c.clips.some(s => s.name === n)) out[n] = [n, ...vs.map(s => exportName(s.name, gameNames))]
  }
  return Object.keys(out).length > 0 ? out : undefined
}
