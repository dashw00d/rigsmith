#!/usr/bin/env node
// Fidelity + structure verification for the converted library (Node + three.js).
//
//   node blender/library/verify/verify_clips.mjs REF.json LIBDIR [--out report.json]
//
// 1. For every clip in REF.json (dumped by dump_reference.py from the ORIGINAL FBX in
//    Blender), loads LIBDIR/clips/<id>.glb with three's GLTFLoader, plays it with an
//    AnimationMixer and compares world joint positions at the reference frames (and rest).
// 2. Structural checks on ALL clip GLBs (single animation, Armature root identity,
//    65 canonical bones, Hips translation track has every frame).
// 3. Rest skeleton distribution over all clips (grouped bone-for-bone) and comparison with
//    the mannequin skeleton (LIBDIR/mannequin/ybot.glb), incl. bone-length differences.
import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const args = process.argv.slice(2)
const refPath = args[0]
const lib = args[1]
const outIdx = args.indexOf('--out')
const outPath = outIdx >= 0 ? args[outIdx + 1] : null
const TOL_MM = 1.0

function readGLBJson (file) {
  const b = fs.readFileSync(file)
  const jsonLen = b.readUInt32LE(12)
  return { json: JSON.parse(b.subarray(20, 20 + jsonLen).toString('utf8')), buf: b }
}

function loadGLB (file) {
  const b = fs.readFileSync(file)
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  return new Promise((resolve, reject) => new GLTFLoader().parse(ab, '', resolve, reject))
}

const CANON = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'HeadTop_End']
for (const s of ['Left', 'Right']) {
  CANON.push(`${s}Shoulder`, `${s}Arm`, `${s}ForeArm`, `${s}Hand`)
  for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) for (let i = 1; i <= 4; i++) CANON.push(`${s}Hand${f}${i}`)
}
for (const s of ['Left', 'Right']) CANON.push(`${s}UpLeg`, `${s}Leg`, `${s}Foot`, `${s}ToeBase`, `${s}Toe_End`)

// ---------------------------------------------------------------- 1. fidelity
async function fidelity (ref) {
  const rows = []
  const v = new THREE.Vector3()
  for (const [id, r] of Object.entries(ref)) {
    const gltf = await loadGLB(path.join(lib, 'clips', `${id}.glb`))
    const root = gltf.scene
    const bones = Object.fromEntries(CANON.map(n => [n, root.getObjectByName(n)]))
    const armature = root.getObjectByName('Armature')
    root.updateMatrixWorld(true)
    let restMax = 0
    for (const n of CANON) {
      bones[n].getWorldPosition(v)
      restMax = Math.max(restMax, v.distanceTo(new THREE.Vector3(...r.rest[n])))
    }
    const clip = gltf.animations[0]
    const mixer = new THREE.AnimationMixer(root)
    const action = mixer.clipAction(clip)
    action.setLoop(THREE.LoopOnce)
    action.clampWhenFinished = true
    action.play()
    let max = 0; let sum = 0; let cnt = 0; let worst = null
    for (const fr of r.frames) {
      mixer.setTime(fr.time)
      root.updateMatrixWorld(true)
      for (const n of CANON) {
        bones[n].getWorldPosition(v)
        const e = v.distanceTo(new THREE.Vector3(...fr.joints[n]))
        sum += e; cnt++
        if (e > max) { max = e; worst = `${n}@f${fr.frame}` }
      }
    }
    const s = armature.scale
    rows.push({
      id,
      name: clip.name,
      fps: r.fps,
      frames: r.frames.map(f => f.frame),
      duration: +clip.duration.toFixed(4),
      tracks: clip.tracks.length,
      armatureScale: [s.x, s.y, s.z],
      boneType: bones.Hips.type,
      restMaxMM: +(restMax * 1000).toFixed(4),
      maxMM: +(max * 1000).toFixed(4),
      meanMM: +(sum / cnt * 1000).toFixed(5),
      worst,
      pass: max * 1000 < TOL_MM && restMax * 1000 < TOL_MM && s.x === 1 && s.y === 1 && s.z === 1
    })
  }
  return rows
}

// ---------------------------------------------------------------- 2+3. structure + rest
function restKey (nodes) {
  return nodes.slice(1, 66).map(n => [...n.translation, ...n.rotation].map(x => x.toFixed(4)).join(',')).join(';')
}

function boneLengths (nodes) {
  const out = {}
  for (const n of nodes.slice(2, 66)) out[n.name] = Math.hypot(...n.translation)
  return out
}

function structure () {
  const dir = path.join(lib, 'clips')
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.glb'))
  const problems = []
  const groups = new Map()
  for (const f of files) {
    const { json } = readGLBJson(path.join(dir, f))
    const id = f.slice(0, -4)
    const nodes = json.nodes
    const a = json.animations || []
    const err = []
    if (a.length !== 1) err.push(`animations=${a.length}`)
    if (nodes[0].name !== 'Armature' || nodes[0].translation || nodes[0].rotation || nodes[0].scale || nodes[0].matrix) err.push('Armature root not identity')
    if (nodes.length !== 66 || nodes.slice(1).some((n, i) => n.name !== CANON[i])) err.push('bone set/order')
    if (json.meshes) err.push('has mesh')
    if (a.length === 1) {
      const ex = a[0].extras
      const hipsT = a[0].channels.find(c => c.target.node === 1 && c.target.path === 'translation')
      if (!hipsT) err.push('no Hips translation')
      else {
        const inp = json.accessors[a[0].samplers[hipsT.sampler].input]
        if (inp.count !== ex.frames) err.push(`hips keys ${inp.count} != frames ${ex.frames}`)
        if (Math.abs(inp.max[0] - (ex.frames - 1) / ex.fps) > 1e-4) err.push('time range')
      }
    }
    if (err.length) problems.push({ id, err })
    const key = restKey(nodes)
    if (!groups.has(key)) groups.set(key, { count: 0, ids: [], nodes })
    const g = groups.get(key); g.count++; if (g.ids.length < 5) g.ids.push(id)
  }
  return { files: files.length, problems, groups }
}

function compareRest (nodesA, nodesB) {
  // per-bone: translation diff (m), rotation diff (deg), bone length ratio
  let maxT = 0; let maxR = 0; let maxLenRel = 0; let worstLen = null; let worstRot = null
  for (let i = 1; i < 66; i++) {
    const a = nodesA[i]; const b = nodesB[i]
    const dt = Math.hypot(...a.translation.map((x, k) => x - b.translation[k]))
    const qa = new THREE.Quaternion(...a.rotation); const qb = new THREE.Quaternion(...b.rotation)
    const dr = THREE.MathUtils.radToDeg(qa.angleTo(qb))
    maxT = Math.max(maxT, dt)
    if (dr > maxR) { maxR = dr; worstRot = a.name }
    if (i > 1) {
      const la = Math.hypot(...a.translation); const lb = Math.hypot(...b.translation)
      const rel = Math.abs(la - lb) / Math.max(lb, 1e-6)
      if (rel > maxLenRel && lb > 0.01) { maxLenRel = rel; worstLen = `${a.name} ${(la * 100).toFixed(2)}cm vs ${(lb * 100).toFixed(2)}cm` }
    }
  }
  const ha = nodesA[1].translation[1]; const hb = nodesB[1].translation[1]
  return {
    hipsHeight: [+ha.toFixed(4), +hb.toFixed(4)],
    maxTranslationDiffMM: +(maxT * 1000).toFixed(3),
    maxRotationDiffDeg: +maxR.toFixed(3),
    worstRotationBone: worstRot,
    maxBoneLengthRelDiff: +maxLenRel.toFixed(4),
    worstBoneLength: worstLen
  }
}

async function main () {
  const report = {}
  if (refPath && refPath !== '-') {
    const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'))
    const rows = await fidelity(ref)
    report.fidelity = rows
    console.log('\n== Fidelity (world joint positions vs Blender on the original FBX) ==')
    for (const r of rows) {
      console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.id} ${String(r.name).slice(0, 24).padEnd(24)} fps=${r.fps} frames=${r.frames.length} ` +
        `max=${r.maxMM}mm mean=${r.meanMM}mm rest=${r.restMaxMM}mm worst=${r.worst} bone=${r.boneType}`)
    }
    const allMax = Math.max(...rows.map(r => r.maxMM))
    console.log(`overall max ${allMax} mm over ${rows.length} clips; ${rows.filter(r => !r.pass).length} failing (tol ${TOL_MM} mm)`)
  }
  const st = structure()
  console.log(`\n== Structure: ${st.files} clip GLBs, ${st.problems.length} with problems ==`)
  for (const p of st.problems.slice(0, 20)) console.log('  ', p.id, p.err.join('; '))
  report.structure = { files: st.files, problems: st.problems }

  const ybot = readGLBJson(path.join(lib, 'mannequin', 'ybot.glb')).json
  const g = [...st.groups.values()].sort((a, b) => b.count - a.count)
  console.log(`\n== Rest skeletons: ${g.length} distinct (rounded 1e-4) across ${st.files} clips ==`)
  report.restGroups = []
  for (const grp of g) {
    const cmp = compareRest(grp.nodes, ybot.nodes)
    const row = { count: grp.count, examples: grp.ids, vsYBot: cmp }
    report.restGroups.push(row)
    console.log(`  ${String(grp.count).padStart(5)} clips e.g. ${grp.ids.slice(0, 3).join(',')} vs ybot: hips ${cmp.hipsHeight[0]} vs ${cmp.hipsHeight[1]} m, ` +
      `max bone-offset diff ${cmp.maxTranslationDiffMM} mm, max rest-rot diff ${cmp.maxRotationDiffDeg} deg (${cmp.worstRotationBone}), ` +
      `max bone-length diff ${(cmp.maxBoneLengthRelDiff * 100).toFixed(1)}% (${cmp.worstBoneLength})`)
  }
  const ybotJoints = ybot.skins[0].joints.map(j => ybot.nodes[j].name)
  report.ybot = {
    jointsMatchCanon: ybotJoints.length === 65 && ybotJoints.every((n, i) => n === CANON[i]),
    meshes: ybot.meshes.map(m => m.name)
  }
  console.log(`\nybot.glb: ${ybotJoints.length} joints, canonical order: ${report.ybot.jointsMatchCanon}, meshes ${report.ybot.meshes}`)
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(report, null, 1))
  if (report.fidelity?.some(r => !r.pass) || st.problems.length > 0 || !report.ybot.jointsMatchCanon) process.exitCode = 1
}

main().catch(e => { console.error(e); process.exit(1) })
