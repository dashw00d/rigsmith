<script lang="ts">
  // The Skeleton step's marker board: the model drawn flat (front for a person, side for a four-legged body), a few
  // coloured markers on it (static/templates/markers.json), the skeleton they give drawn live as you drag
  // (src/engine/markers.ts). A marker's depth comes from the mesh: the middle of the body where it sits (a pair on
  // a side view: the near leg, mirrored onto the far one). Finger tips go on a view of each hand of their own (its
  // back, along the fingers, cut to the hand). Letting go saves the markers and the joints they give, as the user's
  // placements (only the joints that differ from the detected ones become overrides).
  import { onDestroy, onMount, untrack } from 'svelte'
  import * as THREE from 'three'
  import { X } from '@lucide/svelte'
  import type { Character } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { skeleton, type BoardView } from '../../state/skeleton.svelte.ts'
  import type { CharacterView } from '../../engine/CharacterView.ts'
  import { light, place as placeLights, tone, type LightRig } from '../../engine/lighting.ts'
  import { fitMarkers, insideDepth, jointOf, jointsFrom, keysOf, markerRay, placeMarker, type MarkerDef, type Markers, type MarkerSet, type SolveCache, type V3 } from '../../engine/markers.ts'
  import { jointsOf } from '../../model/select.ts'

  let { character, view, set, setName, parents }: { character: Character, view: CharacterView, set: MarkerSet, setName: string, parents: Record<string, string | null> } = $props()

  let host: HTMLDivElement
  let canvas: HTMLCanvasElement
  let width = $state(0)
  let height = $state(0)
  let renderer: THREE.WebGLRenderer | null = null
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 100)
  const ray = new THREE.Raycaster()
  const meshes: THREE.Mesh[] = []
  const box = new THREE.Box3()
  let xCenter = 0
  // (plain values, replaced whole: the solver reads them many times a frame)
  let markers = $state.raw<Markers | null>(null)
  let joints = $state.raw<Record<string, V3>>({})
  // the drag: the last pointer move waiting for the next frame (the solver's work kept for the next solve)
  const live: SolveCache = {}
  let pendingMove: { x: number, y: number } | null = null
  let frameRequest = 0
  let dragging: string | null = null
  let frame = $state(0)   // (bumped when the camera changes: the overlay re-projects)
  // the viewport's light rig (src/engine/lighting.ts), turned with each view
  let lights: LightRig | null = null

  /** The character's skeleton as it is now: detected, with its placements on top. */
  const placed = $derived(jointsOf(character))
  const keys = $derived(keysOf(set))
  const hasHands = $derived(set.markers.some(d => d.view === 'hand') && keys.some(k => k.def.view === 'hand' && placed[`${k.side === 'right' ? 'Right' : 'Left'}HandIndex1`] !== undefined))
  // the markers this view shows: the body's, or one hand's finger tips
  const shown = $derived(keys.filter(k => skeleton.boardView === 'body' ? k.def.view !== 'hand' : k.def.view === 'hand' && k.side === skeleton.boardView))
  const handPrefix = $derived(skeleton.boardView === 'right' ? 'Right' : 'Left')

  const busy = (text: string | null): void => { app.setBusy('markers', text) }

  function build (): void {
    const toLocal = new THREE.Matrix4().copy(view.root.matrixWorld).invert()
    const clay = new THREE.MeshStandardMaterial({ color: 0xd8d8dd, roughness: 0.92, metalness: 0, side: THREE.DoubleSide })
    view.root.updateMatrixWorld(true)
    for (const m of view.meshes) {
      // (at rest: a skinned body's bind shape, else the mesh as it lies)
      const g = m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(toLocal, m.matrixWorld))
      const mesh = new THREE.Mesh(g, clay)
      scene.add(mesh)
      meshes.push(mesh)
      g.computeBoundingBox()
      box.union(g.boundingBox!)
    }
    xCenter = 0.5 * (box.min.x + box.max.x)
    lights = light(scene, renderer ?? undefined)
  }

  /** The light rig turned to a view from `toward` with `up` up: its key and rim at the angles they have to a body seen
   * from the front in the viewport, so each view (the side, the back of a hand) is lit the same way. */
  function aimLights (toward: THREE.Vector3, up: THREE.Vector3, size: number): void {
    if (lights === null) return
    placeLights(lights, size)
    // (directional lights: only their direction from the target, the origin, counts)
    const y = up.clone().normalize()
    const x = new THREE.Vector3().crossVectors(y, toward).normalize()
    const z = new THREE.Vector3().crossVectors(x, y)
    const turn = new THREE.Matrix4().makeBasis(x, y, z)
    lights.key.position.applyMatrix4(turn)
    lights.rim.position.applyMatrix4(turn)
  }

  /** The direction the surface near `center` is thinnest in, square to `up` (a hand's palm normal), or null. */
  function flattest (center: THREE.Vector3, radius: number, up: THREE.Vector3): THREE.Vector3 | null {
    // two directions square to up, and the surface's spread in that plane
    const a = new THREE.Vector3(1, 0, 0); if (Math.abs(a.dot(up)) > 0.9) a.set(0, 0, 1)
    a.addScaledVector(up, -a.dot(up)).normalize()
    const b = new THREE.Vector3().crossVectors(up, a)
    let n = 0; let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0
    const p = new THREE.Vector3()
    for (const mesh of meshes) {
      const pos = mesh.geometry.attributes.position
      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i)
        if (p.distanceToSquared(center) > radius * radius) continue
        p.sub(center)
        const x = p.dot(a); const y = p.dot(b)
        n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y
      }
    }
    if (n < 12) return null
    const cxx = sxx / n - (sx / n) ** 2; const cyy = syy / n - (sy / n) ** 2; const cxy = sxy / n - (sx / n) * (sy / n)
    // the smaller principal direction of [[cxx, cxy], [cxy, cyy]]
    const half = (cxx - cyy) / 2; const r = Math.hypot(half, cxy)
    const small = (cxx + cyy) / 2 - r; const big = (cxx + cyy) / 2 + r
    if (big < 1e-12 || small / big > 0.8) return null   // (round in section: no flat side to go by)
    const angle = Math.atan2(small - cxx, cxy)
    const dir = Math.abs(cxy) < 1e-15 ? (cxx < cyy ? a.clone() : b.clone()) : a.clone().multiplyScalar(Math.cos(angle)).addScaledVector(b, Math.sin(angle))
    return dir.normalize()
  }

  /** A hand's view: from the back of the hand (away from the body), the fingers up, cut to a slab around the hand. */
  function handView (prefix: string): { center: THREE.Vector3, normal: THREE.Vector3, up: THREE.Vector3, size: number } | null {
    const J = Object.keys(joints).length > 0 ? joints : placed
    const at = (n: string): THREE.Vector3 | null => J[`${prefix}${n}`] !== undefined ? new THREE.Vector3(...J[`${prefix}${n}`]) : null
    const wrist = at('Hand'); const tip = at('HandMiddle4') ?? at('HandIndex4')
    if (wrist === null || tip === null) return null
    const up = tip.clone().sub(wrist)
    const length = up.length()
    up.normalize()
    const a = at('HandIndex1'); const b = at('HandPinky1') ?? at('HandThumb1')
    const across = a !== null && b !== null ? a.clone().sub(b) : new THREE.Vector3(1, 0, 0)
    across.addScaledVector(up, -across.dot(up))
    if (across.lengthSq() < 1e-10) {
      across.set(Math.abs(up.x) < 0.8 ? 1 : 0, Math.abs(up.x) < 0.8 ? 0 : 1, 0)
      across.addScaledVector(up, -across.dot(up))
    }
    across.normalize()
    // (which way the palm faces from the hand's own surface where it can be measured: the joints only say so when
    // they're right, and a hand seen edge on can't have its fingertips placed)
    const flat = flattest(wrist.clone().lerp(tip, 0.5), length * 0.55, up)
    if (flat !== null) across.copy(flat).cross(up).normalize()
    const normal = new THREE.Vector3().crossVectors(across, up).normalize()
    // (looking at its back: from out beside the body)
    const out = wrist.clone().sub(box.getCenter(new THREE.Vector3())); out.y = 0
    if (normal.dot(out) < 0) normal.negate()
    return { center: wrist.clone().lerp(tip, 0.5), normal, up, size: length }
  }

  function place (): void {
    if (width === 0 || height === 0) return
    const aspect = width / height
    const hand = skeleton.boardView === 'body' ? null : handView(handPrefix)
    if (hand !== null) {
      const half = Math.max(hand.size * 0.68, hand.size * 0.68 / aspect)
      camera.left = -half * aspect; camera.right = half * aspect; camera.top = half; camera.bottom = -half
      const d = hand.size * 3
      camera.position.copy(hand.center).addScaledVector(hand.normal, d)
      camera.up.copy(hand.up)
      // (a slab around the hand: the leg beside it neither shows nor takes the rays)
      camera.near = d - hand.size * 0.4; camera.far = d + hand.size * 0.4
      camera.lookAt(hand.center)
      aimLights(hand.normal, hand.up, hand.size)
    } else {
      placeBody(aspect)
    }
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
    renderer?.setSize(width, height, false)
    renderer?.render(scene, camera)
    frame++
  }

  function placeBody (aspect: number): void {
    const c = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const across = set.view === 'front' ? size.x : size.z
    const half = Math.max(size.y / 2, across / 2 / aspect) * 1.12
    camera.left = -half * aspect; camera.right = half * aspect; camera.top = half; camera.bottom = -half
    const far = size.length() * 2 + 1
    if (set.view === 'front') camera.position.set(c.x, c.y, box.max.z + far)
    else camera.position.set(box.max.x + far, c.y, c.z)
    camera.near = 0.001; camera.far = far * 3
    camera.up.set(0, 1, 0)
    camera.lookAt(c.x, c.y, c.z)
    aimLights(set.view === 'front' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), size.y)
  }

  const toScreen = (p: V3): { x: number, y: number } => {
    void frame
    const v = new THREE.Vector3(...p).project(camera)
    return { x: (v.x + 1) / 2 * width, y: (1 - v.y) / 2 * height }
  }

  /** The point in the body under a screen point, for a marker: its depth from the mesh (or `keep`'s). */
  function toBody (x: number, y: number, def: MarkerDef, keep: V3 | undefined): V3 {
    const ndc = new THREE.Vector2(x / width * 2 - 1, 1 - y / height * 2)
    markerRay(ray, camera, ndc)
    const hits = ray.intersectObjects(meshes, false).map(h => h.distance)
    ray.near = 0; ray.far = Infinity
    const along = insideDepth(hits)
    const origin = ray.ray.origin; const dir = ray.ray.direction
    const on = along !== null ? origin.clone().addScaledVector(dir, along) : null
    let p: V3
    if (skeleton.boardView !== 'body') {
      // a finger tip: in the middle of the finger under it, else as deep as it was
      const q = on ?? origin.clone().addScaledVector(dir, keep !== undefined ? new THREE.Vector3(...keep).sub(origin).dot(dir) : (camera.far - camera.near) / 2)
      p = [q.x, q.y, q.z]
    } else if (set.view === 'front') {
      const flat = origin.clone()
      p = [flat.x, flat.y, def.depth === 'keep' ? keep?.[2] ?? on?.z ?? 0 : on?.z ?? keep?.[2] ?? 0]
      if (def.mid) p[0] = xCenter
    } else {
      // a pair on the side view takes its depth from the mesh where the ray crosses a limb (a leg below the body),
      // else (through the chest, the shoulder) it keeps its own way out from the middle
      const limb = hits.length >= 2 && hits[1] - hits[0] < 0.45 * (box.max.x - box.min.x)
      p = [limb && on !== null ? on.x : keep?.[0] ?? xCenter, origin.y, origin.z]
      if (def.mid) p[0] = xCenter
      // (a pair goes on the near side, its left: a far leg hit where the near one isn't counts mirrored)
      else if (p[0] < xCenter) p[0] = 2 * xCenter - p[0]
    }
    return p.map(v => Math.round(v * 1e5) / 1e5) as V3
  }

  /** The groin (a marker of its own) under the body: straight up from the ground between the legs. */
  function seedOwn (def: MarkerDef): V3 | null {
    if (def.id !== 'groin') return null
    const hips = placed.Hips
    if (hips === undefined) return null
    ray.set(new THREE.Vector3(xCenter, box.min.y - 0.01, hips[2]), new THREE.Vector3(0, 1, 0))
    const hit = ray.intersectObjects(meshes, false)[0]
    return hit !== undefined && hit.point.y < hips[1] ? [xCenter, hit.point.y, hips[2]] : null
  }

  function solveNow (rounds = 16): void {
    if (markers === null) return
    joints = jointsFrom(set, markers, parents, xCenter, rounds, live)
  }

  /** While dragging: the screen point in the view's plane at the marker's own depth (its depth from the mesh comes on
   * letting go: toBody). */
  function inPlane (x: number, y: number, def: MarkerDef, keep: V3 | undefined): V3 {
    ray.setFromCamera(new THREE.Vector2(x / width * 2 - 1, 1 - y / height * 2), camera)
    const o = ray.ray.origin; const d = ray.ray.direction
    if (skeleton.boardView !== 'body') {
      const q = o.clone().addScaledVector(d, keep !== undefined ? new THREE.Vector3(...keep).sub(o).dot(d) : (camera.far - camera.near) / 2)
      return [q.x, q.y, q.z]
    }
    if (set.view === 'front') return [def.mid ? xCenter : o.x, o.y, keep?.[2] ?? 0]
    return [def.mid ? xCenter : keep?.[0] ?? xCenter, o.y, o.z]
  }

  /** A marker moved (and, on a front view, its pair's other side mirrored). */
  function moveMarker (key: string, p: V3): void {
    if (markers === null) return
    markers = placeMarker(set, markers, key, p, xCenter, skeleton.mirror)
  }

  /** The joints the markers were last fitted to (or solved into): the skeleton changing under the board (a finger
   * level, an undo, the 3D joints) fits them again. */
  let fittedTo: Record<string, V3> | null = null
  const sameJoints = (a: Record<string, V3>, b: Record<string, V3>): boolean => {
    const ka = Object.keys(a)
    if (ka.length !== Object.keys(b).length) return false
    // (within what the placements keep: a joint put back within 1e-6 of where it was detected reads as detected)
    return ka.every(k => b[k] !== undefined && a[k].every((v, i) => Math.abs(v - b[k][i]) < 1e-5))
  }
  $effect(() => {
    const now = placed
    untrack(() => {
      if (markers === null || fittedTo === null || dragging !== null || Object.keys(now).length === 0 || sameJoints(now, fittedTo)) return
      markers = fitMarkers(setName, set, $state.snapshot(markers) as Markers, now, parents, seedOwn)
      fittedTo = now
      live.key = undefined
      solveNow()
    })
  })

  let ro: ResizeObserver | null = null
  onMount(async () => {
    // (the busy pill shows before the board is built: building it takes a moment on a big mesh)
    busy('Placing markers')
    await new Promise(r => setTimeout(r, 30))
    try {
      setUp()
    } catch (error) {
      app.toast('error', `The markers didn't open: ${(error as Error).message}`)
      skeleton.closeBoard()
    } finally {
      busy(null)
    }
  })

  function setUp (): void {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    tone(renderer)
    build()
    const saved = character.skeleton.markers
    const base = untrack(() => placed)
    // the character's own markers fitted to its skeleton as it is now (a finger level since changed: its new tips start
    // on their joints), else seeded from its joints
    // (a plain copy: the character's own is the app's state, shared with every other reader)
    if (Object.keys(base).length > 0) markers = fitMarkers(setName, set, saved === undefined ? undefined : structuredClone($state.snapshot(saved)) as Markers, base, parents, seedOwn)
    fittedTo = Object.keys(base).length === 0 ? null : base
    // (a marker that keeps its joint's depth sits as deep as that joint: markers placed before it kept it move back)
    if (markers !== null) {
      const m = markers
      for (const k of keysOf(set)) {
        const j = jointOf(k.def, k.side)
        const at = m.positions[k.key]
        if (k.def.depth === 'keep' && j !== null && at !== undefined && base[j] !== undefined) at[2] = base[j][2]
      }
    }
    const fit = (): void => { width = host.clientWidth; height = host.clientHeight; place() }
    ro = new ResizeObserver(fit)
    ro.observe(host)
    fit()
    solveNow()
  }
  onDestroy(() => {
    ro?.disconnect()
    if (frameRequest !== 0) cancelAnimationFrame(frameRequest)
    busy(null)
    // (the room reflections were made for this board's renderer alone)
    scene.environment?.dispose()
    renderer?.dispose()
    for (const m of meshes) m.geometry.dispose()
  })

  /** A marker's name as the tooltip gives it: what it marks, and which side ("Elbow · right (A)", "Front knee"). */
  function nameOf (k: { def: MarkerDef, side: 'left' | 'right' | null }): string {
    const what = k.def.letter === 'F' ? `Front ${k.def.label.toLowerCase()}` : k.def.letter === 'H' ? `Hind ${k.def.label.toLowerCase()}` : k.def.label.replace(/s$/, '')
    if (!k.def.pair) return what
    if (set.view === 'front') return `${what} · ${k.side === 'right' ? 'right (A)' : 'left (B)'}`
    return `${what} · near ${k.def.letter !== undefined ? 'leg' : 'side'} (the far one mirrored)`
  }
  let dragKey = $state<string | null>(null)

  function down (e: PointerEvent, key: string): void {
    dragging = key
    dragKey = key
    skeleton.marker = key.replace(/_[lr]$/, '')
    try { (e.target as Element).setPointerCapture(e.pointerId) } catch { /* (a pointer that can't be captured still drags over the board) */ }
    e.preventDefault()
  }

  // (a pointer move only asks for the next frame: however fast the mouse, one update a frame)
  function move (e: PointerEvent): void {
    if (dragging === null) return
    const r = host.getBoundingClientRect()
    pendingMove = { x: e.clientX - r.left, y: e.clientY - r.top }
    if (frameRequest === 0) frameRequest = requestAnimationFrame(dragFrame)
  }
  function dragFrame (): void {
    frameRequest = 0
    const at = pendingMove; pendingMove = null
    if (at === null || dragging === null || markers === null) return
    const k = keys.find(x => x.key === dragging)
    if (k === undefined) return
    // (only the dot moves while it is dragged: the skeleton follows when it is let go)
    moveMarker(k.key, inPlane(at.x, at.y, k.def, markers.positions[k.key]))
  }
  async function up (e: PointerEvent): Promise<void> {
    if (dragging === null || markers === null) return
    const k = keys.find(x => x.key === dragging)
    dragging = null
    dragKey = null
    if (frameRequest !== 0) { cancelAnimationFrame(frameRequest); frameRequest = 0 }
    pendingMove = null
    busy('Fitting the skeleton')
    // (the busy pill shows before the work starts)
    await new Promise(r => setTimeout(r, 0))
    try {
      if (k !== undefined) {
        // where it was let go, its depth now from the mesh
        const r = host.getBoundingClientRect()
        moveMarker(k.key, toBody(e.clientX - r.left, e.clientY - r.top, k.def, markers.positions[k.key]))
      }
      solveNow()
      fittedTo = joints
      await skeleton.place(character, $state.snapshot(joints) as Record<string, V3>, $state.snapshot(markers) as Markers)
    } catch (error) {
      app.toast('error', `The markers didn't save: ${(error as Error).message}`)
    } finally {
      busy(null)
    }
  }

  // the skeleton as lines: each bone from its parent (on a hand's view, that hand's alone)
  // (not a creature's root: it sits on the ground under the body, holding it, not a bone of it)
  const inView = (name: string): boolean => skeleton.boardView === 'body' || name.startsWith(`${handPrefix}Hand`)
  const bones = $derived(Object.entries(parents).flatMap(([c, p]) => p !== null && p !== 'root' && inView(c) && joints[c] !== undefined && joints[p] !== undefined ? [[joints[p], joints[c]] as [V3, V3]] : []))
  // (on a change of view only: place() bumps `frame`, which it also reads, so it runs untracked; in the effect itself
  // it set itself off again, a thousand times over, freezing the board)
  $effect(() => { void skeleton.boardView; untrack(place) })
  const near = (p: V3): boolean => set.view === 'front' || p[0] >= xCenter - 1e-4
  const TABS: Array<[BoardView, string]> = [['body', 'Body'], ['right', 'Right hand (A)'], ['left', 'Left hand (B)']]
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' && dragKey === null) skeleton.closeBoard() }} />
<div class="board" class:dragging={dragKey !== null} bind:this={host} onpointermove={move} onpointerup={up} role="application" aria-label="Skeleton markers">
  <canvas bind:this={canvas}></canvas>
  <svg {width} {height}>
    {#each bones as [a, b]}
      {@const pa = toScreen(a)}{@const pb = toScreen(b)}
      <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} class:far={!near(a) || !near(b)} />
    {/each}
    {#each Object.entries(joints).filter(([k]) => k !== 'root' && inView(k)).map(([, j]) => j) as j}
      {@const p = toScreen(j)}
      <circle cx={p.x} cy={p.y} r="2.5" class="joint" class:far={!near(j)} />
    {/each}
    {#if markers !== null}
      {#each shown as k (k.key)}
        {@const at = markers.positions[k.key]}
        {#if at !== undefined}
          {@const p = toScreen(at)}
          <g class="marker" class:on={skeleton.marker === k.def.id} class:held={dragKey === k.key} transform="translate({p.x},{p.y})" onpointerdown={(e) => down(e, k.key)} role="button" tabindex="-1" aria-label={nameOf(k)}>
            <circle r="13" class="halo" style="stroke: {k.def.color}" />
            <circle r="9" style="fill: {k.def.color}" class="dot" />
            {#if k.def.letter ?? (k.def.pair && set.view === 'front')}
              <text dy="4">{k.def.letter ?? (k.side === 'right' ? 'A' : 'B')}</text>
            {/if}
            <!-- (its name, shown by the browser on hover: no code runs as the pointer moves) -->
            <foreignObject class="tipbox" x="-170" y="-110" width="340" height="88"><div class="tipwrap"><div class="tip"><span class="tipname"><span class="tipdot" style="background: {k.def.color}"></span>{nameOf(k)}</span>{#if k.def.hint}<span class="tiphint">{k.def.hint}</span>{/if}</div></div></foreignObject>
          </g>
        {/if}
      {/each}
    {/if}
  </svg>
  {#if hasHands}
    <div class="tabs">
      {#each TABS as [v, label]}
        <button class:on={skeleton.boardView === v} onclick={() => { skeleton.boardView = v }}>{label}</button>
      {/each}
    </div>
  {/if}
  <div class="hint">{skeleton.boardView === 'body' ? `Drag each marker onto its joint${set.view === 'side' ? ' (the near legs: the far ones follow)' : ''}.` : `Drag each letter onto the very end of its finger${skeleton.mirror ? ' (the other hand follows, mirrored)' : ''}.`} The skeleton follows; letting go saves it. Esc closes.</div>
  <button class="close" onclick={() => { skeleton.closeBoard() }} aria-label="Close markers"><X size={16} /></button>
</div>

<style>
  .board { position: absolute; inset: 0; z-index: 5; background: #1d1f24; touch-action: none; }
  canvas, svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  line { stroke: rgb(142 162 255 / 85%); stroke-width: 2; }
  line.far { stroke: rgb(142 162 255 / 30%); stroke-dasharray: 3 3; }
  .joint { fill: #8ea2ff; }
  .joint.far { fill: rgb(142 162 255 / 35%); }
  /* (a pointing hand over a marker, the grabbing one while it is dragged) */
  .marker { cursor: pointer; }
  .board.dragging, .board.dragging .marker { cursor: grabbing; }
  .tipbox { visibility: hidden; pointer-events: none; overflow: visible; }
  .marker:hover .tipbox, .marker.held .tipbox { visibility: visible; }
  .marker .halo { fill: rgb(0 0 0 / 25%); stroke-width: 2; opacity: 0.9; }
  .marker .dot { stroke: rgb(0 0 0 / 45%); stroke-width: 1; }
  .marker.on .halo { stroke-width: 3.5; }
  .tipwrap { display: flex; flex-direction: column; justify-content: flex-end; height: 100%; }
  .tip { display: flex; flex-direction: column; align-items: center; width: fit-content; max-width: 320px; margin: 0 auto; gap: 2px; padding: 4px 8px; border-radius: 6px; background: rgb(12 14 18 / 92%); border: 1px solid var(--line-strong); color: var(--text-1); font-size: 12px; text-align: center; }
  .tipname { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
  .tiphint { color: var(--text-2, #aab); font-size: 11px; line-height: 1.3; }
  .tipdot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .marker text { font-size: 11px; font-weight: 700; text-anchor: middle; fill: #111; pointer-events: none; }
  .hint { position: absolute; left: 14px; bottom: 12px; font-size: 12px; color: var(--text-3); pointer-events: none; }
  .tabs { position: absolute; top: 10px; left: 10px; display: flex; gap: 4px; }
  .tabs button { height: 28px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--line-strong); background: var(--bg-2); color: var(--text-2); font-size: 12px; }
  .tabs button.on { border-color: var(--accent); color: var(--accent-strong); }
  .close { position: absolute; top: 10px; right: 10px; width: 30px; height: 30px; border-radius: 6px; border: 1px solid var(--line-strong); background: var(--bg-2); color: var(--text-2); display: grid; place-items: center; }
</style>
