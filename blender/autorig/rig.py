"""Auto-rig a humanoid mesh with the Mixamo skeleton.

blender -b --factory-startup --python rig.py -- --input char.fbx --output rigged.glb
    [--fingers none|one|two|full] [--joints joints.json] [--report report.json] [--dump weights.npz]

--joints overrides detection with user-edited joint positions ({bone: [x, y, z]}, Blender world space).
The report has the detected markers, joint positions and warnings so the UI can show and edit them.
"""
import argparse
import json
import os
import sys
import time

import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..'))

import mixamo  # noqa: E402
from common import report, scene_io  # noqa: E402
from landmarks import detect_markers  # noqa: E402
from skeleton import build_joints  # noqa: E402
import weights as weight_tools  # noqa: E402

YBOT = os.path.join(HERE, 'reference', 'ybot_frames.json')


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument('--input', required=True)
    p.add_argument('--output')
    p.add_argument('--fingers', default='two', choices=list(mixamo.FINGER_LEVELS))
    p.add_argument('--joints')
    p.add_argument('--overrides')
    p.add_argument('--template', help='creature template JSON (static/templates/*.json); joints required')
    p.add_argument('--report')
    p.add_argument('--dump')
    p.add_argument('--no-segments', action='store_true', help='plain bone heat (for comparison)')
    return p.parse_args(argv)


def reference_frames():
    """Mixamo bone axes (Y Bot rest pose, Blender world space): {bone: {'y': [...], 'z': [...]}}."""
    if os.path.exists(YBOT):
        return json.load(open(YBOT))
    return {}


def child_of(bone, bones):
    """The joint a bone points at: its main child (continuation of the chain)."""
    children = [b for b, parent in bones if parent == bone]
    if not children:
        return None
    preferred = {'Hips': 'Spine', 'Spine2': 'Neck', 'LeftHand': 'LeftHandMiddle1', 'RightHand': 'RightHandMiddle1'}
    if bone in preferred and preferred[bone] in children:
        return preferred[bone]
    return children[0]


def build_armature(joints, fingers, frames):
    bones = mixamo.hierarchy(fingers)
    data = bpy.data.armatures.new('Armature')
    arm = bpy.data.objects.new('Armature', data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    edit = {}
    for name, parent in bones:
        eb = data.edit_bones.new(name)
        head = Vector(joints[name])
        child = child_of(name, bones)
        if child is not None:
            tail = Vector(joints[child])
        else:
            # Leaf: continue the parent's direction with half its length.
            parent_head = Vector(joints[parent])
            tail = head + (head - parent_head) * 0.5
        if (tail - head).length < 1e-4:
            tail = head + Vector((0, 0, 0.01))
        eb.head, eb.tail = head, tail
        if parent is not None:
            eb.parent = edit[parent]
            eb.use_connect = False
        if name in frames:
            # Rotate the reference Z axis by the minimal rotation from the reference bone direction to ours.
            ref_y = Vector(frames[name]['y'])
            ref_z = Vector(frames[name]['z'])
            ours = (tail - head).normalized()
            z_axis = ref_y.rotation_difference(ours) @ ref_z
            eb.align_roll(z_axis)
        eb.use_deform = not mixamo.is_leaf_end(name)
        edit[name] = eb
    bpy.ops.object.mode_set(mode='OBJECT')
    return arm


def build_template_armature(joints, template):
    """Armature for a creature template: its hierarchy at the given joint positions (Blender space)."""
    order = [b for b in template['order'] if b in joints]
    parents = template['parents']
    children = {b: [c for c in order if parents.get(c) == b] for b in order}
    data = bpy.data.armatures.new('Armature')
    arm = bpy.data.objects.new('Armature', data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    edit = {}
    for name in order:
        eb = data.edit_bones.new(name)
        head = Vector(joints[name])
        kids = children[name]
        if len(kids) == 1:
            tail = Vector(joints[kids[0]])
        elif kids:
            tail = sum((Vector(joints[k]) for k in kids), Vector()) / len(kids)
        elif parents.get(name) in joints:
            tail = head + (head - Vector(joints[parents[name]])) * 0.5
        else:
            tail = head + Vector((0, 0, 0.05))
        if (tail - head).length < 1e-4:
            tail = head + Vector((0, 0, 0.01))
        eb.head, eb.tail = head, tail
        parent = parents.get(name)
        if parent in edit:
            eb.parent = edit[parent]
        lowered = name.lower()
        eb.use_deform = not (name == 'root' or 'leaf' in lowered or lowered.endswith('tip') or lowered.endswith('_end') or not kids and 'end' in lowered)
        edit[name] = eb
    bpy.ops.object.mode_set(mode='OBJECT')
    return arm


def main():
    args = parse_args()
    started = time.time()
    warnings = []
    scene_io.reset()
    meshes = scene_io.import_any(args.input, args.overrides)
    if not meshes:
        raise SystemExit('No meshes found in ' + args.input)
    scene_io.strip_existing_rigs(meshes)
    verts, tris = scene_io.mesh_arrays(meshes)

    markers = None
    report.progress(0.15, 'Placing joints')
    template = json.load(open(args.template)) if args.template else None
    if template is not None:
        if not args.joints:
            raise SystemExit('A creature template needs joint positions (--joints)')
        joints = {k: np.array(report.from_gltf(v)) for k, v in json.load(open(args.joints)).items()}
    elif args.joints:
        # User-edited joints arrive in glTF space (Y up, +Z forward).
        joints = {k: np.array(report.from_gltf(v)) for k, v in json.load(open(args.joints)).items()}
        expected = [b for b, _ in mixamo.hierarchy(args.fingers)]
        missing = [b for b in expected if b not in joints]
        if missing:
            # Joints from a different finger level: fill in from detection.
            sil, markers = detect_markers(verts, tris)
            auto = build_joints(sil, markers, fingers=args.fingers)
            for b in missing:
                joints[b] = auto[b]
    else:
        sil, markers = detect_markers(verts, tris)
        joints = build_joints(sil, markers, fingers=args.fingers)
        for side in ('left', 'right'):
            if markers['arms'][side] is None:
                warnings.append(f'{side} arm not traced; used proportions')
        if markers['legs'] is None:
            warnings.append('legs not separable (robe or skirt); hip height from proportions')

    report.progress(0.3, 'Building skeleton')
    if template is not None:
        arm = build_template_armature(joints, template)
        report.progress(0.45, 'Computing skin weights')
        stats = weight_tools.skin(meshes, arm, verts, tris, steer=False, method='heat')
    else:
        arm = build_armature(joints, args.fingers, reference_frames())
        report.progress(0.45, 'Computing skin weights')
        stats = weight_tools.skin(meshes, arm, verts, tris, steer=not args.no_segments)
    report.progress(0.85, 'Writing GLB')
    warnings += stats.pop('warnings', [])

    if args.dump:
        names = [b.name for b in arm.data.bones]
        w = weight_tools.weight_matrix(meshes, names)
        np.savez_compressed(args.dump, bone_names=np.array(names), heads=np.array([joints[n] for n in names]),
                            verts=verts, tris=tris, weights=w)
    if args.output:
        scene_io.export_glb(args.output, arm, meshes)
    summary = {
        'output': args.output, 'fingers': args.fingers,
        'joints': {k: report.to_gltf(v) for k, v in joints.items()},
        'height': float(np.ptp(verts[:, 2])), 'vertices': int(len(verts)), 'triangles': int(len(tris)),
        'seconds': round(time.time() - started, 2), 'method': stats.get('method'), 'warnings': warnings,
    }
    if args.report:
        json.dump(summary, open(args.report, 'w'), indent=1)
    print('RIG_OK', json.dumps({'seconds': summary['seconds'], 'warnings': warnings}))
    report.result(summary)


if __name__ == '__main__':
    main()
