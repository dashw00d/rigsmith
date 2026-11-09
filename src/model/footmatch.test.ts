import { describe, expect, it } from 'vitest'
import { gaitAt, matchFeet } from './footmatch.ts'

// a walk: left down at 0, 1, 2; right at 0.5, 1.5. A run: left at 0.2, 0.8, 1.4; right at 0.5, 1.1.
const walk = { 'step.L': [0, 1, 2], 'step.R': [0.5, 1.5] }
const run = { 'step.L': [0.2, 0.8, 1.4], 'step.R': [0.5, 1.1] }

describe('match feet', () => {
  it('reads the gait phase: the foot down last and how far to its next fall', () => {
    expect(gaitAt(walk, 1.25)).toEqual({ foot: 'step.L', phase: 0.25 })
    expect(gaitAt(walk, 1.75)).toEqual({ foot: 'step.R', phase: 0.25 })
    // (past the last fall: the stride before it stands in)
    expect(gaitAt(walk, 2.5)).toEqual({ foot: 'step.L', phase: 0.5 })
    expect(gaitAt({ 'step.L': [1] }, 1.5)).toBeNull()
  })

  it('starts the next piece where its same foot is as far through its stride, nearest where it starts', () => {
    // (left a quarter through at the walk's 1.25: in the run, a quarter from 0.2 to 0.8 is 0.35, from 0.8 to 1.4 is 0.95)
    expect(matchFeet(walk, 1.25, run, 1.6, 0.5, 0)).toEqual({ from: 0.35, foot: 'step.L', phase: 0.25 })
    expect(matchFeet(walk, 1.25, run, 1.6, 0.5, 1)).toEqual({ from: 0.95, foot: 'step.L', phase: 0.25 })
    // (one that would run past the content's end loses to one that fits)
    expect(matchFeet(walk, 1.25, run, 1.6, 1, 1)).toMatchObject({ from: 0.35 })
  })

  it('reads one stride of a loop as repeating', () => {
    // (a 1 s walk cycle, each foot down once; a 0.6 s run cycle the same)
    const once = { 'step.L': [0.1], 'step.R': [0.6] }
    const sprint = { 'step.L': [0.15], 'step.R': [0.45] }
    expect(matchFeet(once, 0.85, sprint, 0.6, 0.3, 0)).toMatch(/never come down twice/)
    // (at 0.85 the right foot is a quarter of the way from its fall at 0.6 to its next at 1.6; the run's right falls at
    // -0.15 and 0.45 a cycle apart, so a quarter through starts at 0, the one start that leaves 0.3 s inside it)
    expect(matchFeet(once, 0.85, sprint, 0.6, 0.3, 0, { beforePeriod: 1, period: 0.6 })).toEqual({ from: 0, foot: 'step.R', phase: 0.25 })
  })

  it('says why when there is no stride to match', () => {
    expect(matchFeet({ 'step.L': [1] }, 1.5, run, 1.6, 0.5, 0)).toMatch(/clip before/)
    expect(matchFeet(walk, 1.25, { 'step.L': [0.3] }, 1.6, 0.5, 0)).toMatch(/This clip/)
  })
})
