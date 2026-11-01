import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { WeightPainter } from './weightpaint.ts'

/** Two separated mirrored sheets, each split into two material primitives at x = +/-.05, plus a donor plane.
 * Skin palettes have distinct orders, and each mesh includes a UV copy of its first vertex. */
function panels (): THREE.SkinnedMesh[] {
  const root = new THREE.Group()
  const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.z = -.5; root.add(hips)
  const left = new THREE.Bone(); left.name = 'LeftArm'; left.position.set(.1, .3, 0); hips.add(left)
  const right = new THREE.Bone(); right.name = 'RightArm'; right.position.set(-.1, .3, 0); hips.add(right)
  const head = new THREE.Bone(); head.name = 'Head'; head.position.y = .3; hips.add(head)
  const bones = [hips, left, right, head]
  const meshes = [[-.09, -.05, .008], [-.05, -.01, .008], [.01, .05, .008], [.05, .09, .008], [-.3, .3, 0]].map(([a, b, z]) => {
    const g = new THREE.BufferGeometry(); const positions: number[] = []; const triangles: number[] = []
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) positions.push(a + (b - a) * col / 2, row * .1, z)
    positions.push(...positions.slice(0, 3))
    for (let row = 0; row < 2; row++) for (let col = 0; col < 2; col++) {
      const p = row * 3 + col; const q = p + 1; const r = p + 3; const s = r + 1
      triangles.push(p, q, s, p === 0 ? 9 : p, s, r)
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); g.setIndex(triangles)
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(40).fill(0), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: 10 }, () => [1, 0, 0, 0]).flat(), 4))
    const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial()); root.add(mesh); return mesh
  })
  root.updateMatrixWorld(true)
  const orders = [bones, [...bones].reverse(), [...bones.slice(2), ...bones.slice(0, 2)], [left, hips, head, right], bones]
  meshes.forEach((mesh, q) => {
    mesh.bind(new THREE.Skeleton(orders[q]))
    for (let point = 0; point < 10; point++) set(mesh, point, [['Hips', 1]])
  })
  return meshes
}

function set (mesh: THREE.SkinnedMesh, point: number, values: Array<[string, number]>): void {
  for (const vertex of point === 0 ? [0, 9] : [point]) for (let k = 0; k < 4; k++) {
    mesh.geometry.attributes.skinIndex.setComponent(vertex, k, values[k] === undefined ? 0 : mesh.skeleton.bones.findIndex(b => b.name === values[k][0]))
    mesh.geometry.attributes.skinWeight.setComponent(vertex, k, values[k]?.[1] ?? 0)
  }
}

function field (mesh: THREE.SkinnedMesh, bone: string): void {
  for (let point = 0; point < 10; point++) set(mesh, point, [[bone, 1]])
}

function damaged (meshes: THREE.SkinnedMesh[]): void {
  for (const part of [2, 3]) field(meshes[part], 'LeftArm')
  for (const [part, point] of [[0, 5], [1, 3], [2, 5], [3, 3]]) set(meshes[part], point, [['Head', 1]])
}

function named (painter: WeightPainter, part: number, point: number): Map<string, number> {
  const bones = painter.parts[part].mesh.skeleton.bones
  return new Map([...painter.weights(part, point)].map(([b, w]) => [bones[b].name, w]))
}

const raw = (meshes: THREE.SkinnedMesh[]): number[][][] => meshes.map(mesh =>
  ['position', 'skinIndex', 'skinWeight'].map(name => Array.from(mesh.geometry.attributes[name].array)))
const areas = (painter: WeightPainter): Array<Array<[number, number]>> => painter.area.map(area => [...area].sort((a, b) => a[0] - b[0]))

describe('Area across material and mirror primitives', () => {
  it('marks and erases every physical/mirrored alias with strongest coverage, and Undo restores exact masks', () => {
    const painter = new WeightPainter(panels()); const before = raw(painter.parts.map(p => p.mesh))
    painter.begin(); painter.mark(2, new Map([[5, .3]])); painter.mark(0, new Map([[5, .8]])); painter.end()
    for (const [part, point] of [[0, 5], [1, 3], [2, 5], [3, 3]]) expect(painter.area[part].get(point)).toBe(.8)
    const selected = areas(painter)
    painter.begin(); painter.mark(3, new Map([[3, .2]]), false); painter.end()
    expect(painter.area.every(area => area.size === 0)).toBe(true)
    expect(painter.stepBack()).toBe(true); expect(areas(painter)).toEqual(selected)
    expect(painter.stepBack()).toBe(true); expect(painter.area.every(area => area.size === 0)).toBe(true)
    expect(raw(painter.parts.map(p => p.mesh))).toEqual(before)
    expect(painter.stepBack()).toBe(false)
  })

  it('pins a readonly physical seam, marks its writable mirror, and never selects donor skin', () => {
    const meshes = panels(); const painter = new WeightPainter(meshes, undefined, new Set(meshes.slice(0, 3)))
    painter.begin(); painter.mark(2, new Map([[5, 1]])); painter.end()
    expect(painter.area[2].size).toBe(0); expect(painter.area[3].size).toBe(0); expect(painter.area[4].size).toBe(0)
    expect(painter.area[0].get(5)).toBe(1); expect(painter.area[1].get(3)).toBe(1)
    painter.begin(); painter.mark(3, new Map([[3, 1]]), false); painter.end()
    expect(painter.area[0].get(5)).toBe(1)
    expect(painter.stepBack()).toBe(true); expect(painter.area.every(area => area.size === 0)).toBe(true)
    expect(painter.stepBack()).toBe(false)
  })

  it('ignores invalid and zero coverage without creating Undo', () => {
    const painter = new WeightPainter(panels())
    painter.begin(); painter.mark(2, new Map([[0, 0], [1, -1], [2, Number.NaN], [5, Number.POSITIVE_INFINITY]])); painter.end()
    expect(painter.area.every(area => area.size === 0)).toBe(true)
    expect(painter.stepBack()).toBe(false)
  })
})

describe('Heal over the physical material neighbourhood', () => {
  it('heals each mirrored side from its own authored surrounding skin, preserving every unselected point and donor', () => {
    const meshes = panels(); damaged(meshes); const before = raw(meshes)
    const painter = new WeightPainter(meshes, undefined, new Set(meshes.slice(0, 4)))
    painter.mark(2, new Map([[5, 1]])); const selected = areas(painter)
    expect(painter.heal()).toBe(4)
    for (const [part, point] of [[2, 5], [3, 3]]) expect(named(painter, part, point)).toEqual(new Map([['LeftArm', 1]]))
    for (const [part, point] of [[0, 5], [1, 3]]) expect(named(painter, part, point)).toEqual(new Map([['Hips', 1]]))
    for (let part = 0; part < 5; part++) for (let point = 0; point < 10; point++) {
      if ([[0, 5], [1, 3], [2, 5], [3, 3]].some(([q, p]) => q === part && p === point)) continue
      for (const slot of [1, 2]) expect(raw(meshes)[part][slot].slice(point * 4, point * 4 + 4)).toEqual(before[part][slot].slice(point * 4, point * 4 + 4))
    }
    expect(painter.area.every(area => area.size === 0)).toBe(true)
    expect(painter.stepBack()).toBe(true); expect(raw(meshes)).toEqual(before); expect(areas(painter)).toEqual(selected)
    expect(painter.stepBack()).toBe(false)
  })

  it('blends each healed side with the area falloff rather than copying the opposite blended result', () => {
    const meshes = panels(); damaged(meshes); const painter = new WeightPainter(meshes)
    painter.mark(2, new Map([[5, .25]])); expect(painter.heal()).toBe(4)
    for (const [part, point, target] of [[2, 5, 'LeftArm'], [3, 3, 'LeftArm'], [0, 5, 'Hips'], [1, 3, 'Hips']] as const) {
      expect(named(painter, part, point).get('Head')).toBeCloseTo(.75)
      expect(named(painter, part, point).get(target)).toBeCloseTo(.25)
    }
  })

  it('keeps the two authored healing boundaries independent of primitive iteration order', () => {
    const run = (reverse: boolean): number[][][] => {
      const meshes = panels(); damaged(meshes)
      const painter = new WeightPainter(reverse ? [...meshes].reverse() : meshes)
      const part = painter.parts.findIndex(p => p.mesh === meshes[2])
      painter.mark(part, new Map([[5, 1]])); expect(painter.heal()).toBe(4)
      return raw(meshes)
    }
    expect(run(false)).toEqual(run(true))
  })

  it('uses a neighbouring material as the boundary for an entirely selected primitive', () => {
    const meshes = panels(); field(meshes[2], 'Head')
    for (const point of [0, 3, 6]) set(meshes[3], point, [['Head', 1]])
    const before = raw(meshes); const painter = new WeightPainter(meshes); painter.mirror = false
    painter.mark(2, new Map(Array.from({ length: 9 }, (_, point) => [point, 1])))
    expect(painter.heal()).toBe(12)
    for (let point = 0; point < 9; point++) expect(named(painter, 2, point).get('Hips') ?? 0).toBeGreaterThan(.998)
    for (const point of [1, 2, 4, 5, 7, 8]) {
      expect(raw(meshes)[3][2].slice(point * 4, point * 4 + 4)).toEqual(before[3][2].slice(point * 4, point * 4 + 4))
    }
  })

  it('leaves a wholly selected physical island and its area unchanged without adding Undo', () => {
    const meshes = panels(); damaged(meshes); const painter = new WeightPainter(meshes); painter.mirror = false
    for (const part of [2, 3]) painter.mark(part, new Map(Array.from({ length: 9 }, (_, point) => [point, 1])))
    const before = raw(meshes); const selected = areas(painter)
    expect(painter.heal()).toBe(0); expect(raw(meshes)).toEqual(before); expect(areas(painter)).toEqual(selected)
    expect(painter.stepBack()).toBe(false)
  })

  it('pins readonly and incompatible seam copies while leaving their selections available', () => {
    for (const readonly of [true, false]) {
      const meshes = panels(); const outer = meshes[3]
      if (!readonly) {
        outer.bind(new THREE.Skeleton(outer.skeleton.bones.filter(b => b.name !== 'Head')))
        for (let point = 0; point < 10; point++) set(outer, point, [['Hips', 1]])
      }
      set(meshes[2], 4, [['Head', 1]])
      const editable = readonly ? new Set(meshes.slice(0, 3)) : undefined
      const painter = new WeightPainter(meshes, undefined, editable); painter.mirror = false
      // Direct area setup also verifies that stale selections cannot bypass a later readonly restriction.
      painter.area[2].set(5, 1); painter.area[3].set(3, 1)
      const before = raw(meshes); const selected = areas(painter)
      expect(painter.heal()).toBe(0); expect(raw(meshes)).toEqual(before); expect(areas(painter)).toEqual(selected)
      expect(painter.stepBack()).toBe(false)
    }
  })
})

describe('Copy Side across material and mirror primitives', () => {
  it.each([1, -1] as const)('copies side %s by bone name across independent skins, preserving the source and exact Undo', from => {
    const meshes = panels()
    for (const part of [0, 1]) field(meshes[part], from === 1 ? 'Head' : 'RightArm')
    for (const part of [2, 3]) field(meshes[part], from === 1 ? 'LeftArm' : 'Head')
    const before = raw(meshes); const painter = new WeightPainter(meshes, undefined, new Set(meshes.slice(0, 4))); painter.mirror = false
    expect(painter.copySide(from)).toBeGreaterThan(0); expect(painter.mirror).toBe(false)
    const source = from === 1 ? [2, 3] : [0, 1]; const destination = from === 1 ? [0, 1] : [2, 3]
    for (const part of source) expect(raw(meshes)[part]).toEqual(before[part])
    for (const part of destination) for (let point = 0; point < 10; point++) expect(named(painter, part, point)).toEqual(new Map([[from === 1 ? 'RightArm' : 'LeftArm', 1]]))
    expect(raw(meshes)[4]).toEqual(before[4])
    expect(painter.stepBack()).toBe(true); expect(raw(meshes)).toEqual(before); expect(painter.stepBack()).toBe(false)
  })

  it('preserves tiny positive authored float influences across palette mapping and exact Undo', () => {
    const meshes = panels()
    for (const part of [2, 3]) for (let point = 0; point < 10; point++) set(meshes[part], point, [['LeftArm', .99997], ['Head', .00003]])
    const before = raw(meshes); const painter = new WeightPainter(meshes, undefined, new Set(meshes.slice(0, 4)))
    const source = named(painter, 2, 5)
    expect(painter.copySide(1)).toBeGreaterThan(0)
    for (const part of [0, 1]) for (let point = 0; point < 10; point++) {
      expect(named(painter, part, point).get('RightArm')).toBe(source.get('LeftArm'))
      expect(named(painter, part, point).get('Head')).toBe(source.get('Head'))
    }
    expect(painter.copySide(1)).toBe(0)
    expect(painter.stepBack()).toBe(true); expect(raw(meshes)).toEqual(before); expect(painter.stepBack()).toBe(false)
  })

  it('copies shared groups deterministically when material primitives are visited in a different order', () => {
    const run = (reverse: boolean): number[][][] => {
      const meshes = panels()
      for (const part of [2, 3]) for (let point = 0; point < 10; point++) set(meshes[part], point, [['LeftArm', .4], ['Hips', .59997], ['Head', .00003]])
      const painter = new WeightPainter(reverse ? [...meshes].reverse() : meshes, undefined, new Set(meshes.slice(0, 4)))
      painter.copySide(1); return raw(meshes)
    }
    expect(run(false)).toEqual(run(true))
  })

  it('pins readonly material seams while copying other writable opposite-side vertices', () => {
    const meshes = panels(); for (const part of [2, 3]) field(meshes[part], 'LeftArm')
    const before = raw(meshes); const painter = new WeightPainter(meshes, undefined, new Set([meshes[1], meshes[2], meshes[3]]))
    expect(painter.copySide(1)).toBeGreaterThan(0)
    expect(raw(meshes)[0]).toEqual(before[0]); expect(raw(meshes)[4]).toEqual(before[4])
    for (const point of [0, 3, 6, 9]) expect(named(painter, 1, point)).toEqual(new Map([['Hips', 1]]))
    for (const point of [1, 2, 4, 5, 7, 8]) expect(named(painter, 1, point)).toEqual(new Map([['RightArm', 1]]))
    expect(painter.stepBack()).toBe(true); expect(raw(meshes)).toEqual(before)
  })

  it('pins a complete physical seam if one destination palette lacks a copied influence', () => {
    const meshes = panels(); const inner = meshes[1]
    inner.bind(new THREE.Skeleton(inner.skeleton.bones.filter(b => b.name !== 'RightArm')))
    for (let point = 0; point < 10; point++) set(inner, point, [['Hips', 1]])
    for (const part of [2, 3]) field(meshes[part], 'LeftArm')
    const before = raw(meshes); const painter = new WeightPainter(meshes, undefined, new Set(meshes.slice(0, 4)))
    expect(painter.copySide(1)).toBeGreaterThan(0)
    expect(raw(meshes)[1]).toEqual(before[1])
    for (const point of [2, 5, 8]) expect(named(painter, 0, point)).toEqual(new Map([['Hips', 1]]))
    for (const point of [0, 1, 3, 4, 6, 7, 9]) expect(named(painter, 0, point)).toEqual(new Map([['RightArm', 1]]))
    expect(painter.stepBack()).toBe(true); expect(raw(meshes)).toEqual(before)
  })

  it('keeps raw slots and Undo unchanged when every mirrored semantic weight already matches', () => {
    const meshes = panels()
    for (const part of [0, 1]) for (let point = 0; point < 10; point++) set(meshes[part], point, [['RightArm', .99997], ['Head', .00003]])
    for (const part of [2, 3]) for (let point = 0; point < 10; point++) set(meshes[part], point, [['LeftArm', .99997], ['Head', .00003]])
    const before = raw(meshes); const painter = new WeightPainter(meshes)
    expect(painter.copySide(1)).toBe(0); expect(raw(meshes)).toEqual(before); expect(painter.stepBack()).toBe(false)
  })
})
