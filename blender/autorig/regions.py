"""Mixamo-style region attachment for humanoid skinning (numpy only).

Mixamo's weights read as anatomical regions with soft borders: horizontal bands for the spine bones, arms
and legs following their chains, small clavicle areas. We classify each vertex into a region, attach it
to the matching bone, and let heat diffusion (heat.diffuse) produce the soft borders.

Regions are found from the joints plus the front silhouette (arm/torso separation under the armpits),
so they work with user-edited joints too.
"""
from itertools import permutations

import numpy as np

from fingers import hand_fingers
from hands import measure_hand
from heat import segment_distances
from landmarks import Silhouettes
from raster import runs

# Region borders measured on Mixamo's rigs of the Tripo characters (fractions of height H unless noted).
ARM_START = 0.025          # along the arm, past the shoulder joint
HAND_START = 0.10          # forearm lengths before the wrist joint
NECK_START = 0.18          # of the Spine2->Neck segment, above the neck joint
FOOT_ABOVE_ANKLE = 0.019
CLAVICLE_IN = 0.035        # clavicle band starts this far inside the shoulder joint (x)...
CAP_OUT = 0.015            # ...and hands over to the upper arm this far outside it
CAP_BELOW = 0.05           # shoulder cap reaches this far below the shoulder joint
CLAVICLE_LOW = -0.18       # of the Spine2->Neck segment, relative to Spine2
ARM_CLEARLY_NEARER = 0.5   # left over for the torso but at most this fraction of its spine distance from an arm
# The torso's own outline: its width is measured on the front silhouette's pixels, and its outermost skin (the side of
# the chest, a sash's edge) lies a pixel or two past it. Only skin this far past it counts as beside the torso: without
# it the Archer's chest side, from the waist up to the armpit, went to the upper arm and then (the optimizer) the
# collarbone and forearm, 52-67% / 20-39% / 9-20%, where Mixamo has it 95% spine, and his side followed his arms
# (2026-10-26). Arm skin that close to the body is still found by facing away from the arm's axis.
LATERAL_MARGIN = 0.015


def _torso_half_widths(sil, joints, side):
    """Per silhouette row: distance from the center to the torso's outer edge on one side.

    Below the armpit the torso is its own run. At and above the armpit (arm merged into the run) the
    width measured just below the armpit is held, so shoulders/deltoids count as arm."""
    F = sil.front
    c = sil.center_col
    arm_row = sil.row(joints[('Left' if side > 0 else 'Right') + 'Arm'][2])
    widths = np.full(F.shape[0], np.nan)
    armpit_row = None
    for row in range(arm_row, 0, -1):
        row_runs = runs(F[row])
        center = [r for r in row_runs if r[0] <= c < r[1]]
        if not center:
            continue
        edge = center[0][1] - 1 if side > 0 else center[0][0]
        lateral = [r for r in row_runs if (r[0] > edge if side > 0 else r[1] - 1 < edge)]
        if lateral and armpit_row is None:
            armpit_row = row
        widths[row] = abs(edge - c) * sil.pixel
    if armpit_row is None:
        armpit_row = sil.row(joints['Spine1'][2])
    below = widths[max(armpit_row - int(0.06 * sil.height / sil.pixel), 0):armpit_row]
    held = np.nanmax(below) if np.isfinite(below).any() else 0.15 * sil.height
    widths[armpit_row:] = held
    widths[~np.isfinite(widths)] = held
    return widths, armpit_row


def _limb_radius(verts, a, b, height):
    """Median distance from the middle half of segment a-b to nearby surface vertices."""
    ab = b - a
    length2 = ab @ ab
    t = ((verts - a) @ ab) / length2
    closest = a + np.clip(t, 0, 1)[:, None] * ab
    d = np.linalg.norm(verts - closest, axis=1)
    near = (t > 0.25) & (t < 0.75) & (d < 0.15 * height)
    return float(np.median(d[near])) if near.any() else 0.05 * height


def vertex_normals(verts, tris):
    n = np.cross(verts[tris[:, 1]] - verts[tris[:, 0]], verts[tris[:, 2]] - verts[tris[:, 0]])
    out = np.zeros_like(verts)
    for k in range(3):
        np.add.at(out, tris[:, k], n)
    # Coincident vertices (UV seams) share a normal.
    keys = np.round(verts / 1e-6).astype(np.int64)
    _, inverse = np.unique(keys, axis=0, return_inverse=True)
    inverse = inverse.reshape(-1)
    summed = np.zeros((inverse.max() + 1, 3))
    np.add.at(summed, inverse, out)
    out = summed[inverse]
    return out / np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-12)


def _segment_radial(verts, a, b):
    """Distance to segment a-b and the unit direction from the segment out to each vertex."""
    ab = b - a
    t = np.clip(((verts - a) @ ab) / (ab @ ab), 0, 1)
    off = verts - (a + t[:, None] * ab)
    d = np.linalg.norm(off, axis=1)
    return d, off / np.maximum(d, 1e-12)[:, None]


def _surface_radius(d, radial, normals, verts, a, b, height):
    """Limb thickness: median distance of outward-facing skin around the middle of the segment."""
    ab = b - a
    t = ((verts - a) @ ab) / (ab @ ab)
    near = (t > 0.25) & (t < 0.75) & (d < 0.12 * height) & ((radial * normals).sum(1) > 0.5)
    return float(np.median(d[near])) if near.sum() > 4 else 0.04 * height


def attach(verts, tris, names, heads, tails, joints):
    """(attach_index, distance) per vertex: the bone each vertex is attached to before diffusion."""
    idx = {n: i for i, n in enumerate(names)}
    sil = Silhouettes(verts, tris, resolution=300)
    xc = sil.x_center
    H = sil.height
    dist, _ = segment_distances(verts, heads, tails)
    normals = vertex_normals(verts, tris)
    n = len(verts)
    attach_to = np.full(n, -1)

    x, z = verts[:, 0], verts[:, 2]
    rows = np.clip(np.round((z - sil.front_grid.v_min) / sil.pixel).astype(int), 0, sil.front.shape[0] - 1)

    def nearest_of(mask, bones):
        cand = [idx[b] for b in bones if b in idx]
        if not cand or not mask.any():
            return
        sub = dist[np.ix_(mask, cand)]
        attach_to[mask] = np.array(cand)[np.argmin(sub, axis=1)]

    # Arms: lateral of the torso and beyond a plane just outside the shoulder joint.
    for side, prefix in ((1, 'Left'), (-1, 'Right')):
        widths, _ = _torso_half_widths(sil, joints, side)
        lateral = side * (x - xc) > widths[rows] + LATERAL_MARGIN * H
        shoulder = joints[prefix + 'Arm']
        direction = joints[prefix + 'ForeArm'] - shoulder
        direction /= np.linalg.norm(direction)
        beyond = (verts - shoulder) @ direction > ARM_START * H
        arm_bones = [b for b in names if b.startswith(prefix) and ('Arm' in b or 'Hand' in b)]
        arm_dist = dist[:, [idx[b] for b in arm_bones]].min(axis=1)
        radius = _limb_radius(verts, joints[prefix + 'ForeArm'], joints[prefix + 'Hand'], H)
        # Where the arm rests against the body, skin facing away from the arm's axis is arm and skin
        # facing it is the body (each segment measured with its own thickness).
        facing_out = np.zeros(len(verts), dtype=bool)
        for a, b in ((prefix + 'Arm', prefix + 'ForeArm'), (prefix + 'ForeArm', prefix + 'Hand')):
            d_seg, radial = _segment_radial(verts, joints[a], joints[b])
            seg_radius = _surface_radius(d_seg, radial, normals, verts, joints[a], joints[b], H)
            facing_out |= (d_seg < 1.6 * seg_radius) & ((radial * normals).sum(1) > 0.2)
        # Lateral of the torso, or arm skin against the body; never far from the arm.
        mask = beyond & (lateral | facing_out | (arm_dist < 1.0 * radius)) & (arm_dist < 2.5 * max(radius, 0.04 * H)) & (attach_to < 0)
        nearest_of(mask, arm_bones)
        # The wrist belongs to the hand (Mixamo's boundary sits before the wrist joint).
        wrist, elbow = joints[prefix + 'Hand'], joints[prefix + 'ForeArm']
        forearm = wrist - elbow
        length = np.linalg.norm(forearm)
        past = (verts - wrist) @ (forearm / length) > -HAND_START * length
        attach_to[(attach_to == idx[prefix + 'ForeArm']) & past] = idx[prefix + 'Hand']

    _attach_hands(verts, tris, names, idx, dist, joints, attach_to, H)

    # Head and neck: above the neck band start, within the head's width (pauldrons stay torso).
    spine2_z, neck_z, head_z = joints['Spine2'][2], joints['Neck'][2], joints['Head'][2]
    neck_start = neck_z + NECK_START * (neck_z - spine2_z)
    head_row = sil.row(head_z)
    head_runs = [r for r in runs(sil.front[head_row]) if r[0] <= sil.center_col < r[1]]
    head_half = (max(head_runs[0][1] - sil.center_col, sil.center_col - head_runs[0][0]) * sil.pixel * 1.1
                 if head_runs else 0.2 * H)
    # Anything above the head joint is head (antlers, feathers, hat brims), whatever its width.
    mask = (z > neck_start) & ((np.abs(x - xc) < head_half) | (z >= head_z)) & (attach_to < 0)
    attach_to[mask & (z < head_z)] = idx['Neck']
    attach_to[mask & (z >= head_z)] = idx['Head']

    # Legs: below the pelvis cut, split by side.
    upleg_z = joints['LeftUpLeg'][2]
    thigh = upleg_z - joints['LeftLeg'][2]
    pelvis_cut = upleg_z - 0.18 * thigh
    legs = (z < pelvis_cut) & (attach_to < 0)
    nearest_of(legs & (x >= xc), ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase'])
    nearest_of(legs & (x < xc), ['RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'])
    for prefix in ('Left', 'Right'):
        boot = z < joints[prefix + 'Foot'][2] + FOOT_ABOVE_ANKLE * H
        attach_to[(attach_to == idx[prefix + 'Leg']) & boot] = idx[prefix + 'Foot']

    # Shoulders, top of the torso: a narrow clavicle band around the shoulder joint; the cap beyond
    # it (deltoid, pauldron, fur) rides with the upper arm, the chest inside it stays Spine2.
    torso = attach_to < 0
    clav_z = spine2_z + CLAVICLE_LOW * (neck_z - spine2_z)
    for prefix, sign in (('Left', 1), ('Right', -1)):
        arm_x = abs(joints[prefix + 'Arm'][0] - xc)
        lateral = sign * (x - xc)
        cap = torso & (z > joints[prefix + 'Arm'][2] - CAP_BELOW * H) & (lateral > arm_x + CAP_OUT * H)
        attach_to[cap] = idx[prefix + 'Arm']
        mask = torso & ~cap & (z > clav_z) & (lateral > arm_x - CLAVICLE_IN * H)
        attach_to[mask] = idx[prefix + 'Shoulder']

    # Wide sleeves and cloth hanging under the arm overlap the torso in the front view, so the arm test
    # above misses them; skin twice as close to an arm bone as to any spine bone is arm (Caravan Trader's
    # sleeves, Raider's cloak under the arms: 47 vertices agree with Mixamo, 3 don't, over 12 characters).
    spine = [idx[b] for b in ('Hips', 'Spine', 'Spine1', 'Spine2') if b in idx]
    spine_dist = dist[:, spine].min(axis=1)
    for prefix in ('Left', 'Right'):
        arm = [idx[prefix + b] for b in ('Arm', 'ForeArm') if prefix + b in idx]
        nearer = (attach_to < 0) & (dist[:, arm].min(axis=1) < ARM_CLEARLY_NEARER * spine_dist)
        attach_to[nearer] = np.array(arm)[np.argmin(dist[np.ix_(nearer, arm)], axis=1)]

    # Torso bands by height.
    torso = attach_to < 0
    bands = [('Hips', joints['Spine'][2]), ('Spine', joints['Spine1'][2]), ('Spine1', joints['Spine2'][2]), ('Spine2', np.inf)]
    lower = -np.inf
    for bone, upper in bands:
        mask = torso & (z >= lower) & (z < upper)
        attach_to[mask] = idx[bone]
        lower = upper

    distance = dist[np.arange(n), attach_to]
    return attach_to, distance


def _chain_for(finger, prefix, idx):
    """Deform bones that drive a detected finger at the rig's finger level (mittens share Index)."""
    own = [f'{prefix}Hand{finger}{i}' for i in (1, 2, 3)]
    if all(b in idx for b in own):
        return own
    if finger != 'Thumb':
        shared = [f'{prefix}HandIndex{i}' for i in (1, 2, 3)]
        if all(b in idx for b in shared):
            return shared
    return []


def match_fingers(labeled, prefix, idx, dist):
    """Match traced surface fingers to the placed chains, not a detector's labels.

    The finger markers are authoritative even when the automatic thumb ordering
    or the original hand pose differed. Use a one-to-one match to avoid assigning
    two touching fingers to the same chain. Mitten levels keep their shared chain.
    """
    fingers = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']
    available = [f for f in fingers if all(f'{prefix}Hand{f}{i}' in idx for i in (1, 2, 3))]
    if len(available) < 5 or not labeled:
        return {f: f for f in labeled}
    detected = list(labeled)
    cost = np.zeros((len(detected), len(available)))
    for i, f in enumerate(detected):
        members = np.asarray(labeled[f]['members'], dtype=int)
        for j, name in enumerate(available):
            chain = [idx[b] for b in _chain_for(name, prefix, idx)]
            cost[i, j] = np.mean(np.min(dist[np.ix_(members, chain)], axis=1)) if len(members) else 0
    best = min(permutations(range(len(available)), len(detected)), key=lambda p: sum(cost[i, j] for i, j in enumerate(p)))
    return {f: available[j] for f, j in zip(detected, best)}


def _attach_hands(verts, tris, names, idx, dist, joints, attach_to, height):
    """Each detected finger's vertices attach only to its own chain (no bleed between touching
    fingers); the palm attaches to the hand."""
    for prefix, side in (('Left', 1), ('Right', -1)):
        if prefix + 'Hand' not in idx or prefix + 'ForeArm' not in joints:
            continue
        wrist = joints[prefix + 'Hand']
        hand = measure_hand(verts, tris, wrist, joints[prefix + 'ForeArm'], side, height)
        if hand is None:
            continue
        labeled = hand_fingers(verts, tris, hand, wrist, height)
        matched = match_fingers(labeled, prefix, idx, dist)
        hand_bone = idx[prefix + 'Hand']
        driven = np.isin(attach_to, [idx[b] for b in names if b.startswith(prefix + 'Hand')])
        in_fingers = np.zeros(len(verts), dtype=bool)
        for finger, f in labeled.items():
            members = np.array(f['members'])
            members = members[driven[members]]
            in_fingers[members] = True
            cand = [hand_bone] + [idx[b] for b in _chain_for(matched[finger], prefix, idx)]
            sub = dist[np.ix_(members, cand)]
            attach_to[members] = np.array(cand)[np.argmin(sub, axis=1)]
        if labeled:
            # Palm: the hand, except skin past a knuckle that's nearest that finger's first bone
            # (it bends with the finger when the hand closes), like Mixamo's knuckle weights.
            palm = np.flatnonzero(driven & ~in_fingers)
            attach_to[palm] = hand_bone
            firsts = {_chain_for(f, prefix, idx)[0] for f in matched.values() if _chain_for(f, prefix, idx)}
            cand = [hand_bone] + [idx[b] for b in sorted(firsts)]
            sub = dist[np.ix_(palm, cand)].copy()
            for k, b in enumerate(sorted(firsts), start=1):
                child = b[:-1] + '2'
                head, tail = joints[b], joints.get(child, joints[b])
                axis = tail - head
                past = (verts[palm] - head) @ axis > 0
                sub[~past, k] = np.inf
            attach_to[palm] = np.array(cand)[np.argmin(sub, axis=1)]
