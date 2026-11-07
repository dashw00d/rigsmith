// @vitest-environment node
// Exercise the exported GLB and events, including a set-held piece hidden in the document.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { loadGlbFile } from '../../src/engine/headless.ts'
import { humanJoints, makeCharacter, makeGear, makeSlot } from '../../src/model/fixtures.ts'
import { humanHierarchy } from '../../src/model/skeletons.ts'
import { exportUnit } from './unit_export.ts'

it('exports a hidden set-held shield with a matching stance grip and clip names', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'rigsmith-stance-export-'))
  try {
    const dir = path.join(workspace, 'characters', 'fighter')
    const lib = path.join(workspace, 'library', 'clips')
    mkdirSync(path.join(dir, 'garments', 'shield'), { recursive: true }); mkdirSync(lib, { recursive: true })
    const joints = humanJoints(); const bones = new Map<string, THREE.Bone>(); const root = new THREE.Group()
    for (const [name, parent] of humanHierarchy('full')) {
      const bone = new THREE.Bone(); bone.name = name
      const pos = new THREE.Vector3(...joints[name]); if (parent !== null) pos.sub(new THREE.Vector3(...joints[parent]))
      bone.position.copy(pos); (parent === null ? root : bones.get(parent)!).add(bone); bones.set(name, bone)
    }
    const geo = new THREE.PlaneGeometry(1, 1.8, 4, 6).translate(0, 0.9, 0)
    const n = geo.attributes.position.count
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4))
    const weights = new Float32Array(n * 4); for (let i = 0; i < n; i++) weights[i * 4] = 1
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
    const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial({ name: 'Shirt' })); root.add(mesh)
    root.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton([...bones.values()]))
    const idle = new THREE.AnimationClip('Idle', 1, [
      new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 1, 0, 0, 1, 0]),
      new THREE.QuaternionKeyframeTrack('LeftHandIndex1.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    ])
    const exporter = new GLTFExporter()
    const rigged = await exporter.parseAsync(root, { binary: true }) as ArrayBuffer
    const clip = await exporter.parseAsync(root, { binary: true, animations: [idle] }) as ArrayBuffer
    writeFileSync(path.join(dir, 'rigged.glb'), new Uint8Array(rigged)); writeFileSync(path.join(lib, 'fixture.glb'), new Uint8Array(clip))
    const shieldModel = await exporter.parseAsync(new THREE.Mesh(new THREE.BoxGeometry(.2, .3, .02), new THREE.MeshStandardMaterial()), { binary: true }) as ArrayBuffer
    writeFileSync(path.join(dir, 'garments', 'shield', 'model.glb'), new Uint8Array(shieldModel))
    const slot = makeSlot({ id: 'idle', name: 'Idle', clip: { id: 'fixture', url: '/files/library/clips/fixture.glb#Idle' } })
    const shield = makeGear({ id: 'shield', name: 'Shield', from: 'emberhold:gear/GearShield', model: 'garments/shield/model.glb', hidden: true,
      attach: { kind: 'bone', bone: 'LeftHand', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } },
      handles: [{ id: 'carry', name: 'Carry', kind: 'carry', hand: 'Left', pose: { pose: 'grip' } }] })
    const vest = makeGear({ id: 'vest', name: 'Vest', from: 'emberhold:gear/GearVest', model: 'garments/shield/model.glb' })
    const c = makeCharacter({ id: 'fighter', files: { rigged: 'rigged.glb' }, gear: [vest, shield], clips: [slot],
      hands: { poses: [{ id: 'grip', name: 'Grip', side: 'Left', joints: { Index1: [0.3826834, 0, 0, 0.9238795] } }] },
      folk: { sets: [{ id: 'guard', name: 'Guard', pieces: ['vest', 'shield'], tags: [], grants: [], stance: 'shield' }],
        pools: [], kinds: [], stances: [{ id: 'shield', name: 'Shield', clips: { Idle: ['idle'] } }] } })
    writeFileSync(path.join(dir, 'character.json'), JSON.stringify(c))
    const modelsDir = path.join(workspace, 'out', 'models')
    await exportUnit('fighter', { character: 'fighter', height: 1.8, budget: 10000, clips: ['Idle'], lods: [] },
      { workspace, modelsDir, workDir: path.join(workspace, 'out', 'work') })
    const glb = await loadGlbFile(path.join(modelsDir, 'fighter.glb'))
    const base = glb.animations.find(a => a.name === 'Idle')!
    const stance = glb.animations.find(a => a.name === 'Idle@shield')!
    expect(base).toBeDefined(); expect(stance).toBeDefined()
    const track = (a: THREE.AnimationClip) => a.tracks.find(t => t.name === 'LeftHandIndex1.quaternion')!
    expect(track(stance)).toBeDefined(); expect(track(base)).toBeDefined()
    expect(Array.from(track(stance).values)).not.toEqual(Array.from(track(base).values))
    const events = JSON.parse(readFileSync(path.join(modelsDir, 'fighter.events.json'), 'utf8'))
    const manifest = JSON.parse(readFileSync(path.join(modelsDir, 'fighter.folk.json'), 'utf8'))
    expect(glb.scene.getObjectByName('GearShield')).toBeDefined()
    expect(events.stances.shield.Idle).toEqual(['Idle@shield'])
    expect(manifest.stances[0].clips.Idle).toEqual(events.stances.shield.Idle)
  } finally { rmSync(workspace, { recursive: true, force: true }) }
}, 60_000)
