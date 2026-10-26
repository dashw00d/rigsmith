// How a built unit's feet meet the ground in each clip: per frame, the lowest point of its body (skinned), over the clip
// its lowest (the planted sole should touch 0) and its median (a stance: near 0 standing, a walk's planted foot near 0).
// node tools/dev/ground.ts <unit.glb> [...]   (heights in the file's units and as a share of the unit's height)
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

const g = globalThis as Record<string, unknown>
g.self ??= globalThis
g.createImageBitmap ??= async () => { throw new Error('no images') }
const warn = console.warn
console.warn = (...a: unknown[]) => { if (!String(a[0]).includes('GLTFLoader')) warn(...a) }
for (const file of process.argv.slice(2)) {
  const d = readFileSync(file)
  const gltf = await new Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }>((resolve, reject) => {
    new GLTFLoader().parse(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength), '', r => { resolve(r as never) }, reject)
  })
  const unit = file.split('/').pop()!.replace('.glb', '')
  let body: THREE.SkinnedMesh | undefined
  gltf.scene.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh && o.name === unit) body = o as THREE.SkinnedMesh })
  if (body === undefined) { console.log(unit, 'no body mesh'); continue }
  const pos = body.geometry.attributes.position
  const v = new THREE.Vector3()
  const lowest = (): number => {
    gltf.scene.updateMatrixWorld(true)
    let y = Infinity
    for (let i = 0; i < pos.count; i += 3) { v.fromBufferAttribute(pos, i); body!.applyBoneTransform(i, v); v.applyMatrix4(body!.matrixWorld); y = Math.min(y, v.y) }
    return y
  }
  body.skeleton.pose()
  const rest = lowest()
  const box = new THREE.Box3().setFromObject(body)
  const h = box.max.y - box.min.y
  const rows: string[] = []
  for (const clip of gltf.animations) {
    const mixer = new THREE.AnimationMixer(gltf.scene)
    const action = mixer.clipAction(clip); action.play()
    const ys: number[] = []
    for (let t = 0; t <= clip.duration + 1e-6; t += 1 / 15) { mixer.setTime(t); ys.push(lowest()) }
    action.stop(); mixer.uncacheRoot(gltf.scene); body.skeleton.pose()
    ys.sort((a, b) => a - b)
    const med = ys[Math.floor(ys.length / 2)]
    rows.push(`${clip.name} ${(ys[0] / h * 100).toFixed(1)}/${(med / h * 100).toFixed(1)}`)
  }
  console.log(`${unit.padEnd(11)} rest ${(rest / h * 100).toFixed(1)}%  clips (lowest/median, % of height): ${rows.join('  ')}`)
}
