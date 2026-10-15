"""Sheet of detected fingers (palm view) per character: vertices colored by finger, joints as dots."""
import glob
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from fingers import finger_chains, hand_fingers  # noqa: E402
from hands import measure_hand  # noqa: E402

COLORS = {'Thumb': (240, 90, 90), 'Index': (250, 200, 60), 'Middle': (90, 220, 120), 'Ring': (80, 170, 250), 'Pinky': (200, 110, 250)}
tiles = []
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
        chains = finger_chains(labeled) if labeled else {}
        S = 220
        img = Image.new('RGB', (S, S + 14), (18, 18, 22))
        dr = ImageDraw.Draw(img)
        u, v = hand['axis'], hand['thumb']
        scale = S / (1.3 * hand['length'])

        def px(p):
            q = p - wrist
            return (S / 2 + (q @ v) * scale, 10 + (q @ u) * scale)
        owner = {}
        for fname, f in labeled.items():
            for m in f['members']:
                owner[m] = fname
        tris = T[hand['region'][T].all(axis=1)]
        depth = (V[tris].mean(1) - wrist) @ hand['palm']
        for t in tris[np.argsort(depth)]:
            names = [owner.get(i) for i in t]
            col = COLORS.get(max(set(names), key=names.count), (120, 120, 130)) if any(names) else (110, 110, 120)
            dr.polygon([px(V[i]) for i in t], fill=col, outline=(30, 30, 30))
        for fname, pts in chains.items():
            pts = [p for p in pts if p is not None]
            for a, b in zip(pts[:-1], pts[1:]):
                dr.line([px(a), px(b)], fill=(255, 255, 255), width=2)
            for p in pts:
                x, y = px(p)
                dr.ellipse([x - 3, y - 3, x + 3, y + 3], fill=(255, 255, 255))
        x, y = px(wrist)
        dr.ellipse([x - 4, y - 4, x + 4, y + 4], fill=(255, 60, 60))
        dr.text((3, S), f'{name[:12]} {prefix[0]} {len(labeled)}f', fill=(220, 220, 220))
        tiles.append(img)
cols = 6
sheet = Image.new('RGB', (cols * 220, ((len(tiles) + cols - 1) // cols) * 234), (8, 8, 10))
for i, t in enumerate(tiles):
    sheet.paste(t, ((i % cols) * 220, (i // cols) * 234))
sheet.save(sys.argv[2])
