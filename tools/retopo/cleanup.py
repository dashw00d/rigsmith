"""Clean up a quad remesh: closed where the input is, manifold, and no quad folded over its own corner.

Remeshers leave three kinds of damage on AI meshes:
- Pinches: two sheets sharing an edge (4 faces on it) or a vertex, where nearby surfaces got merged.
- Holes: small boundary loops on a closed input.
- Folds: quads with a reflex corner (scaled Jacobian <= 0), almost always at a valence-3 vertex that landed
  a little off, and the odd doublet (an interior vertex shared by only two quads, a 180-degree corner).

The repairs, in order:
1. Coincident vertices are welded (remeshers emit some), and repeated faces dropped.
2. On a clean input (a closed solid, or a single part), pinches are split: the faces around a pinched edge
   pair up across the solid's inside, and each vertex is copied once per separate fan of faces, nudged
   into its fan. Holes that aren't the input's own boundaries are filled with quad fans centred on the
   surface. (On a messy input of overlapping parts these mirror its own overlaps; patching adds folds.)
3. Doublets are dissolved (their two quads merge into one) where the merged quad is sound.
4. Around each folded quad the vertices are relaxed toward their neighbours and projected back onto the
   input, growing the region until nothing folds. Boundary vertices stay put, and so do tips and creases
   (relaxing them would slide them off the feature and shave it), and vertices whose projection would
   leave the remesh's own layer (the nearest input surface can be an inner one).
5. A quad that still folds is split into two triangles across its reflex corner.

    from cleanup import clean
    verts, polys, stats = clean(verts, polys, surface_trimesh)
"""
import math
from collections import Counter, defaultdict

import numpy as np
import trimesh
from scipy.spatial import cKDTree

GOOD = 0.03     # relax until every corner's scaled Jacobian is above this (0 = folded)
SPLIT = 0.01    # still at or below this after relaxing: split (a margin, so rounding on export can't refold it)
SHARP = 0.25    # a vertex this far off its neighbours' plane (in edge lengths) is a tip or crease: pinned
NUDGE = 0.02    # a split vertex's copy moves this far into its own fan (fraction of the way to its centre)
MAX_HOLE = 64   # longer boundary loops are left open (a fan would be a poor patch)


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


def weld(verts, polys, tolerance=1e-6):
    """Merge vertices closer than `tolerance` x the bounding-box diagonal; drop faces that collapse."""
    verts = np.asarray(verts, dtype=np.float64)
    step = tolerance * max(float(np.linalg.norm(np.ptp(verts, axis=0))), 1e-12)
    _, first, inverse = np.unique(np.round(verts / step).astype(np.int64), axis=0, return_index=True, return_inverse=True)
    inverse = inverse.reshape(-1)
    out = []
    for p in polys:
        q = [int(inverse[v]) for v in p]
        q = [v for k, v in enumerate(q) if v != q[k - 1]]
        if len(q) >= 3 and len(set(q)) == len(q):
            out.append(q)
    return verts[first], out, len(verts) - len(first)


def remove_duplicates(polys):
    """Drop repeated faces, keeping one: extra copies of a face, and the mirror image of one (a sheet of no
    thickness keeps one side; dropping both would delete the cloth it stands for). Returns (polys, dropped)."""
    def cyclic(p):
        i = p.index(min(p))
        return tuple(p[i:] + p[:i])
    groups = defaultdict(lambda: defaultdict(list))
    for f, p in enumerate(polys):
        groups[tuple(sorted(p))][cyclic(list(p))].append(f)
    drop = set()
    for orientations in groups.values():
        faces = [f for same in orientations.values() for f in same]
        drop.update(faces[1:])
    return [list(p) for f, p in enumerate(polys) if f not in drop], len(drop)


def _face_normal(P):
    """Newell's normal of a polygon (unnormalized)."""
    Q = np.roll(P, -1, axis=0)
    return np.array([((P[:, 1] - Q[:, 1]) * (P[:, 2] + Q[:, 2])).sum(), ((P[:, 2] - Q[:, 2]) * (P[:, 0] + Q[:, 0])).sum(),
                     ((P[:, 0] - Q[:, 0]) * (P[:, 1] + Q[:, 1])).sum()])


def _pair_around(verts, polys, edge, faces):
    """Pair the faces around a pinched edge so each pair encloses the solid's inside between them."""
    a, b = edge
    axis = verts[b] - verts[a]
    axis = axis / max(np.linalg.norm(axis), 1e-15)
    ring = []
    for f in faces:
        c = verts[polys[f]].mean(0) - verts[a]
        out = c - (c @ axis) * axis
        ring.append((f, out / max(np.linalg.norm(out), 1e-15), _face_normal(verts[polys[f]])))
    e1 = ring[0][1]
    e2 = np.cross(axis, e1)
    ring.sort(key=lambda r: math.atan2(r[1] @ e2, r[1] @ e1))
    # Each face's normal points toward increasing or decreasing angle around the edge; the inside is the
    # other way. A pair (f, next g) is right when the wedge from f to g is inside for both.
    opens = [float(n @ np.cross(axis, out)) for _, out, n in ring]
    n = len(ring)
    for shift in (0, 1):
        pairs = [(k % n, (k + 1) % n) for k in range(shift, shift + n - n % 2, 2)]
        if all(opens[i] < 0 < opens[j] for i, j in pairs):
            return [(ring[i][0], ring[j][0]) for i, j in pairs]
    return []


def split_nonmanifold(verts, polys):
    """Give every sheet its own vertices where sheets touch. Returns (verts, polys, the separated vertices:
    originals and copies, which must stay apart)."""
    verts = np.asarray(verts, dtype=np.float64)
    by_edge = defaultdict(list)
    for f, p in enumerate(polys):
        for k, v in enumerate(p):
            w = p[(k + 1) % len(p)]
            by_edge[(min(v, w), max(v, w))].append(f)
    glued = defaultdict(list)                                  # vertex -> face pairs joined across its edges
    for e, fs in by_edge.items():
        pairs = [tuple(fs)] if len(fs) == 2 else _pair_around(verts, polys, e, fs) if len(fs) > 2 else []
        for v in e:
            glued[v] += pairs
    faces_of = defaultdict(list)
    for f, p in enumerate(polys):
        for v in p:
            faces_of[v].append(f)
    polys = [list(p) for p in polys]
    extra, touched = [], []
    for v, fs in faces_of.items():
        parent = {f: f for f in fs}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x
        for f, g in glued[v]:
            parent[find(f)] = find(g)
        fans = defaultdict(list)
        for f in fs:
            fans[find(f)].append(f)
        for fan in sorted(fans.values(), key=len, reverse=True)[1:]:
            others = [u for f in fan for u in polys[f] if u != v]
            pos = lambda u: verts[u] if u < len(verts) else extra[u - len(verts)]
            centre = np.mean([pos(u) for u in others], axis=0)
            index = len(verts) + len(extra)
            extra.append(verts[v] + NUDGE * (centre - verts[v]))
            touched.append(v)
            for f in fan:
                polys[f] = [index if u == v else u for u in polys[f]]
    if extra:
        verts = np.vstack([verts, np.array(extra)])
    return verts, polys, sorted(set(touched) | set(range(len(verts) - len(extra), len(verts))))


def _boundary_points(mesh):
    """Midpoints of a triangle mesh's open edges (after welding coincident vertices), or None if closed."""
    V = np.asarray(mesh.vertices, dtype=np.float64)
    keys = np.round(V / (1e-6 * max(float(np.ptp(V, axis=0).max()), 1e-12))).astype(np.int64)
    _, inverse = np.unique(keys, axis=0, return_inverse=True)
    F = inverse.reshape(-1)[np.asarray(mesh.faces)]
    edges = np.sort(np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), axis=1)
    edges, counts = np.unique(edges, axis=0, return_counts=True)
    open_edges = edges[counts == 1]
    if len(open_edges) == 0:
        return None
    first = np.zeros(inverse.max() + 1, dtype=np.int64)
    first[inverse.reshape(-1)] = np.arange(len(V))
    return 0.5 * (V[first[open_edges[:, 0]]] + V[first[open_edges[:, 1]]])


def fill_holes(verts, polys, surface, boundary=None):
    """Close boundary loops that aren't the input's own open edges (`boundary`: points along those) with
    a quad fan around a centre on the surface. Returns (verts, polys, holes filled)."""
    count = Counter()
    for p in polys:
        for k, v in enumerate(p):
            w = p[(k + 1) % len(p)]
            count[(min(v, w), max(v, w))] += 1
    step = {}                                                  # around each hole, against its faces' winding
    for p in polys:
        for k, v in enumerate(p):
            w = p[(k + 1) % len(p)]
            if count[(min(v, w), max(v, w))] == 1:
                step[w] = v
    tree = cKDTree(boundary) if boundary is not None else None
    seen = set()
    new_verts, new_polys = [], []
    filled = 0
    for start in list(step):
        if start in seen:
            continue
        loop = [start]
        seen.add(start)
        v = step[start]
        while v != start and v not in seen and v in step:
            loop.append(v)
            seen.add(v)
            v = step[v]
        if v != start or len(loop) < 3 or len(loop) > MAX_HOLE:
            continue
        P = verts[loop]
        edge = np.linalg.norm(P - np.roll(P, 1, axis=0), axis=1).mean()
        if tree is not None and np.median(tree.query(P)[0]) < 2 * edge:
            continue                                           # the input is open here too
        n = len(loop)
        if n <= 4:
            new_polys.append(loop)
        else:
            c = len(verts) + len(new_verts)
            centre = P.mean(0)
            landed = surface.project(centre[None])[0]
            # Centred on the surface, unless that's another sheet (farther than the hole is wide).
            radius = np.linalg.norm(P - centre, axis=1).mean()
            new_verts.append(landed if np.linalg.norm(landed - centre) < 0.5 * radius else centre)
            new_polys += [[c, loop[k], loop[k + 1], loop[k + 2]] for k in range(0, n - 2, 2)]
            new_polys.append([c, loop[n - 2], loop[n - 1], loop[0]] if n % 2 == 0 else [c, loop[n - 1], loop[0]])
        filled += 1
    if new_verts:
        verts = np.vstack([verts, np.array(new_verts)])
    return verts, [list(p) for p in polys] + new_polys, filled


def _triangles(polys):
    return np.array([[p[0], p[k], p[k + 1]] for p in polys for k in range(1, len(p) - 1)], dtype=np.int64)


def clean(verts, polys, surface):
    """All the repairs above. `surface` (a trimesh) is the mesh that was remeshed: vertices are projected
    onto it, but a relaxed vertex mustn't leave the remesh's own layer (on a messy input the nearest input
    surface can be an inner one)."""
    projector = Surface(surface)
    verts, polys, welded = weld(verts, polys)
    polys, duplicates = remove_duplicates(polys)
    own = Surface(trimesh.Trimesh(verts, _triangles(polys), process=False))
    # Pinches and holes are defects when the input is one clean surface: a closed solid (a volume build)
    # or a single part. On a messy input of overlapping open parts they mirror its own overlaps, and
    # patching them only adds folds.
    welded_input = trimesh.Trimesh(surface.vertices, surface.faces, process=True)
    repair = welded_input.is_winding_consistent and (welded_input.is_watertight or welded_input.body_count == 1)
    separated, holes, holes_added = [], 0, 0
    if repair:
        verts, polys, separated = split_nonmanifold(verts, polys)
        before = len(verts)
        verts, polys, holes = fill_holes(verts, polys, projector, _boundary_points(surface))
        holes_added = len(verts) - before
    keep = np.zeros(len(verts), dtype=bool)
    keep[separated] = True
    patched = np.zeros(len(verts), dtype=bool)
    patched[len(patched) - holes_added:] = True
    verts, polys, stats = unfold(verts, polys, projector, keep, layer=own, patched=patched)
    return verts, polys, {'welded': welded, 'duplicates': duplicates, 'unpinched': len(separated) // 2, 'holes': holes, **stats}


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


def unfold(verts, polys, surface, keep=None, layer=None, patched=None, rounds=8):
    """Relax folded quads' neighbourhoods onto `surface` (a trimesh or Surface); split what won't unfold.
    `keep`: a mask of vertices that mustn't move (besides boundaries, tips and creases). `layer`: a Surface
    the other vertices must stay on (within a quarter edge), except the `patched` mask's."""
    verts = np.array(verts, dtype=np.float64)
    surface = surface if isinstance(surface, Surface) else Surface(surface)
    polys, doublets = dissolve_doublets(verts, polys)
    used = np.unique([v for p in polys for v in p])
    keep = np.zeros(len(used), dtype=bool) if keep is None else np.asarray(keep, dtype=bool)[used]
    free = np.zeros(len(used), dtype=bool) if patched is None else np.asarray(patched, dtype=bool)[used]
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
    pinned = boundary | keep | _sharp(verts, polys, neighbours)
    edge = np.array([np.linalg.norm(verts[n] - verts[v], axis=1).mean() if len(n) else 0.0 for v, n in enumerate(neighbours)])
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
            target = 0.5 * verts[region] + 0.5 * np.array([verts[neighbours[v]].mean(0) for v in region])
            landed = surface.project(target)
            # A projection that lands far from the relaxed spot jumped to another sheet (an inner layer
            # of a messy input, the other side of a thin part): that vertex stays put.
            ok = np.linalg.norm(landed - target, axis=1) < 0.5 * edge[region]
            if layer is not None:
                off = np.linalg.norm(layer.project(landed) - landed, axis=1)
                ok &= free[region] | (off < 0.25 * edge[region])
            verts[region[ok]] = landed[ok]
        moved.update(region.tolist())

    quality = corner_quality(verts, quads)
    split = 0
    out = [p for p in polys]
    # Across the reflex corner, unless that pair of vertices is already an edge (two overlapping folded
    # quads would otherwise both split along it into mirror-image triangles).
    joined = {frozenset((p[i], p[(i + 1) % len(p)])) for p in polys for i in range(len(p))}
    for k in np.flatnonzero(quality.min(1) <= SPLIT):
        c = int(np.argmin(quality[k]))
        ring = quads[k].tolist()
        ring = ring[c:] + ring[:c]                               # reflex corner first
        if frozenset((ring[0], ring[2])) in joined:
            ring = ring[1:] + ring[:1]
        joined.add(frozenset((ring[0], ring[2])))
        out[quad_ids[k]] = None
        out += [[ring[0], ring[1], ring[2]], [ring[0], ring[2], ring[3]]]
        split += 1
    out = [p for p in out if p is not None]
    stats = {'doublets': doublets, 'folded': folded_before, 'relaxed_vertices': len(moved), 'pinned': int(pinned.sum()),
             'split': split}
    return verts, out, stats
