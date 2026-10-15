"""Skin weights: robust bone heat (heat.py) against "weighting segments" that steer the distribution
toward Mixamo's, then influence limiting and normalization."""
import os

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

import heat
import regions

MAX_INFLUENCES = 4
# Benchmarked against Mixamo's rigs of the Tripo characters (dev/bench): tight attachment, rigid past
# a narrow blend band at each region border.
HEAT = float(os.environ.get('RIG_HEAT', 32))
LOCALIZE_HOPS = int(os.environ.get('RIG_LOCALIZE', 0))
BAND = float(os.environ.get('RIG_BAND', 0.04))


def localize(w, attach_to, armature, names, hops=2):
    """Keep only weights from bones within `hops` skeleton steps of the vertex's own bone.

    Heat flows across the surface into any nearby bone: the chest beside an A-pose arm picks up arm
    weight, hands resting on the hips pull the hips along. Two steps still lets neighbors blend
    smoothly (arm with clavicle and chest), but never chest with arm or hip with hand."""
    index = {n: i for i, n in enumerate(names)}
    bones = armature.data.bones
    adjacent = {n: set() for n in names}
    for n in names:
        b = bones[n]
        for other in ([b.parent] if b.parent else []) + list(b.children):
            if other.name in index:
                adjacent[n].add(other.name)
                adjacent[other.name].add(n)
    allowed = np.zeros((len(names), len(names)), dtype=bool)
    for i, n in enumerate(names):
        reach = {n}
        for _ in range(hops):
            reach |= {m for r in reach for m in adjacent[r]}
        allowed[i, [index[m] for m in reach]] = True
    out = np.where(allowed[attach_to], w, 0.0)
    total = out.sum(axis=1, keepdims=True)
    return np.divide(out, total, out=np.zeros_like(out), where=total > 0)


def boundary_distance(verts, tris, labels):
    """Geodesic distance (over mesh edges) from each vertex to the nearest region border."""
    import heapq
    edges = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    edges = np.unique(np.sort(edges, axis=1), axis=0)
    lengths = np.linalg.norm(verts[edges[:, 0]] - verts[edges[:, 1]], axis=1)
    n = len(verts)
    border = np.zeros(n, dtype=bool)
    cross = labels[edges[:, 0]] != labels[edges[:, 1]]
    border[edges[cross].ravel()] = True
    # Coincident vertices (UV seams) are the same point: link them with zero-length edges.
    keys = np.round(verts / (1e-6 * max(float(np.ptp(verts[:, 2])), 1e-9))).astype(np.int64)
    _, inverse = np.unique(keys, axis=0, return_inverse=True)
    inverse = inverse.reshape(-1)
    order = np.argsort(inverse, kind='stable')
    same = inverse[order[1:]] == inverse[order[:-1]]
    welds = np.stack([order[1:][same], order[:-1][same]], axis=1)
    edges = np.concatenate([edges, welds])
    lengths = np.concatenate([lengths, np.zeros(len(welds))])
    neighbors = [[] for _ in range(n)]
    for (a, b), l in zip(edges.tolist(), lengths.tolist()):
        neighbors[a].append((b, l))
        neighbors[b].append((a, l))
    dist = np.full(n, np.inf)
    heap = [(0.0, int(v)) for v in np.flatnonzero(border)]
    for _, v in heap:
        dist[v] = 0.0
    heapq.heapify(heap)
    while heap:
        d, v = heapq.heappop(heap)
        if d > dist[v]:
            continue
        for u, l in neighbors[v]:
            if d + l < dist[u]:
                dist[u] = d + l
                heapq.heappush(heap, (d + l, u))
    return dist


def band_blend(verts, tris, w, attach_to, band):
    """Smooth (diffused) weights near region borders, rigid single-bone weights beyond `band`.

    Heat diffusion never lets a bone's weight reach zero, so the middle of a thigh still carries some
    hip and knee and bends a little with them. Mixamo's limbs are rigid between joints; so are ours
    past the blend band."""
    d = boundary_distance(verts, tris, attach_to)
    x = np.clip(d / band, 0.0, 1.0)
    alpha = 1.0 - x * x * (3 - 2 * x)  # smoothstep: 1 at the border, 0 past the band
    onehot = np.zeros_like(w)
    onehot[np.arange(len(w)), attach_to] = 1.0
    return alpha[:, None] * w + (1.0 - alpha[:, None]) * onehot


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
        w = heat.diffuse(verts, tris, attach_to, distance, len(deform), heat=HEAT)
        if LOCALIZE_HOPS:
            w = localize(w, attach_to, armature, deform, LOCALIZE_HOPS)
        if BAND > 0:
            w = band_blend(verts, tris, w, attach_to, BAND * float(np.ptp(verts[:, 2])))
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
