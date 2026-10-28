// How a built unit's feet meet the ground in each clip: per frame, the lowest point of its body (skinned), over the clip
// its lowest (the planted sole should touch 0) and its median (a stance: near 0 standing, a walk's planted foot near 0).
// node tools/dev/ground.ts <unit.glb> [...]   (heights in the file's units and as a share of the unit's height)
import * as THREE from 'three'
import { loadGlbFile } from '../../src/engine/headless.ts'

for (const file of process.argv.slice(2)) {
  const gltf = await loadGlbFile(file)
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
