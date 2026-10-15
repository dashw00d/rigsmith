"""Skin weights: robust bone heat (heat.py) against "weighting segments" that steer the distribution
toward Mixamo's, then influence limiting and normalization."""
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

import heat
import regions

MAX_INFLUENCES = 4


def weight_matrix(meshes, bone_names):
    """Dense (total_vertices, bones) weights for the given meshes, in order."""
    blocks = []
    index = {n: i for i, n in enumerate(bone_names)}
    for ob in meshes:
        w = np.zeros((len(ob.data.vertices), len(bone_names)))
        group_bone = {g.index: index[g.name] for g in ob.vertex_groups if g.name in index}
        for v in ob.data.vertices:
            for g in v.groups:
                b = group_bone.get(g.group)
                if b is not None:
                    w[v.index, b] = g.weight
        blocks.append(w)
    return np.concatenate(blocks)


def limit_and_normalize(w, max_influences=MAX_INFLUENCES, floor=0.02):
    w = np.where(w < floor, 0.0, w)
    if w.shape[1] > max_influences:
        keep = np.zeros(w.shape, dtype=bool)
        order = np.argsort(-w, axis=1)[:, :max_influences]
        np.put_along_axis(keep, order, True, axis=1)
        w = np.where(keep, w, 0.0)
    total = w.sum(axis=1, keepdims=True)
    return np.divide(w, total, out=np.zeros_like(w), where=total > 0)


def weighting_segments(armature, names, steer=True):
    if not steer:
        bones = armature.data.bones
        return np.array([list(bones[n].head_local) for n in names]), np.array([list(bones[n].tail_local) for n in names])
    """Bone segments used for weighting. With steer, reshape a few so heat spreads like Mixamo:
    clavicles only attract near the shoulder (chest goes to Spine2); thighs start lower and Hips reaches
    down to the crotch (pelvis and buttocks go to Hips)."""
    bones = armature.data.bones
    heads = np.array([list(bones[n].head_local) for n in names])
    tails = np.array([list(bones[n].tail_local) for n in names])
    if not steer:
        return heads, tails
    idx = {n: i for i, n in enumerate(names)}
    for side in ('Left', 'Right'):
        if side + 'Shoulder' in idx:
            i = idx[side + 'Shoulder']
            heads[i] = heads[i] + 0.55 * (tails[i] - heads[i])
        if side + 'UpLeg' in idx:
            i = idx[side + 'UpLeg']
            heads[i] = heads[i] + 0.18 * (tails[i] - heads[i])
    if 'Hips' in idx and 'LeftUpLeg' in idx and 'LeftLeg' in idx:
        up = bones['LeftUpLeg'].head_local.z
        thigh = up - bones['LeftLeg'].head_local.z
        heads[idx['Hips']][2] = up - 0.3 * thigh
    return heads, tails


def skin(meshes, armature, verts, tris, steer=True, method='regions'):
    deform = [b.name for b in armature.data.bones if b.use_deform]
    heads, tails = weighting_segments(armature, deform, steer)
    if method == 'regions':
        joints = {b.name: np.array(b.head_local) for b in armature.data.bones}
        attach_to, distance = regions.attach(verts, tris, deform, heads, tails, joints)
        w = heat.diffuse(verts, tris, attach_to, distance, len(deform))
    else:
        tree = BVHTree.FromPolygons([tuple(v) for v in verts], [tuple(t) for t in tris], all_triangles=True)

        def ray_cast(origin, direction, distance):
            return tree.ray_cast(Vector(origin), Vector(direction), distance)[0] is not None

        w = heat.bone_heat(verts, tris, heads, tails, ray_cast)
    w = limit_and_normalize(w)
    offset = 0
    for ob in meshes:
        n = len(ob.data.vertices)
        _bind(ob, armature, w[offset:offset + n], deform)
        offset += n
    return {'method': method, 'warnings': []}


def _bind(ob, armature, w, bone_names):
    ob.parent = armature
    ob.matrix_parent_inverse.identity()
    for mod in [m for m in ob.modifiers if m.type == 'ARMATURE']:
        ob.modifiers.remove(mod)
    mod = ob.modifiers.new('Armature', 'ARMATURE')
    mod.object = armature
    ob.vertex_groups.clear()
    for b, name in enumerate(bone_names):
        group = ob.vertex_groups.new(name=name)
        nz = np.flatnonzero(w[:, b] > 0)
        for i in nz:
            group.add([int(i)], float(w[i, b]), 'REPLACE')
