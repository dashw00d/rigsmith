<script lang="ts">
  import { untrack } from 'svelte'
  import { CoverageOverlay } from '../../engine/coverageOverlay.ts'
  import { coverage } from '../../state/coverage.svelte.ts'
  import { app } from '../../state/app.svelte.ts'
  import { viewer } from '../../state/viewer.svelte.ts'
  let overlay = $state.raw<CoverageOverlay | null>(null)
  $effect(() => {
    const view = viewer.character; const stage = viewer.stage
    if (!coverage.on || app.step !== 'gear' || view === null || stage === null) return
    const data = untrack(() => coverage.data)
    if (data === null) return
    // Follow the view, not coverage updates: colors change separately below.
    const next = new CoverageOverlay(data.body, stage)
    overlay = next
    return () => { if (overlay === next) overlay = null; next.dispose() }
  })
  $effect(() => {
    if (!coverage.on || app.step !== 'gear' || overlay === null) return
    const data = coverage.data
    if (data !== null) overlay?.update(data.body, data.regions, coverage.hover)
  })
</script>
