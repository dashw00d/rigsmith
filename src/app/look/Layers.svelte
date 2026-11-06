<script lang="ts">
  // The look's layers, top of the stack first, over the source's own texture: switch each on or off, move it up or
  // down, remove it (its file stays, so undo brings it back), or switch them all off ("Back to the original texture").
  // Each is a look.layer.* command; the server lays the enabled ones over the texture again after any of them.
  import { ArrowDown, ArrowUp, Layers as LayersIcon, RotateCcw, Trash2 } from '@lucide/svelte'
  import type { Command } from '../../model/command-types.ts'
  import type { Character, Job, TextureLayer } from '../../state/api.ts'
  import { asset } from '../../state/assets.svelte.ts'
  import { app } from '../../state/app.svelte.ts'
  import Badge from '../../ui/Badge.svelte'
  import Button from '../../ui/Button.svelte'
  import IconButton from '../../ui/IconButton.svelte'
  import { tooltip } from '../../ui/tooltip.ts'
  import { ago, LAYER_KIND, layerDetail } from './text.ts'

  let { character }: { character: Character } = $props()

  const layers = $derived(character.look.layers)
  const top = $derived([...layers].reverse())
  const enabled = $derived(layers.filter(l => l.enabled))
  const manyImages = $derived(new Set([...layers.map(l => l.image), ...(character.look.scan?.images ?? []).map(i => i.image)]).size > 1)

  const active = (j: Job): boolean => j.status === 'queued' || j.status === 'running'
  const composes = $derived(app.jobs.filter(j => j.characterId === character.id && j.kind === 'compose'))
  const composing = $derived(composes.find(active))
  // (the newest compose failed and none has run since: the texture shown isn't what the layers say)
  const failed = $derived(composing === undefined ? composes.find(j => !active(j) && j.status !== 'cancelled') : undefined)
  const failure = $derived(failed?.status === 'failed' ? failed.error ?? failed.message : null)

  async function run (commands: Command[], what?: string): Promise<void> {
    await app.do(character.id, commands, what)
  }

  function toggle (l: TextureLayer): void {
    void run([{ type: 'look.layer.update', id: l.id, patch: { enabled: !l.enabled } }])
  }

  /** Move a layer one place toward the top (+1) or the bottom (-1). */
  function move (l: TextureLayer, by: 1 | -1): void {
    const ids = layers.map(x => x.id)
    const at = ids.indexOf(l.id)
    const to = at + by
    if (at < 0 || to < 0 || to >= ids.length) return
    ;[ids[at], ids[to]] = [ids[to], ids[at]]
    void run([{ type: 'look.layer.reorder', ids }])
  }

  function remove (l: TextureLayer): void {
    void run([{ type: 'look.layer.remove', id: l.id }])
  }

  function original (): void {
    void run(enabled.map(l => ({ type: 'look.layer.update' as const, id: l.id, patch: { enabled: false } })), 'look: back to the original texture')
  }
</script>

{#if layers.length === 0}
  <p class="faint small">No layers yet: the model wears its texture as imported. Filling the holes or keeping a projection painting adds one.</p>
{:else}
  <ul class="layers" aria-label="Layers, top first">
    {#each top as l, i (l.id)}
      {@const detail = layerDetail(l, manyImages)}
      <li class:off={!l.enabled}>
        <input type="checkbox" checked={l.enabled} aria-label="Show this layer" use:tooltip={l.enabled ? 'On: switch it off' : 'Off: switch it on'} onchange={() => { toggle(l) }} />
        <img class="thumb" src={asset(character, l.file)} alt="" loading="lazy" />
        <div class="text">
          <span class="kind">{LAYER_KIND[l.kind]}</span>
          {#if detail !== ''}<span class="faint detail" use:tooltip={detail.length > 40 ? detail : null}>{detail}</span>{/if}
          <span class="faint when">{ago(l.at)}</span>
        </div>
        <div class="tools">
          <IconButton label="Move up" size="sm" disabled={i === 0} onclick={() => { move(l, 1) }}><ArrowUp size={13} /></IconButton>
          <IconButton label="Move down" size="sm" disabled={i === top.length - 1} onclick={() => { move(l, -1) }}><ArrowDown size={13} /></IconButton>
          <IconButton label="Remove" hint="Remove it: its file stays, so Undo (Activity) brings it back" size="sm" variant="danger" onclick={() => { remove(l) }}><Trash2 size={13} /></IconButton>
        </div>
      </li>
    {/each}
    <li class="base">
      <LayersIcon size={14} />
      <span class="faint">The texture as imported</span>
    </li>
  </ul>
  <div class="row">
    {#if composing !== undefined}
      <Badge tone="busy" dot>{composing.status === 'queued' ? 'Texture update queued' : composing.message || 'Updating the texture'}</Badge>
    {:else if failure !== null}
      <p class="error small" role="alert">The texture didn't update: {failure}</p>
    {/if}
    <Button size="sm" variant="ghost" disabled={enabled.length === 0} onclick={original}><RotateCcw size={13} /> Back to the original texture</Button>
  </div>
  <p class="faint small">Every change here is undoable from the Activity drawer.</p>
{/if}

<style>
  .small { font-size: 12px; margin: 0; }
  .layers { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .layers li { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: var(--r-1); border: 1px solid var(--line); background: var(--bg-2); min-width: 0; }
  .layers li.off .thumb, .layers li.off .text { opacity: 0.45; }
  .layers li.base { background: none; border-style: dashed; color: var(--text-3); font-size: 12px; }
  input[type='checkbox'] { accent-color: var(--accent); margin: 0; }
  .thumb {
    width: 32px; height: 32px; flex: none; border-radius: var(--r-1); object-fit: cover; border: 1px solid var(--line);
    /* (a decal is mostly clear: the checks show where it covers) */
    background: repeating-conic-gradient(#2a2f3a 0 25%, #1d2129 0 50%) 0 0 / 8px 8px;
  }
  .text { display: flex; flex-direction: column; min-width: 0; flex: 1; font-size: 12px; line-height: 1.3; }
  .kind { font-weight: 600; }
  .detail { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .when { font-size: 11px; }
  .tools { display: flex; gap: 2px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
  .error { color: var(--danger); }
</style>
