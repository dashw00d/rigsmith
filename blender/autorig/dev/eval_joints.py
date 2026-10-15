"""Joint placement error vs Mixamo ground truth (fractions of height). Writes overlay JSON for view_gt.py."""
import glob
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, '..'))
from landmarks import detect_markers  # noqa: E402
from skeleton import build_joints  # noqa: E402

gt_dir, out_json = sys.argv[1], sys.argv[2]
overlay, errors = {}, {}
for path in sorted(glob.glob(os.path.join(gt_dir, '*.npz'))):
    name = os.path.basename(path)[:-4]
    data = np.load(path)
    verts, tris = data['verts'], data['tris']
    if np.ptp(verts[:, 2]) < 0.1:
        continue
    sil, markers = detect_markers(verts, tris)
    joints = build_joints(sil, markers, fingers='two')
    gt = {n: data['heads'][i] for i, n in enumerate(data['bone_names'])}
    H = markers['height']
    overlay[name] = {k: v.tolist() for k, v in joints.items()}
    errors[name] = {k: float(np.linalg.norm(joints[k] - gt[k]) / H) for k in joints if k in gt}

core = ['Hips', 'Spine1', 'Neck', 'Head', 'HeadTop_End', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
        'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'LeftHandIndex1', 'LeftHandThumb1']
print(f"{'':15s}" + ''.join(f"{k.replace('Left', 'L')[:9]:>10s}" for k in core) + '      mean')
for name, err in errors.items():
    vals = [err.get(k, np.nan) for k in core]
    print(f"{name[:15]:15s}" + ''.join(f"{v * 100:10.1f}" for v in vals) + f"{np.nanmean(list(err.values())) * 100:10.1f}")
allv = np.array([[errors[n].get(k, np.nan) for k in core] for n in errors])
print(f"{'mean %H':15s}" + ''.join(f"{v * 100:10.1f}" for v in np.nanmean(allv, 0)))
json.dump(overlay, open(out_json, 'w'))
