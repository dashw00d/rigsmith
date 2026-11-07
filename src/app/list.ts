import { isFolkCharacter } from '../model/folk.ts'
import type { Character } from '../model/types.ts'

export type CharacterSort = 'name' | 'updated'
export function searchCharacters (list: readonly Character[], query: string): Character[] {
  const q = query.trim().toLowerCase()
  return list.filter(c => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
}
export function sortCharacters (list: readonly Character[], sort: CharacterSort): Character[] {
  return [...list].sort((a, b) => (sort === 'updated' ? b.updatedAt - a.updatedAt : 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}
export function groupCharacters (list: readonly Character[], group: 'none' | 'body'): Array<{ name: string, characters: Character[] }> {
  if (group === 'none') return [{ name: '', characters: [...list] }]
  const groups = new Map<string, Character[]>()
  for (const c of list) {
    const name = isFolkCharacter(c) ? 'Dynamic' : c.status !== 'rigged' ? 'Not rigged' : c.skeleton.template === 'human' ? 'Humanoid' : c.skeleton.template || 'Not rigged'
    groups.set(name, [...groups.get(name) ?? [], c])
  }
  return [...groups].map(([name, characters]) => ({ name, characters }))
}
