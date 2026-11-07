import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles/tokens.css'
import './styles/base.css'
import { mount } from 'svelte'
import App from './app/App.svelte'

mount(App, { target: document.getElementById('app')! })

// (dev: the long-task logger, and the app's state for the profile harness and the console: tools/lib/profile.ts)
if (import.meta.env.DEV) {
  // Glob lookups keep this hook usable before optional wave modules exist and pick them up when they land.
  const optional = import.meta.glob(['./state/ship.svelte.ts', './app/gear/wardrobe.svelte.ts', './engine/folkpick.ts', './state/classes.svelte.ts'])
  const loadOptional = async (file: string): Promise<Record<string, unknown> | undefined> => {
    const loader = optional[file]
    return loader === undefined ? undefined : await loader() as Record<string, unknown>
  }
  void Promise.all([import('./engine/perf.ts'), import('./state/app.svelte.ts'), import('./state/gear.svelte.ts'),
    import('./state/animator.svelte.ts'), import('./state/viewer.svelte.ts'), import('./state/dress.svelte.ts'),
    import('./state/assets.svelte.ts'), loadOptional('./state/ship.svelte.ts'), loadOptional('./app/gear/wardrobe.svelte.ts'),
    loadOptional('./engine/folkpick.ts'), loadOptional('./state/classes.svelte.ts')])
    .then(([perf, { app }, { gear }, { animator }, { viewer }, { dress }, { assets }, ship, wardrobe, pick, classes]) => {
      perf.watchLongTasks()
      ;(window as unknown as { __rigsmith: unknown }).__rigsmith = { app, gear, animator, viewer, dress, assets, perf, ...(ship?.ship ? { ship: ship.ship } : {}), ...(wardrobe?.wardrobe ? { wardrobe: wardrobe.wardrobe } : {}), ...(pick ? { pick } : {}), ...(classes?.classes ? { classes: classes.classes } : {}) }
    })
}
