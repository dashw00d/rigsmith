import { expect, it, vi } from 'vitest'
import { api, type GameStatus } from '../../state/api.ts'
import { app } from '../../state/app.svelte.ts'
import { ship } from '../../state/ship.svelte.ts'

it.fails('keeps the newest game-unit reload when requests resolve out of order', async () => {
  let finishOld!: (value: GameStatus) => void
  let finishNew!: (value: GameStatus) => void
  const old = new Promise<GameStatus>(resolve => { finishOld = resolve })
  const fresh = new Promise<GameStatus>(resolve => { finishNew = resolve })
  const spy = vi.spyOn(api, 'game').mockReturnValueOnce(old).mockReturnValueOnce(fresh)
  app.gameBeat += 1
  const a = ship.load()
  app.gameBeat += 1
  const b = ship.load()
  const empty: GameStatus = { repo: '', defaults: {}, units: {} }
  const newer: GameStatus = { repo: '', defaults: {}, units: { unit: { ours: { character: 'c', height: 2, budget: 1000, clips: [] }, game: null, differs: true } } }
  finishNew(newer); await b
  finishOld(empty); await a
  expect(ship.status?.units.unit?.ours?.character).toBe('c')
  spy.mockRestore()
})
