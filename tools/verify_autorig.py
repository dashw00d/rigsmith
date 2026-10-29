"""Re-rig the local character library into an isolated directory, leaving saved work intact.

python3 tools/verify_autorig.py --out workspace/audits/rigging/generated [--joints skeleton|rig]
Each Blender job is bounded; failures are retained in results.json and the per-character log.

Characters are read as schema 3 or 4 (their joints are the same in both; run `node tools/migrate.ts` on a workspace of older files). The joints given to
Blender are the character's effective skeleton, as src/model/select.ts jointsOf computes it (the detected joints with
the user's placements on top, only the joints its skeleton has), or with --joints rig the joints its last rig was
built from (characters/<id>/joints.json, written by the rig job).
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / 'static/templates'


def hierarchy(skeleton):
    """The joint names of a skeleton (src/model/skeletons.ts hierarchyOf): the human at its finger level, a creature
    template's joints, or for a template this build doesn't know, whatever joints it has."""
    template = skeleton.get('template', 'human')
    if template == 'human':
        human = json.loads((TEMPLATES / 'human-skeleton.json').read_text())
        fingers = human['fingerLevels'][skeleton.get('fingerLevel', 'full')]
        return [row[0] for row in human['bones'] if len(row) < 3 or row[2] in fingers]
    spec = TEMPLATES / f'{template}.json'
    if spec.exists():
        t = json.loads(spec.read_text())
        if 'order' in t and 'parents' in t:
            return list(t['order'])
    return list(dict.fromkeys([*(skeleton.get('detected') or {}), *(skeleton.get('overrides') or {})]))


def joints_of(c):
    """The effective skeleton (select.ts jointsOf): detected, overrides on top, restricted to the hierarchy; at the full
    finger level a hand without a Middle1 drops its Index chain (it was a mitten's middle, never an index finger)."""
    s = c['skeleton']
    every = {**(s.get('detected') or {}), **(s.get('overrides') or {})}
    out = {j: every[j] for j in hierarchy(s) if j in every}
    if s.get('template', 'human') == 'human' and s.get('fingerLevel', 'full') == 'full':
        for side in ('Left', 'Right'):
            if f'{side}HandMiddle1' not in out:
                for i in range(1, 5):
                    out.pop(f'{side}HandIndex{i}', None)
    return out


def main():
    p = argparse.ArgumentParser(__doc__)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--workspace', type=Path, default=ROOT / 'workspace')
    p.add_argument('--script', type=Path, default=ROOT / 'blender/autorig/rig.py')
    p.add_argument('--only', nargs='*')
    p.add_argument('--workers', type=int, default=2)
    p.add_argument('--native', action='store_true', help='also export a volume-heat candidate')
    p.add_argument('--joints', choices=['skeleton', 'rig'], default='skeleton',
                   help="the character's skeleton as it is now (default), or the joints its last rig was built from")
    args = p.parse_args()

    files = [f for f in sorted((args.workspace / 'characters').glob('*/character.json'))
             if not args.only or f.parent.name in args.only]
    old = [f.parent.name for f in files if json.loads(f.read_text()).get('schema') not in (3, 4)]
    if old:
        raise SystemExit(f"{', '.join(old)}: not schema 3 or 4. Run node tools/migrate.ts first")
    args.out.mkdir(parents=True, exist_ok=True)

    def run(file):
        c = json.loads(file.read_text())
        dest = args.out / c['id']
        dest.mkdir(parents=True, exist_ok=True)
        skeleton = c['skeleton']
        template = skeleton.get('template', 'human')
        cmd = [os.environ.get('BLENDER', 'blender'), '-b', '--factory-startup', '-t', '2',
               '--python-exit-code', '1', '--python', str(args.script.resolve()), '--',
               '--input', str((file.parent / c['source']['file']).resolve()),
               '--output', str((dest / 'rigged.glb').resolve()), '--fingers', skeleton.get('fingerLevel', 'full'),
               '--scale', str(c['source'].get('scale', 1)),
               '--report', str((dest / 'report.json').resolve()), '--dump', str((dest / 'skin.npz').resolve())]
        if args.native:
            cmd += ['--native-output', str((dest / 'native.glb').resolve())]
        rig_joints = file.parent / 'joints.json'
        joints = json.loads(rig_joints.read_text()) if args.joints == 'rig' and rig_joints.exists() else joints_of(c)
        if joints:
            (dest / 'joints.json').write_text(json.dumps(joints))
            cmd += ['--joints', str((dest / 'joints.json').resolve())]
        if template != 'human':
            cmd += ['--template', str(TEMPLATES / (template + '.json'))]
        try:
            with (dest / 'rig.log').open('w') as log:
                result = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT, timeout=120, cwd=ROOT)
            ok = result.returncode == 0 and (dest / 'report.json').exists()
            report = json.loads((dest / 'report.json').read_text()) if ok else {}
            row = {'id': c['id'], 'name': c['name'], 'ok': ok, 'joints': len(joints), 'report': report}
        except subprocess.TimeoutExpired:
            row = {'id': c['id'], 'name': c['name'], 'ok': False, 'error': 'Blender timed out after 120 seconds'}
        print(c['name'], 'OK' if row['ok'] else 'FAILED', flush=True)
        return row

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        rows = list(pool.map(run, files))
    (args.out / 'results.json').write_text(json.dumps(rows, indent=2))
    raise SystemExit(0 if rows and all(r['ok'] for r in rows) else 1)


if __name__ == '__main__':
    main()
