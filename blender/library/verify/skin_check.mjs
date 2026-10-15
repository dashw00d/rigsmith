#!/usr/bin/env node
// Skinning check for the mannequin: plays a converted clip on mannequin/ybot.glb in three.js
// and writes rest + skinned (CPU, SkinnedMesh.getVertexPosition) vertex positions so
// skin_compare.py can compare them with Blender's deformation of the original FBX.
//   node skin_check.mjs LIBDIR CLIP_ID TIME OUT.bin
import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const [lib, clipId, timeStr, out] = process.argv.slice(2)
const load = f => {
  const b = fs.readFileSync(f)
  return new Promise((resolve, reject) => new GLTFLoader().parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '', resolve, reject))
}
const ybot = await load(path.join(lib, 'mannequin', 'ybot.glb'))
const clip = (await load(path.join(lib, 'clips', `${clipId}.glb`))).animations[0]
const root = ybot.scene
const mixer = new THREE.AnimationMixer(root)
const action = mixer.clipAction(clip)
action.setLoop(THREE.LoopOnce); action.clampWhenFinished = true; action.play()
mixer.setTime(Number(timeStr))
root.updateMatrixWorld(true)
const meshes = []
root.traverse(o => { if (o.isSkinnedMesh) meshes.push(o) })
const chunks = []
let total = 0
const v = new THREE.Vector3()
for (const m of meshes) {
  m.skeleton.update()
  const n = m.geometry.attributes.position.count
  const arr = new Float32Array(n * 6)
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(m.geometry.attributes.position, i)
    arr[i * 6] = v.x; arr[i * 6 + 1] = v.y; arr[i * 6 + 2] = v.z
    m.getVertexPosition(i, v)
    v.applyMatrix4(m.matrixWorld)
    arr[i * 6 + 3] = v.x; arr[i * 6 + 4] = v.y; arr[i * 6 + 5] = v.z
  }
  chunks.push(Buffer.from(arr.buffer)); total += n
  console.log(`${m.name}: ${n} vertices, bones ${m.skeleton.bones.length}`)
}
fs.writeFileSync(out, Buffer.concat(chunks))
console.log(`wrote ${total} vertices (rest xyz, skinned xyz) to ${out}`)
