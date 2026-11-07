// The subset of the harness contract used here; the harness owns its full UI and hook types.
import type { Character } from '../../src/model/types.ts'
import type { Stage } from '../../src/engine/Stage.ts'
import type { Dressed } from '../../src/state/dressing.ts'

export interface Hook {
  app: { selected: Character | null }
  gear: { selected: string | null, fitting: string | null, isWorn: (id: string) => boolean, select: (id: string | null) => void, pickAt: (event: Pick<PointerEvent, 'clientX' | 'clientY'>) => void }
  dress: { worn: (c: Character) => Dressed, locked: (id: string, field: 'skin') => boolean }
  viewer: { stage: Stage | null }
  wardrobe: { crowdOpen: boolean, unit: (c: Character) => { uid: number } | null }
}
export type Selector = { testid: string, id?: string, within?: Selector } | { role: string, name: string, within?: Selector }
export interface UI {
  click: (selector: Selector) => Promise<void>
  rightClick: (selector: Selector) => Promise<void>
  clickAt: (selector: Selector, x: number, y: number) => Promise<void>
  fill: (selector: Selector, value: string) => Promise<void>
  key: (key: string) => Promise<void>
  press: (keys: string) => Promise<void>
  exists: (selector: Selector) => Promise<boolean>
  count: (selector: Selector) => Promise<number>
  text: (selector: Selector) => Promise<string>
  waitFor: (target: Selector | ((r: Hook) => boolean), ms?: number) => Promise<void>
  eval: <T, A extends unknown[] = []>(fn: (r: Hook, ...args: A) => T | Promise<T>, ...args: A) => Promise<Awaited<T>>
  shot: (label: string) => Promise<string>
}
