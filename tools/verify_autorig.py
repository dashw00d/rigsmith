"""Re-rig the local character library into an isolated directory, leaving saved work intact.

python3 tools/verify_autorig.py --out workspace/audits/rigging/generated
Each Blender job is bounded; failures are retained in results.json and the per-character log.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def main():
    p = argparse.ArgumentParser(__doc__)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--workspace', type=Path, default=ROOT / 'workspace')
    p.add_argument('--script', type=Path, default=ROOT / 'blender/autorig/rig.py')
    p.add_argument('--only', nargs='*')
    p.add_argument('--workers', type=int, default=2)
    p.add_argument('--native', action='store_true', help='also export a volume-heat candidate')
    args = p.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    def run(file):
        c = json.loads(file.read_text())
        dest = args.out / c['id']
        dest.mkdir(parents=True, exist_ok=True)
        cmd = [os.environ.get('BLENDER', 'blender'), '-b', '--factory-startup', '-t', '2',
               '--python-exit-code', '1', '--python', str(args.script.resolve()), '--',
               '--input', str((file.parent / c['source']['file']).resolve()),
               '--output', str((dest / 'rigged.glb').resolve()), '--fingers', c.get('fingers', 'full'),
               '--report', str((dest / 'report.json').resolve()), '--dump', str((dest / 'skin.npz').resolve())]
        if args.native:
            cmd += ['--native-output', str((dest / 'native.glb').resolve())]
        creature = c.get('template', 'human') != 'human'
        if c.get('joints'):
            (dest / 'joints.json').write_text(json.dumps(c['joints']))
            cmd += ['--joints', str((dest / 'joints.json').resolve())]
        if creature:
            cmd += ['--template', str(ROOT / 'static/templates' / (c['template'] + '.json'))]
        try:
            with (dest / 'rig.log').open('w') as log:
                result = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT, timeout=120, cwd=ROOT)
            ok = result.returncode == 0 and (dest / 'report.json').exists()
            report = json.loads((dest / 'report.json').read_text()) if ok else {}
            row = {'id': c['id'], 'name': c['name'], 'ok': ok, 'report': report}
        except subprocess.TimeoutExpired:
            row = {'id': c['id'], 'name': c['name'], 'ok': False, 'error': 'Blender timed out after 120 seconds'}
        print(c['name'], 'OK' if row['ok'] else 'FAILED', flush=True)
        return row

    files = [f for f in sorted((args.workspace / 'characters').glob('*/character.json'))
             if not args.only or f.parent.name in args.only]
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        rows = list(pool.map(run, files))
    (args.out / 'results.json').write_text(json.dumps(rows, indent=2))
    raise SystemExit(0 if rows and all(r['ok'] for r in rows) else 1)


if __name__ == '__main__':
    main()
