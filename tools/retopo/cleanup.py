"""Unfold a quad remesh: no quad folded over its own corner.

Instant Meshes leaves a handful of quads with a reflex corner (scaled Jacobian <= 0), almost always at a
valence-3 vertex that landed a little off, and the odd doublet (an interior vertex shared by only two
quads, a 180-degree corner). Both render as folds once triangulated. Here:
1. doublets are dissolved (their two quads merge into one) where the merged quad is sound;
2. around each folded quad the vertices are relaxed toward their neighbours and projected back onto the
   surface, growing the region until nothing folds. Boundary vertices stay put, and so do tips and
   creases (relaxing them would slide them off the feature and shave it);
3. a quad that still folds is split into two triangles across its reflex corner.

    from cleanup import unfold
    verts, polys, stats = unfold(verts, polys, surface_trimesh)
"""
from collections import defaultdict

import numpy as np
import trimesh
from scipy.spatial import cKDTree

GOOD = 0.03     # relax until every corner's scaled Jacobian is above this (0 = folded)
SPLIT = 0.01    # still at or below this after relaxing: split (a margin, so rounding on export can't refold it)
SHARP = 0.25    # a vertex this far off its neighbours' plane (in edge lengths) is a tip or crease: pinned


def corner_quality(verts, quads):
    """Scaled Jacobian of every quad corner, signed by the quad's diagonal normal (as the bench scores it)."""
    if len(quads) == 0:
        return np.zeros((0, 4))
    P = verts[quads]
    normal = np.cross(P[:, 2] - P[:, 0], P[:, 3] - P[:, 1])
    normal /= np.maximum(np.linalg.norm(normal, axis=1, keepdims=True), 1e-15)
    e_next, e_prev = np.roll(P, -1, axis=1) - P, np.roll(P, 1, axis=1) - P
    lengths = np.linalg.norm(e_next, axis=2) * np.linalg.norm(e_prev, axis=2)
    return (np.cross(e_next, e_prev) * normal[:, None, :]).sum(2) / np.maximum(lengths, 1e-15)


class Surface:
    """Closest points on a triangle mesh, without rtree: candidate triangles from the nearest of points
    spread over the surface (centroids, plus extra points along long triangles so slivers are found too),
    then exact."""

    def __init__(self, mesh, k=16):
        self.triangles = np.asarray(mesh.triangles, dtype=np.float64)
        T = self.triangles
        longest = np.linalg.norm(T - np.roll(T, 1, axis=1), axis=2).max(1)
        extra = np.ceil(longest / max(np.median(longest), 1e-12)).astype(np.int64) - 1
        owner = np.repeat(np.arange(len(T)), extra)
        rng = np.random.default_rng(0)
        bary = rng.random((len(owner), 2))
        flip = bary.sum(1) > 1
        bary[flip] = 1 - bary[flip]
        spread = T[owner, 0] + bary[:, :1] * (T[owner, 1] - T[owner, 0]) + bary[:, 1:] * (T[owner, 2] - T[owner, 0])
        self.owner = np.concatenate([np.arange(len(T)), owner])
        self.tree = cKDTree(np.vstack([T.mean(1), spread]))
        self.k = min(k, len(self.owner))

    def project(self, points):
        _, idx = self.tree.query(points, self.k)
        candidates = self.owner[idx.reshape(len(points), self.k)]
        queries = np.repeat(points, self.k, axis=0)
        closest = trimesh.triangles.closest_point(self.triangles[candidates.ravel()], queries).reshape(len(points), self.k, 3)
        best = ((closest - points[:, None, :]) ** 2).sum(2).argmin(1)
        return closest[np.arange(len(points)), best]


def _edges(polys):
    faces_of = defaultdict(list)
    for f, ring in enumerate(polys):
        for i, v in enumerate(ring):
            faces_of[frozenset((v, ring[(i + 1) % len(ring)]))].append(f)
    return faces_of


def _sharp(verts, polys, neighbours):
    """Vertices far off the plane of their neighbours, relative to their edge lengths: tips and creases."""
    normals = np.zeros_like(verts)
    for ring in polys:
        P = verts[ring]
        n = np.cross(P[2] - P[0], P[-1] - P[1]) if len(ring) == 4 else np.cross(P[1] - P[0], P[2] - P[0])
        normals[ring] += n
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-15)
    sharp = np.zeros(len(verts), dtype=bool)
    for v, n in enumerate(neighbours):
        if len(n):
            offset = verts[v] - verts[n].mean(0)
            edge = np.linalg.norm(verts[n] - verts[v], axis=1).mean()
            sharp[v] = abs(offset @ normals[v]) > SHARP * edge
    return sharp


def dissolve_doublets(verts, polys):
    """Merge the two quads around every interior vertex that only they share. Returns (polys, count)."""
    polys = [list(p) for p in polys]
    count = 0
    while True:
        faces_of = _edges(polys)
        boundary = {v for e, fs in faces_of.items() if len(fs) == 1 for v in e}
        around = defaultdict(list)
        for f, ring in enumerate(polys):
            for v in ring:
                around[v].append(f)
        dead = set()
        for v, fs in around.items():
            if len(fs) != 2 or v in boundary or any(f in dead for f in fs) or any(len(polys[f]) != 4 for f in fs):
                continue
            a_ring, b_ring = polys[fs[0]], polys[fs[1]]
            i = a_ring.index(v)
            _, a, x, b = a_ring[i:] + a_ring[:i]                  # v -> a -> x -> b
            j = b_ring.index(v)
            _, b2, y, a2 = b_ring[j:] + b_ring[:j]                # v -> b -> y -> a
            if (a2, b2) != (a, b) or x == y:
                continue
            # Only where the merge is harmless: the merged quad doesn't fold, and the doublet vertex lies
            # near its plane (otherwise it holds up a bump or tip that the merge would shave off).
            merged = np.array([a, x, b, y])
            P = verts[merged]
            normal = np.cross(P[2] - P[0], P[3] - P[1])
            normal /= max(np.linalg.norm(normal), 1e-15)
            edge = np.linalg.norm(P - np.roll(P, 1, axis=0), axis=1).mean()
            if corner_quality(verts, merged[None]).min() <= GOOD or abs((verts[v] - P.mean(0)) @ normal) > SHARP * edge:
                continue
            polys[fs[0]] = [a, x, b, y]
            polys[fs[1]] = None
            dead.update(fs)
            count += 1
        polys = [p for p in polys if p is not None]
        if not dead:
            return polys, count


def unfold(verts, polys, surface, rounds=8):
    """Relax folded quads' neighbourhoods onto `surface` (a trimesh); split what won't unfold."""
    verts = np.array(verts, dtype=np.float64)
    surface = Surface(surface)
    polys, doublets = dissolve_doublets(verts, polys)
    used = np.unique([v for p in polys for v in p])
    remap = np.full(len(verts), -1)
    remap[used] = np.arange(len(used))
    verts = verts[used]
    polys = [[int(remap[v]) for v in p] for p in polys]

    faces_of = _edges(polys)
    boundary = np.zeros(len(verts), dtype=bool)
    neighbours = [set() for _ in verts]
    for e, fs in faces_of.items():
        u, w = tuple(e)
        neighbours[u].add(w)
        neighbours[w].add(u)
        if len(fs) == 1:
            boundary[u] = boundary[w] = True
    neighbours = [np.fromiter(n, dtype=np.int64) for n in neighbours]
    pinned = boundary | _sharp(verts, polys, neighbours)
    quad_ids = np.array([f for f, p in enumerate(polys) if len(p) == 4], dtype=np.int64)
    quads = np.array([polys[f] for f in quad_ids], dtype=np.int64).reshape(-1, 4)

    folded_before = int((corner_quality(verts, quads).min(1) <= 0).sum())
    moved = set()
    for r in range(rounds):
        bad = np.flatnonzero(corner_quality(verts, quads).min(1) <= GOOD)
        if len(bad) == 0:
            break
        region = set(quads[bad].ravel().tolist())
        for _ in range(r // 2):                                  # grow by a ring every other round
            region |= {int(u) for v in region for u in neighbours[v]}
        region = np.array(sorted(v for v in region if not pinned[v]), dtype=np.int64)
        if len(region) == 0:
            break
        for _ in range(6):
            target = np.array([verts[neighbours[v]].mean(0) for v in region])
            verts[region] = 0.5 * verts[region] + 0.5 * target
            verts[region] = surface.project(verts[region])
        moved.update(region.tolist())

    quality = corner_quality(verts, quads)
    split = 0
    out = [p for p in polys]
    for k in np.flatnonzero(quality.min(1) <= SPLIT):
        c = int(np.argmin(quality[k]))
        ring = quads[k].tolist()
        ring = ring[c:] + ring[:c]                               # reflex corner first
        out[quad_ids[k]] = None
        out += [[ring[0], ring[1], ring[2]], [ring[0], ring[2], ring[3]]]
        split += 1
    out = [p for p in out if p is not None]
    stats = {'doublets': doublets, 'folded': folded_before, 'relaxed_vertices': len(moved), 'pinned': int(pinned.sum()),
             'split': split}
    return verts, out, stats
