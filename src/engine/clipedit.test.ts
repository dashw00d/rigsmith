// @vitest-environment node
// The editor's clip: a library clip retargeted onto a character and taken back (the retarget undone) is the clip it
// was; skipped without the local library and a rigged character.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { captureRest, retarget } from './retarget.ts'
import { carrierGrip, handOn, socketMisses, unretarget, type PropRig } from './clipedit.ts'

const g = globalThis as Record<string, unknown>
g.self ??= globalThis
g.createImageBitmap ??= async () => { throw new Error('no images in tests') }

const ROOT = path.resolve(__dirname, '../..')
const CLIP = path.join(ROOT, 'workspace/library/clips/mixamo-Jumping_Jacks.glb')
const chars = path.join(ROOT, 'workspace/characters')
const rigged = existsSync(chars) ? readdirSync(chars).map(d => path.join(chars, d, 'rigged.glb')).find(f => existsSync(f) && !/horse|pony/.test(f)) : undefined
const have = existsSync(CLIP) && rigged !== undefined

async function load (file: string): Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }> {
  const data = readFileSync(file)
  return await new Promise((resolve, reject) => { new GLTFLoader().parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '', r => { resolve(r) }, reject) })
}
const isBone = (o: THREE.Object3D): boolean => (o as THREE.Bone).isBone === true

describe('prop grip frames', () => {
  it('reconstructs the carrying hand from fixed rest transforms, including prop scale', () => {
    const place = new THREE.Matrix4().compose(new THREE.Vector3(.2, .8, -.1), new THREE.Quaternion().setFromEuler(new THREE.Euler(.2, .7, -.3)), new THREE.Vector3(2, 2, 2))
    const rest = new THREE.Matrix4().compose(new THREE.Vector3(.1, .7, .2), new THREE.Quaternion().setFromEuler(new THREE.Euler(-.4, .1, .2)), new THREE.Vector3(1, 1, 1))
    const socket = carrierGrip('Spear', 'Right', place, rest)
    const goal = handOn(place, socket)
    expect(goal.at.distanceTo(new THREE.Vector3().setFromMatrixPosition(rest))).toBeLessThan(1e-8)
    expect(goal.turn.angleTo(new THREE.Quaternion().setFromRotationMatrix(rest))).toBeLessThan(1e-7)
  })

  it('reports a moving prop leaving a fixed hand and restores the sampled scene', () => {
    const root = new THREE.Group()
    const left = new THREE.Bone(); left.name = 'LeftHand'
    const right = new THREE.Bone(); right.name = 'RightHand'
    const prop = new THREE.Group(); prop.name = 'spear_place'
    right.add(prop); root.add(left, right); root.updateMatrixWorld(true)
    const props: PropRig = {
      node: () => prop.name, paths: {}, attachments: [{ hand: 'Left', prop: 'Spear', socket: 'left' }], carriers: { Spear: 'RightHand' }, fingers: {},
      sockets: { Spear: [{ id: 'left', name: 'Left', position: [0, 0, 0], rotation: [0, 0, 0, 1] }] },
    }
    const clip = new THREE.AnimationClip('drift', 1, [new THREE.VectorKeyframeTrack('RightHand.position', [0, 1], [0, 0, 0, .1, 0, 0])])
    expect(Math.max(...socketMisses(clip, root, props))).toBeCloseTo(.1, 6)
    expect(right.position.length()).toBe(0)
  })
})

describe.skipIf(!have)('taking an edited clip back to the library', () => {
  it('gives back the clip it was retargeted from', async () => {
    const src = await load(CLIP)
    const target = await load(rigged!)
    const sRest = captureRest(src.scene, isBone)
    const tRest = captureRest(target.scene, isBone)
    const onTarget = retarget(src.scene, sRest, src.animations[0], tRest, { fps: 30 })
    const back = unretarget(onTarget, target.scene, tRest, sRest, src.animations[0])
    // the source as it plays, against what came back, frame by frame: every bone's local turn, and the hips
    const mixer = new THREE.AnimationMixer(src.scene)
    mixer.clipAction(src.animations[0]).play()
    let worst = 0; let hipsWorst = 0
    const per = new Map<string, number>()
    back.rotations.forEach((frame, f) => {
      mixer.setTime(Math.min(f / back.fps, src.animations[0].duration))
      back.bones.forEach((name, b) => {
        const node = sRest.bones.get(name)!.node
        const q = new THREE.Quaternion().fromArray(frame[b])
        const a = THREE.MathUtils.radToDeg(q.angleTo(node.quaternion))
        per.set(name, Math.max(per.get(name) ?? 0, a))
        worst = Math.max(worst, a)
      })
      const hips = sRest.bones.get('Hips')!.node
      hipsWorst = Math.max(hipsWorst, new THREE.Vector3().fromArray(back.hips[f]).distanceTo(hips.position))
    })
    if (worst >= 0.5) console.log([...per].filter(([, a]) => a > 0.5).map(([n, a]) => `${n} ${a.toFixed(1)}`).join(', '), 'in target:', [...per.keys()].filter(n => !tRest.bones.has(n)).join(','))
    expect(worst).toBeLessThan(0.5)
    expect(hipsWorst).toBeLessThan(0.005)
  })
})

describe('a creature\'s hips under a turning root bone', () => {
  it('keeps the root\'s turn out of the hips\' position', () => {
    const make = (): THREE.Group => {
      const scene = new THREE.Group()
      const root = new THREE.Bone(); root.name = 'root'
      const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0.5)
      const spine = new THREE.Bone(); spine.name = 'Spine'; spine.position.set(0, 0.3, 0)
      scene.add(root); root.add(hips); hips.add(spine)
      return scene
    }
    const src = make(); const tgt = make()
    const sRest = captureRest(src, isBone, n => n)
    const tRest = captureRest(tgt, isBone, n => n)
    const turned = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4)
    const clip = new THREE.AnimationClip('turn', 1, [
      new THREE.QuaternionKeyframeTrack('root.quaternion', [0, 1], [0, 0, 0, 1, ...turned.toArray()]),
    ])
    const back = unretarget(clip, tgt, tRest, sRest)
    const worst = Math.max(...back.hips.map(h => new THREE.Vector3().fromArray(h).distanceTo(new THREE.Vector3(0, 1, 0.5))))
    expect(worst).toBeLessThan(1e-4)
  })
})

describe('a prop moved in its socket', () => {
  it('shifts it in its own placed frame on the keyed frames, tweened, whatever holds it staying put', async () => {
    const { buildEdit } = await import('./clipedit.ts')
    const { HUMAN_RIG } = await import('./PoseEditor.ts')
    const root = new THREE.Group()
    const hips = new THREE.Bone(); hips.name = 'Hips'
    const hand = new THREE.Bone(); hand.name = 'RightHand'; hand.position.set(0.3, 0, 0)
    const prop = new THREE.Group(); prop.name = 'Bow_place'; prop.position.set(0, 0.1, 0); prop.scale.setScalar(2)
    hips.add(hand); hand.add(prop); root.add(hips); root.updateMatrixWorld(true)
    const base = new THREE.AnimationClip('Die', 1, [
      new THREE.VectorKeyframeTrack('Bow_place.position', [0, 1], [0, 0.1, 0, 0, 0.1, 0]),
      new THREE.QuaternionKeyframeTrack('Bow_place.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    ])
    const props: PropRig = {
      node: p => `${p}_place`, attachments: [], carriers: { Bow: 'RightHand' }, fingers: {}, sockets: {},
      // (let go of on the last frame: half a meter down in its own frame, a quarter turn)
      paths: { Bow: { locked: false, keys: [{ u: 0, q: [0, 0, 0, 1], p: [0, 0, 0] }, { u: 1, q: [0, 0, Math.SQRT1_2, Math.SQRT1_2], p: [0, -0.5, 0] }] } },
    }
    const clip = buildEdit(base, {}, false, () => null, root, HUMAN_RIG, -10, null, props, 1, { solve: () => { throw new Error('nothing to solve') }, bones: () => [] } as never)
    const pos = clip.tracks.find(t => t.name === 'Bow_place.position')!
    const at = (i: number): number[] => Array.from(pos.values.slice(i * 3, i * 3 + 3))
    // first frame: where its socket holds it; last: moved by the key in its placed frame (its scale 2: one meter)
    expect(at(0)[1]).toBeCloseTo(0.1, 6)
    expect(at(pos.times.length - 1)[1]).toBeCloseTo(0.1 - 1, 6)
    // halfway: tweened
    expect(at(Math.floor(pos.times.length / 2))[1]).toBeGreaterThan(0.1 - 1)
    expect(at(Math.floor(pos.times.length / 2))[1]).toBeLessThan(0.1)
    // the hand holding it never moved
    expect(clip.tracks.some(t => t.name.startsWith('RightHand.'))).toBe(false)
  })
})
