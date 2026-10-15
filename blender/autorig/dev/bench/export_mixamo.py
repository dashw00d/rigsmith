"""Export a Mixamo-rigged FBX as a GLB for the rig benchmark, the same way the app imports rigs.

blender -b --factory-startup --python export_mixamo.py -- <rigged.fbx> <out.glb>
"""
import os
import sys

import bpy

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
from common import scene_io  # noqa: E402

src, out = sys.argv[sys.argv.index('--') + 1:][:2]
scene_io.reset()
meshes = scene_io.import_any(src)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
arm.animation_data_clear()
scene_io.apply_rig_scale(arm, meshes)
scene_io.export_glb(out, arm, meshes)
print('EXPORT_OK', out)
