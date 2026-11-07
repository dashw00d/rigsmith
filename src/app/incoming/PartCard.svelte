<script lang="ts">
  import type { PartView } from '../../../server/incoming/read.ts'
  import { isFolk } from '../../engine/folk.ts'
  import { app } from '../../state/app.svelte.ts'
  import { incoming } from '../../state/incoming.svelte.ts'
  import Button from '../../ui/Button.svelte'
  let { part, packageId }: { part: PartView, packageId: string } = $props()
  const preview = $derived(part.preview ? `/files/incoming/${encodeURIComponent(packageId)}/${part.preview.split('/').map(encodeURIComponent).join('/')}` : null)
  const painted = $derived(part.from ? app.selected?.gear.find(g => g.from === part.from)?.painted ?? 0 : 0)
  const canAccept = $derived(app.selected !== null && isFolk(app.selected) && !part.damaged && painted === 0)
</script>
<div class="part" data-testid="incoming-part" data-id={part.id}>
  {#if preview}<img src={preview} alt="Preview of {part.name}" />{/if}
  <div class="content">
    <strong>{part.name}</strong>
    <span class="badge">{part.damaged ? 'Damaged' : part.status === 'pending' ? (part.effect === 'update' ? 'Update' : 'New') : part.status === 'accepted' ? 'Accepted' : 'Rejected'}</span>
    {#if part.damaged}<p role="alert">{part.damaged}</p>{/if}
    {#if part.effect === 'update' && !part.damaged}<p>Existing placement is kept.</p>{/if}
    {#if painted > 0}<p>Update unavailable while this piece has painted weights.</p>{/if}
    <div class="actions">
      {#if part.status === 'pending'}
        <Button size="sm" variant="primary" disabled={!canAccept || incoming.busy !== null} onclick={() => incoming.change('accept', packageId, part.id)}>Accept</Button>
        <Button size="sm" disabled={incoming.busy !== null} onclick={() => incoming.change('reject', packageId, part.id)}>Reject</Button>
      {:else if part.status === 'rejected'}<Button size="sm" disabled={incoming.busy !== null} onclick={() => incoming.change('restore', packageId, part.id)}>Restore</Button>{/if}
    </div>
  </div>
</div>
<style>
  .part { display: flex; gap: 10px; padding: 10px; border: 1px solid var(--line); border-radius: var(--r-2); }
  img { width: 72px; height: 72px; object-fit: contain; background: var(--bg-2); }
  .content { min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  strong { overflow-wrap: anywhere; } .badge { font-size: 11px; color: var(--accent-strong); }
  p { width: 100%; margin: 0; font-size: 12px; color: var(--text-3); } .actions { width: 100%; display: flex; gap: 6px; }
</style>
