// The harness runs this against its default folk character in the Gear step.
type Selector = { role: string, name: string }
type UI = { exists: (selector: Selector) => Promise<boolean>, key: (key: string) => Promise<void>, waitFor: (fn: (r: { app: { drawer: string | null } }) => boolean) => Promise<void> }
export default {
  name: 'library.forge-gone', step: 'gear',
  async run (ui: UI): Promise<void> {
    if (await ui.exists({ role: 'button', name: 'Forge' })) throw new Error('Forge button is still present')
    if (!await ui.exists({ role: 'button', name: 'Activity: connected' })) throw new Error('Activity button is missing')
    await ui.key('w')
    await ui.waitFor(r => r.app.drawer === 'wardrobe')
  },
}
