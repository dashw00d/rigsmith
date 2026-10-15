<script lang="ts">
  import { Move3d, Rotate3d, Scale3d, RotateCcw, Shirt, Trash2, Sword } from '@lucide/svelte'
  import type { Character } from '../../state/api.ts'
  import { outfit, type GizmoMode } from '../../state/outfit.svelte.ts'
  import { SOCKETS, type Socket } from '../../engine/props.ts'
  import { POLICIES } from '../../engine/garments.ts'
  import { CircleAlert, LoaderCircle, Upload } from '@lucide/svelte'
  import Toggle from '../../ui/Toggle.svelte'
  import { app } from '../../state/app.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import Section from '../../ui/Section.svelte'
  import Segmented from '../../ui/Segmented.svelte'

  let { character }: { character: Character } = $props()

  const attached = $derived(outfit.props)
  const garments = $derived(outfit.garments)
  const fitting = $derived(garments.find(g => g.id === outfit.fitting) ?? null)
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
      <p class="faint small">Tip: play an animation in the Animate step to check the grip in motion. Props export as bone attachments.</p>
    </Section>
  {/if}

  <Section title="Your clothes and accessories">
    {#snippet action()}
      <Button size="sm" variant="ghost" onclick={() => upload?.click()}><Upload size={13} /> Add</Button>
    {/snippet}
    <input bind:this={upload} type="file" accept=".fbx,.glb,.gltf,.obj,.dae,.zip" hidden multiple
      onchange={() => { for (const f of upload?.files ?? []) void outfit.upload(f); if (upload) upload.value = '' }} />
    {#if garments.length === 0}
      <div class="empty">
        <Shirt size={18} />
        <span class="faint">Add a separate mesh (a cape, helmet, armor piece or hair). Line it up with the gizmo, then it binds to the body with weights that only come from the bones it should follow.</span>
      </div>
    {:else}
      <ul>
        {#each garments as g (g.id)}
          <li class:selected={g.id === outfit.fitting}>
            <button class="row" disabled={g.status !== 'ready'} onclick={() => outfit.fit(g.id === outfit.fitting ? null : g.id)}>
              <span class="name">{g.name}</span>
              <span class="socket faint">
                {#if g.status === 'importing'}<LoaderCircle size={12} class="spin" /> importing
                {:else if g.status === 'error'}<CircleAlert size={12} /> failed
                {:else}{g.mode === 'rigid' ? `on ${g.bone}` : POLICIES.find(p => p.id === g.policy)?.label}{/if}
              </span>
            </button>
            <button class="icon" onclick={() => outfit.removeGarment(g.id)} aria-label="Remove {g.name}"><Trash2 size={13} /></button>
          </li>
        {/each}
      </ul>
    {/if}
  </Section>

  {#if fitting}
    <Section title="Fit {fitting.name}">
      <p class="faint small">Shown unbound while you place it. Click it again in the list (or pick another) to bind it.</p>
      <Segmented options={[{ value: 'clothing', label: 'Clothing' }, { value: 'rigid', label: 'Rigid' }]} value={fitting.mode}
        onchange={(m) => outfit.patchGarment(fitting.id, { mode: m as 'clothing' | 'rigid' })} />
      {#if fitting.mode === 'clothing'}
        <div class="field">
          <span>Follows</span>
          <select value={fitting.policy} onchange={(e) => outfit.patchGarment(fitting.id, { policy: (e.target as HTMLSelectElement).value as typeof fitting.policy })}>
            {#each POLICIES as p}<option value={p.id}>{p.label}</option>{/each}
          </select>
        </div>
        <p class="faint small">{POLICIES.find(p => p.id === fitting.policy)?.hint}</p>
        <Toggle label="Hide body underneath" hint="Removes skin covered by this piece so it can't poke through" checked={fitting.hideBody}
          onchange={(v) => outfit.patchGarment(fitting.id, { hideBody: v })} />
      {:else}
        <div class="field">
          <span>Attached to</span>
          <select value={fitting.bone} onchange={(e) => outfit.patchGarment(fitting.id, { bone: (e.target as HTMLSelectElement).value })}>
            {#each bones as b}<option value={b}>{b}</option>{/each}
          </select>
        </div>
      {/if}
      <Segmented options={modes} bind:value={mode} onchange={(m) => outfit.setMode(m)} />
      <div class="xyz">
        <span class="label faint">Position</span>
        {#each [0, 1, 2] as i}<input class="mono" type="number" step="0.01" value={fitting.position[i]} onchange={(e) => garmentNumber(i, 'position', (e.target as HTMLInputElement).value)} aria-label="Position {'XYZ'[i]}" />{/each}
        <span class="label faint">Rotation</span>
        {#each [0, 1, 2] as i}<input class="mono" type="number" step="5" value={fitting.rotation[i]} onchange={(e) => garmentNumber(i, 'rotation', (e.target as HTMLInputElement).value)} aria-label="Rotation {'XYZ'[i]}" />{/each}
        <span class="label faint">Scale</span>
        <input class="mono wide" type="number" step="0.05" min="0.01" value={fitting.scale} onchange={(e) => outfit.patchGarment(fitting.id, { scale: Math.max(0.01, Number((e.target as HTMLInputElement).value) || fitting.scale) })} aria-label="Scale" />
      </div>
      <Button variant="primary" block onclick={() => outfit.fit(null)}>Bind to {app.selected?.name ?? 'character'}</Button>
    </Section>
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
</style>
