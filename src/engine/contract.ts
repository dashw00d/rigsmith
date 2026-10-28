// The game's rules for a unit, as constants and small functions: what the game looks for by name (meshes, levels,
// swapped parts), what a clip must do to be played under its name, what counts against the triangle budget. One copy
// for the unit export (tools/lib/unit_export.ts), the Ship step's checks (src/engine/checks.ts) and the scale room.
import type { Gear } from '../model/types.ts'

/** Parts the game shows by job or look (the villager's tools and loads, spare heads, job wear), by mesh name: exported
 * even while hidden in Rigsmith, and outside the body's triangle budget. */
export const SWAPPED = /^(Gear|Head|Wear)/

// What a game clip must look like, by its name: locomotion steps, standing clips stand. Library names can mislead
// ("Carrying" was "Carrying Someone Idle", "Talking" "Talking While Seated"), so the export checks the motion itself.
// (A rider's clips are not checked: his feet are in the stirrups, his steps the horse's.)
/** Clips whose feet must swing (the lesser foot, front to back) at least STEP_SWING × the unit's height. */
export const STEPS: ReadonlySet<string> = new Set(['Walk', 'Carry', 'Run'])
export const STEP_SWING = 0.12
/** Clips whose hips' median height must stay at least STAND_HIPS × their height at rest (not seated, not crouched). */
export const STANDS: ReadonlySet<string> = new Set(['Idle', 'Trade', 'Hunt'])
export const STAND_HIPS = 0.8

/** Where in an attack the game lands its hit, as a share of the clip. */
export const HIT_AT = 0.45

/** A mesh with this many triangles or fewer gets no levels (<mesh>_LOD1, _LOD2). */
export const NO_LOD_BELOW = 60
/** A unit's levels as ratios of LOD0, when its spec names none. */
export const DEFAULT_LODS: readonly number[] = [0.45, 0.15]

/** Why a clip doesn't move as its game name says, or null. `footSwing` and `hipsMedian` are shares of the unit's
 * height (the export's build record keeps them), `restHips` the hips' height at rest the same way. */
export function clipProblem (name: string, stats: { footSwing: number, hipsMedian: number }, restHips: number): string | null {
  if (STEPS.has(name) && stats.footSwing < STEP_SWING) return `clip ${name}: the feet swing ${stats.footSwing} x height: it doesn't walk (an idle under a walking name?)`
  if (STANDS.has(name) && stats.hipsMedian < STAND_HIPS * restHips) return `clip ${name}: the hips sit at ${stats.hipsMedian} x height (rest ${restHips.toFixed(3)}): not standing (a seated clip?)`
  return null
}

/** The name the game knows a piece of gear's mesh by: game gear (from 'emberhold:<unit>/<part>') by its part, any other
 * by its own name. */
export function meshNameOf (g: Pick<Gear, 'name' | 'from'>): string {
  return /^emberhold:[^/]*\/(.+)$/.exec(g.from ?? '')?.[1] ?? g.name
}

/** Why the unit export leaves a piece of gear out (the reason its build record gives), or null when it goes in. Only
 * parts the game built go in (from 'emberhold:...': every model starts in Blender); a hidden one stays out unless the
 * game swaps it in by job or look. */
export function gearLeftOut (g: Gear): string | null {
  if (g.status !== 'ready' || (g.model === undefined && g.catalog === undefined)) return 'not ready'
  if (g.hidden === true && !SWAPPED.test(meshNameOf(g))) return 'hidden'
  if (!(g.from ?? '').startsWith('emberhold:')) return 'not a part the game built (AGENTS.md: every model starts in Blender)'
  return null
}

export const gearExported = (g: Gear): boolean => gearLeftOut(g) === null

/** The body's share of a unit's LOD0 budget: what its gear leaves (parts by mesh name; swapped parts don't count, the
 * game shows one of them at a time). */
export function budgetOf (budget: number, parts: Array<{ name: string, triangles: number }>): number {
  return budget - parts.reduce((t, p) => t + (SWAPPED.test(p.name) ? 0 : p.triangles), 0)
}

/** The simplify ratio that brings a mesh of `triangles` within `budget` (1: it is already), a little under so the
 * simplifier's overshoot stays inside. */
export function budgetRatio (triangles: number, budget: number): number {
  return triangles > budget ? budget / triangles * 0.99 : 1
}
