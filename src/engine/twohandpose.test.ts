// @vitest-environment node
// Seeds for a two-handed hold from the library's real holds (static/templates/rom/human-twohand.json): the Y Bot posed
// from a seed has its fists where the seed says (before any IK), a pose mirrored is the pose reflected, and a real frame
// that is not in the thinned set finds poses near its own grip. Skipped without the local library.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { handGrip } from './clipedit.ts'
import { captureRest, type RestSkeleton } from './retarget.ts'
import { bodyScale, gripOfPose, TwoHandSeeder, worldOfBones, type GripQuery, type TwoHandData } from './twohandpose.ts'

const g = globalThis as Record<string, unknown>
g.self ??= globalThis
g.createImageBitmap ??= async () => { throw new Error('no images in tests') }

const ROOT = path.resolve(__dirname, '../..')
const LIBRARY = path.join(ROOT, 'workspace/library')
const DATA = path.join(ROOT, 'static/templates/rom/human-twohand.json')
const have = existsSync(path.join(LIBRARY, 'mannequin', 'ybot.glb')) && existsSync(DATA)
const isBone = (o: THREE.Object3D): boolean => (o as THREE.Bone).isBone === true

async function load (file: string): Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }> {
  const data = readFileSync(file)
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  return await new Promise((resolve, reject) => { new GLTFLoader().parse(buffer, '', r => { resolve(r) }, reject) })
}

async function ybot (): Promise<{ scene: THREE.Group, rest: RestSkeleton, bones: Map<string, THREE.Object3D> }> {
  const { scene } = await load(path.join(LIBRARY, 'mannequin', 'ybot.glb'))
  const rest = captureRest(scene, isBone)
  const bones = new Map([...rest.bones].map(([n, b]) => [n, b.node]))
  return { scene, rest, bones }
}

const data = have ? JSON.parse(readFileSync(DATA, 'utf8')) as TwoHandData : null
const q = (left: [number, number, number], right: [number, number, number], shaft: [number, number, number]): GripQuery => ({ left, right, shaft })

describe.skipIf(!have)('two-handed seeds from real holds', () => {
  it('keeps a few hundred to a couple of thousand poses, under a megabyte', () => {
    expect(data!.clip.length).toBeGreaterThan(300)
    expect(data!.clip.length).toBeLessThan(2500)
    expect(readFileSync(DATA).length).toBeLessThan(1_000_000)
    expect(data!.turns.length).toBe(data!.clip.length * 56)
    expect(data!.grip.length).toBe(data!.clip.length * 9)
  })

  it('poses the Y Bot with its fists where its stored grip says, mirrored too', async () => {
    const { rest } = await ybot()
    const seeder = new TwoHandSeeder(data!, rest, rest)
    const s = seeder.scale.size
    let worst = 0
    for (let i = 0; i < seeder.count; i += 29) {
      const grip = seeder.storedGrip(i)
      const f = seeder.fistsOfStored(i)
      worst = Math.max(worst, f[0].distanceTo(new THREE.Vector3(...grip.left).multiplyScalar(s)), f[1].distanceTo(new THREE.Vector3(...grip.right).multiplyScalar(s)))
      const m = seeder.fistsOfStored(i, true)
      worst = Math.max(worst, m[0].distanceTo(new THREE.Vector3(-grip.right[0], grip.right[1], grip.right[2]).multiplyScalar(s)), m[1].distanceTo(new THREE.Vector3(-grip.left[0], grip.left[1], grip.left[2]).multiplyScalar(s)))
    }
    expect(worst).toBeLessThan(0.003)
  })

  it('finds a pose for its own grip, at any heading', async () => {
    const { rest } = await ybot()
    const seeder = new TwoHandSeeder(data!, rest, rest)
    for (const i of [3, 400, 900]) {
      const [l, r] = seeder.fistsOfStored(i, false, 0.7)   // (the same pose, the body turned 40 degrees)
      const { seeds } = seeder.seeds({ left: l.toArray() as [number, number, number], right: r.toArray() as [number, number, number] }, { k: 3 })
      expect(seeds[0].miss.worst).toBeLessThan(0.005)
      expect(Math.abs(seeds[0].heading - 0.7)).toBeLessThan(0.1)
    }
  })

  it('puts the Y Bot\'s fists where the seed says, before any IK', async () => {
    const { rest, bones } = await ybot()
    const seeder = new TwoHandSeeder(data!, rest, rest)
    const hips = bones.get('Hips')!.getWorldPosition(new THREE.Vector3())
    const target = q([0.05, -0.05, 0.40], [0.0, -0.10, 0.30], [0, 0, 1])
    const { seeds } = seeder.seeds(target, { k: 3 })
    const fist = { Left: handGrip(rest, 'Left')!.fist, Right: handGrip(rest, 'Right')!.fist }
    const anchor = seeder.anchor(hips)
    for (const seed of seeds) {
      seed.apply(bones)
      const w = worldOfBones(bones)
      const at = (side: 'Left' | 'Right'): THREE.Vector3 => w.position(`${side}Hand`)!.add(fist[side].clone().applyQuaternion(w.quaternion(`${side}Hand`)!))
      expect(at('Left').distanceTo(anchor.clone().add(new THREE.Vector3(...target.left)))).toBeCloseTo(seed.miss.left, 2)
      expect(at('Right').distanceTo(anchor.clone().add(new THREE.Vector3(...target.right)))).toBeCloseTo(seed.miss.right, 2)
    }
  })

  it('puts the fists near a staff, a spear, a rifle held as the library holds them, and says how near', async () => {
    const { rest } = await ybot()
    const seeder = new TwoHandSeeder(data!, rest, rest)
    const asked: Array<[string, GripQuery, number]> = [
      // (hands as far apart as the library's real holds have them: 8 to 20 cm; the best of 5, and the blend)
      ['rifle at the hip, 12 cm', q([0.10, -0.20, 0.38], [-0.08, -0.27, 0.30], [0.5, -0.3, 0.8]), 0.10],
      ['spear level forward, 12 cm', q([0.05, -0.05, 0.40], [0.0, -0.10, 0.30], [0, 0, 1]), 0.10],
      ['staff across the chest, 12 cm', q([0.12, 0.0, 0.25], [0.0, 0.0, 0.25], [-1, 0, 0]), 0.10],
      // (the library has next to no real holds with the hands 25 to 35 cm apart: these are what it gives today)
      ['spear level forward, 35 cm', q([0.05, -0.05, 0.50], [0.0, -0.10, 0.15], [0, 0, 1]), 0.16],
      ['staff across the chest, 35 cm', q([0.30, 0.0, 0.25], [-0.05, 0.0, 0.25], [-1, 0, 0]), 0.16],
    ]
    for (const [name, query, within] of asked) {
      const { seeds, blend } = seeder.seeds(query, { k: 5 })
      expect(seeds.length, name).toBeGreaterThanOrEqual(3)
      expect(seeds[0].miss.worst, name).toBeLessThan(within)
      expect(blend!.miss.worst, name).toBeLessThan(within * 1.6)
      for (let i = 1; i < seeds.length; i++) expect(seeds[i].miss.worst).toBeGreaterThanOrEqual(seeds[i - 1].miss.worst)
    }
  })

  it('finds poses near a real frame that is not in the set', async () => {
    const { rest } = await ybot()
    const tested: string[] = []
    for (const name of ['Golf_Drive_3', 'Baseball_Idle', '2hand_Idle']) {
      const id = `mixamo-${name}`
      const file = path.join(LIBRARY, 'clips', `${id}.glb`)
      if (!existsSync(file)) continue
      const clip = await load(file)
      const sRest = captureRest(clip.scene, isBone)
      const seeder = new TwoHandSeeder(data!, sRest, rest)
      const scale = bodyScale(sRest)!
      const fist = { Left: handGrip(sRest, 'Left')!.fist, Right: handGrip(sRest, 'Right')!.fist }
      const names = new Map([...sRest.bones].map(([n, b]) => [n, b.node]))
      const mixer = new THREE.AnimationMixer(clip.scene)
      mixer.clipAction(clip.animations[0]).play()
      // (the set holds the even frames: an odd one of a stored clip is a real frame it does not hold)
      const index = data!.clips.indexOf(id)
      const frames = [...new Set(data!.frame.filter((_, i) => data!.clip[i] === index))].filter(f => f % 4 === 0).slice(0, 6)
      for (const f of frames) {
        mixer.setTime((f + 1) / 30)
        clip.scene.updateMatrixWorld(true)
        const pg = gripOfPose(worldOfBones(names), fist, scale)!
        const query: GripQuery = { left: pg.grip.left.map(x => x * scale.size) as [number, number, number], right: pg.grip.right.map(x => x * scale.size) as [number, number, number], shaft: pg.grip.shaft }
        const { seeds } = seeder.seeds(query, { k: 5 })
        // (the clip's own rest against the Y Bot's: the retarget's palm twist moves a fist a centimetre or so)
        expect(seeds[0].miss.worst, `${name} ${f + 1}`).toBeLessThan(0.05)
        tested.push(`${name} ${f + 1}`)
      }
    }
    expect(tested.length).toBeGreaterThan(3)
  })
})
