"""Calibrate the finger layout: Mixamo's finger joints expressed in the measured hand frame.

python3 -I calib_hands.py <gt_dir>
Coordinates per joint: (along axis, toward thumb, palm-facing) in units of measured hand length.
"""
import glob
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from hands import measure_hand, assumed_palm  # noqa: E402

gt_dir = sys.argv[1]
coords = {}
for path in sorted(glob.glob(os.path.join(gt_dir, '*.npz'))):
    name = os.path.basename(path)[:-4]
    if name == 'villager_open':
        continue
    d = np.load(path)
    names = [str(n) for n in d['bone_names']]
    J = {n: d['heads'][i] for i, n in enumerate(names)}
    V, T, W = d['verts'], d['tris'], d['weights']
    H = np.ptp(V[:, 2])
    for prefix, side in (('Left', 1), ('Right', -1)):
        m = measure_hand(V, T, J[prefix + 'Hand'], J[prefix + 'ForeArm'], side, H)
        wrist = J[prefix + 'Hand']
        # Reference palm: PCA of Mixamo's hand-weighted vertices.
        hb = [i for i, n in enumerate(names) if n.startswith(prefix + 'Hand')]
        P = V[W[:, hb].sum(1) > 0.5]
        _, _, vt = np.linalg.svd(P - P.mean(0), full_matrices=False)
        idx = J[prefix + 'HandIndex1'] - wrist
        idx /= np.linalg.norm(idx)
        fa = wrist - J[prefix + 'ForeArm']; fa /= np.linalg.norm(fa)
        pa = assumed_palm(m['axis'], side)
        print(f"{name[:12]:12s} {prefix[0]} len {m['length'] / H * 100:4.1f}%H flat {m['flat']:.2f} region {m['region'].sum():4d}v  "
              f"axis~idx1 {np.degrees(np.arccos(np.clip(m['axis'] @ idx, -1, 1))):4.0f}  forearm~idx1 {np.degrees(np.arccos(np.clip(fa @ idx, -1, 1))):4.0f}  "
              f"palm~gtpalm {np.degrees(np.arccos(abs(m['palm'] @ vt[2]))):4.0f}  assumed~gtpalm {np.degrees(np.arccos(abs(pa @ vt[2]))):4.0f}")
        frame = np.stack([m['axis'], m['thumb'], m['palm']])
        for f in ('Thumb', 'Index'):
            for i in range(1, 5):
                b = f'{prefix}Hand{f}{i}'
                if b in J:
                    coords.setdefault(f'{f}{i}', []).append(frame @ (J[b] - wrist) / m['length'])
print()
for k, v in coords.items():
    v = np.array(v)
    print(f"{k:7s} n={len(v):2d} median ({', '.join(f'{x:+.3f}' for x in np.median(v, 0))})  spread ({', '.join(f'{x:.3f}' for x in np.std(v, 0))})")
