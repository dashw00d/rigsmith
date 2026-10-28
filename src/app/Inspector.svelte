<script lang="ts">
  // The right side: the step's panel for the selected character (each area's src/app/steps/<Name>Panel.svelte).
  import { UserRound } from '@lucide/svelte'
  import { app } from '../state/app.svelte.ts'
  import EmptyState from '../ui/EmptyState.svelte'
  import GearPanel from './steps/GearPanel.svelte'
  import ImportPanel from './steps/ImportPanel.svelte'
  import LookPanel from './steps/LookPanel.svelte'
  import MotionPanel from './steps/MotionPanel.svelte'
  import ShipPanel from './steps/ShipPanel.svelte'
  import SkeletonPanel from './steps/SkeletonPanel.svelte'
  import SkinPanel from './steps/SkinPanel.svelte'
</script>

{#if app.selected === null}
  <EmptyState icon={UserRound} title="No character" body="Import one (drop a model anywhere) or pick one on the left to see its details here." />
{:else if app.step === 'import'}
  <ImportPanel character={app.selected} />
{:else if app.step === 'skeleton'}
  <SkeletonPanel character={app.selected} />
{:else if app.step === 'skin'}
  <SkinPanel character={app.selected} />
{:else if app.step === 'gear'}
  <GearPanel character={app.selected} />
{:else if app.step === 'look'}
  <LookPanel character={app.selected} />
{:else if app.step === 'motion'}
  <MotionPanel character={app.selected} />
{:else}
  <ShipPanel character={app.selected} />
{/if}
