import { app } from './app.svelte.ts'
import type { CharacterSort } from '../app/list.ts'

type Tab = 'characters' | 'classes'
type Group = 'none' | 'body'
function read (key: string): string | null { try { return localStorage.getItem(`rigsmith.classes.${key}`) } catch { return null } }
function write (key: string, value: string): void { try { localStorage.setItem(`rigsmith.classes.${key}`, value) } catch { /* unavailable */ } }
function readOpened (): Record<string, string> {
  try {
    const value: unknown = JSON.parse(read('open') ?? '{}')
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch { return {} }
}
class ClassesState {
  tab = $state<Tab>(read('tab') === 'classes' ? 'classes' : 'characters')
  sort = $state<CharacterSort>(read('sort') === 'updated' ? 'updated' : 'name')
  group = $state<Group>(read('group') === 'body' ? 'body' : 'none')
  private opened = $state<Record<string, string>>(readOpened())
  get view (): { sort: CharacterSort, group: Group } { return { sort: this.sort, group: this.group } }
  get openId (): string | null { return app.selectedId === null ? null : this.opened[app.selectedId] ?? null }
  setTab (value: Tab): void { this.tab = value; write('tab', value) }
  setSort (value: CharacterSort): void { this.sort = value; write('sort', value) }
  setGroup (value: Group): void { this.group = value; write('group', value) }
  close (): void { if (app.selectedId !== null) { delete this.opened[app.selectedId]; write('open', JSON.stringify(this.opened)) } }
  async openClass (characterId: string, kindId: string): Promise<boolean> {
    if (!await app.select(characterId) || !await app.go('gear')) return false
    this.opened[characterId] = kindId
    write('open', JSON.stringify(this.opened))
    return true
  }
}
export const classes = new ClassesState()
