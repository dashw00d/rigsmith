"""Volume build: a clean, watertight stand-in for a character mesh (sparse voxels -> SurfaceNets).

npm run volume -- <in.glb|obj|ply|stl> <out.glb|obj|ply> [--voxel 0.01] [--close 0] [--smooth 0]
    [--fill winding|parity] [--no-shell] [--json]

AI meshes are open (cracks, cloth edges), self-intersecting where parts were fused and unevenly
triangulated. This voxelizes the solid (three sweep axes, so a hole can't empty a column) plus a
one-voxel shell around the surface (so single-layer cloth like capes and skirt flaps survives), seals
edge-only voxel contacts and meshes the result, giving a manifold, evenly sampled surface in the
same space as the input. Gaps narrower than about two voxels close; `--voxel` is a fraction of the
model's height (0.01 = 1 cm on a 1 m character keeps A-pose arms off the body and the hands; 0.005
adds surface detail at ~6x the cost).

Uses sparse-cubes (GPL-3.0) from the repo's .venv.
"""
import argparse
import json
import sys
import time

import numpy as np
import sparsecubes as sc
import trimesh


def build(mesh, voxel=0.01, close=0, fill='winding', shell=True, smooth=0):
    """Watertight stand-in of a trimesh mesh. Returns (trimesh, stats)."""
    started = time.time()
    height = float(np.ptp(mesh.vertices[:, 1])) or float(mesh.extents.max())
    spacing = voxel * height
    voxels = sc.voxelize(mesh, spacing=spacing, solid=True, fill=fill, axes=3)
    if shell:
        voxels = sc.binary.union(voxels, sc.voxelize(mesh, spacing=spacing, solid=False))
    if close > 0:
        voxels = sc.binary.closing(voxels, iterations=close)
    # Overlapping parts leave sealed pockets inside the body; their walls would be extra surfaces.
    voxels = sc.binary.fill_cavities(voxels, mode='exact')
    voxels = sc.binary.make_manifold(voxels)
    out = sc.mesh(voxels, spacing=spacing)
    if smooth > 0:
        # Taubin smoothing takes out the voxel stepping without shrinking the volume.
        trimesh.smoothing.filter_taubin(out, iterations=smooth)
    stats = {
        'spacing': spacing, 'voxels': int(len(voxels)), 'vertices': int(len(out.vertices)), 'faces': int(len(out.faces)),
        'watertight': bool(out.is_watertight), 'winding_consistent': bool(out.is_winding_consistent),
        'components': int(len(out.split(only_watertight=False))), 'seconds': round(time.time() - started, 2),
        'input': {'vertices': int(len(mesh.vertices)), 'faces': int(len(mesh.faces)), 'watertight': bool(mesh.is_watertight)},
    }
    return out, stats


def main():
    p = argparse.ArgumentParser()
    p.add_argument('input')
    p.add_argument('output')
    p.add_argument('--voxel', type=float, default=0.01, help="voxel size as a fraction of height")
    p.add_argument('--close', type=int, default=0, help='closing iterations (bridges gaps up to 2x this, can fuse parts)')
    p.add_argument('--fill', default='winding', choices=['winding', 'parity'])
    p.add_argument('--no-shell', action='store_true', help="don't keep single-layer surfaces (cloth) as thin solids")
    p.add_argument('--smooth', type=int, default=0, help='Taubin smoothing iterations (removes voxel stepping)')
    p.add_argument('--json', action='store_true')
    a = p.parse_args()
    mesh = trimesh.load(a.input, force='mesh')
    out, stats = build(mesh, a.voxel, a.close, a.fill, not a.no_shell, a.smooth)
    out.export(a.output)
    print(json.dumps(stats) if a.json else '\n'.join(f'{k}: {v}' for k, v in stats.items()))


if __name__ == '__main__':
    sys.exit(main())
