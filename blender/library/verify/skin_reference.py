"""Blender side of the mannequin skinning check.

  blender -b --factory-startup --python skin_reference.py -- CHARACTER.fbx CLIP.fbx FRAME OUT.npz

Imports the original character FBX and the original clip FBX, puts the clip's action on the
character armature (same bone names and rest skeleton), evaluates the armature-deformed
meshes at FRAME and saves rest + deformed world vertex positions in canonical glTF space.
"""
import sys

import bpy
import numpy as np

char_path, clip_path, frame, out = sys.argv[sys.argv.index("--") + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=char_path)
char_objs = set(bpy.data.objects)
char_arm = next(o for o in char_objs if o.type == "ARMATURE")
meshes = sorted((o for o in char_objs if o.type == "MESH"), key=lambda o: o.name)
bpy.ops.import_scene.fbx(filepath=clip_path)
clip_arm = next(o for o in bpy.data.objects if o.type == "ARMATURE" and o not in char_objs)
act = clip_arm.animation_data.action
start = int(round(act.frame_range[0]))
char_arm.animation_data_create()
char_arm.animation_data.action = act
if hasattr(char_arm.animation_data, "action_slot") and act.slots:
    char_arm.animation_data.action_slot = act.slots[0]
C = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], dtype=np.float64)


def world_verts(ob, evaluated):
    dg = bpy.context.evaluated_depsgraph_get()
    src = ob.evaluated_get(dg) if evaluated else ob
    me = src.to_mesh() if evaluated else src.data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    W = np.array(src.matrix_world)
    p = co @ W[:3, :3].T + W[:3, 3]
    if evaluated:
        src.to_mesh_clear()
    return p @ C.T


rest = {m.name: world_verts(m, False) for m in meshes}
bpy.context.scene.frame_set(start + int(frame))
posed = {m.name: world_verts(m, True) for m in meshes}
np.savez(out, **{f"rest_{k}": v for k, v in rest.items()}, **{f"posed_{k}": v for k, v in posed.items()})
print("saved", out, {k: v.shape for k, v in posed.items()})
