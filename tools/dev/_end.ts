import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
const g = globalThis as Record<string, unknown>
g.self ??= globalThis
const [file, bone] = process.argv.slice(2)
const buf = readFileSync(file)
new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', (gltf) => {
  const d = gltf.animations.find(a => a.name === 'Die')!
  const mixer = new THREE.AnimationMixer(gltf.scene)
  const a = mixer.clipAction(d); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.play()
  const b = gltf.scene.getObjectByName(bone)!
  const out: string[] = []
  for (const f of [0, 0.5, 0.9, 0.97, 1.0]) { mixer.setTime(d.duration * f); gltf.scene.updateMatrixWorld(true); out.push(`${f}:${new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).y.toFixed(2)}`) }
  console.log(file.split('/').pop(), bone, 'Die', d.duration.toFixed(2), 's  y at', out.join('  '))
})
