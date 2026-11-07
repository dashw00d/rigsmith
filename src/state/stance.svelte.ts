/** Motion's active stance is preview state, scoped to the selected character. */
class StanceState {
  characterId = $state<string | null>(null)
  id = $state<string | null>(null)
  select (characterId: string, id: string | null): void { this.characterId = characterId; this.id = id }
  current (characterId: string): string | null { return this.characterId === characterId ? this.id : null }
}
export const stance = new StanceState()
