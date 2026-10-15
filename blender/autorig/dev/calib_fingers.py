"""Where Mixamo's thumb/index joints sit along the detected fingers (arc length / visible finger length)."""
import glob
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from fingers import along, hand_fingers  # noqa: E402
from hands import measure_hand  # noqa: E402

stats = {}
for path in sorted(glob.glob(os.path.join(sys.argv[1], '*.npz'))):
    name = os.path.basename(path)[:-4]
    if name == 'villager_open':
        continue
    d = np.load(path)
    J = {str(n): d['heads'][i] for i, n in enumerate(d['bone_names'])}
    V, T = d['verts'], d['tris']
    H = np.ptp(V[:, 2])
    for prefix, side in (('Left', 1), ('Right', -1)):
        wrist = J[prefix + 'Hand']
        hand = measure_hand(V, T, wrist, J[prefix + 'ForeArm'], side, H)
        labeled = hand_fingers(V, T, hand, wrist, H)
        row = []
        for f in ('Thumb', 'Index'):
            if f not in labeled or prefix + f'Hand{f}1' not in J:
                continue
            line = labeled[f]['line']
            for i in range(1, 5):
                s, off, total = along(line, J[f'{prefix}Hand{f}{i}'])
                stats.setdefault(f'{f}{i}', []).append((s / total, off / H))
                row.append(f'{f[0]}{i} {s / total:+.2f}/{off / H * 100:.1f}')
        print(f"{name[:12]:12s} {prefix[0]} found {','.join(labeled)}  " + '  '.join(row))
print()
for k, v in stats.items():
    v = np.array(v)
    print(f'{k:7s} n={len(v):2d}  s/len median {np.median(v[:, 0]):+.2f} (iqr {np.percentile(v[:, 0], 25):+.2f}..{np.percentile(v[:, 0], 75):+.2f})  offset median {np.median(v[:, 1]) * 100:.1f}%H')
