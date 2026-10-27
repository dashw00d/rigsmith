// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { checkEdit, type SavedEdit } from './clipedits.ts'

const edit = (base: string): SavedEdit => ({
  name: 'Named edit', base, frames: { fps: 30, bones: ['Hips'], rotations: [[[0, 0, 0, 1]]], hips: [[0, 1, 0]] },
})

describe('edited clip validation', () => {
  it('accepts the catalog IDs containing periods without accepting paths', () => {
    for (const id of ['mixamo-Standing_Idle_Looking_Ver._1', 'mixamo-Standing_Melee_Combo_Attack_Ver._3', 'custom-My_Clip']) {
      expect(() => checkEdit(edit(id))).not.toThrow()
    }
    for (const id of ['../clip', 'folder/clip', 'folder\\clip', 'clip\u0000']) expect(() => checkEdit(edit(id))).toThrow('Which clip was edited?')
  })
})
