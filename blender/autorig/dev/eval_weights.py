"""Compare skin weights against Mixamo ground truth; render dominant-bone maps side by side.

python3 eval_weights.py <gt_dir> <ours_dir> <out.png>
Finger weights are folded into the hand on both sides so finger detail levels don't matter.
"""
import glob
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from raster import Grid2D  # noqa: E402

gt_dir, ours_dir, out_png = sys.argv[1:4]

REGIONS = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
           'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
           'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase']
rng = np.random.default_rng(3)
PALETTE = (rng.random((len(REGIONS), 3)) * 200 + 55).astype(np.uint8)


def folded(names, w):
    out = np.zeros((len(w), len(REGIONS)))
    for i, n in enumerate(names):
        n = str(n)
        if 'Hand' in n and n not in ('LeftHand', 'RightHand'):
            n = 'LeftHand' if n.startswith('Left') else 'RightHand'
        if n in REGIONS:
            out[:, REGIONS.index(n)] += w[:, i]
    s = out.sum(1, keepdims=True)
    return np.divide(out, s, out=np.zeros_like(out), where=s > 0)


def render(verts, tris, w, size=260):
    """Front view, dominant bone color per triangle (painter's sort by depth)."""
    H = np.ptp(verts[:, 2])
    pixel = H / size
    grid = Grid2D.fit(verts, 0, 2, pixel)
    img = Image.new('RGB', (grid.width, grid.height), (16, 16, 20))
    draw = ImageDraw.Draw(img)
    dominant = np.argmax(w, axis=1)
    depth = verts[tris].mean(1)[:, 1]
    for t in np.argsort(-depth):  # back to front (front = -Y)
        tri = tris[t]
        rows, cols = grid.to_pixel(verts[tri, 0], verts[tri, 2])
        pts = [(c, grid.height - 1 - r) for r, c in zip(rows, cols)]
        color = PALETTE[np.bincount(dominant[tri], minlength=len(REGIONS)).argmax()]
        draw.polygon(pts, fill=tuple(int(c) for c in color))
    return img


tiles, lines = [], []
for gt_path in sorted(glob.glob(os.path.join(gt_dir, '*.npz'))):
    name = os.path.basename(gt_path)[:-4]
    ours_path = os.path.join(ours_dir, name + '.npz')
    if not os.path.exists(ours_path):
        continue
    gt, ours = np.load(gt_path), np.load(ours_path)
    if len(gt['verts']) != len(ours['verts']):
        lines.append(f'{name}: vertex count differs')
        continue
    mismatch = np.abs(gt['verts'] - ours['verts']).max()
    wg = folded(gt['bone_names'], gt['weights'])
    wo = folded(ours['bone_names'], ours['weights'])
    diff = 0.5 * np.abs(wg - wo).sum(1)
    agree = (wg.argmax(1) == wo.argmax(1)).mean()
    lines.append(f'{name:15s} weight diff {diff.mean():.3f} (p90 {np.percentile(diff, 90):.3f})  dominant agree {agree * 100:5.1f}%  vert mismatch {mismatch:.1e}')
    a, b = render(gt['verts'], gt['tris'], wg), render(ours['verts'], ours['tris'], wo)
    tile = Image.new('RGB', (a.width + b.width + 4, a.height + 16), (8, 8, 10))
    tile.paste(a, (0, 16))
    tile.paste(b, (a.width + 4, 16))
    ImageDraw.Draw(tile).text((3, 2), f'{name}  mixamo | ours   diff {diff.mean():.2f}', fill=(230, 230, 230))
    tiles.append(tile)

print('\n'.join(lines))
if tiles:
    cols = 3
    cw, ch = max(t.width for t in tiles), max(t.height for t in tiles)
    sheet = Image.new('RGB', (cols * cw, ((len(tiles) + cols - 1) // cols) * ch), (8, 8, 10))
    for i, t in enumerate(tiles):
        sheet.paste(t, ((i % cols) * cw, (i // cols) * ch))
    sheet.save(out_png)
