"""Hand measurement (numpy only): direction, length and palm orientation of each hand from the mesh.

Frame: Z up, character faces -Y, character's left = +X (see raster.py).

Stylized hands are rarely aligned with the forearm (Tripo hands bend 10-40 degrees at the wrist) and
their palms usually face the thighs rather than the floor. Mixamo follows the hand, not the forearm:
the hand bone runs toward the index knuckle and the hand, finger and forearm bones roll so their Z
axis is the direction the palm faces. We measure the same things here.
"""
import numpy as np

FORWARD = np.array([0.0, -1.0, 0.0])


def _adjacency(n, tris, verts, weld):
    """CSR neighbor lists over triangle edges, plus edges between coincident vertices."""
    edges = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    keys = np.round(verts / weld).astype(np.int64)
    _, inverse = np.unique(keys, axis=0, return_inverse=True)
    inverse = inverse.reshape(-1)
    order = np.argsort(inverse, kind='stable')
    same = inverse[order[1:]] == inverse[order[:-1]]
    welds = np.stack([order[1:][same], order[:-1][same]], axis=1)
    edges = np.concatenate([edges, welds])
    edges = np.concatenate([edges, edges[:, ::-1]])
    edges = edges[np.argsort(edges[:, 0], kind='stable')]
    starts = np.searchsorted(edges[:, 0], np.arange(n + 1))
    return starts, edges[:, 1]


def _flood(starts, neighbors, seed, allowed):
    seen = np.zeros(len(allowed), dtype=bool)
    seen[seed] = True
    frontier = np.array([seed])
    while len(frontier):
        nxt = np.concatenate([neighbors[starts[v]:starts[v + 1]] for v in frontier])
        nxt = np.unique(nxt)
        nxt = nxt[allowed[nxt] & ~seen[nxt]]
        seen[nxt] = True
        frontier = nxt
    return seen


def assumed_palm(direction, side):
    """Palm normal for a hand pointing `direction` with the thumb forward (the A/T-pose default)."""
    lateral = FORWARD - (FORWARD @ direction) * direction
    lateral /= np.linalg.norm(lateral)
    n = np.cross(direction, lateral) if side > 0 else np.cross(lateral, direction)
    return n / np.linalg.norm(n)


def measure_hand(verts, tris, wrist, elbow, side, height):
    """{'axis', 'palm', 'thumb', 'length', 'tip', 'flat', 'region'} for one hand, or None.

    axis: unit vector from the wrist toward the fingertips; palm: unit normal the palm faces;
    thumb: unit vector across the palm toward the thumb; length: wrist -> fingertip along axis."""
    forearm = wrist - elbow
    forearm = forearm / np.linalg.norm(forearm)
    rel = verts - wrist
    t = rel @ forearm
    dist = np.linalg.norm(rel, axis=1)
    radial = np.linalg.norm(rel - t[:, None] * forearm, axis=1)
    # The hand: everything connected to the fingertip a little past the wrist, near the arm's line.
    allowed = (t > -0.025 * height) & (dist < 0.32 * height) & (radial < 0.12 * height)
    # Fingertip seed: the farthest such point inside a ~55 degree cone around the forearm.
    cone = allowed & (t > 0) & (radial < 1.4 * t)
    if not cone.any():
        return None
    seed = int(np.flatnonzero(cone)[np.argmax(dist[cone])])
    starts, neighbors = _adjacency(len(verts), tris, verts, 1e-5 * height)
    region = _flood(starts, neighbors, seed, allowed)
    # Area-weighted PCA over triangles fully inside the region (vertex density varies a lot).
    inside = region[tris].all(axis=1)
    if inside.sum() < 12:
        return None
    a, b, c = verts[tris[inside, 0]], verts[tris[inside, 1]], verts[tris[inside, 2]]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    centroid = (a + b + c) / 3.0
    weights = area / area.sum()
    mean = weights @ centroid
    centered = centroid - mean
    cov = (centered * weights[:, None]).T @ centered
    # Add each triangle's own spread so big flat triangles count as surfaces, not points.
    for p in (a, b, c):
        d = p - centroid
        cov += (d * weights[:, None]).T @ d / 12.0
    values, vectors = np.linalg.eigh(cov)
    axis = vectors[:, 2] * np.sign(vectors[:, 2] @ forearm or 1.0)
    flat = float(np.sqrt(values[0] / max(values[1], 1e-12)))
    expected = assumed_palm(axis, side)
    palm = vectors[:, 0]
    palm = palm - (palm @ axis) * axis
    palm /= np.linalg.norm(palm)
    palm *= np.sign(palm @ expected) or 1.0
    if flat > 0.8:
        # A fist or a blob: no reliable palm plane, keep the thumb-forward default.
        palm = expected
    thumb = np.cross(palm, axis) if side > 0 else np.cross(axis, palm)
    hand_pts = verts[region]
    length = float(((hand_pts - wrist) @ axis).max())
    tip = hand_pts[np.argmax((hand_pts - wrist) @ axis)]
    return {'axis': axis, 'palm': palm, 'thumb': thumb / np.linalg.norm(thumb), 'length': length,
            'tip': tip, 'flat': flat, 'region': region}


def mirror(v):
    return np.array([-v[0], v[1], v[2]])


def symmetric_hand(verts, tris, joints, height, x_center):
    """Left-hand frame, averaged with the mirrored right hand when both measure cleanly."""
    frames = []
    for prefix, side in (('Left', 1), ('Right', -1)):
        if prefix + 'Hand' not in joints:
            continue
        m = measure_hand(verts, tris, joints[prefix + 'Hand'], joints[prefix + 'ForeArm'], side, height)
        if m is None:
            continue
        if side < 0:
            m = dict(m, axis=mirror(m['axis']), palm=mirror(m['palm']), thumb=mirror(m['thumb']))
        frames.append(m)
    if not frames:
        return None
    axis = np.mean([f['axis'] for f in frames], axis=0)
    axis /= np.linalg.norm(axis)
    palm = np.mean([f['palm'] for f in frames], axis=0)
    palm -= (palm @ axis) * axis
    palm /= np.linalg.norm(palm)
    thumb = np.cross(palm, axis)
    return {'axis': axis, 'palm': palm, 'thumb': thumb, 'length': float(np.mean([f['length'] for f in frames])),
            'flat': float(np.mean([f['flat'] for f in frames])), 'measured': len(frames)}

