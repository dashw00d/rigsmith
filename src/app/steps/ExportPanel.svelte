<script lang="ts">
  import { CircleCheck, Download, FolderOutput, PackageCheck } from '@lucide/svelte'
  import { api, type Character } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { entryUrl } from '../../state/animator.svelte.ts'
  import { viewer } from '../../state/viewer.svelte.ts'
  import { CharacterView } from '../../engine/CharacterView.ts'
  import { RetargetCache } from '../../engine/clips.ts'
  import { attachProps, detachProps, type PropAttachment } from '../../engine/props.ts'
  import { DEFAULT_EXPORT, clipName, exportCharacter, type ExportOptions } from '../../engine/exporter.ts'
  import { fileUrl } from '../../state/api.ts'
  import Button from '../../ui/Button.svelte'
  import Section from '../../ui/Section.svelte'
  import Segmented from '../../ui/Segmented.svelte'
  import Toggle from '../../ui/Toggle.svelte'

  let { character }: { character: Character } = $props()

  function loadOptions (): ExportOptions {
    try { return { ...DEFAULT_EXPORT, ...JSON.parse(localStorage.getItem('rigsmith.export') ?? '{}') } } catch { return { ...DEFAULT_EXPORT } }
  }
  let options = $state<ExportOptions>(loadOptions())
  $effect(() => { try { localStorage.setItem('rigsmith.export', JSON.stringify(options)) } catch {} })

  let textureChoice = $state(String(options.textureSize ?? 'original'))
  let includeProps = $state(true)
  let busy = $state<string | null>(null)
  let last = $state<{ path: string, bytes: number, name: string } | null>(null)

  const ready = $derived(app.characters.filter(c => c.status === 'rigged' && c.animations.length > 0))
  const fileName = (c: Character): string => `${c.name.replace(/[^\w .-]+/g, '').trim().replace(/\s+/g, '_') || c.id}.glb`

  async function build (c: Character): Promise<Blob> {
    // The selected character is already loaded in the viewport; others load offscreen.
    let view = c.id === app.selectedId ? viewer.character : null
    if (view === null) {
      const url = fileUrl(c, c.files.rigged)
      if (url === null) throw new Error(`${c.name} is not rigged`)
      view = await CharacterView.load(url)
      await attachProps(view, (c.props ?? []) as PropAttachment[])
    }
    if (view.rest === null) throw new Error(`${c.name} has no skeleton`)
    if (!includeProps) detachProps(view)
    try {
      return await exportCharacter(view, c.animations, new RetargetCache(view.rest), entryUrl, options)
    } finally {
      if (!includeProps && c.id === app.selectedId) await attachProps(view, (c.props ?? []) as PropAttachment[])
    }
  }

  async function exportOne (c: Character): Promise<void> {
    const blob = await build(c)
    const saved = await api.saveExport(fileName(c), blob)
    last = { path: saved.path, bytes: blob.size, name: c.name }
  }

  async function run (all: boolean): Promise<void> {
    const targets = all ? ready : [character]
    try {
      for (const [i, c] of targets.entries()) {
        busy = all ? `Exporting ${i + 1} of ${targets.length}: ${c.name}` : 'Exporting'
        await exportOne(c)
      }
      app.toast('ok', all ? `Exported ${targets.length} characters` : `Exported ${character.name}`)
    } catch (error) {
      app.toast('error', (error as Error).message)
    } finally {
      busy = null
    }
  }

  async function download (): Promise<void> {
    busy = 'Building file'
    try {
      const blob = await build(character)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = fileName(character)
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
    } catch (error) {
      app.toast('error', (error as Error).message)
    } finally {
      busy = null
    }
  }
</script>

{#if character.status !== 'rigged'}
  <Section><p class="muted">Rig {character.name} and pick animations before exporting.</p></Section>
{:else}
  <Section title="Package">
    <div class="summary">
      <PackageCheck size={18} />
      <div>
        <strong>{fileName(character)}</strong>
        <span class="faint">{character.stats?.bones ?? 0} bones · {character.animations.length} animation{character.animations.length === 1 ? '' : 's'} · {character.stats?.triangles.toLocaleString()} tris</span>
      </div>
    </div>
    {#if character.animations.length > 0}
      <ul class="clips">
        {#each character.animations as entry}<li class="mono">{clipName(entry, options)}</li>{/each}
      </ul>
    {:else}
      <p class="faint small">No animations picked: the file will contain the rigged character only.</p>
    {/if}
  </Section>

  <Section title="Settings">
    <div class="field">
      <span>Bone names</span>
      <Segmented size="sm" bind:value={options.boneNames} options={[{ value: 'mixamo', label: 'Hips' }, { value: 'mixamorig', label: 'mixamorig:Hips' }]} />
    </div>
    <div class="field">
      <span>Texture size</span>
      <Segmented size="sm" bind:value={textureChoice} onchange={(v) => { options.textureSize = v === 'original' ? null : Number(v) }}
        options={[{ value: 'original', label: 'Original' }, { value: '2048', label: '2K' }, { value: '1024', label: '1K' }, { value: '512', label: '512' }]} />
    </div>
    <div class="field">
      <span>Image format</span>
      <Segmented size="sm" bind:value={options.imageFormat} options={[{ value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPEG' }]} />
    </div>
    <Toggle label="Godot looping" hint="Adds -loop to looping clips so Godot loops them on import" bind:checked={options.loopSuffix} />
    {#if (character.props?.length ?? 0) > 0}
      <Toggle label="Include props" hint="Exported as bone attachments ({character.props?.length} attached)" bind:checked={includeProps} />
    {/if}
  </Section>

  <Section title="Destination">
    <div class="dest"><FolderOutput size={14} /><span class="mono">{app.settings?.exportDir}</span></div>
    <p class="faint small">Change it in Settings (top right), e.g. to a folder in your Godot project.</p>
  </Section>

  <Section>
    <Button variant="primary" size="lg" block loading={busy !== null} onclick={() => run(false)}>
      {#if busy === null}<FolderOutput size={15} />{/if} {busy ?? `Export ${character.name}`}
    </Button>
    <div class="row">
      <Button size="sm" variant="ghost" disabled={busy !== null} onclick={download}><Download size={13} /> Download instead</Button>
      {#if ready.length > 1}
        <Button size="sm" variant="ghost" disabled={busy !== null} onclick={() => run(true)}>Export all {ready.length}</Button>
      {/if}
    </div>
    {#if last}
      <div class="done">
        <CircleCheck size={15} />
        <div><strong>{last.name}</strong> · {(last.bytes / 1024 / 1024).toFixed(1)} MB<br /><span class="mono faint">{last.path}</span></div>
      </div>
    {/if}
  </Section>
{/if}

<style>
  .summary { display: flex; gap: 10px; align-items: flex-start; color: var(--accent-strong); }
  .summary div { display: flex; flex-direction: column; gap: 2px; color: var(--text-1); }
  .summary span { font-size: 12px; }
  .clips { list-style: none; margin: 0; padding: 8px 10px; border-radius: var(--r-1); background: var(--bg-0); max-height: 160px; overflow: auto; }
  .clips li { font-size: 11.5px; color: var(--text-2); padding: 1px 0; }
  .field { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .field > span { color: var(--text-2); }
  .dest { display: flex; gap: 7px; align-items: center; color: var(--text-2); }
  .dest span { font-size: 11.5px; word-break: break-all; }
  .small { font-size: 12px; margin: 0; }
  .row { display: flex; justify-content: space-between; }
  .done { display: flex; gap: 8px; padding: 10px 12px; border-radius: var(--r-2); background: var(--ok-soft); color: var(--ok); font-size: 12px; }
  .done div { color: var(--text-1); }
  .done span { font-size: 11px; word-break: break-all; }
</style>
