"""Record Mixamo bone axes from Y Bot so generated rigs share Mixamo's bone orientation conventions.

blender -b --factory-startup --python make_reference.py -- "<Y Bot.fbx>"
Writes ../reference/ybot_frames.json: {bone: {"y": [..], "z": [..]}} in Blender world space.
"""
import json
import os
import sys

import bpy

src = sys.argv[sys.argv.index('--') + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=src, automatic_bone_orientation=False, ignore_leaf_bones=False)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
rot = arm.matrix_world.to_3x3().normalized()
frames = {}
for bone in arm.data.bones:
    m = rot @ bone.matrix_local.to_3x3()
    frames[bone.name.split(':')[-1]] = {'y': list(m.col[1].normalized()), 'z': list(m.col[2].normalized())}
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'reference', 'ybot_frames.json')
os.makedirs(os.path.dirname(out), exist_ok=True)
json.dump(frames, open(out, 'w'), indent=1)
print('REF_OK', len(frames), out)
