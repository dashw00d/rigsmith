import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles/tokens.css'
import './styles/base.css'
import { mount } from 'svelte'
import App from './app/App.svelte'

mount(App, { target: document.getElementById('app')! })

// (dev: the long-task logger, and the app's state for the profile harness and the console: tools/lib/profile.ts)
if (import.meta.env.DEV) {
  void Promise.all([import('./engine/perf.ts'), import('./state/app.svelte.ts'), import('./state/gear.svelte.ts'),
    import('./state/animator.svelte.ts'), import('./state/viewer.svelte.ts'), import('./state/dress.svelte.ts'),
    import('./state/assets.svelte.ts')])
    .then(([perf, { app }, { gear }, { animator }, { viewer }, { dress }, { assets }]) => {
      perf.watchLongTasks()
      ;(window as unknown as { __rigsmith: unknown }).__rigsmith = { app, gear, animator, viewer, dress, assets, perf }
    })
}
