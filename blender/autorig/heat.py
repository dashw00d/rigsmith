"""Robust bone-heat skinning (Baran & Popović 2007), numpy only.

Each vertex is attached to the closest bone segment it can see (visibility by ray casting against the
mesh). Weights then diffuse over the surface by solving (L + M H) w_b = M H p_b for every bone at once
with conjugate gradients, where L is the cotangent Laplacian, M the vertex areas and H = 1 / d^2.
Unlike Blender's solver this never fails outright: non-manifold edges, open borders and disconnected
pieces are fine (coincident vertices are welded by extra graph edges).
"""
import numpy as np


def segment_distances(points, heads, tails):
    """(n, b) distance from each point to each segment and the (n, b, 3) closest points."""
    ab = tails - heads
    denom = np.maximum((ab * ab).sum(-1), 1e-12)
    t = np.clip(((points[:, None, :] - heads[None]) * ab[None]).sum(-1) / denom, 0.0, 1.0)
    closest = heads[None] + t[..., None] * ab[None]
    return np.linalg.norm(points[:, None, :] - closest, axis=-1), closest


def laplacian(verts, tris, weld_tolerance):
    """Symmetric graph (rows, cols, vals) of clamped cotangent weights plus vertex areas."""
    i, j, k = tris[:, 0], tris[:, 1], tris[:, 2]

    def cot(a, b, c):
        u, v = verts[b] - verts[a], verts[c] - verts[a]
        cross = np.linalg.norm(np.cross(u, v), axis=1)
        return (u * v).sum(1) / np.maximum(cross, 1e-12)

    cot_i, cot_j, cot_k = cot(i, j, k), cot(j, k, i), cot(k, i, j)
    rows = np.concatenate([j, k, k, i, i, j])
    cols = np.concatenate([k, j, i, k, j, i])
    vals = 0.5 * np.concatenate([cot_i, cot_i, cot_j, cot_j, cot_k, cot_k])
    # Negative cotangents (obtuse triangles) break the maximum principle; clamp them.
    vals = np.clip(vals, 1e-3, 1e3)

    area = 0.5 * np.linalg.norm(np.cross(verts[j] - verts[i], verts[k] - verts[i]), axis=1)
    mass = np.bincount(np.concatenate([i, j, k]), weights=np.repeat(area / 3.0, 3), minlength=len(verts))
    mass = np.maximum(mass, 1e-12)

    # Weld vertices that share a position (UV seams, split normals) with stiff edges.
    keys = np.round(verts / weld_tolerance).astype(np.int64)
    _, inverse, counts = np.unique(keys, axis=0, return_inverse=True, return_counts=True)
    inverse = inverse.reshape(-1)
    dup = np.flatnonzero(counts[inverse] > 1)
    if len(dup):
        order = dup[np.argsort(inverse[dup], kind='stable')]
        groups = inverse[order]
        first = np.r_[True, groups[1:] != groups[:-1]]
        leader = order[np.maximum.accumulate(np.where(first, np.arange(len(order)), 0))]
        a, b = order[~first], leader[~first]
        stiff = np.full(len(a), 50.0)
        rows = np.concatenate([rows, a, b])
        cols = np.concatenate([cols, b, a])
        vals = np.concatenate([vals, stiff, stiff])
    return rows, cols, vals, mass


class Graph:
    """Graph Laplacian with a fast multi-column matvec (edges sorted by row, summed with reduceat)."""

    def __init__(self, rows, cols, vals, n):
        order = np.argsort(rows, kind='stable')
        self.rows, self.cols, self.vals = rows[order], cols[order], vals[order]
        self.starts = np.flatnonzero(np.r_[True, self.rows[1:] != self.rows[:-1]])
        self.row_ids = self.rows[self.starts]
        self.degree = np.bincount(rows, weights=vals, minlength=n)

    def apply(self, x):
        contribution = self.vals[:, None] * (x[self.rows] - x[self.cols])
        out = np.zeros_like(x)
        out[self.row_ids] = np.add.reduceat(contribution, self.starts, axis=0)
        return out


def solve(graph, diag, rhs, iterations=400, tolerance=3e-4):
    """Jacobi-preconditioned CG on (diag + L) x = rhs for all columns at once."""
    precond = 1.0 / (diag + graph.degree)
    x = rhs * precond[:, None]
    r = rhs - (diag[:, None] * x + graph.apply(x))
    z = precond[:, None] * r
    p = z.copy()
    rz = (r * z).sum(0)
    norm0 = np.sqrt((rhs * rhs).sum(0)) + 1e-30
    for _ in range(iterations):
        ap = diag[:, None] * p + graph.apply(p)
        alpha = rz / np.maximum((p * ap).sum(0), 1e-30)
        x += alpha * p
        r -= alpha * ap
        if (np.sqrt((r * r).sum(0)) / norm0).max() < tolerance:
            break
        z = precond[:, None] * r
        rz_new = (r * z).sum(0)
        p = z + (rz_new / np.maximum(rz, 1e-30)) * p
        rz = rz_new
    return x


def diffuse(verts, tris, attach, distance, n_bones, heat=1.0):
    """Heat-diffuse attachments: vertex i is attached to bone attach[i] at segment distance distance[i]."""
    height = float(np.ptp(verts[:, 2])) or 1.0
    rows, cols, vals, mass = laplacian(verts, tris, weld_tolerance=1e-5 * height)
    graph = Graph(rows, cols, vals, len(verts))
    h = heat * mass / np.maximum(distance, 1e-3 * height) ** 2
    rhs = np.zeros((len(verts), n_bones), dtype=np.float32)
    rhs[np.arange(len(verts)), attach] = h
    graph.vals = graph.vals.astype(np.float32)
    return np.clip(solve(graph, h.astype(np.float32), rhs), 0.0, 1.0).astype(np.float64)


def side_eligible(verts, heads, tails, x_center, height, inside=0.35):
    """(n, b) whether vertex v may attach to bone b: a bone off to one side of the body (a left or right limb) takes
    only skin on its own side, at least `inside` of the bone's own distance out from the middle; the middle (a belly,
    a chest, a back) goes to the bones down the middle. Heat alone binds a horse's belly to whichever stifle or elbow
    is nearest, left on one vertex and right on the next, and the belly tears when the legs part."""
    mid = 0.5 * (heads[:, 0] + tails[:, 0]) - x_center
    offset = np.minimum(np.abs(heads[:, 0] - x_center), np.abs(tails[:, 0] - x_center))
    side = np.where(np.abs(mid) > 0.02 * height, np.sign(mid), 0.0)
    x = verts[:, 0:1] - x_center
    return (side[None, :] == 0) | (x * side[None, :] > inside * offset[None, :])


def bone_heat(verts, tris, heads, tails, ray_cast=None, candidates=4, heat=1.0, eligible=None, attachments=False):
    """Weights (n_verts, n_bones). ray_cast(origin, direction, max_distance) -> bool (hit). `eligible` (n, b): which
    bones each vertex may attach to (side_eligible). With `attachments`, also each vertex's bone and its distance
    from it (the body's thickness there)."""
    height = float(np.ptp(verts[:, 2])) or 1.0
    dist, closest = segment_distances(verts, heads, tails)
    if eligible is not None:
        dist = np.where(eligible, dist, dist + 1e3 * height)
    order = np.argsort(dist, axis=1)
    nearest = order[:, 0].copy()
    if ray_cast is not None:
        eps = 1e-4 * height
        for v in range(len(verts)):
            for b in order[v, :candidates]:
                target = closest[v, b]
                direction = target - verts[v]
                length = np.linalg.norm(direction)
                if length < eps * 4:
                    nearest[v] = b
                    break
                direction /= length
                if not ray_cast(verts[v] + direction * eps * 2, direction, length - eps * 4):
                    nearest[v] = b
                    break
    radius = np.minimum(dist[np.arange(len(verts)), nearest], height)
    w = diffuse(verts, tris, nearest, radius, len(heads), heat)
    return (w, nearest, radius) if attachments else w
