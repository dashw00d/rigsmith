import { describe, expect, it } from 'vitest'
import { decisionsOf, methodDecisions, notesOf } from './report.ts'

describe('the rig report', () => {
  it('reads a method code into decisions for a rig made before reasons were kept', () => {
    expect(methodDecisions('regions+hybrid-heat+retained-weights+pose-optimized').map(d => [d.stage, d.choice])).toEqual([
      ['Weights', 'Regional heat'], ['Volume heat', 'Volume heat on some parts'],
      ['Previous rig', 'Previous weights kept, whole or in part'], ['Pose optimizer', 'Optimized'],
    ])
    expect(methodDecisions('native-heat')).toEqual([{ stage: 'Weights', choice: 'Volume heat', why: '' }])
    expect(methodDecisions('heat+hybrid-optimized').map(d => d.choice)).toEqual(['Bone heat', 'Optimized, except some parts'])
    expect(decisionsOf({ method: 'regions', seconds: 1, warnings: [] })).toEqual({ decisions: [{ stage: 'Weights', choice: 'Regional heat', why: '' }], older: true })
  })

  it('keeps the decisions the rig wrote', () => {
    const decisions = [{ stage: 'Weights', choice: 'Regional heat', why: 'Each part of the body weighted to its own bones' }]
    expect(decisionsOf({ method: 'regions', seconds: 1, warnings: [], decisions })).toEqual({ decisions, older: false })
  })

  it('shows only the warnings the decisions don\'t already say', () => {
    const warnings = [
      'Blender moved 2 of the placed joints (LeftHand, RightHand; up to 1.2 cm): the rig is built where it put them',
      'Used previous weights on some surface islands: they deform better on every test animation with these joint placements',
      '120 painted vertices put back (Skin step: Forget the painting to drop them)',
      'weights not pose-optimized: optimize.py failed',
      'Alternative heat skin unavailable: no islands',
    ]
    const decisions = [{ stage: 'Volume heat', choice: 'Not built', why: 'Alternative heat skin unavailable: no islands' }]
    expect(notesOf({ method: 'regions', seconds: 1, warnings, decisions })).toEqual([warnings[0]])
    expect(notesOf({ method: 'regions', seconds: 1, warnings })).toEqual(warnings)
  })
})
