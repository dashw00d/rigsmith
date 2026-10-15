"""Mixamo-style region attachment for humanoid skinning (numpy only).

Mixamo's weights read as anatomical regions with soft borders: horizontal bands for the spine bones, arms
and legs following their chains, small clavicle areas. We classify each vertex into a region, attach it
to the matching bone, and let heat diffusion (heat.diffuse) produce the soft borders.

Regions are found from the joints plus the front silhouette (arm/torso separation under the armpits),
so they work with user-edited joints too.
"""
import numpy as np

from heat import segment_distances
from landmarks import Silhouettes
from raster import runs

# Region borders measured on Mixamo's rigs of the Tripo characters (fractions of height H unless noted).
ARM_START = 0.025          # along the arm, past the shoulder joint
HAND_START = 0.10          # forearm lengths before the wrist joint
NECK_START = 0.18          # of the Spine2->Neck segment, above the neck joint
FOOT_ABOVE_ANKLE = 0.019
CLAVICLE_INNER = 0.046     # lateral of the clavicle's inner end
CLAVICLE_LOW = -0.18       # of the Spine2->Neck segment, relative to Spine2


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


def attach(verts, tris, names, heads, tails, joints):
    """(attach_index, distance) per vertex: the bone each vertex is attached to before diffusion."""
    idx = {n: i for i, n in enumerate(names)}
    sil = Silhouettes(verts, tris, resolution=300)
    xc = sil.x_center
    H = sil.height
    dist, _ = segment_distances(verts, heads, tails)
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
        lateral = side * (x - xc) > widths[rows]
        shoulder = joints[prefix + 'Arm']
        direction = joints[prefix + 'ForeArm'] - shoulder
        direction /= np.linalg.norm(direction)
        beyond = (verts - shoulder) @ direction > ARM_START * H
        arm_bones = [b for b in names if b.startswith(prefix) and ('Arm' in b or 'Hand' in b)]
        arm_dist = dist[:, [idx[b] for b in arm_bones]].min(axis=1)
        radius = _limb_radius(verts, joints[prefix + 'ForeArm'], joints[prefix + 'Hand'], H)
        # Lateral of the torso, or hugging the arm where a hand touches the body; never far from the arm.
        mask = beyond & (lateral | (arm_dist < 1.0 * radius)) & (arm_dist < 2.5 * radius) & (attach_to < 0)
        nearest_of(mask, arm_bones)
        # The wrist belongs to the hand (Mixamo's boundary sits before the wrist joint).
        wrist, elbow = joints[prefix + 'Hand'], joints[prefix + 'ForeArm']
        forearm = wrist - elbow
        length = np.linalg.norm(forearm)
        past = (verts - wrist) @ (forearm / length) > -HAND_START * length
        attach_to[(attach_to == idx[prefix + 'ForeArm']) & past] = idx[prefix + 'Hand']

    # Head and neck: above the neck band start, within the head's width (pauldrons stay torso).
    spine2_z, neck_z, head_z = joints['Spine2'][2], joints['Neck'][2], joints['Head'][2]
    neck_start = neck_z + NECK_START * (neck_z - spine2_z)
    head_row = sil.row(head_z)
    head_runs = [r for r in runs(sil.front[head_row]) if r[0] <= sil.center_col < r[1]]
    head_half = (max(head_runs[0][1] - sil.center_col, sil.center_col - head_runs[0][0]) * sil.pixel * 1.1
                 if head_runs else 0.2 * H)
    mask = (z > neck_start) & (np.abs(x - xc) < head_half) & (attach_to < 0)
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

    # Clavicles: top of the torso, lateral of the clavicle's inner end.
    torso = attach_to < 0
    clav_z = spine2_z + CLAVICLE_LOW * (neck_z - spine2_z)
    for prefix, sign in (('Left', 1), ('Right', -1)):
        inner = abs(joints[prefix + 'Shoulder'][0] - xc) + CLAVICLE_INNER * H
        mask = torso & (z > clav_z) & (sign * (x - xc) > inner)
        attach_to[mask] = idx[prefix + 'Shoulder']

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
