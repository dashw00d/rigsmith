import { describe, expect, it } from 'vitest'
import { makeCharacter, makeGear, makeSlot } from '../../model/fixtures.ts'
import { boneChoices, boneLabel, freeHandleName, fromGame, handlesInOrder, holdsOf, originOf, swapGroups, swapSets, wearText } from './text.ts'

describe('gear text', () => {
  it('tells where a piece came from', () => {
    expect(fromGame({ from: 'emberhold:warrior/Weapons_RightHand' })).toBe(true)
    expect(originOf(makeGear({ from: 'emberhold:warrior/Weapons_RightHand' }))).toBe('game')
    expect(originOf(makeGear({ catalog: 'sword_B.glb', from: 'catalog:sword_B.glb' }))).toBe('catalog')
    expect(originOf(makeGear())).toBe('upload')
  })

  it('says how it is worn', () => {
    expect(wearText(makeGear())).toBe('on Spine2')
    expect(wearText(makeGear({ attach: { kind: 'skin', policy: 'cape', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } }, painted: 3 })))
      .toBe('on the skin · Cape / cloak · painted')
    expect(wearText(makeGear({ attach: { kind: 'spot', anchor: [0, 1, 0], animation: 'Spin', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } })))
      .toBe('pinned to a spot · plays Spin')
  })

  it('groups the list by swap set, loose pieces first', () => {
    const gear = [makeGear({ id: 'a', swapSet: 'tools' }), makeGear({ id: 'b' }), makeGear({ id: 'c', swapSet: 'heads' }), makeGear({ id: 'd', swapSet: 'tools' })]
    expect(swapGroups(gear).map(g => [g.set, g.gear.map(x => x.id)])).toEqual([[null, ['b']], ['tools', ['a', 'd']], ['heads', ['c']]])
    expect(swapSets(gear)).toEqual(['tools', 'heads'])
    expect(swapGroups([])).toEqual([])
  })

  it('offers the skeleton\'s bones, the hands first, keeping one it lost', () => {
    const c = makeCharacter()
    const bones = boneChoices(c)
    expect(bones.slice(0, 2)).toEqual(['RightHand', 'LeftHand'])
    expect(bones).toContain('Spine2')
    expect(new Set(bones).size).toBe(bones.length)
    expect(boneChoices(c, 'Tail3')[0]).toBe('Tail3')
    expect(boneLabel('LeftHand')).toBe('Left hand')
    expect(boneLabel('Spine2')).toBe('Spine2')
  })

  it('lists the slots holding a pull', () => {
    const c = makeCharacter({
      clips: [
        makeSlot({ id: 's1', name: 'Shoot', adjustments: [{ id: 'a1', kind: 'handleHold', enabled: true, gear: 'g1', handle: 'h1', windows: [[0.1, 0.4567]] }] }),
        makeSlot({ id: 's2', name: 'Idle', adjustments: [{ id: 'a2', kind: 'handleHold', enabled: false, gear: 'g1', handle: 'h2', windows: [[0, 1]] }] }),
      ],
    })
    const holds = holdsOf(c, 'g1', 'h1')
    expect(holds.map(h => [h.slot.id, h.adjustment, h.enabled])).toEqual([['s1', 'a1', true]])
    expect(holds[0].windows).toEqual([[0.1, 0.4567]])
    // (shown as Motion shows a window, as parts of the clip)
    expect(holds[0].when).toBe('10–46%')
    expect(holdsOf(c, 'g1', 'h2')[0].when).toBe('the whole clip')
  })

  it('orders handles and names new ones freely', () => {
    const g = makeGear({
      handles: [
        { id: 'p', name: 'Draw', kind: 'pull', pull: { bone: 'RightHand', grip: [0, 0, 0], rest: [0, 0, 0] } },
        { id: 'g', name: 'Left grip', kind: 'grip', hand: 'Left' },
        { id: 'carry', name: 'Carried', kind: 'carry', hand: 'Right' },
      ],
    })
    expect(handlesInOrder(g).map(h => h.kind)).toEqual(['carry', 'grip', 'pull'])
    expect(freeHandleName(g, 'Draw')).toBe('Draw 2')
    expect(freeHandleName(g, 'Pull')).toBe('Pull')
  })
})
