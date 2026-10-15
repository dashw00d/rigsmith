#!/usr/bin/env python3
"""Compare three.js-skinned ybot.glb vertices with Blender's deformation of the original FBX.

  python3 skin_compare.py THREE.bin BLENDER.npz

Matches each glTF vertex (meshes in name order, as written by convert.py) to the source
vertex with the same rest position, then reports the deformed-position error.
"""
import sys

import numpy as np

three = np.fromfile(sys.argv[1], dtype=np.float32).reshape(-1, 6).astype(np.float64)
ref = np.load(sys.argv[2])
names = sorted(k[5:] for k in ref.files if k.startswith("rest_"))
off = 0
worst = 0.0
for n in names:
    rest_src, posed_src = ref["rest_" + n], ref["posed_" + n]
    # convert.py emits each mesh's vertices sorted by source vertex index (split by normal),
    # so walk both lists monotonically, matching on rest position.
    idx, k, j = [], off, 0
    while k < len(three) and j < len(rest_src):
        if np.abs(three[k, :3] - rest_src[j]).max() < 2e-6:
            idx.append(j)
            k += 1
        else:
            j += 1
    idx = np.array(idx)
    seg = three[off:k]
    err_rest = np.linalg.norm(seg[:, :3] - rest_src[idx], axis=1).max()
    err = np.linalg.norm(seg[:, 3:] - posed_src[idx], axis=1)
    moved = np.linalg.norm(posed_src[idx] - rest_src[idx], axis=1)
    print(f"{n}: {len(seg)} glTF verts -> {len(set(idx.tolist()))}/{len(rest_src)} source verts, "
          f"rest err {err_rest * 1000:.4f} mm, skinned err max {err.max() * 1000:.4f} mm "
          f"mean {err.mean() * 1000:.4f} mm (verts moved up to {moved.max():.3f} m)")
    worst = max(worst, err.max())
    off = k
print(f"matched {off}/{len(three)} vertices; worst skinned error {worst * 1000:.4f} mm")
sys.exit(0 if off == len(three) and worst < 1e-3 else 1)
