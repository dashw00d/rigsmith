"""Finger joint error vs Mixamo (%H): detected wrist vs Mixamo's wrist, measured frame vs forearm frame.

python3 -I eval_hands.py <gt_dir>
"""
import glob
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import skeleton  # noqa: E402
from hands import symmetric_hand  # noqa: E402
from landmarks import detect_markers  # noqa: E402

gt_dir = sys.argv[1]
FINGERS = [f'LeftHand{f}{i}' for f in ('Thumb', 'Index') for i in range(1, 5)]
results = {k: {j: [] for j in FINGERS} for k in ('forearm', 'measured', 'detected', 'forearm@gtwrist', 'measured@gtwrist', 'detected@gtwrist')}
for path in sorted(glob.glob(os.path.join(gt_dir, '*.npz'))):
    name = os.path.basename(path)[:-4]
    if name == 'villager_open':
        continue
    d = np.load(path)
    gt = {str(n): d['heads'][i] for i, n in enumerate(d['bone_names'])}
    sil, markers = detect_markers(d['verts'], d['tris'])
    H = markers['height']
    xc = markers['x_center']
    detected = skeleton.build_joints(sil, markers, fingers='two')
    for wrist_src in ('', '@gtwrist'):
        base = dict(detected)
        if wrist_src == '@gtwrist':
            base['LeftHand'], base['LeftForeArm'] = gt['LeftHand'], gt['LeftForeArm']
        both = dict(base)
        both['RightHand'] = np.array([2 * xc - base['LeftHand'][0], *base['LeftHand'][1:]])
        both['RightForeArm'] = np.array([2 * xc - base['LeftForeArm'][0], *base['LeftForeArm'][1:]])
        hand = symmetric_hand(d['verts'], d['tris'], both, H, xc)
        for mode, frame in (('forearm', None), ('measured', hand), ('detected', hand)):
            j = dict(base)
            skeleton._add_fingers(j, 'two', frame)
            if mode == 'detected':
                found = skeleton.detect_finger_joints(d['verts'], d['tris'], both, H, xc)
                j.update(skeleton.fit_finger_level(found, 'two', j))
            for b in FINGERS:
                if b in gt:
                    results[mode + wrist_src][b].append(np.linalg.norm(j[b] - gt[b]) / H * 100)
print(f"{'':18s}" + ''.join(f'{b[8:]:>8s}' for b in FINGERS) + '    mean')
for k, r in results.items():
    vals = [np.mean(r[b]) for b in FINGERS]
    print(f'{k:18s}' + ''.join(f'{v:8.1f}' for v in vals) + f'{np.mean(vals):8.1f}')
