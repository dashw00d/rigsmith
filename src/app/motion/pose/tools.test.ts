// @vitest-environment node
// The pose toolbar's work (./tools.ts) against a TimelineView as the timeline hands it (src/app/motion/lanes.ts), over
// the workspace archer's Idle as it bakes, its writes applied as slot.keys.set applies them (src/model/commands): what
// the toolbar sends is what the timeline then shows. Without the workspace it says so and checks nothing.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { bakeSlot, type BakeContext, type BakedSlot } from '../../../engine/bake.ts'
import { poseAt } from '../../../engine/onion.ts'
import { angle } from '../../../model/posetools.ts'
import { applyCommands } from '../../../model/commands.ts'
import type { Character, Slot } from '../../../model/types.ts'
import type { SelectedItem, TimelineView } from '../lanes.ts'
import { body, character, nodeClipSource, settings, WORKSPACE } from '../../../../tools/lib/node3d.ts'
import * as tools from './tools.ts'

const ID = 'archer-b8157d'
const here = existsSync(path.join(WORKSPACE, 'characters', ID, 'character.json'))

function viewOf (c: Character, slot: Slot, baked: BakedSlot, playhead: number, selection: SelectedItem[] = []): TimelineView {
  const frames = Math.round(baked.clip.duration * 30)
  return {
    character: c, slot, baked, toX: v => v * 600, fromX: x => x / 600, width: 600, duration: baked.clip.duration, frames,
    toPlayed: baked.time.toPlayed, toSource: baked.time.toSource,
    snap: (v, free) => (free === true ? v : Math.round(v * frames) / frames),
    playhead, seek: () => {}, selection, select: () => {},
  }
}

describe.skipIf(!here)('the pose toolbar on the archer\'s Idle', () => {
  it('copies, pastes, tweens, eases, spreads and closes the seam through slot.keys.set', async () => {
    const view3 = await body(ID)
    let c = character(ID)
    const rest = view3.rest!
    const ctx: BakeContext = { rest, posable: view3.root, clips: nodeClipSource(rest, WORKSPACE), fps: 30, sharedPoses: settings().handPoses }
    const slotOf = (): Slot => c.clips.find(s => s.name === 'Idle')!
    const run = (tracks: ReturnType<typeof tools.pasteWrites>, at: TimelineView): void => {
      c = applyCommands(c, [tools.keysCommand(at, tracks)]).character
    }
    let baked = await bakeSlot(c, slotOf(), ctx)

    // copy the left arm at frame 10, paste it at frame 40: shown there as it was at 10
    const sel: SelectedItem[] = ['LeftArm', 'LeftForeArm'].map(b => ({ track: `body:${b}`, id: '', u: 0 }))
    const at10 = viewOf(c, slotOf(), baked, 10 / Math.round(baked.clip.duration * 30) + 0.004, sel)
    const clip = tools.copyAt(at10, rest)!
    expect(clip.bones).toBe(2)
    expect(clip.from).toBe('Idle, frame 10')
    const n = Math.round(baked.clip.duration * 30)
    const at40 = viewOf(c, slotOf(), baked, 40 / n)
    const pasted = tools.pasteWrites(at40, rest, clip, false)
    expect(pasted.map(w => ('bone' in w ? w.bone : '')).sort()).toEqual(['LeftArm', 'LeftForeArm'])
    run(pasted, at40)
    baked = await bakeSlot(c, slotOf(), ctx)
    const shown = poseAt(baked.clip, 40 / n * baked.clip.duration, rest, { bones: ['LeftArm', 'LeftForeArm'] })
    expect(angle(shown.LeftArm.q, clip.pose.LeftArm.q)).toBeLessThan(1e-4)

    // mirrored at frame 60: the right arm's tracks
    const at60 = viewOf(c, slotOf(), baked, 60 / n)
    const mirrored = tools.pasteWrites(at60, rest, clip, true)
    expect(mirrored.map(w => ('bone' in w ? w.bone : '')).sort()).toEqual(['RightArm', 'RightForeArm'])
    run(mirrored, at60)
    baked = await bakeSlot(c, slotOf(), ctx)

    // tween at frame 20 between the left arm's keys (its pin at 0 and the paste at 40): 0 is the pin, 1 the paste
    const at20 = viewOf(c, slotOf(), baked, 20 / n, [{ track: 'body:LeftArm', id: '', u: 0 }])
    const t1 = tools.tweenWrites(at20, 'tween', 1)
    const k40 = slotOf().bones!.LeftArm.find(k => Math.abs(k.u - at40.toSource(40 / n)) < 1e-6)!
    expect(angle(t1[0].keys.find(k => Math.abs(k.u - at20.toSource(20 / n)) < 1e-6)!.q, k40.q)).toBeLessThan(1e-5)
    // (and its live preview: the arm where the slot will show it once keyed)
    const preview = tools.previewOf(at20, rest, t1)
    run(t1, at20)
    baked = await bakeSlot(c, slotOf(), ctx)
    const after = poseAt(baked.clip, 20 / n * baked.clip.duration, rest, { bones: ['LeftArm'] })
    expect(angle(preview.get(rest.bones.get('LeftArm')!.node)!.q, after.LeftArm.q)).toBeLessThan(1e-4)

    // ease the selected key's span
    const keySel: SelectedItem[] = [{ track: 'body:LeftArm', id: String(k40.u), u: k40.u }]
    const atE = viewOf(c, slotOf(), baked, 0, keySel)
    expect(tools.selectedEase(atE)).toBe('smooth')
    run(tools.easeWrites(atE, 'hold'), atE)
    expect(slotOf().bones!.LeftArm.find(k => k.u === k40.u)!.ease).toBe('hold')
    expect(tools.selectedEase(viewOf(c, slotOf(), baked, 0, keySel))).toBe('hold')
    run(tools.easeWrites(viewOf(c, slotOf(), baked, 0, keySel), 'smooth'), atE)
    expect(slotOf().bones!.LeftArm.find(k => k.u === k40.u)!.ease).toBeUndefined()
    baked = await bakeSlot(c, slotOf(), ctx)

    // range edit: frames 25-55 set, the head keyed at frame 40, spread over the range
    const range: tools.RangeEdit = { slot: slotOf().id, range: [at40.toSource(25 / n), at40.toSource(55 / n)], before: tools.snapshot(viewOf(c, slotOf(), baked, 40 / n)) }
    const head = tools.pasteWrites(viewOf(c, slotOf(), baked, 40 / n), rest, { pose: { Head: { q: [0.2, 0, 0, 0.98] } }, from: '', bones: 1 }, false)
    run(head, at40)
    const spread = tools.spreadWrites(viewOf(c, slotOf(), baked, 40 / n), range, 'smooth')!
    expect(spread.map(w => ('bone' in w ? w.bone : ''))).toEqual(['Head'])
    expect(tools.spreadWrites(viewOf(c, slotOf(), baked, 10 / n), range, 'smooth')).toBeNull()
    run(spread, at40)
    const ks = slotOf().bones!.Head
    console.log(`range edit: Head keyed at ${ks.length} moments, frames ${ks.map(k => Math.round(at40.toPlayed(k.u) * n)).join(' ')}`)
    expect(ks.every(k => k.u >= range.range[0] - 1e-6 && k.u <= range.range[1] + 1e-6 || Math.abs(k.u) < 1e-6)).toBe(true)

    // the seam: Idle loops; matched, it meets
    baked = await bakeSlot(c, slotOf(), ctx)
    const open = tools.seamOf(viewOf(c, slotOf(), baked, 0), rest)!
    run(tools.matchWrites(viewOf(c, slotOf(), baked, 0), rest), at40)
    baked = await bakeSlot(c, slotOf(), ctx)
    const closed = tools.seamOf(viewOf(c, slotOf(), baked, 0), rest)!
    console.log(`toolbar seam: ${(open.worst!.angle * 180 / Math.PI).toFixed(3)}° (${open.worst!.bone}) -> ${(closed.worst!.angle * 180 / Math.PI).toExponential(2)}°`)
    expect(closed.worst!.angle).toBeLessThan(1e-4)
  }, 120000)
})
