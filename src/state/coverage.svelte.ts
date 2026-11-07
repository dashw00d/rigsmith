import type { CharacterView } from '../engine/CharacterView.ts'
import { bodySurface, type BodySurface } from '../engine/garments.ts'
import { regionNames, regionStates, type CoveragePiece, type RegionState } from '../engine/coverage.ts'
import { gear } from './gear.svelte.ts'
import { viewer } from './viewer.svelte.ts'

interface CoverageData { body: BodySurface, names: string[], regions: RegionState[], pieces: CoveragePiece[] }
const bodies = new WeakMap<CharacterView, { body: BodySurface, names: string[] } | null>()

class CoverageState {
  on = $state(false)
  hover = $state<number | null>(null)

  get data (): CoverageData | null {
    const view = viewer.character
    if (view === null) return null
    let found = bodies.get(view)
    if (found === undefined) {
      const body = bodySurface(view)
      found = body === null ? null : { body, names: regionNames(body, view) }
      bodies.set(view, found)
    }
    if (found === null) return null
    const pieces = gear.coveragePieces().flatMap(({ gear: g, worn, shown }) => worn.hits === undefined ? [] : [{ id: g.id, hits: worn.hits, share: worn.hideShare, shown }])
    return { ...found, pieces, regions: regionStates(pieces.filter(p => p.shown), found.body.regions.vertices) }
  }

  /** One piece's counts, whether it is currently shown or kept fitted for browsing. */
  piece (id: string): RegionState[] | null {
    const data = this.data
    const piece = data?.pieces.find(p => p.id === id)
    return data === null || data === undefined || piece === undefined ? null : regionStates([piece], data.body.regions.vertices)
  }
}
export const coverage = new CoverageState()
