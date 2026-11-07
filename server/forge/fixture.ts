// A game repo for the Forge's tests: a forge.json of small shell stages (no GPU, Blender or ComfyUI), in a temp folder.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const SCRIPTS: Record<string, string> = {
  // a generation: a sheet that differs by seed
  'sheet.sh': `#!/bin/sh
set -e
item="$3"; test -f "$4"
mkdir -p "$1/$item"
echo '@@PROGRESS {"progress": 0.5, "message": "Painting"}'
echo "sheet seed $2 for $item" > "$1/$item/sheet.png"
echo "painted"
`,
  // deterministic: views from the sheet linked in
  'prepare.sh': `#!/bin/sh
set -e
mkdir -p "$(dirname "$1")/views"
cat "$1" > "$(dirname "$1")/views/front.png"
echo front >> "$(dirname "$1")/views/front.png"
echo '@@RESULT {"views": 1}'
`,
  // the item split into pieces
  'cut.sh': `#!/bin/sh
set -e
d="$1/$2"
mkdir -p "$d/pieces"
for p in head leg_L leg_R; do cat "$d/views/front.png" > "$d/pieces/$p.glb"; echo "$p" >> "$d/pieces/$p.glb"; done
echo '@@RESULT {"pieces": ["head", "leg_L", "leg_R"]}'
`,
  // changes its input in place
  'finish.sh': `#!/bin/sh
set -e
for f in "$1/$2"/pieces/*.glb; do echo finished >> "$f"; done
`,
  // slow, and carries on where it was: a marker left in work/ the first time
  'slow.sh': `#!/bin/sh
d="$1/$2"; mkdir -p "$d"
if [ -f "$1/started" ]; then echo "carried on" > "$d/slow.txt"; exit 0; fi
touch "$1/started"
echo "$$" > "$1/pid"
sleep 30
echo "slow" > "$d/slow.txt"
`,
  'fail.sh': `#!/bin/sh
echo "working"
echo "Error: the shape is broken" >&2
exit 3
`,
}

export interface Fixture { root: string, repo: string, store: string, raw: Record<string, unknown> }

export function makeFixture (): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'rigsmith-forge-'))
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'tools'), { recursive: true })
  for (const [name, text] of Object.entries(SCRIPTS)) {
    writeFileSync(path.join(repo, 'tools', name), text)
    chmodSync(path.join(repo, 'tools', name), 0o755)
  }
  writeFileSync(path.join(repo, 'guide.png'), 'the guide\n')
  const sh = (name: string, ...args: string[]): string[] => ['sh', `tools/${name}`, ...args]
  const raw = {
    schema: 1,
    store: 'store',
    comfy: 'http://127.0.0.1:8188',
    hashes: ['sh', '-c', 'echo hashed >> hashes.log'],
    pipelines: {
      outfit: {
        label: 'Outfit', item: 'outfit',
        stages: [
          { id: 'sheet', label: 'Sheet', cmd: sh('sheet.sh', '{work}', '{seed}', '{item}', '{spec}'), gpu: { vram: 100, family: 'comfy' }, variants: 2, gate: 'pick', inputs: { guide: { file: 'guide.png' } }, outputs: ['{item}/sheet.png'], code: ['tools/sheet.sh'] },
          { id: 'prepare', label: 'Prepare', cmd: sh('prepare.sh', '{in.sheet}'), inputs: { sheet: { stage: 'sheet' } }, outputs: ['{item}/views/'], code: ['tools/prepare.sh'], cache: true },
          { id: 'cut', label: 'Cut', cmd: sh('cut.sh', '{work}', '{item}'), inputs: { views: { stage: 'prepare' } }, outputs: ['{item}/pieces/*.glb', '?{item}/pieces/review.png'], code: ['tools/cut.sh'], splits: true, gate: 'approve', scratch: true },
          { id: 'finish', label: 'Finish', cmd: sh('finish.sh', '{work}', '{item}'), inputs: { pieces: { stage: 'cut' } }, outputs: ['{item}/pieces/*.glb'], mutates: true },
        ],
        publish: {
          into: 'gear/{item}', stages: ['sheet', 'cut', 'finish'],
          roster: { file: 'gear/roster.json', list: 'outfits', key: 'id' },
          character: {
            pieces: 'pieces/*.glb', name: 'Outfit_{item}_{piece}', from: 'emberhold:gear/{name}',
            policy: { head: 'head', leg: 'lower' }, hideBody: true,
            skip: { head: ['HAIR'] }, tags: [{ piece: 'head', anyOf: ['HAT'], tags: ['covers-hair'] }], field: 'outfit',
          },
        },
      },
      slow: {
        label: 'Slow', item: 'thing',
        stages: [
          { id: 'slow', label: 'Slow', cmd: sh('slow.sh', '{work}', '{item}'), outputs: ['{item}/slow.txt'], resumable: true },
          { id: 'fail', label: 'Fail', cmd: sh('fail.sh'), outputs: ['x'] },
          { id: 'never', label: 'Never', cmd: sh('slow.sh', '{work}', '{item}'), outputs: ['{item}/slow.txt'] },
        ],
      },
    },
  }
  writeFileSync(path.join(repo, 'forge.json'), JSON.stringify(raw, null, 1))
  return { root, repo, store: path.join(repo, 'store'), raw }
}
