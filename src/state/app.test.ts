// The app's pending-by-cid queue (src/state/pending.ts, used by app.svelte.ts do()): a toy document and reducer stand
// in for the character and src/model/commands.ts.
import { describe, expect, it } from 'vitest'
import { push, receive, settle, shown, track, type Apply } from './pending.ts'

interface Toy { version: number, createdAt: number, items: string[] }
type Cmd = { add: string } | { remove: string }

/** Adds or removes items; refuses to add one that is there or remove one that isn't (as a CommandError would). */
const apply: Apply<Toy, Cmd> = (doc, commands) => {
  let items = doc.items
  for (const c of commands) {
    if ('add' in c) {
      if (items.includes(c.add)) throw new Error(`${c.add} is taken`)
      items = [...items, c.add]
    } else {
      if (!items.includes(c.remove)) throw new Error(`no ${c.remove}`)
      items = items.filter(i => i !== c.remove)
    }
  }
  return { ...doc, items }
}

const toy = (version: number, items: string[], createdAt = 1): Toy => ({ version, createdAt, items })

describe('pending commands', () => {
  it('shows the server copy itself when nothing is pending', () => {
    const server = toy(1, ['a'])
    expect(shown(track<Toy, Cmd>(server), apply)).toBe(server)
  })

  it('lays pending batches over the server copy in the order they were issued', () => {
    let t = track<Toy, Cmd>(toy(1, ['a']))
    t = push(t, { cid: 'x', commands: [{ add: 'b' }] })
    t = push(t, { cid: 'y', commands: [{ remove: 'a' }, { add: 'c' }] })
    expect(shown(t, apply).items).toEqual(['b', 'c'])
    expect(t.server.items).toEqual(['a'])
  })

  it('drops the batch a server copy names and keeps the rest on top', () => {
    let t = track<Toy, Cmd>(toy(1, []))
    t = push(t, { cid: 'x', commands: [{ add: 'b' }] })
    t = push(t, { cid: 'y', commands: [{ add: 'c' }] })
    t = receive(t, toy(2, ['b']), 'x')
    expect(t.pending.map(b => b.cid)).toEqual(['y'])
    expect(shown(t, apply).items).toEqual(['b', 'c'])
  })

  it('re-applies pending batches over a newer copy from another writer', () => {
    let t = track<Toy, Cmd>(toy(1, []))
    t = push(t, { cid: 'x', commands: [{ add: 'b' }] })
    t = receive(t, toy(2, ['z']))
    expect(t.server.version).toBe(2)
    expect(shown(t, apply).items).toEqual(['z', 'b'])
  })

  it('ignores an older copy but still settles the batch it names', () => {
    let t = track<Toy, Cmd>(toy(1, []))
    t = push(t, { cid: 'x', commands: [{ add: 'b' }] })
    t = push(t, { cid: 'y', commands: [{ add: 'c' }] })
    // (the SSE echo of both landed first; the reply to x comes late)
    t = receive(t, toy(3, ['b', 'c']), 'y')
    t = receive(t, toy(2, ['b']), 'x')
    expect(t.server.version).toBe(3)
    expect(t.pending).toEqual([])
    expect(shown(t, apply).items).toEqual(['b', 'c'])
  })

  it('keeps the held object for a copy of the same version', () => {
    const t = receive(track<Toy, Cmd>(toy(2, ['a'])), toy(2, ['a']))
    const again = receive(t, toy(2, ['a']))
    expect(again).toBe(t)
  })

  it('takes a character imported again under the same id, though its version starts over', () => {
    const t = receive(track<Toy, Cmd>(toy(9, ['old'], 1)), toy(1, [], 2))
    expect(t.server.items).toEqual([])
  })

  it('leaves out a batch that no longer applies and still applies the ones after it', () => {
    let t = track<Toy, Cmd>(toy(1, []))
    t = push(t, { cid: 'x', commands: [{ add: 'b' }] })
    t = push(t, { cid: 'y', commands: [{ add: 'c' }] })
    // (someone else added b meanwhile: x would fail on the server too)
    t = receive(t, toy(2, ['b']))
    expect(shown(t, apply).items).toEqual(['b', 'c'])
  })

  it('applies a batch all or nothing', () => {
    let t = track<Toy, Cmd>(toy(1, ['a']))
    t = push(t, { cid: 'x', commands: [{ add: 'b' }, { add: 'a' }] })
    expect(shown(t, apply).items).toEqual(['a'])
  })

  it('drops a failed batch by its cid', () => {
    let t = track<Toy, Cmd>(toy(1, []))
    t = push(t, { cid: 'x', commands: [{ add: 'b' }] })
    t = push(t, { cid: 'y', commands: [{ add: 'c' }] })
    t = settle(t, 'x')
    expect(shown(t, apply).items).toEqual(['c'])
    expect(settle(t, 'nope')).toBe(t)
  })

  it('starts a track from the first copy it receives', () => {
    const t = receive<Toy, Cmd>(undefined, toy(4, ['a']))
    expect(t.server.version).toBe(4)
    expect(t.pending).toEqual([])
  })
})
