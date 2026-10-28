// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { captureRest } from '../../src/engine/retarget.ts'
import { clipFile, isBone, nodeClipSource, ROOT } from './node3d.ts'

describe('tools: clip urls as files', () => {
  const ws = path.join(tmpdir(), 'rigsmith-ws')

  it('maps the library\'s urls into the workspace and bundled ones into the app, without the #name', () => {
    expect(clipFile('/files/library/clips/mixamo-Walk.glb', ws)).toBe(path.join(ws, 'library', 'clips', 'mixamo-Walk.glb'))
    expect(clipFile('/files/library/creatures/horse/a%20b.glb#Walk', ws)).toBe(path.join(ws, 'library', 'creatures', 'horse', 'a b.glb'))
    expect(clipFile('/animations/horse-animations.glb#Idle', ws)).toBe(path.join(ROOT, 'static', 'animations', 'horse-animations.glb'))
  })

  it('refuses anything else, and a url that leaves its folder', () => {
    expect(() => clipFile('/files/characters/x/rigged.glb', ws)).toThrow('not a clip')
    expect(() => clipFile('/animations/../../package.json', ws)).toThrow('leaves its folder')
    expect(() => clipFile('/files/library/', ws)).toThrow('leaves its folder')
  })
})

// A two-bone chain (Hips, Spine above it), its Spine turning a quarter about Z over a second.
function chain (): THREE.Group {
  const root = new THREE.Group()
  const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0)
  const spine = new THREE.Bone(); spine.name = 'Spine'; spine.position.set(0, 0.3, 0)
  hips.add(spine); root.add(hips)
  root.updateMatrixWorld(true)
  return root
}

describe('tools: nodeClipSource', () => {
  it('retargets a library clip from its file onto a skeleton, once per clip and options', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'rigsmith-clips-'))
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
    const clip = new THREE.AnimationClip('Turn', 1, [new THREE.QuaternionKeyframeTrack('Spine.quaternion', [0, 1], [0, 0, 0, 1, ...turn.toArray()])])
    const glb = await new GLTFExporter().parseAsync(chain(), { binary: true, animations: [clip] }) as ArrayBuffer
    mkdirSync(path.join(ws, 'library', 'clips'), { recursive: true })
    writeFileSync(path.join(ws, 'library', 'clips', 'turn.glb'), new Uint8Array(glb))

    const target = chain()
    const source = nodeClipSource(captureRest(target, isBone), ws)
    const got = await source.get({ id: 'turn' }, { inPlace: false })
    expect(got.duration).toBeCloseTo(1, 5)
    const spine = got.tracks.find(t => t.name === 'Spine.quaternion')!
    const end = new THREE.Quaternion().fromArray(spine.values, spine.values.length - 4)
    expect(end.angleTo(turn)).toBeLessThan(1e-3)
    expect(await source.get({ id: 'turn' }, { inPlace: false })).toBe(got)
    expect(await source.get({ id: 'turn' }, { inPlace: true })).not.toBe(got)
    await expect(source.get({ id: 'missing' }, { inPlace: false })).rejects.toThrow('no clip file')
    rmSync(ws, { recursive: true, force: true })
  })
})
