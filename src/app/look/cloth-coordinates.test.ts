import { expect, it } from 'vitest'
import { bodyField } from '../../engine/clothcut.ts'

it('maps glTF UV v=0 to the top row of the source image', () => {
  const field = bodyField({ positions: [0, 0, 0, 0, 1, 0, 1, 0, 0], uv: [0, 0, 0, 0.5, 0.5, 0], index: [0, 1, 2] }, [0, 0, 0], 1, 4)
  expect(field.region[0]).toBe(0)
  expect(field.region[3 * 4]).toBe(-1)
})
