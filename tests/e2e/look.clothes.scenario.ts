import assert from 'node:assert/strict'
import type { Scenario } from './ui.ts'

export default {
  name: 'look.clothes', character: 'folk-v6-0ba482', step: 'look',
  async run (ui) {
    const wait = async (label: string, condition: Parameters<typeof ui.waitFor>[0]): Promise<void> => {
      try { await ui.waitFor(condition) } catch (error) { throw new Error(`${label}: ${String(error)}`, { cause: error }) }
    }
    const source = await ui.eval(async r => {
      const c = r.app.selected!; const skin = c.look.skins!.find(s => s.name === r.dress.worn(c).skin)!
      const { bare } = await import('/state/bare.svelte.ts')
      await bare.make(c, [skin])
      if (!r.app.selected!.look.skins!.find(s => s.name === skin.name)?.bare) throw new Error('No bare skin')
      return r.app.selected!.look.cloth!.find(l => l.name === 'long_blue')!.id
    })
    await ui.click({ role: 'button', name: 'Duplicate as shorts', within: { testid: 'look-cloth-row', id: source } })
    await wait('duplicate shorts', r => r.app.selected?.look.cloth?.some(l => l.name === 'long_blue shorts') === true)
    const id = await ui.eval(r => r.app.selected!.look.cloth!.find(l => l.name === 'long_blue shorts')!.id)
    await ui.eval((_r, key) => { (window as unknown as { clothScenarioId: string }).clothScenarioId = key }, id)
    const row = { testid: 'look-cloth-row', id }
    assert.ok(await ui.exists(row))
    const preset = await ui.eval((r, key) => r.app.selected!.look.cloth!.find(l => l.id === key)!.cut, id)
    assert.ok(preset?.below?.length === 2 && preset.below.every(x => Math.abs(x.y - 0.35) < 0.001), 'both leg presets cut at 0.35')
    await ui.click({ testid: 'look-cloth-edit', within: row })
    const slider = { role: 'slider', name: 'long_blue shorts left leg height', within: row }
    const width = await ui.eval(() => document.querySelector<HTMLInputElement>('[aria-label="long_blue shorts left leg height"]')!.getBoundingClientRect().width)
    await ui.clickAt(slider, Math.round(width * 0.8), 8)
    try { await wait('slider commit', r => r.app.selected?.look.cloth?.find(l => l.id === (window as unknown as { clothScenarioId: string }).clothScenarioId)?.cut?.below?.some(b => b.y > 0.38) === true) } catch (error) {
      const details = await ui.eval((r, key) => ({ cut: r.app.selected!.look.cloth!.find(l => l.id === key)!.cut, slider: document.querySelector<HTMLInputElement>('[aria-label="long_blue shorts left leg height"]')?.value }), id)
      throw new Error(`${String(error)}: ${JSON.stringify(details)}`, { cause: error })
    }
    const changed = await ui.eval((r, key) => r.app.selected!.look.cloth!.find(l => l.id === key)!.cut, id)
    assert.ok(changed?.below?.some(b => b.y > 0.38), 'slider release commits the cut')
    await ui.shot('cut-editor')
    // A focused range input consumes Ctrl+Z; return focus to the disclosure before undoing a document command.
    await ui.click({ testid: 'look-cloth-edit', within: row })
    await ui.press('ctrl+z')
    await wait('undo slider', r => r.app.selected?.look.cloth?.find(l => l.id === (window as unknown as { clothScenarioId: string }).clothScenarioId)?.cut?.below?.every(b => Math.abs(b.y - 0.35) < 0.001) === true)
    await ui.press('ctrl+z')
    await wait('undo duplicate', r => r.app.selected?.look.cloth?.every(l => l.id !== (window as unknown as { clothScenarioId: string }).clothScenarioId) === true)
    assert.equal(await ui.eval((r, key) => r.app.selected!.look.cloth!.some(l => l.id === key), id), false, 'undo removes the duplicated layer')
  },
} satisfies Scenario
