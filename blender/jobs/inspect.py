"""Inspect an imported file: what is it (mesh, rigged character, animation), which rig preset, stats.
Writes a normalized preview GLB and, for unrigged humanoid meshes, auto-detected joint positions.

blender -b --factory-startup --python inspect.py -- --input <file> --out <dir> [--animations]
  [--scale <s>] [--ground] [--fingers none|one|two|full] [--overrides <textures dir>]
--animations keeps the model's own animations in the preview (an accessory's: a mechanism's moving parts).
--scale and --ground size a character (Import -> Size) and stand it on the floor, rigged or not: a rigged file's
skeleton is sized with its skin, so later imports keep the size the character was given.
"""
import argparse
import os
import sys

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
sys.path.insert(0, os.path.join(HERE, '..', 'autorig'))

from common import report, scene_io  # noqa: E402
from common.rigs import detect_preset, normalize_bone_names  # noqa: E402


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--input', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--fingers', default='full')
    p.add_argument('--overrides')
    p.add_argument('--scale', type=float, default=1.0, help="a character's size against its file (Import -> Size)")
    p.add_argument('--ground', action='store_true', help='a character: sized by --scale and stood on the floor (lowest point at 0)')
    p.add_argument('--animations', action='store_true')
    p.add_argument('--no-joints', action='store_true', help='gear: a model worn, not a body (no human joint detection)')
    a = p.parse_args(report.args())
    os.makedirs(a.out, exist_ok=True)
    warnings = []

    report.progress(0.1, 'Importing')
    scene_io.reset()
    meshes = scene_io.import_any(a.input, a.overrides)
    armatures = [o for o in bpy.data.objects if o.type == 'ARMATURE']
    skinned = [m for m in meshes if any(mod.type == 'ARMATURE' and mod.object for mod in m.modifiers)]
    has_action = any(a.animation_data and a.animation_data.action for a in armatures)

    if armatures and not meshes:
        kind = 'animation'
    elif armatures and skinned:
        kind = 'rigged'
    elif meshes:
        kind = 'mesh'
    else:
        raise SystemExit('Nothing to import: no meshes or skeletons found')

    preset = None
    bones = 0
    if armatures:
        arm = max(armatures, key=lambda o: len(o.data.bones))
        bones = len(arm.data.bones)
        preset = detect_preset([b.name for b in arm.data.bones])
        if preset == 'mixamo':
            normalize_bone_names(arm, meshes)

    if kind in ('mesh', 'rigged') and a.ground:
        # (a rigged file's armature goes with its skin; apply_rig_scale below bakes both into the bones and vertices)
        rig = arm if kind == 'rigged' else None
        scene_io.scale_model(meshes, a.scale, rig)
        moved = scene_io.ground(meshes, rig)
        if abs(moved) > 1e-3:
            warnings.append(f'Stood on the floor: moved {moved:+.3f} up (its lowest point was off the ground).')

    report.progress(0.4, 'Measuring')
    verts, tris = scene_io.mesh_arrays(meshes) if meshes else (np.zeros((0, 3)), np.zeros((0, 3), dtype=int))
    stats = {
        'vertices': int(len(verts)), 'triangles': int(len(tris)), 'meshes': len(meshes), 'bones': bones,
        'height': float(np.ptp(verts[:, 2])) if len(verts) else 0.0,
    }

    joints = None
    if kind == 'mesh' and not a.no_joints:
        report.progress(0.6, 'Finding joints')
        try:
            from landmarks import detect_markers
            from skeleton import build_joints
            sil, markers = detect_markers(verts, tris)
            found = build_joints(sil, markers, fingers=a.fingers)
            joints = {k: report.to_gltf(v) for k, v in found.items()}
            if markers['legs'] is None:
                warnings.append('Legs are hidden (robe or skirt); hip height estimated from proportions.')
            for side in ('left', 'right'):
                if markers['arms'][side] is None:
                    warnings.append(f'Could not trace the {side} arm.')
        except Exception as error:  # Not a humanoid in A/T pose: the user places joints by hand.
            warnings.append(f'Automatic joint detection failed: {error}')

    report.progress(0.8, 'Writing preview')
    if kind == 'rigged':
        scene_io.apply_rig_scale(arm, meshes)
        scene_io.export_glb(os.path.join(a.out, 'model.glb'), arm, meshes, animations=a.animations)
    elif kind == 'mesh':
        if not a.animations:
            scene_io.strip_existing_rigs(meshes)
        scene_io.export_glb(os.path.join(a.out, 'model.glb'), None, meshes, animations=a.animations)

    report.result({'kind': kind, 'rigPreset': preset, 'stats': stats, 'joints': joints,
                   'model': 'model.glb' if kind != 'animation' else None, 'animated': has_action, 'warnings': warnings})


try:
    main()
finally:
    scene_io.cleanup()
