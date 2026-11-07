import type { Gear } from './types.ts'

/** Incoming replacement meshes use their own immutable-named painting file; legacy meshes keep weights.json. */
export function gearWeightsFile (gear: Pick<Gear, 'id' | 'model'>): string {
  const incoming = /(?:^|\/)incoming-([a-f0-9]{16})\.glb$/i.exec(gear.model ?? '')
  return `garments/${gear.id}/${incoming === null ? 'weights.json' : `weights.incoming-${incoming[1]}.json`}`
}
