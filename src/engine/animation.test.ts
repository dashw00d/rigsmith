import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { clone } from 'three/addons/utils/SkeletonUtils.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnimationEntry, Character, Garment } from '../../server/workspace.ts'
import { bakeEntry, withPropTracks } from './animation.ts'
import { CharacterView } from './CharacterView.ts'
import { RetargetCache } from './clips.ts'
import { DEFAULT_EXPORT, exportCharacter, loadExportView } from './exporter.ts'

afterEach(() => { vi.restoreAllMocks() })

function character (): { view: CharacterView, entry: AnimationEntry, data: Character, raw: THREE.AnimationClip } {
  const root = new THREE.Group()
  const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.y = 1
  const arm = new THREE.Bone(); arm.name = 'RightArm'; arm.position.y = .2
  const hand = new THREE.Bone(); hand.name = 'RightHand'; hand.position.x = .2
  root.add(hips); hips.add(arm); arm.add(hand)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(12).fill(0), 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4))
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial())
  root.add(mesh); root.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton([hips, arm, hand]))
  const view = new CharacterView(root)
  const prop = new THREE.Group(); prop.name = 'Spear_place'; hand.add(prop)
  const garment: Garment = { id: 'spear', name: 'Spear', status: 'ready', file: 'spear.glb', mode: 'rigid', policy: 'body', bone: 'RightHand', position: [.2, 0, 0], rotation: [0, 0, 0], scale: 2, hideBody: false }
  const entry: AnimationEntry = {
    name: 'Attack', clipId: 'source', speed: 2, loop: false, inPlace: false, lift: .1,
    keys: { bones: { RightArm: [{ u: 0, q: [0, 0, Math.sin(.2), Math.cos(.2)] }] }, props: { Spear: [{ u: 0, q: [0, 0, 0, 1], p: [.1, 0, 0] }] } },
  }
  const data = { name: 'Test', files: { rigged: 'rigged.glb' }, animations: [entry], garments: [garment], scripts: [{ id: 'blow', enabled: true, kind: 'blow', clip: 'Attack', at: .5, blowU: .75 }] } as Character
  const raw = new THREE.AnimationClip('source', 1, [
    new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 1, 0, 2, 1, 0]),
    new THREE.QuaternionKeyframeTrack('RightArm.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
  ])
  return { view, entry, data, raw }
}

function value (clip: THREE.AnimationClip, name: string): number[] {
  const track = clip.tracks.find(t => t.name === name)!
  return Array.from((track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant().evaluate(0))
}

describe('the shared animation bake', () => {
  it('serializes the viewer bake with scripts, speed, ground and bone/prop keys intact', async () => {
    const { view, entry, data, raw } = character()
    const cache = new RetargetCache(view.rest!)
    vi.spyOn(cache, 'get').mockResolvedValue(raw)
    const { clip } = await bakeEntry(data, view, cache, clone(view.root), entry)
    expect(clip.duration).toBeCloseTo(.25)
    expect(value(clip, 'Hips.position')[1]).toBeCloseTo(1.1)
    expect(value(clip, 'Spear_place.position')[0]).toBeCloseTo(.4)
    const blob = await exportCharacter(view, [entry], cache, () => 'source', { ...DEFAULT_EXPORT, lods: 0 }, data)
    const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => { resolve(reader.result as ArrayBuffer) }; reader.onerror = reject; reader.readAsArrayBuffer(blob)
    })
    const length = new DataView(buffer).getUint32(12, true)
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, length)))
    const animation = json.animations[0]
    for (const [node, path, track] of [['Hips', 'translation', 'Hips.position'], ['RightArm', 'rotation', 'RightArm.quaternion'], ['Spear_place', 'translation', 'Spear_place.position']] as const) {
      const channel = animation.channels.find((c: { target: { node: number, path: string } }) => json.nodes[c.target.node].name === node && c.target.path === path)
      expect(channel, node).toBeDefined()
      const sampler = animation.samplers[channel.sampler]
      const accessor = json.accessors[sampler.output]; const bytes = json.bufferViews[accessor.bufferView]
      const expected = value(clip, track)
      const actual = new Float32Array(buffer, 20 + length + 8 + (bytes.byteOffset ?? 0) + (accessor.byteOffset ?? 0), expected.length)
      expected.forEach((v, i) => expect(actual[i], `${track}[${i}]`).toBeCloseTo(v, 6))
      expect(json.accessors[sampler.input].max[0]).toBeCloseTo(clip.duration)
    }
  })

  it('replaces old prop tracks when switching from a keyed clip to a plain one', () => {
    const { view, data, raw, entry } = character()
    const keyed = withPropTracks(raw, entry.keys?.props, false, data, view.root)
    const reset = withPropTracks(keyed, undefined, false, data, view.root)
    expect(reset.tracks.filter(t => t.name === 'Spear_place.position')).toHaveLength(1)
    expect(value(reset, 'Spear_place.position')).toEqual([Math.fround(.2), 0, 0])
  })

  it('loads rigid garments and clothing on an offscreen export, omitting hidden pieces', async () => {
    const { view, data } = character()
    view.root.getObjectByName('Spear_place')!.removeFromParent()
    const spear = data.garments![0]
    data.garments = [spear, { ...spear, id: 'shirt', name: 'Shirt', mode: 'clothing', scale: 1 }, { ...spear, id: 'hidden', name: 'Hidden', hidden: true }]
    vi.spyOn(CharacterView, 'load').mockResolvedValue(view)
    const scene = new THREE.Group(); scene.add(new THREE.Mesh(new THREE.BoxGeometry(.05, .05, .05), new THREE.MeshBasicMaterial()))
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue({ scene } as GLTF)
    const exported = await loadExportView(data, file => file ?? null)
    expect(exported.root.getObjectByName('Spear_place')).toBeDefined()
    expect(exported.skinned).toHaveLength(2)
    expect(exported.root.getObjectByName('Hidden_place')).toBeUndefined()
  })
})
