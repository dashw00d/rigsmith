// @vitest-environment node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { makeCharacter } from '../model/fixtures.ts'
import { TEMPLATE_PARENTS } from '../model/skeletons.ts'
import { creatureGroups, fitTemplate, jointLabel, mirrorOf, sideOf, skeletonSpec, swapSide, templateInfo, TEMPLATES, type Template } from './templates.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const file = (id: string): Template => JSON.parse(readFileSync(path.join(ROOT, 'static', 'templates', `${id}.json`), 'utf8')) as Template
const CREATURES = Object.keys(TEMPLATE_PARENTS)

describe('the template registry', () => {
  it('lists the human and every creature template there is, human and horse supported', () => {
    expect(TEMPLATES.map(t => t.id).sort()).toEqual(['human', ...CREATURES].sort())
    expect(TEMPLATES.filter(t => t.status === 'supported').map(t => t.id)).toEqual(['human', 'horse'])
  })

  it('says which have marker sets and deformation tests, as the data files do', () => {
    const markers = JSON.parse(readFileSync(path.join(ROOT, 'static', 'templates', 'markers.json'), 'utf8')) as Record<string, unknown>
    const tests = JSON.parse(readFileSync(path.join(ROOT, 'static', 'templates', 'tests.json'), 'utf8')) as Record<string, unknown[]>
    for (const t of TEMPLATES) {
      expect(t.markers).toBe(markers[t.id] !== undefined)
      expect(t.tests).toBe((tests[t.id]?.length ?? 0) > 0)
    }
  })

  it('takes a template it does not list as experimental', () => {
    expect(templateInfo('wyvern')).toMatchObject({ id: 'wyvern', label: 'Wyvern', status: 'experimental', markers: false })
  })
})

describe('sides from names', () => {
  it('agree with every template\'s own mirror map', () => {
    for (const id of CREATURES) {
      const t = file(id)
      const names = new Set(t.order)
      for (const n of t.order) {
        expect(mirrorOf(n, names)).toBe(t.mirror[n] ?? n)
        expect(sideOf(n, names) === 'center').toBe(t.mirror[n] === undefined)
      }
    }
  })

  it('swap a person\'s sides and a creature\'s', () => {
    expect(swapSide('LeftHandIndex2')).toBe('RightHandIndex2')
    expect(swapSide('front_leg_upper_l')).toBe('front_leg_upper_r')
    expect(swapSide('wing_feather_1_2_L')).toBe('wing_feather_1_2_R')
    expect(swapSide('Hips')).toBe('Hips')
  })

  it('give a person\'s skeleton its sides and partners', () => {
    const spec = skeletonSpec(makeCharacter())
    expect(spec.bones).toHaveLength(65)
    expect(spec.side('LeftHand')).toBe('left')
    expect(spec.side('RightToe_End')).toBe('right')
    expect(spec.side('Spine2')).toBe('center')
    expect(spec.mirror('LeftHandThumb3')).toBe('RightHandThumb3')
  })
})

describe('creature chips', () => {
  it('cover every joint of a template once (one side of each pair)', () => {
    for (const id of CREATURES) {
      const t = file(id)
      const names = new Set(t.order)
      const bones = t.order.map((n): [string, string | null] => [n, t.parents[n] ?? null])
      const chips = creatureGroups(bones).flatMap(g => g.bones)
      expect(new Set(chips).size).toBe(chips.length)
      const want = t.order.filter(n => n !== 'root' && sideOf(n, names) !== 'right')
      expect(chips.sort()).toEqual(want.sort())
    }
  })
})

describe('joint labels', () => {
  it('read a person\'s and a creature\'s joints', () => {
    expect(jointLabel('LeftForeArm')).toBe('Forearm')
    expect(jointLabel('RightHandIndex2')).toBe('Index 2')
    expect(jointLabel('front_leg_upper_l')).toBe('Front leg upper')
    expect(jointLabel('wing_feather_1_2_L')).toBe('Wing feather 1 2')
    expect(jointLabel('tail_1')).toBe('Tail 1')
  })
})

describe('the bounding-box fit', () => {
  it('puts the horse inside the model\'s bounds, symmetric about its middle', () => {
    const t = file('horse')
    const box = new THREE.Box3(new THREE.Vector3(-0.4, 0, -1), new THREE.Vector3(0.6, 2, 1))
    const j = fitTemplate(t, box)
    expect(Object.keys(j).sort()).toEqual(Object.keys(t.joints).sort())
    for (const [a, b] of Object.entries(t.mirror)) expect(j[a][0] + j[b][0]).toBeCloseTo(0.2, 9)
    for (const n of t.order) if (t.mirror[n] === undefined) expect(j[n][0]).toBeCloseTo(0.1, 9)
  })
})
