"""Fit a quadruped template (horse, fox...) to a mesh along the mesh's own medial skeleton.

.venv/bin/python tools/creature_fit.py <model.glb> <template.json>

Prints {"joints": {name: [x, y, z]}, "notes": [...]} in the model's glTF space (Y up), or exits non-zero
when the mesh doesn't read as a quadruped (the caller then falls back to the bounding-box fit).

The bounding-box fit stretches the template to the model's bounds: cargo, saddles and manes skew it, and
a tail that hangs (instead of streaming out like the template's) ends up outside the mesh. Here the mesh
is voxelized and skeletonized (TEASAR, sparse-cubes); its branch tips are read as four feet, a tail, a
muzzle and ears. Starting from the bounding-box fit (its spine, neck and head heights are consistent):
- the legs stand on the mesh's leg columns below the belly, and keep the template's shape inside the body;
- the spine moves back or forward with the legs;
- the ears end at the mesh's ear tips and the tail is laid along the mesh's tail branch.
Left and right are mirrored.
"""
import argparse
import heapq
import json
import sys

import numpy as np
import sparsecubes as sc
import trimesh


def load_mesh(path):
    scene = trimesh.load(path)
    return scene.to_geometry() if hasattr(scene, 'to_geometry') else scene


def skeleton(mesh, height):
    spacing = 0.012 * height
    vox = sc.voxelize(mesh, spacing=spacing, solid=True, fill='winding', axes=3)
    vox = sc.binary.union(vox, sc.voxelize(mesh, spacing=spacing, solid=False))
    vox = sc.binary.fill_cavities(vox, mode='exact')
    offset = vox.min(0) - 2  # TEASAR wants non-negative voxel indices
    sk = sc.teasar_skeletonize(vox - offset, spacing=(spacing,) * 3, min_branch_length=0.06 * height)
    return (np.asarray(sk.nodes) + offset) * spacing, np.asarray(sk.edges)


class Graph:
    def __init__(self, points, edges):
        self.points = points
        self.adj = [[] for _ in range(len(points))]
        for a, b in edges:
            w = float(np.linalg.norm(points[a] - points[b]))
            self.adj[a].append((b, w))
            self.adj[b].append((a, w))

    def path(self, a, b):
        dist = {a: 0.0}
        prev = {}
        heap = [(0.0, a)]
        while heap:
            d, v = heapq.heappop(heap)
            if v == b:
                break
            if d > dist[v]:
                continue
            for u, w in self.adj[v]:
                if d + w < dist.get(u, np.inf):
                    dist[u] = d + w
                    prev[u] = v
                    heapq.heappush(heap, (d + w, u))
        out = [b]
        while out[-1] != a:
            out.append(prev[out[-1]])
        return out[::-1]


def polyline_at(points, fractions):
    """Points at arc-length fractions (0 = first point, 1 = last) of a polyline."""
    seg = np.linalg.norm(np.diff(points, axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)])
    total = cum[-1] if cum[-1] > 0 else 1.0
    out = []
    for f in fractions:
        s = np.clip(f, 0, 1) * total
        i = min(int(np.searchsorted(cum, s, side='right') - 1), len(seg) - 1)
        t = (s - cum[i]) / seg[i] if seg[i] > 0 else 0.0
        out.append(points[i] + t * (points[i + 1] - points[i]))
    return out


def leg_column(path, height):
    """The leg's upright run along its skeleton path (foot tip first).

    TEASAR ends a leg branch at the hoof's rim, not under the leg, so the first few nodes run diagonally
    across the hoof: the column starts 8% of the height up. It climbs while the path, looked at over 6%
    of the height, rises steeply and stays near that start (legs stand nearly upright seen from the front,
    so sideways drift is held tighter); it ends where the path bends into the body toward the spine.
    """
    y = path[:, 1]
    start = next((i for i in range(len(path)) if y[i] - y[0] >= 0.08 * height), len(path) - 1)
    top = start
    while top < len(path) - 1:
        ahead = next((j for j in range(top + 1, len(path)) if np.linalg.norm(path[j] - path[top]) >= 0.06 * height),
                     len(path) - 1)
        step = path[ahead] - path[top]
        drift = path[ahead] - path[start]
        if step[1] < 0.6 * np.linalg.norm(step) or abs(drift[0]) > 0.05 * height or abs(drift[2]) > 0.15 * height:
            break
        top += 1
    return path[start:top + 1]


def tree_path(parents, a, b):
    """Joints on the template tree path from a to b."""
    def up(x):
        out = [x]
        while parents.get(out[-1]) is not None:
            out.append(parents[out[-1]])
        return out
    pa, pb = up(a), up(b)
    common = next(x for x in pa if x in pb)
    return pa[:pa.index(common) + 1] + pb[:pb.index(common)][::-1]


def classify_template(t):
    J = {k: np.array(v) for k, v in t['joints'].items()}
    parents = t['parents']
    kids = {}
    for b, p in parents.items():
        kids.setdefault(p, []).append(b)
    leaves = [b for b in t['order'] if b not in kids]
    height = t['meshBox'][1][1] - t['meshBox'][0][1]
    feet = [b for b in leaves if J[b][1] < 0.1 * height]
    rest = [b for b in leaves if b not in feet]
    if len(feet) != 4 or not rest:
        return None
    tail = min(rest, key=lambda b: J[b][2])
    head = max(rest, key=lambda b: J[b][2])
    # The head joint: the first joint named like one on the way back from the muzzle tip, not a leaf
    # (horse.json's muzzle tip is 'head_leaf').
    head_joint = next((b for b in tree_path(parents, head, tail) if 'head' in b.lower() and b in kids), parents[head])
    ears = [b for b in rest if b not in (tail, head) and J[b][1] > J[head_joint][1] and head_joint in tree_path(parents, b, head)
            and 'ear' in b.lower()]
    return {'J': J, 'parents': parents, 'feet': feet, 'tail': tail, 'head': head, 'head_joint': head_joint, 'ears': ears}


def classify_mesh(points, graph, height, ground):
    deg = np.array([len(a) for a in graph.adj])
    ends = np.flatnonzero(deg == 1)
    # Feet: the four lowest tips, all near the ground (a hanging tail can reach low too).
    low = sorted(ends, key=lambda e: points[e][1])
    feet = low[:4]
    if len(feet) != 4 or any(points[e][1] - ground > 0.08 * height for e in feet):
        return None
    rest = [e for e in ends if e not in feet]
    if len(rest) < 2:
        return None
    tail = min(rest, key=lambda e: points[e][2])
    head = max(rest, key=lambda e: points[e][2])
    # Ears: a mirrored pair of tips above the muzzle, nearest to it.
    pairs = []
    for i, a in enumerate(rest):
        for b in rest[i + 1:]:
            pa, pb = points[a], points[b]
            if pa[0] * pb[0] < 0 and abs(pa[1] - pb[1]) < 0.05 * height and abs(pa[2] - pb[2]) < 0.05 * height \
                    and min(pa[1], pb[1]) > points[head][1] and a != head and b != head:
                d = np.linalg.norm((pa + pb) / 2 - points[head])
                if d < 0.6 * height:
                    pairs.append((d, a, b))
    ears = list(min(pairs)[1:]) if pairs else []
    return {'feet': feet, 'tail': tail, 'head': head, 'ears': ears}


def fit(mesh, template):
    V = np.asarray(mesh.vertices)
    ground, height = float(V[:, 1].min()), float(np.ptp(V[:, 1]))
    xc = float((V[:, 0].min() + V[:, 0].max()) / 2)
    tc = classify_template(template)
    if tc is None:
        raise SystemExit('template is not a quadruped')
    points, edges = skeleton(mesh, height)
    graph = Graph(points, edges)
    mc = classify_mesh(points, graph, height, ground)
    if mc is None:
        raise SystemExit('mesh does not read as a quadruped (need four feet, a head and a tail)')
    J, parents = tc['J'], tc['parents']

    def side(x):
        return 'l' if x > 0 else 'r'

    def is_front(name):
        return J[name][2] > 0.5 * (min(J[f][2] for f in tc['feet']) + max(J[f][2] for f in tc['feet']))
    tfeet = {(('front' if is_front(f) else 'back'), side(J[f][0])): f for f in tc['feet']}
    zmid = 0.5 * (min(points[e][2] for e in mc['feet']) + max(points[e][2] for e in mc['feet']))
    mfeet = {(('front' if points[e][2] > zmid else 'back'), side(points[e][0] - xc)): e for e in mc['feet']}
    if set(tfeet) != set(mfeet):
        raise SystemExit('feet not one per corner')

    # Start from the bounding-box fit (what the app did before): consistent spine, neck, head heights.
    lo, hi = np.array(template['meshBox'][0]), np.array(template['meshBox'][1])
    mlo, mhi = V.min(0), V.max(0)
    out = {b: mlo + (J[b] - lo) / np.maximum(hi - lo, 1e-9) * (mhi - mlo) for b in template['order']}
    # Legs stand on the mesh's leg columns. Below the belly each leg joint keeps its height and takes the
    # leg path's horizontal position there. Joints inside the body (hip, stifle, shoulder, elbow) keep the
    # template's leg shape: they move back or forward with the highest joint on the column, and their
    # sideways offset scales to it (the box's width counts cargo, the column doesn't).
    spine_chain = tree_path(parents, tc['tail'], tc['head'])
    box = {b: p.copy() for b, p in out.items()}
    shift = {}
    in_legs = set()
    for key, e in mfeet.items():
        leg = [b for b in tree_path(parents, tfeet[key], tc['tail']) if b not in spine_chain]   # foot first
        in_legs.update(leg)
        column = leg_column(points[graph.path(e, mc['head'])], height)
        on_column = [b for b in leg if out[b][1] <= column[-1][1]] or leg[:1]
        for b in on_column:
            y = out[b][1]
            if y <= column[0][1]:
                xz = column[0]
            else:
                i = max(0, min(int(np.searchsorted(column[:, 1], y) - 1), len(column) - 2))
                f = (y - column[i][1]) / max(column[i + 1][1] - column[i][1], 1e-9)
                xz = column[i] + f * (column[i + 1] - column[i])
            out[b] = np.array([xz[0], y, xz[2]])
        anchor = on_column[-1]
        shift[key] = (box[anchor][2], out[anchor][2] - box[anchor][2])
        width = (out[anchor][0] - xc) / (box[anchor][0] - xc if abs(box[anchor][0] - xc) > 1e-4 else 1e-4)
        for b in leg[len(on_column):]:
            out[b] = np.array([xc + (box[b][0] - xc) * width, box[b][1], box[b][2] + shift[key][1]])

    # The body moves back or forward with its legs: the spine takes the back legs' shift behind the hips,
    # the front legs' shift at the shoulders, a blend between, and fades to none at the head (the muzzle is
    # the box's front, so the box fit holds there).
    knots = sorted([np.mean([shift[(end, s_)][k] for s_ in 'lr']) for k in (0, 1)] for end in ('back', 'front'))
    knots.append([box[tc['head_joint']][2], 0.0])
    knots = np.array(knots)

    def under_head(b):
        while b is not None and b != tc['head_joint']:
            b = parents.get(b)
        return b is not None
    for b in template['order']:
        if b not in in_legs and not under_head(b):
            out[b][2] = box[b][2] + float(np.interp(box[b][2], knots[:, 0], knots[:, 1]))

    # Ears end at the mesh's ear tips (the chain bends over toward them, more at the tip).
    for leaf in tc['ears']:
        tip = next((e for e in mc['ears'] if side(points[e][0] - xc) == side(J[leaf][0])), None)
        if tip is not None:
            chain = tree_path(parents, leaf, tc['head_joint'])[:-1][::-1]           # ear base ... tip
            delta = points[tip] - out[leaf]
            for i, b in enumerate(chain):
                out[b] = out[b] + delta * (i + 1) / len(chain)

    # The tail follows the mesh's tail branch (a hanging tail, not the template's streaming one), from
    # the hips out to the tip.
    hips_side = tree_path(parents, tc['tail'], tfeet[('back', 'l')])
    root_of_tail = next(b for b in hips_side if b in tree_path(parents, tfeet[('back', 'l')], tc['head']))
    tail_chain = tree_path(parents, tc['tail'], root_of_tail)[:-1]          # tip ... first tail joint
    path = graph.path(mc['tail'], mc['head'])
    to_body = points[path[:max(2, len(path) // 4)]]
    # Walk the tail branch from the tip until it reaches the hips' distance from the tip.
    anchor = out[root_of_tail]
    reach = np.linalg.norm(points[mc['tail']] - anchor)
    cut = next((i for i, p_ in enumerate(to_body) if np.linalg.norm(p_ - points[mc['tail']]) >= reach), len(to_body) - 1)
    branch = np.vstack([to_body[:cut + 1], anchor])
    tp = np.array([J[b] for b in tail_chain + [root_of_tail]])
    seg = np.linalg.norm(np.diff(tp, axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)])
    for b, p_ in zip(tail_chain, polyline_at(branch, cum[:-1] / max(cum[-1], 1e-9))):
        out[b] = p_

    # Mirror to an exact symmetry plane.
    for a, b in template['mirror'].items():
        if a < b and a in out and b in out:
            pa, pb = out[a], out[b]
            mid = 0.5 * (pa + np.array([2 * xc - pb[0], pb[1], pb[2]]))
            out[a] = mid
            out[b] = np.array([2 * xc - mid[0], mid[1], mid[2]])
    for b in template['order']:
        if b not in template['mirror']:
            out[b][0] = xc
    notes = [f'skeleton: {len(points)} nodes; legs on their columns, tail along its branch'
             + (', ears on their tips' if mc['ears'] else '')]
    return {k: [round(float(x), 5) for x in v] for k, v in out.items()}, notes


def main():
    p = argparse.ArgumentParser()
    p.add_argument('model')
    p.add_argument('template')
    a = p.parse_args()
    joints, notes = fit(load_mesh(a.model), json.load(open(a.template)))
    print(json.dumps({'joints': joints, 'notes': notes}))


if __name__ == '__main__':
    sys.exit(main())
