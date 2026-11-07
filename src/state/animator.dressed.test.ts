import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { makeCharacter, makeGear, makeSlot } from '../model/fixtures.ts'
import { dressedCharacter } from '../model/stances.ts'
import { bakeSlot, type BakeContext } from '../engine/bake.ts'
import { captureRest } from '../engine/retarget.ts'

function context (): BakeContext {
  const root = new THREE.Group()
  const hips = new THREE.Bone(); hips.name = 'Hips'; root.add(hips)
  const hand = new THREE.Bone(); hand.name = 'LeftHand'; hips.add(hand)
  let parent: THREE.Object3D = hand
  for (let i = 1; i <= 3; i++) { const finger = new THREE.Bone(); finger.name = `LeftHandIndex${i}`; parent.add(finger); parent = finger }
  root.updateMatrixWorld(true)
  const clip = new THREE.AnimationClip('Idle', 1, [new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 0, 0, 0, 0, 0])])
  return { rest: captureRest(root, o => (o as THREE.Bone).isBone === true), posable: root, clips: { get: async () => clip } }
}

describe('dressed motion bake', () => {
  it('bakes a carry layer only when the shield set is worn', async () => {
    const shield = makeGear({ id: 'shield', name: 'Shield', hidden: true, attach: { kind: 'bone', bone: 'LeftHand', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } }, handles: [{ id: 'carry', name: 'Carry', kind: 'carry', hand: 'Left' }] })
    const slot = makeSlot({ id: 'idle', clip: { id: 'idle' } })
    const c = makeCharacter({ gear: [shield], clips: [slot], folk: { sets: [
      { id: 'shield-set', name: 'Shield set', pieces: ['shield'], tags: [], grants: [] },
      { id: 'empty-set', name: 'Empty set', pieces: [], tags: [], grants: [] },
    ], pools: [], kinds: [], stances: [] } })
    const withShield = await bakeSlot(dressedCharacter(c, 'shield-set'), slot, context())
    const without = await bakeSlot(dressedCharacter(c, 'empty-set'), slot, context())
    expect(withShield.hands.Left.map(x => x.source)).toContain('carry')
    expect(without.hands.Left.map(x => x.source)).not.toContain('carry')
    expect(c.gear[0].hidden).toBe(true)
  })
})
