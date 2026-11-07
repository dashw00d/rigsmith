import { expect, it } from 'vitest'
import { composeSlots, type BodyField, type Pixels } from '../../engine/clothcut.ts'

it('keeps the painted empty top while a cut bottom reveals bare skin', () => {
  const image = (values: number[]): Pixels => ({ width: 4, height: 1, rgba: Uint8ClampedArray.from(values.flatMap(v => [v, v, v, 255])) })
  const field: BodyField = { width: 4, height: 1, region: Int16Array.from([0, 1, 1, 2]), y: Float32Array.from([0.8, 0.2, 0.8, 0.9]) }
  const result = composeSlots({
    base: image([40, 50, 60, 70]), bare: image([100, 110, 120, 130]), field,
    regions: [{ id: 0, material: 'Shirt', x: 0 }, { id: 1, material: 'Trousers', x: 1 }, { id: 2, material: 'Face', x: 0 }],
    layers: [{ ...image([200, 200, 200, 200]), id: 'shorts', slots: ['bottom'], cut: { below: [{ regions: [1], y: 0.5, feather: 0 }] } }],
  })
  expect([0, 1, 2, 3].map(i => result.rgba[i * 4])).toEqual([40, 110, 200, 70])
})

it('feathers and masks toward bare, or the painted base when bare is unavailable', () => {
  const image = (v: number): Pixels => ({ width: 2, height: 1, rgba: Uint8ClampedArray.from([v, v, v, 255, v, v, v, 255]) })
  const field: BodyField = { width: 2, height: 1, region: Int16Array.from([1, 1]), y: Float32Array.from([0.5, 0.8]) }
  const layers = [{ ...image(200), id: 'shorts', slots: ['bottom' as const], cut: { below: [{ regions: [1], y: 0.5, feather: 0.2 }] }, mask: Uint8ClampedArray.from([255, 255, 255, 255, 0, 0, 0, 255]) }]
  const regions = [{ id: 1, material: 'Trousers', x: 1 }]
  const withBare = composeSlots({ base: image(40), bare: image(100), field, regions, layers })
  const noBare = composeSlots({ base: image(40), bare: null, field, regions, layers })
  expect([withBare.rgba[0], withBare.rgba[4]]).toEqual([150, 100])
  expect([noBare.rgba[0], noBare.rgba[4]]).toEqual([120, 40])
})

it('composes a two-slot layer once and never paints unrelated body regions', () => {
  const image = (rgba: number[]): Pixels => ({ width: 3, height: 1, rgba: Uint8ClampedArray.from([...rgba, ...rgba, ...rgba]) })
  const field: BodyField = { width: 3, height: 1, region: Int16Array.from([0, 1, 2]), y: Float32Array.from([0.8, 0.8, 0.8]) }
  const result = composeSlots({ base: image([0, 0, 0, 255]), bare: null, field,
    regions: [{ id: 0, material: 'Shirt', x: 0 }, { id: 1, material: 'Trousers', x: 1 }, { id: 2, material: 'Face', x: 0 }],
    layers: [{ ...image([200, 0, 0, 128]), id: 'both', slots: ['top', 'bottom'] }] })
  expect([result.rgba[0], result.rgba[4], result.rgba[8]]).toEqual([100, 100, 0])
})

it('extends cut edges into unmapped seam padding without affecting mapped skin', () => {
  const image = (v: number): Pixels => ({ width: 4, height: 1, rgba: Uint8ClampedArray.from(Array.from({ length: 4 }, () => [v, v, v, 255]).flat()) })
  const field: BodyField = { width: 4, height: 1, region: Int16Array.from([1, -1, -1, 2]), y: Float32Array.from([0.2, 0, 0, 0.9]) }
  const result = composeSlots({ base: image(40), bare: image(100), field,
    regions: [{ id: 1, material: 'Trousers', x: 1 }, { id: 2, material: 'Face', x: 0 }],
    layers: [{ ...image(200), id: 'shorts', slots: ['bottom'], cut: { below: [{ regions: [1], y: 0.5, feather: 0 }] } }] })
  expect([0, 1, 2, 3].map(i => result.rgba[i * 4])).toEqual([100, 100, 100, 40])
})
