// @vitest-environment node
import { parseArgs } from 'node:util'
import { describe, expect, it } from 'vitest'
import { bonesMissing, optimizerExclude, rigDecisions, rigMethod, type RigStages, trainedIds, validateArgs } from './skinopt.ts'

const stages = (o: Partial<RigStages> = {}): RigStages => ({
  template: 'human', label: 'person', method: 'regions', given: 65, added: [], moved: [],
  optimizer: { ran: false, why: 'No PyTorch here' }, painted: 0, ...o,
})

describe('the clips the optimizer trains on', () => {
  it('the slots\' and the library tests\', never the held-out benchmark clips', () => {
    const tests = [{ id: 'mixamo-Air_Squat' }, { id: 'mixamo-Boxing_8' }, { id: 'horse-walk', url: '/animations/horse.glb#Walk' }]
    expect(trainedIds(['mixamo-Walking', 'mixamo-Dying', 'mixamo-Walking'], tests, ['mixamo-Air_Squat', 'mixamo-Dying']))
      .toEqual(['mixamo-Walking', 'mixamo-Boxing_8'])
  })

  it('the check after it leaves out every clip it trained on: the ones asked for and the ones it drew', () => {
    expect(optimizerExclude(['mixamo-Walking', 'mixamo-Boxing_8'], ['mixamo-Boxing_8', 'mixamo-Jump_5']))
      .toEqual(['mixamo-Walking', 'mixamo-Boxing_8', 'mixamo-Jump_5'])
    expect(optimizerExclude(['mixamo-Walking'], null)).toEqual(['mixamo-Walking'])
  })

  it('hands validate.ts the clips to leave out as it reads them (tools/skin_opt/validate.ts)', () => {
    const args = validateArgs('/w/rigging-1.glb', '/w/rigging-1-before-optimize.glb', 'human', ['mixamo-A', '', 'mixamo-B', 'mixamo-A'])
    expect(args[0]).toMatch(/tools[\\/]skin_opt[\\/]validate\.ts$/)
    const { positionals, values } = parseArgs({ args: args.slice(1), allowPositionals: true, options: { exclude: { type: 'string' } } })
    expect(positionals).toEqual(['/w/rigging-1.glb', '/w/rigging-1-before-optimize.glb', 'human'])
    expect(values.exclude).toBe('mixamo-A,mixamo-B')
    // (the volume heat and previous rig checks, before any training: nothing left out)
    expect(validateArgs('/w/a.glb', '/w/b.glb', 'horse')).toHaveLength(4)
  })
})

describe('painted bones a skeleton lacks', () => {
  it('lists the bones painted with weight that the skeleton has not', () => {
    const painted = [
      { mesh: 0, vertex: 1, weights: [['LeftHandMiddle1', 0.5], ['LeftHand', 0.5]] as Array<[string, number]> },
      { mesh: 0, vertex: 2, weights: [['LeftHandRing1', 0], ['Hips', 1]] as Array<[string, number]> },
    ]
    expect(bonesMissing(painted, ['LeftHand', 'Hips'])).toEqual(['LeftHandMiddle1'])
    expect(bonesMissing(painted, ['LeftHand', 'Hips', 'LeftHandMiddle1'])).toEqual([])
  })
})

describe('the rig report', () => {
  it('a first rig without PyTorch: joints, regional weights, the optimizer skipped', () => {
    const s = stages()
    expect(rigDecisions(s).map(d => [d.stage, d.choice])).toEqual([
      ['Joints', 'As placed'], ['Weights', 'Regional heat'], ['Pose optimizer', 'Skipped'],
    ])
    expect(rigMethod(s)).toBe('regions')
  })

  it('says why each comparison went as it did, and keeps the v1 method code', () => {
    const s = stages({
      added: ['LeftHandIndex4'],
      volume: { built: true, check: { compared: true, retained: false, why: 'was no worse on any of the 8 tests' } },
      previous: { compared: true, retained: false, hybrid: true, switched: 2, islands: 40 },
      optimizer: { ran: true, check: { compared: true, retained: false, why: 'was no worse on any of the 12 tests (4% less strain)' } },
      painted: 120,
    })
    const d = rigDecisions(s)
    expect(d.map(x => x.stage)).toEqual(['Joints', 'Weights', 'Volume heat', 'Previous rig', 'Pose optimizer', 'Painting'])
    expect(d[0].why).toBe('65 joints from the Skeleton step; Blender added 1')
    expect(d[2]).toEqual({ stage: 'Volume heat', choice: 'Regional heat', why: 'Regional heat was no worse on any of the 8 tests' })
    expect(d[3].why).toBe('The previous weights deformed better on 2 of 40 surface islands, on every test')
    expect(d[4].choice).toBe('Optimized')
    expect(d[5].why).toMatch(/^120 painted points/)
    expect(rigMethod(s)).toBe('regions+retained-weights+pose-optimized')
  })

  it('volume heat winning, a reverted optimizer and a creature', () => {
    const s = stages({
      template: 'horse', label: 'horse', method: 'heat', given: 56,
      volume: { built: true, check: { compared: true, retained: true, why: 'strained Walk 15% more' } },
      optimizer: { ran: true, check: { compared: true, retained: true, why: 'strained the 8 tests 3% more in all' } },
    })
    const d = rigDecisions(s)
    expect(d[1]).toEqual({ stage: 'Weights', choice: 'Bone heat', why: "The horse template's bones, by plain bone heat (no regions)" })
    expect(d[2]).toEqual({ stage: 'Volume heat', choice: 'Volume heat', why: 'Bone heat strained Walk 15% more' })
    expect(d[3]).toEqual({ stage: 'Pose optimizer', choice: 'Reverted', why: 'The optimized weights strained the 8 tests 3% more in all' })
    expect(rigMethod(s)).toBe('native-heat')
  })

  it('stages that could not run say so', () => {
    const s = stages({
      given: 0,
      volume: { built: false, why: 'Alternative heat skin unavailable: no islands' },
      previous: { compared: false, retained: false, reason: 'Skinned primitive count changed' },
      optimizer: { ran: true, failed: 'optimize.py failed: CUDA out of memory' },
    })
    const d = rigDecisions(s)
    expect(d[0].choice).toBe('Found by Blender')
    expect(d.find(x => x.stage === 'Volume heat')!.choice).toBe('Not built')
    expect(d.find(x => x.stage === 'Previous rig')).toEqual({ stage: 'Previous rig', choice: 'Not compared', why: 'Skinned primitive count changed' })
    expect(d.find(x => x.stage === 'Pose optimizer')!.choice).toBe('Failed, not used')
    expect(rigMethod(s)).toBe('regions')
  })

  it('the layers fit after the optimizer: kept, said with what it did, and in the method', () => {
    const s = stages({
      method: 'heat',
      optimizer: { ran: true, check: { compared: true, retained: true, why: 'strained Petting Animal 29% more' } },
      layers: { ran: true, check: { compared: true, retained: false, why: 'kept the layers apart (92% fewer points through the layer under them on the 24 tests, 2% less strain)' } },
    })
    const d = rigDecisions(s)
    expect(d.map(x => x.stage)).toEqual(['Joints', 'Weights', 'Pose optimizer', 'Layers'])
    expect(d.at(-1)).toEqual({ stage: 'Layers', choice: 'Fitted', why: 'The fitted weights kept the layers apart (92% fewer points through the layer under them on the 24 tests, 2% less strain)' })
    expect(rigMethod(s)).toBe('heat+layers')
    const reverted = stages({ layers: { ran: true, check: { compared: true, retained: true, why: 'let 60 more points through the layer under them on the 8 tests' } } })
    expect(rigDecisions(reverted).at(-1)!.choice).toBe('Reverted')
    expect(rigMethod(reverted)).toBe('regions')
    expect(rigDecisions(stages({ layers: { ran: true, failed: 'optimize.py failed' } })).at(-1)!.choice).toBe('Failed, not used')
  })
})
