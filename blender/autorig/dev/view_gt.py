"""Contact sheet of front/side silhouettes with ground-truth (and optionally detected) joints.

python3 view_gt.py <gt_dir> <out.png> [detected.json]
"""
import glob
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from raster import Grid2D, close, sample_surface  # noqa: E402

gt_dir, out_path = sys.argv[1], sys.argv[2]
detected = json.load(open(sys.argv[3])) if len(sys.argv) > 3 else {}
tiles = []
for path in sorted(glob.glob(os.path.join(gt_dir, '*.npz'))):
    name = os.path.basename(path)[:-4]
    data = np.load(path)
    verts, tris = data['verts'], data['tris']
    height = verts[:, 2].max() - verts[:, 2].min()
    if height < 0.1:
        continue
    pixel = height / 300
    points = sample_surface(verts, tris, pixel)
    joints = {n: data['heads'][i] for i, n in enumerate(data['bone_names'])}
    tile_parts = []
    for h_axis in (0, 1):
        grid = Grid2D.fit(points, h_axis, 2, pixel)
        image = close(grid.rasterize(points), 2)
        rgb = np.where(image[::-1, :, None], np.array([70, 70, 80], np.uint8), np.array([18, 18, 22], np.uint8))
        canvas = Image.fromarray(rgb.astype(np.uint8))
        draw = ImageDraw.Draw(canvas)

        def mark(point, color, size=2):
            row, col = grid.to_pixel(point[h_axis], point[2])
            y = grid.height - 1 - row
            draw.ellipse([col - size, y - size, col + size, y + size], fill=color)

        for i, bone in enumerate(data['bone_names']):
            parent = data['parents'][i]
            if parent >= 0:
                a, b = data['heads'][parent], data['heads'][i]
                ra, ca = grid.to_pixel(a[h_axis], a[2])
                rb, cb = grid.to_pixel(b[h_axis], b[2])
                draw.line([ca, grid.height - 1 - ra, cb, grid.height - 1 - rb], fill=(90, 200, 120), width=1)
            mark(joints[bone], (90, 220, 130))
        for bone, point in detected.get(name, {}).items():
            mark(np.array(point), (255, 90, 60), 3)
        tile_parts.append(canvas)
    w = sum(p.width for p in tile_parts) + 6
    h = max(p.height for p in tile_parts) + 18
    tile = Image.new('RGB', (w, h), (10, 10, 12))
    x = 0
    for part in tile_parts:
        tile.paste(part, (x, 18))
        x += part.width + 6
    ImageDraw.Draw(tile).text((4, 3), name, fill=(220, 220, 220))
    tiles.append(tile)

cols = 4
rows = (len(tiles) + cols - 1) // cols
cell_w = max(t.width for t in tiles)
cell_h = max(t.height for t in tiles)
sheet = Image.new('RGB', (cols * cell_w, rows * cell_h), (10, 10, 12))
for i, tile in enumerate(tiles):
    sheet.paste(tile, ((i % cols) * cell_w, (i // cols) * cell_h))
sheet.save(out_path)
print('wrote', out_path, sheet.size)
