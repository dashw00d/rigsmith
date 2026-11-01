import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { WeightPainter } from './weightpaint.ts'

type Tool = 'add' | 'remove' | 'smooth' | 'rigid'
const tools: Tool[] = ['add', 'remove', 'smooth', 'rigid']

/** Four material panels, including UV aliases, and a separate donor sheet just behind them. Every skin uses a
 * different palette order, while its bones belong to one rig. The panels meet at x = -.06, 0 and .06. */
function panels (): THREE.SkinnedMesh[] {
  const root = new THREE.Group()
  const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.z = -.5; root.add(hips)
  const left = new THREE.Bone(); left.name = 'LeftArm'; left.position.set(.1, 1, 0); hips.add(left)
  const right = new THREE.Bone(); right.name = 'RightArm'; right.position.set(-.1, 1, 0); hips.add(right)
  const head = new THREE.Bone(); head.name = 'Head'; head.position.y = 1; hips.add(head)
  const bones = [hips, left, right, head]
  const meshes = [[-.12, -.06, .008], [-.06, 0, .008], [0, .06, .008], [.06, .12, .008], [-.3, .3, 0]].map(([a, b, z]) => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([a, .4, z, b, .4, z, a, .6, z, b, .6, z, a, .4, z], 3))
    g.setIndex([0, 1, 3, 4, 3, 2])
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(20).fill(0), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: 5 }, () => [1, 0, 0, 0]).flat(), 4))
    const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial()); root.add(mesh); return mesh
  })
  root.updateMatrixWorld(true)
  const orders = [bones, [...bones].reverse(), [...bones.slice(2), ...bones.slice(0, 2)], [left, hips, head, right], bones]
  meshes.forEach((mesh, q) => {
    mesh.bind(new THREE.Skeleton(orders[q]))
    for (let p = 0; p < 5; p++) set(mesh, p, [['Hips', 1]])
  })
  return meshes
}

function set (mesh: THREE.SkinnedMesh, p: number, values: Array<[string, number]>): void {
  for (const v of p === 0 ? [0, 4] : [p]) for (let k = 0; k < 4; k++) {
    mesh.geometry.attributes.skinIndex.setComponent(v, k, values[k] === undefined ? 0 : mesh.skeleton.bones.findIndex(b => b.name === values[k][0]))
    mesh.geometry.attributes.skinWeight.setComponent(v, k, values[k]?.[1] ?? 0)
  }
}

function asymmetry (meshes: THREE.SkinnedMesh[], arm = .4, opposite = .8): void {
  for (const [part, point] of [[2, 1], [3, 0]]) set(meshes[part], point, [['LeftArm', arm], ['Hips', 1 - arm]])
  for (const [part, point] of [[0, 1], [1, 0]]) set(meshes[part], point, [['RightArm', opposite], ['Hips', 1 - opposite]])
}

function named (painter: WeightPainter, part: number, point: number): Map<string, number> {
  const bones = painter.parts[part].mesh.skeleton.bones
  return new Map([...painter.weights(part, point)].map(([b, w]) => [bones[b].name, w]))
}

function raw (meshes: THREE.SkinnedMesh[]): number[][][] {
  return meshes.map(mesh => ['position', 'skinIndex', 'skinWeight'].map(name => Array.from(mesh.geometry.attributes[name].array)))
}

function dab (painter: WeightPainter, tool: Tool, part: number, point: number, strength: number, falloff = 1): void {
  const points = new Map([[point, falloff]])
  if (tool === 'add' || tool === 'remove') {
    const bone = painter.parts[part].mesh.skeleton.bones.findIndex(b => b.name === 'LeftArm')
    painter[tool](part, points, bone, strength)
  } else painter[tool](part, points, strength)
}

describe('manual brushes across material and mirror primitives', () => {
  it.each(tools)('runs %s from every recipient\'s source, maps palettes and restores all raw buffers in one Undo', tool => {
    const meshes = panels(); asymmetry(meshes); const before = raw(meshes)
    const painter = new WeightPainter(meshes)
    painter.begin({ bounded: true }); dab(painter, tool, 2, 1, .25, .4); painter.end()
    const right = tool === 'add' ? .46 : .36; const left = tool === 'add' ? .82 : .72
    for (const [part, point] of [[2, 1], [3, 0], [3, 4]]) expect(named(painter, part, point).get('LeftArm')).toBeCloseTo(right)
    for (const [part, point] of [[0, 1], [1, 0], [1, 4]]) expect(named(painter, part, point).get('RightArm')).toBeCloseTo(left)
    expect(raw([meshes[4]])).toEqual([before[4]])
    expect(new Set(painter.edits().map(edit => edit.mesh))).toEqual(new Set([0, 1, 2, 3]))
    expect(painter.stepBack()).toBe(true)
    expect(raw(meshes)).toEqual(before)
    expect(painter.editedCount).toBe(0)
    expect(painter.stepBack()).toBe(false)
  })

  it.each(tools)('uses strongest %s coverage once across both mirror halves and every seam alias, regardless of dab order', tool => {
    const run = (order: number[]): number[][][] => {
      const meshes = panels(); asymmetry(meshes, .2, .2)
      const painter = new WeightPainter(meshes)
      const dabs = [[2, 1, .2], [3, 0, 1], [1, 0, .7], [0, 1, .3]]
      painter.begin({ bounded: true })
      for (const index of order) {
        const [part, point, falloff] = dabs[index]; dab(painter, tool, part, point, .4, falloff)
      }
      painter.end(); return raw(meshes)
    }
    expect(run([0, 1, 2, 3])).toEqual(run([3, 2, 1, 0]))
    expect(run([0, 1, 2, 3])).toEqual(run([1, 0, 3, 2]))
  })

  it.each(tools)('resolves equal %s coverage consistently when separate dabs begin on opposite primitives', tool => {
    const run = (dabs: number[][]): number[][][] => {
      const meshes = panels(); asymmetry(meshes, .2, .2); const painter = new WeightPainter(meshes)
      painter.begin({ bounded: true })
      for (const [part, point] of dabs) dab(painter, tool, part, point, .4)
      painter.end(); return raw(meshes)
    }
    expect(run([[0, 1], [2, 1], [1, 0], [3, 0]])).toEqual(run([[3, 0], [1, 0], [2, 1], [0, 1]]))
  })

  it('uses the stronger mirror dab even when falloffs differ by less than the write tolerance', () => {
    const run = (reverse: boolean): number[][][] => {
      const meshes = panels(); const painter = new WeightPainter(meshes)
      const dabs = [[2, 1, .7], [0, 1, .700000001]]
      painter.begin({ bounded: true })
      for (const [part, point, falloff] of reverse ? dabs.reverse() : dabs) dab(painter, 'add', part, point, .4, falloff)
      painter.end(); return raw(meshes)
    }
    expect(run(false)).toEqual(run(true))
  })

  it.each(tools)('pins shared %s seam points if either physical copy is read-only while editing the writable mirror', tool => {
    const meshes = panels(); asymmetry(meshes); const before = raw(meshes)
    const painter = new WeightPainter(meshes, undefined, new Set([meshes[0], meshes[1], meshes[2]]))
    painter.begin({ bounded: true }); dab(painter, tool, 2, 1, .5); painter.end()
    expect(raw(meshes.slice(2))).toEqual(before.slice(2))
    expect(named(painter, 0, 1).get('RightArm')).not.toBeCloseTo(.8)
    expect(named(painter, 1, 0)).toEqual(named(painter, 0, 1))
    expect(painter.stepBack()).toBe(true)
    expect(raw(meshes)).toEqual(before)
  })

  it.each(tools)('leaves read-only %s mirror recipients and donors unchanged', tool => {
    const meshes = panels(); asymmetry(meshes); const before = raw(meshes)
    const painter = new WeightPainter(meshes, undefined, new Set([meshes[2], meshes[3]]))
    painter.begin({ bounded: true }); dab(painter, tool, 2, 1, .5); painter.end()
    expect(raw(meshes.slice(0, 2))).toEqual(before.slice(0, 2))
    expect(raw([meshes[4]])).toEqual([before[4]])
    expect(new Set(painter.edits().map(edit => edit.mesh))).toEqual(new Set([2, 3]))
    const after = raw(meshes)
    painter.begin({ bounded: true }); dab(painter, tool, 0, 1, 1); painter.end()
    expect(raw(meshes)).toEqual(after)
    expect(painter.stepBack()).toBe(true)
    expect(raw(meshes)).toEqual(before)
    expect(painter.stepBack()).toBe(false)
  })

  it('smooths the complete physical neighbourhood across a material seam', () => {
    const meshes = panels()
    for (const point of [0, 2]) set(meshes[2], point, [['Head', 1]])
    for (const point of [1, 3]) set(meshes[3], point, [['LeftArm', 1]])
    const painter = new WeightPainter(meshes); painter.mirror = false
    painter.begin({ bounded: true }); painter.smooth(2, new Map([[1, 1]]), .4); painter.end()
    for (const [part, point] of [[2, 1], [3, 0], [3, 4]]) {
      expect(named(painter, part, point).get('Hips')).toBeCloseTo(.7)
      expect(named(painter, part, point).get('Head')).toBeCloseTo(.1)
      expect(named(painter, part, point).get('LeftArm')).toBeCloseTo(.2)
    }
  })

  it('holds a Bone target by name when a stroke moves to another primitive with a different palette', () => {
    const meshes = panels()
    set(meshes[2], 1, [['LeftArm', 1]]); set(meshes[3], 0, [['LeftArm', 1]]); set(meshes[3], 3, [['Head', 1]])
    const before = raw(meshes); const painter = new WeightPainter(meshes); painter.mirror = false
    painter.begin({ bounded: true }); painter.rigid(2, new Map([[1, 1]]), .5)
    const bone = painter.strokeBoneFor(3)
    expect(bone).not.toBeNull(); expect(meshes[3].skeleton.bones[bone!].name).toBe('LeftArm')
    painter.rigid(3, new Map([[3, 1]]), .5); painter.end()
    expect(named(painter, 3, 3)).toEqual(new Map([['Head', .5], ['LeftArm', .5]]))
    expect(painter.stepBack()).toBe(true); expect(raw(meshes)).toEqual(before)
  })

  it('evens a shared centre-line point once across both material copies', () => {
    const meshes = panels(); const painter = new WeightPainter(meshes)
    painter.begin({ bounded: true }); dab(painter, 'add', 1, 1, .4, .2); dab(painter, 'add', 2, 0, .4); painter.end()
    for (const [part, point] of [[1, 1], [2, 0], [2, 4]]) {
      const weights = named(painter, part, point)
      expect(weights.get('Hips')).toBeCloseTo(.6)
      expect(weights.get('LeftArm')).toBeCloseTo(.2)
      expect(weights.get('RightArm')).toBeCloseTo(.2)
    }
  })

  it('pins a physical seam when one palette cannot represent the selected bone', () => {
    const meshes = panels(); const outer = meshes[3]
    outer.bind(new THREE.Skeleton(outer.skeleton.bones.filter(b => b.name !== 'LeftArm')))
    for (let point = 0; point < 5; point++) set(outer, point, [['Hips', 1]])
    const before = raw(meshes); const painter = new WeightPainter(meshes); painter.mirror = false
    painter.begin({ bounded: true }); dab(painter, 'add', 2, 1, .5); painter.end()
    expect(raw(meshes)).toEqual(before)
    expect(painter.stepBack()).toBe(false)
  })

  it('pins a smooth seam when one palette cannot represent the shared neighbour field', () => {
    const meshes = panels(); const outer = meshes[3]
    outer.bind(new THREE.Skeleton(outer.skeleton.bones.filter(b => b.name !== 'Head')))
    for (let point = 0; point < 5; point++) set(outer, point, [['Hips', 1]])
    set(meshes[2], 0, [['Head', 1]])
    const before = raw(meshes); const painter = new WeightPainter(meshes); painter.mirror = false
    painter.begin({ bounded: true }); dab(painter, 'smooth', 2, 1, .5); painter.end()
    expect(raw(meshes)).toEqual(before)
    expect(painter.stepBack()).toBe(false)
  })

  it.each(tools)('keeps raw source slots and Undo unchanged for zero-strength and ineffective %s strokes', tool => {
    const meshes = panels()
    for (let part = 0; part < meshes.length; part++) for (let point = 0; point < 5; point++) {
      const bone = tool === 'add' ? (part < 2 ? 'RightArm' : 'LeftArm') : 'Hips'
      set(meshes[part], point, [[bone, .4], [bone, .6]])
    }
    const before = raw(meshes); const painter = new WeightPainter(meshes)
    for (const strength of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, .1]) {
      painter.begin({ bounded: true }); dab(painter, tool, 2, 1, strength); painter.end()
      expect(raw(meshes)).toEqual(before)
      expect(painter.editedCount).toBe(0)
      expect(painter.stepBack()).toBe(false)
    }
  })

  it('continues across a compatible material edge and cannot jump to the nearby donor plane', () => {
    const painter = new WeightPainter(panels()); painter.mirror = false
    const ray = (x: number): THREE.Ray => new THREE.Ray(new THREE.Vector3(x, .5, 1), new THREE.Vector3(0, 0, -1))
    const first = painter.pick(ray(.03), .04)!
    expect(first.part).toBe(2)
    const held = { part: first.part, sheet: new Set([...first.points.keys(), ...first.face.map(p => painter.parts[first.part].point[p])]) }
    expect(painter.pick(ray(.07), .04, held)?.part).toBe(3)
    expect(painter.pick(ray(.2), .04, held)).toBeNull()
  })
})
