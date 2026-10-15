"""Retopology for AI meshes: volume build -> quad remesh -> xatlas UVs -> texture bake.

npm run retopo -- <in.glb|obj> <out.glb> [--remesher instant|quadwild] [--triangles 8000]
    [--texture 2048] [--voxel 0.005] [--crease 30] [--smooth 5] [--keep-work DIR] [--json]

Remeshers:
  instant   Instant Meshes (PyNanoInstantMeshes): uniform field-aligned quads, ~0.5 s.
  quadwild  QuadWild-BiMDF (binary release, RIGSMITH_QUADWILD or ~/dev/ml/quadwild-bimdf): traces
            feature-following patches and solves a global quad layout, ~40-60 s. Its size control has
            a floor set by the patch count, so very low targets come out above the target.

The Linux, in-repo take on MegaTopo's Blender + Instant Meshes mode:
  1. Volume build (tools/volume): a watertight, evenly sampled solid of the input, cloth kept.
  2. Instant Meshes (PyNanoInstantMeshes): field-aligned quad-dominant remesh at the target size.
  3. xatlas: a packed UV atlas (tighter than Smart UV Project, so more texels per pixel).
  4. Blender Cycles (blender/jobs/bake.py): diffuse colour baked from the original's texture,
     selected-to-active through a cage, then the GLB is written.
The input stays the bake source, so texture overrides and hole fills carry over.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

import numpy as np
import pynanoinstantmeshes as nim
import trimesh
import xatlas

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'volume'))
from build import build as volume_build  # noqa: E402


def progress(value, message):
    print('@@PROGRESS ' + json.dumps({'progress': value, 'message': message}), flush=True)


def remesh(mesh, triangles, crease, smooth):
    """Instant Meshes, quad-dominant; returns (vertices, quads-or-tris list, triangles array)."""
    quads = max(triangles // 2, 64)
    # The bindings' face/vertex counts don't match the CLI's; an edge length from the surface area does.
    # (Its scale is about half an edge: measured 3.8x the quads at sqrt(area / quads).)
    scale = 1.95 * float(np.sqrt(mesh.area / quads))
    verts, faces = nim.remesh(np.asarray(mesh.vertices, dtype=np.float32), np.asarray(mesh.faces, dtype=np.uint32),
                              vertex_count=-1, scale=scale, creaseAngle=float(crease), smooth_iter=int(smooth),
                              deterministic=True, posy=4, rosy=4, extrinsic=True)
    verts = np.asarray(verts, dtype=np.float64)
    faces = np.asarray(faces, dtype=np.int64)
    polys = []
    for f in faces:
        # Triangles come back as quads with a repeated corner.
        ring = [int(v) for i, v in enumerate(f) if v != f[i - 1]]
        if len(ring) >= 3 and len(set(ring)) == len(ring):
            polys.append(ring)
    out = quads_to_trimesh(verts, polys)
    return out, sum(1 for r in polys if len(r) == 4), len(polys)


QUADWILD = os.environ.get('RIGSMITH_QUADWILD', os.path.expanduser('~/dev/ml/quadwild-bimdf'))


def quads_to_trimesh(verts, polys):
    tris = []
    for ring in polys:
        if len(ring) == 3:
            tris.append(ring)
        elif len(ring) == 4:
            a, b, c, d = ring
            if np.linalg.norm(verts[a] - verts[c]) <= np.linalg.norm(verts[b] - verts[d]):
                tris += [[a, b, c], [a, c, d]]
            else:
                tris += [[a, b, d], [b, c, d]]
        elif len(ring) > 4:
            tris += [[ring[0], ring[i], ring[i + 1]] for i in range(1, len(ring) - 1)]
    out = trimesh.Trimesh(verts, np.array(tris), process=True)
    out.remove_unreferenced_vertices()
    return out


def read_obj_polys(path):
    verts, polys = [], []
    for line in open(path):
        if line.startswith('v '):
            verts.append([float(x) for x in line.split()[1:4]])
        elif line.startswith('f '):
            polys.append([int(t.split('/')[0]) - 1 for t in line.split()[1:]])
    return np.array(verts), polys


def remesh_quadwild(source, triangles, work):
    """QuadWild-BiMDF on a smoothed volume build; picks the flow scale that lands nearest the target."""
    solid, _ = volume_build(source, voxel=0.01, smooth=20)
    obj = os.path.join(work, 'qw.obj')
    solid.export(obj)
    setup = os.path.join(work, 'setup.txt')
    shutil.copy(os.path.join(QUADWILD, 'config', 'prep_config', 'basic_setup_Organic.txt'), setup)
    run = subprocess.run([os.path.join(QUADWILD, 'quadwild'), obj, '2', setup], cwd=QUADWILD, capture_output=True, text=True)
    traced = os.path.join(work, 'qw_rem_p0.obj')
    if not os.path.exists(traced):
        raise SystemExit('quadwild failed: ' + (run.stdout + run.stderr)[-800:])
    flow = open(os.path.join(QUADWILD, 'config', 'main_config', 'flow.txt')).read()
    target = max(triangles // 2, 64)
    tried = {}

    def attempt(scale):
        config = os.path.join(work, f'flow_{scale}.txt')
        open(config, 'w').write(flow.replace('scaleFact 1', f'scaleFact {scale}'))
        result = os.path.join(work, 'qw_rem_p0_1_quadrangulation_smooth.obj')
        if os.path.exists(result):
            os.remove(result)
        # It writes its result and then sometimes crashes on exit; the file is what counts.
        subprocess.run([os.path.join(QUADWILD, 'quad_from_patches'), traced, '1', config], cwd=QUADWILD, capture_output=True)
        if not os.path.exists(result):
            return None
        kept = os.path.join(work, f'quads_{scale}.obj')
        shutil.move(result, kept)
        tried[scale] = (sum(1 for line in open(kept) if line.startswith('f ')), kept)
        return tried[scale][0]

    count = attempt(3)
    if count is not None and count > 1.15 * target:
        attempt(6)
    elif count is not None and count < 0.85 * target:
        attempt(1.5)
    if not tried:
        raise SystemExit('quad_from_patches produced nothing')
    scale, (count, path) = min(tried.items(), key=lambda kv: abs(kv[1][0] - target))
    verts, polys = read_obj_polys(path)
    return quads_to_trimesh(verts, polys), sum(1 for r in polys if len(r) == 4), len(polys), scale


def main():
    p = argparse.ArgumentParser()
    p.add_argument('input')
    p.add_argument('output')
    p.add_argument('--remesher', default='instant', choices=['instant', 'quadwild'])
    p.add_argument('--triangles', type=int, default=8000, help='target triangle count (quads count as two)')
    p.add_argument('--texture', type=int, default=2048, help='baked texture size')
    p.add_argument('--voxel', type=float, default=0.005, help='volume build voxel, fraction of height')
    p.add_argument('--crease', type=float, default=30, help='crease angle Instant Meshes keeps sharp')
    p.add_argument('--smooth', type=int, default=5, help='Instant Meshes smoothing iterations')
    p.add_argument('--samples', type=int, default=8)
    p.add_argument('--keep-work', help='keep intermediate files in this directory')
    p.add_argument('--json', action='store_true')
    a = p.parse_args()
    started = time.time()
    stats = {}
    work = a.keep_work or tempfile.mkdtemp(prefix='rigsmith-retopo-')
    os.makedirs(work, exist_ok=True)
    try:
        progress(0.02, 'Reading the mesh')
        source = trimesh.load(a.input, force='mesh')
        stats['input'] = {'vertices': int(len(source.vertices)), 'triangles': int(len(source.faces))}

        t = time.time()
        if a.remesher == 'quadwild':
            progress(0.08, 'Remeshing (QuadWild-BiMDF)')
            retopo, quads, polys, scale = remesh_quadwild(source, a.triangles, work)
            stats['remesh'] = {'remesher': 'quadwild', 'scale': scale}
        else:
            progress(0.08, 'Building the volume')
            solid, vstats = volume_build(source, voxel=a.voxel)
            stats['volume'] = {k: vstats[k] for k in ('spacing', 'faces', 'watertight', 'seconds')}
            progress(0.25, 'Remeshing (Instant Meshes)')
            t = time.time()
            retopo, quads, polys = remesh(solid, a.triangles, a.crease, a.smooth)
            stats['remesh'] = {'remesher': 'instant'}
        stats['remesh'].update({'polygons': polys, 'quads': quads, 'triangles': int(len(retopo.faces)),
                                'vertices': int(len(retopo.vertices)), 'watertight': bool(retopo.is_watertight),
                                'seconds': round(time.time() - t, 2)})

        progress(0.4, 'Unwrapping UVs (xatlas)')
        t = time.time()
        atlas = xatlas.Atlas()
        atlas.add_mesh(np.asarray(retopo.vertices, dtype=np.float32), np.asarray(retopo.faces, dtype=np.uint32),
                       np.asarray(retopo.vertex_normals, dtype=np.float32))
        pack = xatlas.PackOptions()
        pack.resolution = a.texture
        pack.padding = max(2, a.texture // 256)
        pack.bilinear = True
        atlas.generate(pack_options=pack)
        vmap, faces, uvs = atlas[0]
        unwrapped = os.path.join(work, 'retopo.obj')
        xatlas.export(unwrapped, retopo.vertices[vmap], faces, uvs)
        stats['uv'] = {'charts': int(atlas.chart_count), 'utilization': round(float(atlas.utilization), 3),
                       'vertices': int(len(vmap)), 'seconds': round(time.time() - t, 2)}

        progress(0.5, 'Baking the texture')
        t = time.time()
        blender = os.environ.get('BLENDER', shutil.which('blender') or '/snap/bin/blender')
        height = float(np.ptp(source.vertices[:, 1]))
        cmd = [blender, '-b', '--factory-startup', '--python-exit-code', '1', '--python',
               os.path.join(ROOT, 'blender', 'jobs', 'bake.py'), '--',
               '--source', a.input, '--target', unwrapped, '--output', a.output, '--size', str(a.texture),
               '--samples', str(a.samples), '--cage', str(0.015 * height), '--max-ray', str(0.04 * height)]
        run = subprocess.run(cmd, capture_output=True, text=True)
        if run.returncode != 0 or not os.path.exists(a.output):
            tail = (run.stdout + run.stderr).strip().splitlines()[-12:]
            raise SystemExit('bake failed:\n' + '\n'.join(tail))
        for line in run.stdout.splitlines():
            if line.startswith('@@RESULT '):
                stats['bake'] = json.loads(line[9:])
        stats['bake'] = dict(stats.get('bake', {}), seconds=round(time.time() - t, 2))
        stats['seconds'] = round(time.time() - started, 2)
        progress(1.0, 'Done')
        print('@@RESULT ' + json.dumps(stats) if a.json else json.dumps(stats, indent=1), flush=True)
    finally:
        if not a.keep_work:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    main()
