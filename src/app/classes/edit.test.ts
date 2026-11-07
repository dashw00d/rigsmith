// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { makeCharacter } from '../../model/fixtures.ts'
import { applyCommands } from '../../model/commands.ts'
import { kindSets } from '../../model/folk.ts'
import { addClass, copyPoolFor, toList, weigh } from './edit.ts'
import { pick, worldOf } from '../../engine/folkpick.ts'

const fixture = () => makeCharacter({ folk: { sets: [{ id: 'a', name: 'A', tags: ['culture:norse'], pieces: [], grants: [], weight: 2 }, { id: 'b', name: 'B', tags: [], pieces: [], grants: [] }], pools: [{ id: 'hair', name: 'Hair', kind: 'hair', items: [] }], kinds: [{ id: 'folk', name: 'Folk', tags: [], sets: { query: [] }, pools: { hair: 'hair' } }, { id: 'other', name: 'Other', tags: [], sets: { query: [] }, pools: { hair: 'hair' } }], stances: [] } })
const run = (c: ReturnType<typeof fixture>, commands: Parameters<typeof applyCommands>[1]) => applyCommands(c, commands).character
describe('class edits', () => {
  it('creates a unique id and preserves query weights when listing', () => {
    let c = fixture(); c = run(c, addClass(c, 'Folk'))
    expect(c.folk!.kinds.at(-1)!.id).toBe('folk-2')
    const kind = c.folk!.kinds[0]; const rows = kindSets(c.folk!.sets, kind)
    c = run(c, [{ type: 'folk.kind.sets', id: kind.id, sets: toList(c, kind) }])
    expect(kindSets(c.folk!.sets, c.folk!.kinds[0])).toEqual(rows)
    c = run(c, weigh(c, c.folk!.kinds[0], 'a', 0))
    expect(kindSets(c.folk!.sets, c.folk!.kinds[0])[0].weight).toBe(0)
  })
  it('copies a pool for one class only', () => {
    let c = fixture(); c = run(c, copyPoolFor(c, c.folk!.kinds[0], 'hair'))
    expect(c.folk!.kinds[0].pools!.hair).toBe('hair-copy')
    expect(c.folk!.kinds[1].pools!.hair).toBe('hair')
    const implicit = fixture(); delete implicit.folk!.kinds[0].pools
    const copied = run(implicit, copyPoolFor(implicit, implicit.folk!.kinds[0], 'hair'))
    expect(copied.folk!.kinds[0].pools!.hair).toBe('hair-copy')
  })
  it('removing a skin from a copied pool changes only that class across 200 units', () => {
    let c = makeCharacter({ look: { skins: [{ name: 'A', file: 'a.png' }, { name: 'B', file: 'b.png' }] }, folk: {
      sets: [], pools: [{ id: 'skin', name: 'Skin', kind: 'skin', items: [{ ref: 'A' }, { ref: 'B' }] }],
      kinds: [{ id: 'one', name: 'One', tags: [], sets: { query: [] } }, { id: 'two', name: 'Two', tags: [], sets: { query: [] } }], stances: [],
    } })
    c = run(c, copyPoolFor(c, c.folk!.kinds[0], 'skin'))
    c = run(c, [{ type: 'folk.pool.items', id: 'skin-copy', items: [{ ref: 'B' }] }])
    const world = worldOf(c)
    const own = Array.from({ length: 200 }, (_, i) => pick(world, i + 1, { kind: 'one' }).picks.skin)
    const other = Array.from({ length: 200 }, (_, i) => pick(world, i + 1, { kind: 'two' }).picks.skin)
    expect(own.every(x => x === 'B')).toBe(true)
    expect(other).toContain('A')
  })
})
