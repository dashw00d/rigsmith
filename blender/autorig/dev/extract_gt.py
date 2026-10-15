"""Dump ground truth from a Mixamo-rigged FBX: world joint heads, mesh, skin weights.

Run: blender -b --factory-startup --python extract_gt.py -- <rigged.fbx> <out.npz>
Coordinates are Blender world space (Z-up, character faces -Y), meters.
"""
import sys

import bpy
import numpy as np

src, out = sys.argv[sys.argv.index('--') + 1:][:2]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=src, automatic_bone_orientation=False, ignore_leaf_bones=False)

arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
mw = arm.matrix_world

bone_names = [b.name.split(':')[-1] for b in arm.data.bones]
heads = np.array([list(mw @ b.head_local) for b in arm.data.bones], dtype=np.float64)
tails = np.array([list(mw @ b.tail_local) for b in arm.data.bones], dtype=np.float64)
parents = np.array([arm.data.bones.find(b.parent.name) if b.parent else -1 for b in arm.data.bones])

verts, tris, weights = [], [], []
offset = 0
for ob in meshes:
    dg = bpy.context.evaluated_depsgraph_get()
    me = ob.data
    co = np.array([list(ob.matrix_world @ v.co) for v in me.vertices])
    me.calc_loop_triangles()
    tri = np.array([list(t.vertices) for t in me.loop_triangles]) + offset
    w = np.zeros((len(me.vertices), len(bone_names)))
    group_to_bone = {g.index: bone_names.index(g.name.split(':')[-1]) for g in ob.vertex_groups if g.name.split(':')[-1] in bone_names}
    for v in me.vertices:
        for g in v.groups:
            if g.group in group_to_bone:
                w[v.index, group_to_bone[g.group]] = g.weight
    verts.append(co); tris.append(tri); weights.append(w)
    offset += len(me.vertices)

np.savez_compressed(out, bone_names=np.array(bone_names), heads=heads, tails=tails, parents=parents,
                    verts=np.concatenate(verts), tris=np.concatenate(tris), weights=np.concatenate(weights))
print('GT_OK', out, len(bone_names), sum(len(v) for v in verts))
