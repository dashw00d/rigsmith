"""Finger detection from hand geometry (numpy only): five chains traced from the wrist.

Given the hand region (hands.measure_hand), geodesic distance from the wrist cut grows along the
fingers. Its merge tree (sweeping the distance downward, components born at fingertips merge where
fingers join the palm) gives each finger's tip, its branch of vertices and where it meets the palm.
Thumb = the branch that joins nearest the wrist; the others are ordered across the palm from it.
"""
import heapq

import numpy as np

from mixamo import ANATOMY


def _graph(verts, tris, region):
    """Edges (i, j, length) among region vertices, coincident vertices welded."""
    edges = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    edges = edges[region[edges].all(axis=1)]
    n = len(verts)
    neighbors = [[] for _ in range(n)]
    for a, b in edges:
        length = float(np.linalg.norm(verts[a] - verts[b]))
        neighbors[a].append((b, length))
        neighbors[b].append((a, length))
    # Weld coincident vertices (UV seams) with zero-length edges.
    idx = np.flatnonzero(region)
    keys = np.round(verts[idx] / 1e-6).astype(np.int64)
    _, inverse = np.unique(keys, axis=0, return_inverse=True)
    inverse = inverse.reshape(-1)
    first = {}
    for k, v in zip(inverse, idx):
        if k in first:
            neighbors[v].append((first[k], 0.0))
            neighbors[first[k]].append((v, 0.0))
        else:
            first[k] = v
    return neighbors


def geodesic(neighbors, sources, n):
    dist = np.full(n, np.inf)
    heap = [(0.0, int(s)) for s in sources]
    for _, s in heap:
        dist[s] = 0.0
    heapq.heapify(heap)
    while heap:
        d, v = heapq.heappop(heap)
        if d > dist[v]:
            continue
        for u, w in neighbors[v]:
            nd = d + w
            if nd < dist[u]:
                dist[u] = nd
                heapq.heappush(heap, (nd, u))
    return dist


def merge_tree(neighbors, dist, region):
    """Persistence of geodesic maxima. Returns [(tip, birth, death, death_vertex, members)], longest first.

    Sweeping vertices from far to near, a component is born at each local maximum (a fingertip) and
    dies when it merges into an older (farther-reaching) component."""
    order = [v for v in np.argsort(-dist) if region[v] and np.isfinite(dist[v])]
    parent = {}

    def find(v):
        while parent[v] != v:
            parent[v] = parent[parent[v]]
            v = parent[v]
        return v

    tip_of, members = {}, {}
    branches = []
    for v in order:
        parent[v] = v
        tip_of[v] = v
        members[v] = [v]
        roots = {find(u) for u, _ in neighbors[v] if u in parent and u != v}
        roots.discard(v)
        if not roots:
            continue
        # Join v to the oldest neighbor component; the others die here.
        oldest = max(roots, key=lambda r: dist[tip_of[r]])
        for r in roots:
            if r != oldest:
                branches.append((tip_of[r], dist[tip_of[r]], dist[v], v, list(members[r])))
        for r in roots:
            parent[r] = v
            if r != oldest:
                members[v] += members.pop(r)
        members[v] += members.pop(oldest)
        tip_of[v] = tip_of[oldest]
        # Keep the root as v with the oldest tip.
    root = find(order[0])
    branches.append((tip_of[root], dist[tip_of[root]], 0.0, None, list(members[root])))
    return sorted(branches, key=lambda b: b[1] - b[2], reverse=True)


def _component(neighbors, seed, allowed):
    seen = {seed}
    stack = [seed]
    while stack:
        v = stack.pop()
        for u, _ in neighbors[v]:
            if u not in seen and allowed[u]:
                seen.add(u)
                stack.append(u)
    return sorted(seen)


def centerline(verts, dist, members, start, stop, steps=12):
    """Centroids of geodesic level bands of a branch, from its base (start) to its tip (stop)."""
    members = np.array(members)
    d = dist[members]
    points = []
    edges = np.linspace(start, stop, steps + 1)
    for lo, hi in zip(edges[:-1], edges[1:]):
        band = members[(d >= lo) & (d <= hi)]
        if len(band):
            points.append(verts[band].mean(axis=0))
    return np.array(points)


def detect_fingers(verts, tris, hand, wrist, height, min_length=0.02):
    """[{'tip', 'base_dist', 'tip_dist', 'line', 'members'}] for the finger branches of one hand."""
    region = hand['region']
    neighbors = _graph(verts, tris, region)
    t = (verts - wrist) @ hand['axis']
    idx = np.flatnonzero(region)
    cut = idx[t[idx] < t[idx].min() + 0.01 * height]
    dist = geodesic(neighbors, cut, len(verts))
    branches = merge_tree(neighbors, dist, region)
    fingers = []
    # (neighbors are returned for label_fingers)
    for tip, birth, death, at, members in branches:
        if birth - death < min_length * height:
            continue
        fingers.append({'tip': tip, 'tip_dist': birth, 'base_dist': death, 'members': members,
                        'line': centerline(verts, dist, members, death, birth)})
    return fingers, dist, neighbors


def label_fingers(verts, neighbors, fingers, dist, region, hand, wrist):
    """{'Thumb': f, 'Index': f, 'Middle': f, 'Ring': f, 'Pinky': f} (fewer when fewer were found).

    The root branch (the farthest-reaching finger) owns the whole hand in the merge tree; its own
    finger is the part beyond where the other fingers join."""
    if not fingers:
        return {}
    others = [f for f in fingers if f['base_dist'] > 0]
    root = next((f for f in fingers if f['base_dist'] == 0), None)
    if root is not None and others:
        # Its finger starts where the last neighbor joins (the thumb joins much lower, so skip it),
        # and is only what's connected to its tip beyond that.
        bases = sorted(f['base_dist'] for f in others)
        base = bases[-1] if len(bases) < 2 else max(bases[1:])
        taken = np.zeros(len(verts), dtype=bool)
        for f in others:
            taken[f['members']] = True
        allowed = region & (dist > base) & ~taken
        members = _component(neighbors, root['tip'], allowed)
        root = dict(root, base_dist=base, members=members, line=centerline(verts, dist, members, base, root['tip_dist']))
        fingers = others + [root]
    fingers = [f for f in fingers if len(f['line']) >= 2]
    if len(fingers) < 2:
        return {}
    # Thumb: joins the palm nearest the wrist and sits on the thumb side of the hand.
    def thumbness(f):
        others = [g['base_dist'] for g in fingers if g is not f]
        return (np.median(others) - f['base_dist']) + ((verts[f['tip']] - wrist) @ hand['thumb'])
    thumb = max(fingers, key=thumbness)
    rest = [f for f in fingers if f is not thumb]
    # Order the remaining fingers across the palm, starting next to the thumb.
    # (Finger midpoints are spread more evenly than the bases, which crowd together at the web.)
    mids = np.array([f['line'].mean(axis=0) for f in rest])
    if len(rest) > 1:
        center = mids.mean(axis=0)
        _, _, vt = np.linalg.svd(mids - center, full_matrices=False)
        across = vt[0] * np.sign(vt[0] @ (thumb['line'][0] - center) or 1.0)
        rest = sorted(rest, key=lambda f: -(f['line'].mean(axis=0) - center) @ across)
    names = ['Index', 'Middle', 'Ring', 'Pinky'][:len(rest)]
    out = {'Thumb': thumb}
    out.update(zip(names, rest))
    return out


def along(line, point):
    """(s, offset): arc-length position of point's projection on the polyline, extended at both ends."""
    seg = np.diff(line, axis=0)
    lengths = np.linalg.norm(seg, axis=1)
    cum = np.concatenate([[0], np.cumsum(lengths)])
    best = (np.inf, 0.0)
    for i, (a, d, L) in enumerate(zip(line[:-1], seg, lengths)):
        if L < 1e-12:
            continue
        t = (point - a) @ d / (L * L)
        if i > 0:
            t = max(t, 0.0)
        if i < len(seg) - 1:
            t = min(t, 1.0)
        off = np.linalg.norm(point - (a + t * d))
        if off < best[0]:
            best = (off, cum[i] + t * L)
    return best[1], best[0], cum[-1]


# Joint positions along each finger's centerline as fractions of its visible length (palm web -> tip);
# negative = extended back into the palm. Knuckles (1) sit inside the palm behind the web; the
# phalanges split the knuckle -> tip length about 0.45 / 0.28 / 0.27. Thumb 2/3/4 are Mixamo's medians
# on the Tripo characters (dev/calib_fingers.py); Thumb1 comes from the hand-frame layout.
CHAIN = {
    'Thumb': [None, 0.0, 0.42, 0.97],
    'finger': [-0.25, 0.31, 0.66, 0.97],
}


def point_at(line, s):
    """Point at arc length s along a polyline, extrapolating straight past either end."""
    seg = np.diff(line, axis=0)
    lengths = np.linalg.norm(seg, axis=1)
    cum = np.concatenate([[0], np.cumsum(lengths)])
    if s <= 0:
        d = line[min(2, len(line) - 1)] - line[0]
        return line[0] + s * d / max(np.linalg.norm(d), 1e-9)
    if s >= cum[-1]:
        d = line[-1] - line[max(len(line) - 3, 0)]
        return line[-1] + (s - cum[-1]) * d / max(np.linalg.norm(d), 1e-9)
    i = int(np.searchsorted(cum, s, side='right') - 1)
    return line[i] + (s - cum[i]) / max(lengths[i], 1e-12) * seg[i]


# ANATOMY (where a finger's joints sit along the hand, from Mixamo's proportions: the knuckle as a fraction of the
# wrist -> fingertip reach along the hand, then the two joints between knuckle and tip as fractions of that span) comes
# from static/templates/human-skeleton.json through mixamo.py: the marker board lays fingers by the same table.


def finger_chains(labeled, wrist=None, axis=None):
    """{'Thumb': [None, p2, p3, p4], 'Index': [p1..p4], ...} from labeled fingers.

    Relaxed fingers are close to straight, so joints go on a line fitted through the finger's centerline (robust to
    ragged level bands at the web). The tip is where the finger ends. A finger's knuckle is where a hand's knuckles
    are, along the hand from the wrist (`wrist`, `axis`: the hand's direction): not where the finger comes apart from
    its neighbour, which on a mesh with the fingers fused most of their length is near the tip, and would squeeze the
    whole finger into its last joint. Never past that parting, though."""
    out = {}
    for name, f in labeled.items():
        line = f['line']
        center = line.mean(axis=0)
        _, _, vt = np.linalg.svd(line - center, full_matrices=False)
        direction = vt[0] * np.sign(vt[0] @ (line[-1] - line[0]) or 1.0)
        s0 = (line[0] - center) @ direction
        s1 = (line[-1] - center) @ direction
        at = lambda x: center + (s0 + x * (s1 - s0)) * direction
        if name == 'Thumb' or name not in ANATOMY:
            out[name] = [None if x is None else at(x) for x in CHAIN['Thumb' if name == 'Thumb' else 'finger']]
            continue
        tip_s = s0 + CHAIN['finger'][3] * (s1 - s0)
        knuckle_s = s0 + CHAIN['finger'][0] * (s1 - s0)
        if wrist is not None and axis is not None and direction @ axis > 0.3:
            # (the knuckle where the hand's proportions put it: its reach along the hand a fraction of the tip's)
            reach = (center + tip_s * direction - wrist) @ axis
            want = ANATOMY[name][0] * reach
            knuckle_s = min((want - (center - wrist) @ axis) / (direction @ axis), s0)
        k, a, b = knuckle_s, ANATOMY[name][1], ANATOMY[name][2]
        span = tip_s - k
        out[name] = [center + s * direction for s in (k, k + a * span, k + b * span, tip_s)]
    return out


def space_evenly(chains, verts, hand, wrist):
    """The four fingers' chains kept to a hand's even spacing (in place).

    Knuckles sit evenly across the palm: the middle and ring knuckles put between the index's and the pinky's. A
    finger whose tip came out on top of a neighbour's (two chains on one finger, its own missed: fingers fused on
    the mesh) gets its tip again in its own lane across the hand, as the farthest the hand's surface reaches there,
    and its joints laid between knuckle and tip again."""
    names = ['Index', 'Middle', 'Ring', 'Pinky']
    if any(n not in chains or any(p is None for p in chains[n]) for n in names):
        return chains
    axis = hand['axis']
    across = chains['Index'][0] - chains['Pinky'][0]
    across = across - (across @ axis) * axis
    if np.linalg.norm(across) < 1e-9:
        return chains
    across = across / np.linalg.norm(across)
    at = {n: [np.asarray(p, dtype=float) for p in chains[n]] for n in names}
    # knuckles: evenly across, each where it is along the hand and off the palm
    a0, a3 = at['Index'][0] @ across, at['Pinky'][0] @ across
    for i, n in enumerate(names[1:3], start=1):
        k = at[n][0]
        at[n][0] = k + ((a0 + i * (a3 - a0) / 3) - k @ across) * across
    # tips: a tip on top of its neighbour's found again in its own lane
    t0, t3 = at['Index'][3] @ across, at['Pinky'][3] @ across
    lane = abs(t3 - t0) / 3
    if lane > 1e-9:
        tips = [at[n][3] @ across for n in names]
        crowded = set()
        for i in range(3):
            if abs(tips[i + 1] - tips[i]) < 0.5 * lane:
                crowded.update({i, i + 1} - {0, 3} or {i + 1})
        region = hand.get('region')
        pts = verts[region] if region is not None else verts
        reach = (pts - wrist) @ axis
        side = pts @ across
        for i in sorted(crowded):
            want = t0 + i * (t3 - t0) / 3
            near = np.abs(side - want) < 0.5 * lane
            if near.sum() < 3:
                continue
            far = reach[near].max()
            tip_pts = pts[near][reach[near] > far - 0.15 * lane]
            n = names[i]
            tip = tip_pts.mean(axis=0)
            # (a joint's length short of the very end, as the detected tips are)
            k = at[n][0]
            d = tip - k
            tip = k + d * (1 - 0.03)
            a, b = ANATOMY[n][1], ANATOMY[n][2]
            at[n] = [k, k + a * (tip - k), k + b * (tip - k), tip]
    # (every finger's two middle joints laid again between its knuckle and tip: a knuckle moved leaves no kink)
    for n in names:
        k, tip = at[n][0], at[n][3]
        a, b = ANATOMY[n][1], ANATOMY[n][2]
        chains[n] = [k, k + a * (tip - k), k + b * (tip - k), tip]
    return chains


def hand_fingers(verts, tris, hand, wrist, height):
    """Detected and labeled fingers for one hand, or {} when the hand doesn't show five fingers."""
    fingers, dist, neighbors = detect_fingers(verts, tris, hand, wrist, height)
    if len(fingers) != 5:
        return {}
    labeled = label_fingers(verts, neighbors, fingers, dist, hand['region'], hand, wrist)
    return labeled if len(labeled) == 5 else {}
