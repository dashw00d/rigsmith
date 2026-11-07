import { setsWith, type Folkish } from '../../model/folk.ts'
import type { Gear } from '../../model/types.ts'
import type { MenuItem } from '../../ui/contextmenu.ts'

export function gearListMatches (c: Folkish, gear: Gear, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return [gear.name, gear.swapSet ?? '', ...(gear.tags ?? []), ...setsWith(c, gear.id).map(s => s.name)].some(text => text.toLowerCase().includes(q))
}

interface MenuOptions {
  shown: boolean
  renameable: boolean
  sets: Array<{ id: string, name: string, contains: boolean }>
  select: () => void
  toggle: () => void
  rename: () => void
  addToSet: (id: string) => void
  tag: () => void
  remove: () => void
}

export function buildGearMenu (o: MenuOptions): MenuItem[] {
  return [
    { label: 'Select', run: o.select },
    { label: o.shown ? 'Hide' : 'Show', run: o.toggle },
    { label: 'Rename', disabled: !o.renameable, run: o.rename },
    { label: 'Add to set', disabled: o.sets.length === 0, run: () => {}, children: o.sets.map(s => ({ label: s.name, disabled: s.contains, run: () => { o.addToSet(s.id) } })) },
    { label: 'Tag…', run: o.tag },
    { label: 'Remove', danger: true, run: o.remove },
  ]
}
