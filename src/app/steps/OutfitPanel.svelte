<script lang="ts">
  import { Crosshair, Eye, EyeOff, Play, Plus, Move3d, Rotate3d, Scale3d, RotateCcw, Shirt, Trash2, Sword } from '@lucide/svelte'
  import { fileUrl, type Character, type Garment } from '../../state/api.ts'
  import type { PullSocket } from '../../engine/pulls.ts'
  import WeightPaintPanel from '../rig/WeightPaintPanel.svelte'
  import HandPoseSelect from '../rig/HandPoseSelect.svelte'
  import { outfit, type GizmoMode } from '../../state/outfit.svelte.ts'
  import { SOCKETS, type Socket } from '../../engine/props.ts'
  import { garmentAnimations, POLICIES } from '../../engine/garments.ts'
  import { CircleAlert, LoaderCircle, Upload } from '@lucide/svelte'
  import Toggle from '../../ui/Toggle.svelte'
  import { app } from '../../state/app.svelte.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { LOWER_BODY } from '../../engine/mount.ts'
  import Button from '../../ui/Button.svelte'
  import Section from '../../ui/Section.svelte'
  import Segmented from '../../ui/Segmented.svelte'

  let { character }: { character: Character } = $props()

  const attached = $derived(outfit.props)
  const garments = $derived(outfit.garments)
  const fitting = $derived(garments.find(g => g.id === outfit.fitting) ?? null)
  // (the piece whose settings are open: being placed, or picked last)
  const current = $derived(garments.find(g => g.id === (outfit.fitting ?? outfit.focus)) ?? null)
  type Kind = 'prop' | 'clothing' | 'part'
  const KINDS: Array<{ id: Kind, label: string, short: string, hint: string }> = [
    { id: 'prop', label: 'Props', short: 'Prop', hint: 'Rides one bone, socket based: a weapon in a hand, a quiver on the back. Hands can grip it in the animation editor.' },
    { id: 'clothing', label: 'Clothes', short: 'Clothing', hint: 'Skinned to the body: each vertex moves like the skin under it, from the bones its policy allows. Paint its weights below.' },
    { id: 'part', label: 'Parts', short: 'Part', hint: 'Pinned to one spot on the body: the whole piece moves as that skin does, without bending (a buckle, a pouch). A mechanism plays its own animation.' },
  ]
  const kindOf = (g: Garment): Kind => (g.mode === 'rigid' ? 'prop' : g.mode === 'part' ? 'part' : 'clothing')
  function setKind (g: Garment, k: Kind): void {
    void outfit.patchGarment(g.id, { mode: k === 'prop' ? 'rigid' : k === 'part' ? 'part' : 'clothing' })
  }
  function detail (g: Garment): string {
    if (g.mode === 'rigid') return `on ${g.bone}`
    if (g.mode === 'part') return g.animation ? `pinned · plays ${g.animation}` : 'pinned to the body'
    return `${POLICIES.find(p => p.id === g.policy)?.label ?? ''}${g.painted ? ' · painted' : ''}`
  }
  /** Open a piece: a prop or a piece being placed shows the gizmo; clothing and parts open bound (to paint, to pin). */
  function open (g: Garment): void {
    // (picking a piece opens its settings; placing it with the gizmo is its own button)
    if (outfit.focus === g.id && outfit.fitting === null) { outfit.focus = null; return }
    outfit.fit(null)
    outfit.focus = g.id
  }
  /** Play a clip of the character (to see a pull drawn in it). */
  function playClip (index: number): void {
    const entry = character.animations[index]
    if (entry !== undefined) animator.playEntry(entry, index)
  }
  // pulls: the bones that can draw one (the hands first), hold windows as text ("0.12-0.45, 0.7-0.9")
  const pullBones = $derived(['RightHand', 'LeftHand', ...(animator.character?.rest?.order.filter(b => animator.character!.bones.has(b) && b !== 'RightHand' && b !== 'LeftHand') ?? [])])
  const holdText = (h: Array<[number, number]> | undefined): string => (h ?? []).map(([a, b]) => `${a}-${b}`).join(', ')
  function setHolds (p: PullSocket, clip: string, text: string): void {
    const windows = text.split(',').map(w => w.split(/[-–]/).map(Number)).filter(w => w.length === 2 && w.every(Number.isFinite))
      .map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.min(1, Math.max(a, b))] as [number, number])
    const holds = { ...(p.holds ?? {}) }
    if (windows.length > 0) holds[clip] = windows; else delete holds[clip]
    if (current !== null) void outfit.patchPull(current.id, p.id, { holds })
  }
  let finding = $state<string | null>(null)
  async function find (p: PullSocket, entry: number): Promise<void> {
    if (current === null) return
    finding = `${p.id}:${entry}`
    try {
      const found = await outfit.findHolds(current.id, p.id, entry)
      if (found.length === 0) app.toast('info', `${p.bone} never reaches ${p.name}'s point in ${character.animations[entry].name}`)
    } finally { finding = null }
  }
  function setPullBone (p: PullSocket, bone: string): void {
    // (its grip: where that bone holds, the socket's, if it has one; else the bone itself)
    void outfit.patchPull(current!.id, p.id, { bone, grip: outfit.gripOf(bone) })
  }
  const isHand = (bone: string): boolean => bone === 'LeftHand' || bone === 'RightHand'
  let adding = $state<Kind>('clothing')
  function add (k: Kind): void { adding = k; upload?.click() }
  // a part's own animations (a mechanism's), from its model
  let clips = $state<string[]>([])
  $effect(() => {
    const g = current
    clips = []
    if (g === null || g.mode !== 'part' || g.file === undefined) return
    const url = fileUrl(character, g.file)
    if (url !== null) void garmentAnimations(url).then(list => { if (current?.id === g.id) clips = list }, () => {})
  })
  let upload = $state<HTMLInputElement>()
  const bones = $derived(['Head', 'Neck', 'Spine2', 'Spine1', 'Spine', 'Hips', 'LeftHand', 'RightHand', 'LeftForeArm', 'RightForeArm', 'LeftArm', 'RightArm', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot'])

  function garmentNumber (index: number, key: 'position' | 'rotation', value: string): void {
    if (fitting === null) return
    const v = Number(value)
    if (!Number.isFinite(v)) return
    const next = [...fitting[key]] as [number, number, number]
    next[index] = v
    void outfit.patchGarment(fitting.id, { [key]: next })
  }
  const selected = $derived(attached.find(p => p.id === outfit.selected) ?? null)
  let mode = $state<GizmoMode>(outfit.mode)
  const modes: Array<{ value: GizmoMode, label: string, icon: typeof Move3d }> = [
    { value: 'translate', label: 'Move', icon: Move3d },
    { value: 'rotate', label: 'Rotate', icon: Rotate3d },
    { value: 'scale', label: 'Scale', icon: Scale3d },
  ]

  // The pose the gear is fitted in: rest, rest with the fists closed (the Hold fist scripts), or any clip of the set
  // (with its scripts, as the game plays it), paused at any frame from the timeline.
  const pose = $derived(animator.current === null ? 'rest' : animator.current.clipId === 'fists' ? 'fists'
    : animator.current.entry !== null ? String(animator.current.entry) : 'rest')
  // Riding: the horses there are (rigged creatures), the one ridden, its bones (the seat's), his held bones.
  const horses = $derived(app.characters.filter(c => c.id !== character.id && c.status === 'rigged' && (c.template ?? 'human') !== 'human'))
  const mount = $derived(character.mount)
  const horseBones = $derived(animator.horse?.rest?.order.filter(b => animator.horse!.bones.has(b)) ?? [])
  const riderBones = $derived(animator.character?.rest?.order.filter(b => animator.character!.bones.has(b)) ?? [])
  function toggleHeld (bone: string, on: boolean): void {
    if (mount === undefined) return
    const freeze = on ? [...new Set([...mount.freeze, bone])] : mount.freeze.filter(b => b !== bone)
    void outfit.patchMount({ freeze })
  }

  function setPose (value: string): void {
    if (value === 'rest') animator.stop()
    else if (value === 'fists') void animator.playFists()
    else {
      const i = Number(value)
      const entry = character.animations[i]
      if (entry !== undefined) animator.playEntry(entry, i)
    }
  }

  function number (index: number, key: 'position' | 'rotation', value: string): void {
    if (selected === null) return
    const v = Number(value)
    if (!Number.isFinite(v)) return
    const next = [...selected[key]] as [number, number, number]
    next[index] = v
    void outfit.patch(selected.id, { [key]: next })
  }
</script>

{#if character.status !== 'rigged'}
  <Section><p class="muted">Rig {character.name} first. Props and accessories attach to its bones.</p></Section>
{:else}
  <Section title="Pose">
    <select class="pose" value={pose} onchange={(e) => setPose((e.target as HTMLSelectElement).value)} aria-label="Pose">
      <option value="rest">Rest</option>
      <option value="fists">Rest, fists closed</option>
      {#each character.animations as a, i}<option value={String(i)}>{a.name}</option>{/each}
    </select>
    <p class="faint small">Fit gear on a clip as the game plays it (its scripts too: a held fist stays closed). Pause on any frame
      (Space, or the timeline; , and . step a frame) and drag the gizmo there.</p>
  </Section>

  <Section title="Mount">
    <div class="field">
      <span>Rides</span>
      <select value={mount?.character ?? ''} onchange={(e) => outfit.setMount((e.target as HTMLSelectElement).value || null)} aria-label="Horse">
        <option value="">Nothing (on foot)</option>
        {#each horses as h}<option value={h.id}>{h.name}</option>{/each}
      </select>
    </div>
    {#if mount !== undefined}
      <div class="field">
        <span>Sits on</span>
        <select value={mount.bone} onchange={(e) => outfit.patchMount({ bone: (e.target as HTMLSelectElement).value })} aria-label="Horse bone">
          {#each horseBones.includes(mount.bone) ? horseBones : [mount.bone, ...horseBones] as b}<option value={b}>{b}</option>{/each}
        </select>
      </div>
      <div class="row-buttons">
        <button class:on={outfit.mountTarget === 'seat'} onclick={() => outfit.aim(outfit.mountTarget === 'seat' ? null : 'seat')}>Place him</button>
        <button onclick={() => outfit.takeSeatPose()} title="His held bones as they stand now (play a seated clip, pause on the frame)">Take the legs from the pose playing</button>
      </div>
      <p class="faint small">Held still in the seat (the rest of him plays his clips, with his gear, keys and scripts, over the horse's
        clip of the same name):</p>
      <div class="held">
        {#each riderBones.filter(b => LOWER_BODY.includes(b) || mount.freeze.includes(b)) as b}
          <label class:on={mount.freeze.includes(b)}>
            <input type="checkbox" checked={mount.freeze.includes(b)} onchange={(e) => toggleHeld(b, (e.target as HTMLInputElement).checked)} />
            <button class="link" class:aimed={outfit.mountTarget === `bone:${b}`} disabled={!mount.freeze.includes(b)}
              onclick={() => outfit.aim(outfit.mountTarget === `bone:${b}` ? null : `bone:${b}`)} title="Shape it with the gizmo">{b}</button>
          </label>
        {/each}
      </div>
      {#if outfit.mountTarget !== null}
        <Segmented options={modes} bind:value={mode} onchange={(m) => outfit.setMode(m)} />
        <p class="faint small">{outfit.mountTarget === 'seat' ? 'Drag him onto the horse.' : `Turn ${outfit.mountTarget.slice(5)} into the seat.`} Letting go saves it.</p>
      {/if}
    {/if}
  </Section>

  <Section title="Attached">
    {#if attached.length === 0}
      <div class="empty">
        <Sword size={18} />
        <span class="faint">Pick a weapon, shield or tool from the catalog. It snaps to a sensible bone; drag the gizmo to fine-tune.</span>
      </div>
    {:else}
      <ul>
        {#each attached as prop (prop.id)}
          <li class:selected={prop.id === outfit.selected}>
            <button class="row" onclick={() => outfit.select(prop.id === outfit.selected ? null : prop.id)}>
              <span class="name">{prop.name}</span>
              <span class="socket faint">{SOCKETS.find(s => s.id === prop.socket)?.label}</span>
            </button>
            <button class="icon" onclick={() => outfit.remove(prop.id)} aria-label="Remove {prop.name}"><Trash2 size={13} /></button>
          </li>
        {/each}
      </ul>
    {/if}
  </Section>

  {#if selected}
    <Section title={selected.name}>
      <div class="field">
        <span>Attached to</span>
        <select value={selected.socket} onchange={(e) => outfit.setSocket(selected.id, (e.target as HTMLSelectElement).value as Socket)}>
          {#each SOCKETS as s}<option value={s.id}>{s.label}</option>{/each}
        </select>
      </div>
      <Segmented options={modes} bind:value={mode} onchange={(m) => outfit.setMode(m)} />
      <div class="xyz">
        <span class="label faint">Position</span>
        {#each [0, 1, 2] as i}<input class="mono" type="number" step="0.05" value={selected.position[i]} onchange={(e) => number(i, 'position', (e.target as HTMLInputElement).value)} aria-label="Position {'XYZ'[i]}" />{/each}
        <span class="label faint">Rotation</span>
        {#each [0, 1, 2] as i}<input class="mono" type="number" step="5" value={selected.rotation[i]} onchange={(e) => number(i, 'rotation', (e.target as HTMLInputElement).value)} aria-label="Rotation {'XYZ'[i]}" />{/each}
        <span class="label faint">Scale</span>
        <input class="mono wide" type="number" step="0.05" min="0.01" value={selected.scale} onchange={(e) => outfit.patch(selected.id, { scale: Math.max(0.01, Number((e.target as HTMLInputElement).value) || selected.scale) })} aria-label="Scale" />
      </div>
      <Button size="sm" variant="ghost" onclick={() => outfit.reset(selected.id)}><RotateCcw size={13} /> Reset placement</Button>
      <p class="faint small">Pick a clip under Pose to check the grip in motion. Props export as bone attachments.</p>
    </Section>
  {/if}

  <Section title="Accessories">
    {#snippet action()}
      <div class="adds">
        {#each KINDS as k}<Button size="sm" variant="ghost" onclick={() => add(k.id)} title={k.hint}><Upload size={12} /> {k.short}</Button>{/each}
      </div>
    {/snippet}
    <input bind:this={upload} type="file" accept=".fbx,.glb,.gltf,.obj,.dae,.zip" hidden multiple
      onchange={() => { for (const f of upload?.files ?? []) void outfit.upload(f, adding); if (upload) upload.value = '' }} />
    {#if garments.length === 0}
      <div class="empty">
        <Shirt size={18} />
        <span class="faint">Add your own meshes: a <strong>prop</strong> rides a bone (a weapon, a quiver), <strong>clothing</strong> skins to the
          body like the skin under it (a cape, a coat), a <strong>part</strong> is pinned to a spot on the body and moves with that skin (a
          buckle, a pouch, a mechanism with its own animation). Any of them can be switched off, or put in a switch set.</span>
      </div>
    {:else}
      {#each KINDS as k}
        {@const list = garments.filter(g => kindOf(g) === k.id)}
        {#if list.length > 0}
          <div class="kind-head faint">{k.label} <span class="count">{list.length}</span></div>
          <ul>
            {#each list as g (g.id)}
              <li class:selected={g.id === (outfit.fitting ?? outfit.focus)} class:hidden={g.hidden === true}>
                <button class="row" disabled={g.status !== 'ready'} onclick={() => open(g)}>
                  <span class="name">{g.name}</span>
                  <span class="socket faint">
                    {#if g.status === 'importing'}<LoaderCircle size={12} class="spin" /> importing
                    {:else if g.status === 'error'}<CircleAlert size={12} /> failed
                    {:else}{detail(g)}{/if}
                  </span>
                </button>
                {#if g.group}<span class="set" title="Switch set: one of it shows at a time">{g.group}</span>{/if}
                <button class="icon show" onclick={() => outfit.setShown(g.id, g.hidden === true)}
                  aria-label="{g.hidden === true ? 'Show' : 'Switch off'} {g.name}" title={g.hidden === true ? 'Switched off: not shown (nor exported, unless the game switches it: a Gear, Wear or Head piece)' : 'Shown'}>
                  {#if g.hidden === true}<EyeOff size={13} />{:else}<Eye size={13} />{/if}
                </button>
                <button class="icon" onclick={() => outfit.removeGarment(g.id)} aria-label="Remove {g.name}"><Trash2 size={13} /></button>
              </li>
            {/each}
          </ul>
        {/if}
      {/each}
    {/if}
  </Section>

  {#if current}
    <Section title={current.name}>
      <div class="field">
        <span>Kind</span>
        <!-- (what it is, not a view: changing it changes how it moves and exports) -->
        <select value={kindOf(current)} onchange={(e) => setKind(current, (e.target as HTMLSelectElement).value as Kind)} aria-label="Kind">
          {#each KINDS as k}<option value={k.id}>{k.short}</option>{/each}
        </select>
      </div>
      <p class="faint small">{KINDS.find(k => k.id === kindOf(current))?.hint}</p>

      <div class="field">
        <span>Switch set</span>
        <input class="set-input" list="switch-sets" placeholder="none" value={current.group ?? ''}
          onchange={(e) => { const v = (e.target as HTMLInputElement).value.trim(); void outfit.patchGarment(current.id, { group: v === '' ? undefined : v }) }} aria-label="Switch set" />
        <datalist id="switch-sets">{#each outfit.groups as name}<option value={name}></option>{/each}</datalist>
      </div>
      <Toggle label="Shown" hint={current.group ? `Showing it switches off the rest of ${current.group}` : 'Switched off: kept, but not shown or exported'}
        checked={current.hidden !== true} onchange={(v) => outfit.setShown(current.id, v)} />

      {#if current.mode === 'rigid'}
        <!-- (its sockets: the section below) -->
      {:else if current.mode === 'clothing'}
        <div class="field">
          <span>Follows</span>
          <select value={current.policy} onchange={(e) => outfit.patchGarment(current.id, { policy: (e.target as HTMLSelectElement).value as typeof current.policy })}>
            {#each POLICIES as p}<option value={p.id}>{p.label}</option>{/each}
          </select>
        </div>
        <p class="faint small">{POLICIES.find(p => p.id === current.policy)?.hint}</p>
        <Toggle label="Hide body underneath" hint="Removes skin covered by this piece so it can't poke through" checked={current.hideBody}
          onchange={(v) => outfit.patchGarment(current.id, { hideBody: v })} />
      {:else}
        <div class="field">
          <span>Pinned to</span>
          <span class="faint">{current.anchor ? 'the spot picked' : 'the skin nearest its middle'}</span>
        </div>
        <div class="row-buttons">
          <button class:on={outfit.picking === current.id} onclick={() => (outfit.picking === current.id ? outfit.stopPicking() : outfit.pickSpot(current.id))}>
            <Crosshair size={12} /> {outfit.picking === current.id ? 'Click the body…' : 'Pick the spot on the body'}</button>
          {#if current.anchor}<button onclick={() => outfit.patchGarment(current.id, { anchor: undefined })}>Use the nearest skin</button>{/if}
        </div>
        <p class="faint small">Every vertex moves as that skin does: it rides the body without bending.</p>
        {#if clips.length > 0}
          <div class="field">
            <span>Its own animation</span>
            <select value={current.animation ?? ''} onchange={(e) => { const v = (e.target as HTMLSelectElement).value; void outfit.patchGarment(current.id, { animation: v === '' ? undefined : v }) }}>
              <option value="">None (still)</option>
              {#each clips as c}<option value={c}>{c}</option>{/each}
            </select>
          </div>
          {#if current.animation}<p class="faint small">Playing, it rides the spot's leading bone (its own bones move inside it). The game gets it still for now.</p>{/if}
        {/if}
      {/if}

      {#if outfit.fitting === current.id}
        <Segmented options={modes} bind:value={mode} onchange={(m) => outfit.setMode(m)} />
        <div class="xyz">
          <span class="label faint">Position</span>
          {#each [0, 1, 2] as i}<input class="mono" type="number" step="0.01" value={current.position[i]} onchange={(e) => garmentNumber(i, 'position', (e.target as HTMLInputElement).value)} aria-label="Position {'XYZ'[i]}" />{/each}
          <span class="label faint">Rotation</span>
          {#each [0, 1, 2] as i}<input class="mono" type="number" step="5" value={current.rotation[i]} onchange={(e) => garmentNumber(i, 'rotation', (e.target as HTMLInputElement).value)} aria-label="Rotation {'XYZ'[i]}" />{/each}
          <span class="label faint">Scale</span>
          <input class="mono wide" type="number" step="0.05" min="0.01" value={current.scale} onchange={(e) => outfit.patchGarment(current.id, { scale: Math.max(0.01, Number((e.target as HTMLInputElement).value) || current.scale) })} aria-label="Scale" />
        </div>
        {#if current.mode !== 'rigid'}<p class="faint small">Shown unbound while you place it.</p>{/if}
        <Button variant="primary" block onclick={() => outfit.fit(null)}>{current.mode === 'rigid' ? 'Done' : `Bind to ${app.selected?.name ?? 'character'}`}</Button>
      {:else}
        <Button size="sm" variant="ghost" onclick={() => outfit.fit(current.id)}><Move3d size={13} /> Place it (gizmo)</Button>
      {/if}
    </Section>
    {#if current.mode === 'rigid' && current.status === 'ready'}
      <Section title="Sockets & pulls">
        <div class="field">
          <span>Held by</span>
          <select value={current.bone} onchange={(e) => outfit.setBone(current.id, (e.target as HTMLSelectElement).value)}>
            {#each bones.includes(current.bone) ? bones : [current.bone, ...bones] as b}<option value={b}>{b}</option>{/each}
          </select>
        </div>
        {#if isHand(current.bone)}
          <div class="field">
            <span>{current.bone.replace('Hand', ' hand')}</span>
            <HandPoseSelect value={current.carryPose ?? ''} onchange={(v) => outfit.patchGarment(current.id, { carryPose: v === '' ? undefined : v })} />
          </div>
        {/if}
        <p class="faint small">Its carry socket: it rides {current.bone}, rigid{isHand(current.bone) ? ', the hand closed on it in every clip (a clip can open it: Animate → Edit)' : ''}.
          Grips for the other hand (two-handed holds) are made in Animate → Edit, by dragging a hand onto the prop.</p>
        <Button size="sm" block onclick={() => outfit.addPull(current.id)}><Plus size={13} /> Add a pull socket</Button>
        {#if (current.pulls ?? []).length === 0}
          <p class="faint small">A pull socket is a point of the prop another bone takes hold of and drags while a clip holds it: a
            bowstring drawn back by the other hand, a rope, a chain, a lever. It starts on the prop's thinnest piece (a string),
            which is split there so it bends. Then paint, under Weights, which parts it pulls (rigid ↔ soft).</p>
        {/if}
        {#each current.pulls ?? [] as p (p.id)}
          <div class="pull">
            <div class="field">
              <input class="set-input" value={p.name} aria-label="Pull name"
                onchange={(e) => { const v = (e.target as HTMLInputElement).value.trim(); if (v !== '') void outfit.patchPull(current.id, p.id, { name: v }) }} />
              <button class="icon" onclick={() => outfit.removePull(current.id, p.id)} aria-label="Remove {p.name}"><Trash2 size={13} /></button>
            </div>
            <div class="field">
              <span>Drawn by</span>
              <select value={p.bone} onchange={(e) => setPullBone(p, (e.target as HTMLSelectElement).value)}>
                {#each pullBones.includes(p.bone) ? pullBones : [p.bone, ...pullBones] as b}<option value={b}>{b}</option>{/each}
              </select>
            </div>
            {#if isHand(p.bone)}
              <div class="field">
                <span>Its hand while drawing</span>
                <HandPoseSelect value={p.pose ?? ''} defaultLabel="As the clip has it" open={false}
                  onchange={(v) => outfit.patchPull(current.id, p.id, { pose: v === '' ? undefined : v })} />
              </div>
            {/if}
            <div class="row-buttons">
              <button class:on={outfit.picking === `${current.id}:${p.id}`} onclick={() => (outfit.picking === `${current.id}:${p.id}` ? outfit.stopPicking() : outfit.pickPullPoint(current.id, p.id))}>
                <Crosshair size={12} /> {outfit.picking === `${current.id}:${p.id}` ? 'Click the prop…' : 'Pick its point on the prop'}</button>
            </div>
            <p class="faint small"><strong>When it's pulled</strong>, per clip, as parts of the clip (0 its start, 1 its end; "0.5-1"). Find
              plays the clip and takes it from when {p.bone} reaches the strand to the clip's release or a full draw. Play shows it.</p>
            <div class="holds">
              {#each character.animations as a, i (i)}
                <button class="link clip" onclick={() => playClip(i)} title="Play {a.name}"><Play size={11} /> {a.name}</button>
                <input class="mono" value={holdText(p.holds?.[a.name])} placeholder="never" aria-label="{p.name} held in {a.name}"
                  onchange={(e) => setHolds(p, a.name, (e.target as HTMLInputElement).value)} />
                <button class="link" disabled={finding !== null} onclick={() => find(p, i)}>{finding === `${p.id}:${i}` ? 'Finding…' : 'Find'}</button>
              {/each}
            </div>
          </div>
        {/each}
      </Section>
    {/if}
    {#if current.status === 'ready' && current.hidden !== true && ((current.mode === 'clothing' && outfit.fitting !== current.id) || (current.mode === 'rigid' && (current.pulls ?? []).length > 0))}
      <WeightPaintPanel {character} garment={current} />
    {:else if current.status === 'ready' && current.mode !== 'part'}
      <Section title="Weights">
        <p class="faint small">{current.hidden === true ? 'Show it to paint its weights.'
          : current.mode === 'rigid' ? 'A prop is rigid on its bone: add a pull socket above, then paint which parts of it the pull drags.'
          : 'Bind it (finish placing) to paint its weights.'}</p>
      </Section>
    {/if}
  {/if}
{/if}

<style>
  .empty { display: flex; gap: 10px; align-items: flex-start; padding: 12px; border: 1px dashed var(--line-strong); border-radius: var(--r-2); color: var(--text-2); }
  .empty span { font-size: 12.5px; }
  ul { list-style: none; margin: 0 -6px; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  li { display: flex; align-items: center; border-radius: var(--r-1); border: 1px solid transparent; }
  li:hover { background: var(--bg-2); }
  li.selected { background: var(--accent-soft); border-color: rgb(142 162 255 / 30%); }
  .row { flex: 1; display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 8px; border: 0; background: transparent; text-align: left; }
  .name { font-weight: 550; }
  .socket { font-size: 12px; }
  .icon { width: 26px; height: 26px; margin-right: 4px; border: 0; border-radius: 5px; background: transparent; color: var(--text-3); display: grid; place-items: center; }
  .icon:hover { color: var(--danger); background: var(--danger-soft); }
  .icon.show { margin-right: 0; }
  .icon.show:hover { color: var(--text-1); background: var(--bg-3); }
  li.hidden .name { color: var(--text-3); }
  .row-buttons { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 8px; }
  .row-buttons button { height: 26px; padding: 0 9px; border-radius: 5px; border: 1px solid var(--line-strong); background: var(--bg-2); color: var(--text-2); font-size: 12px; }
  .row-buttons button.on { border-color: var(--accent); color: var(--accent-strong); }
  .held { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px; margin-bottom: 8px; }
  .held label { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-3); }
  .held label.on { color: var(--text-1); }
  .link { border: 0; background: transparent; padding: 0; color: inherit; font-size: 12px; text-align: left; }
  .link:disabled { cursor: default; }
  .link.aimed { color: var(--accent-strong); font-weight: 600; }
  .pose { width: 100%; height: 30px; border-radius: var(--r-1); border: 1px solid var(--line-strong); background: var(--bg-2); padding: 0 6px; margin-bottom: 6px; }
  .field { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .field span { color: var(--text-2); }
  select { height: 28px; border-radius: var(--r-1); border: 1px solid var(--line-strong); background: var(--bg-2); padding: 0 6px; }
  .xyz { display: grid; grid-template-columns: 62px repeat(3, 1fr); gap: 6px; align-items: center; }
  .xyz input { min-width: 0; height: 26px; border-radius: 5px; border: 1px solid var(--line); background: var(--bg-1); padding: 0 6px; font-size: 11.5px; }
  .xyz input:focus { outline: none; border-color: var(--accent); }
  .xyz .wide { grid-column: span 3; }
  .label { font-size: 12px; }
  .small { font-size: 12px; margin: 0; }
  .socket { display: inline-flex; gap: 4px; align-items: center; }
  .row:disabled { cursor: default; }
  .adds { display: flex; gap: 2px; }
  .kind-head { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; margin: 10px 0 2px; }
  .kind-head:first-of-type { margin-top: 0; }
  .count { margin-left: 4px; }
  .set { font-size: 11px; padding: 1px 6px; border-radius: 9px; background: var(--bg-3); color: var(--text-2); white-space: nowrap; }
  .set-input { width: 150px; height: 28px; border-radius: var(--r-1); border: 1px solid var(--line-strong); background: var(--bg-2); padding: 0 6px; }
  .row-buttons button { display: inline-flex; align-items: center; gap: 4px; }
  .pull { display: flex; flex-direction: column; gap: 6px; padding: 8px 0; border-top: 1px solid var(--line); }
  .pull:first-of-type { border-top: 0; padding-top: 0; }
  .holds { display: grid; grid-template-columns: auto 1fr auto; gap: 4px 8px; align-items: center; }
  .holds .clip { font-size: 12px; color: var(--text-2); display: inline-flex; align-items: center; gap: 3px; }
  .holds input { min-width: 0; height: 24px; border-radius: 5px; border: 1px solid var(--line); background: var(--bg-1); padding: 0 6px; font-size: 11.5px; }
</style>
