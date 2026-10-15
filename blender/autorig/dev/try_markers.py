"""Run marker detection on every GT mesh, dump overlay points + compare against Mixamo joints."""
import glob
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, '..'))
from landmarks import detect_markers  # noqa: E402

gt_dir, out_json = sys.argv[1], sys.argv[2]
overlay = {}
stats = []
for path in sorted(glob.glob(os.path.join(gt_dir, '*.npz'))):
    name = os.path.basename(path)[:-4]
    data = np.load(path)
    verts, tris = data['verts'], data['tris']
    if verts[:, 2].max() - verts[:, 2].min() < 0.1:
        continue
    sil, m = detect_markers(verts, tris)
    gt = {n: data['heads'][i] for i, n in enumerate(data['bone_names'])}
    pts = {}
    H = m['height']
    row = {'name': name}
    for side, prefix in (('left', 'Left'), ('right', 'Right')):
        arm = m['arms'][side]
        if arm is None:
            row[side + '_arm'] = 'FAIL'
            continue
        pts[f'{side}_tip'] = [float(arm['tip'][0]), sil.depth_center(arm['tip'][0], arm['tip'][2]), float(arm['tip'][2])]
        pts[f'{side}_armpit'] = [float(arm['armpit'][0]), sil.depth_center(arm['armpit'][0], arm['armpit'][2]), float(arm['armpit'][2])]
        for i, (x, z) in enumerate(arm['centerline'][::6]):
            pts[f'{side}_c{i}'] = [float(x), sil.depth_center(x, z), float(z)]
        # relation of GT joints to armpit
        a = gt[prefix + 'Arm']
        row[side + '_arm_vs_armpit_dz'] = round(float((a[2] - arm['armpit'][2]) / H), 3)
        row[side + '_arm_vs_armpit_dx'] = round(float(abs(a[0] - arm['armpit'][0]) / H), 3)
    legs = m['legs']
    if legs is None:
        row['legs'] = 'none'
    else:
        c = legs['crotch']
        pts['crotch'] = [float(c[0]), sil.depth_center(c[0], c[2]), float(c[2])]
        row['crotch_z'] = round(float((c[2] - m['z_min']) / H), 3)
        row['gt_upleg_z'] = round(float((gt['LeftUpLeg'][2] - m['z_min']) / H), 3)
    overlay[name] = pts
    stats.append(row)
json.dump(overlay, open(out_json, 'w'))
for r in stats:
    print(r)
