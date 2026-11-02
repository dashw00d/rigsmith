"""Turn detected markers into Mixamo joint positions (numpy only).

Proportions are calibrated against Mixamo's own auto-rigs of the Tripo characters in
workspace/rigdev/gt (see dev/fit_stats in the rig notes). All lengths are fractions of model height H.
"""
import numpy as np

import mixamo
from fingers import finger_chains, hand_fingers, space_evenly
from hands import measure_hand, mirror, symmetric_hand


def validate_joints(joints, hierarchy):
    """Reject invalid placements before geometric fitting or heat diffusion.

    A collapsed limb has no direction: substituting an arbitrary bone tail does
    not repair its regions, palm frame or weights. Name the conflicting markers.
    Missing positions are left to the fitter to complete.
    """
    if not joints:
        raise ValueError('No joint placements supplied')
    for name, point in joints.items():
        if np.shape(point) != (3,) or not np.isfinite(point).all():
            raise ValueError(f'{name} needs three finite coordinates')
    extent = float(np.linalg.norm(np.ptp(np.asarray(list(joints.values())), axis=0)))
    tolerance = max(extent * 1e-6, 1e-8)
    for name, parent in hierarchy:
        if parent in joints and name in joints and np.linalg.norm(np.asarray(joints[name]) - joints[parent]) <= tolerance:
            raise ValueError(f'{parent} and {name} overlap; move their markers apart before rigging')


# Calibrated against Mixamo rigs (mean over 11 stylized A-pose characters).
SHOULDER_ABOVE_ARMPIT = 0.100      # along the arm axis, from the armpit's projection
ELBOW_RATIO = 0.554                # shoulder -> wrist
WRIST_FROM_TIP = 0.334             # fraction of shoulder -> fingertip length
FALLBACK_SHOULDER = (0.150, 0.698)  # (|x| from center, z above ground) when the armpit can't be found
CLAVICLE_X = 0.051
CLAVICLE_ABOVE_ARM = 0.026
HEAD_ABOVE_CHIN_NOTCH = 0.027    # Mixamo's head joint above its neck joint where the chin shows
CHIN_NOTCH_DEPTH = 0.04          # a profile notch at least this deep (fraction of H) is a real chin
# Where beards, hoods and pelts hide the chin, the reference rigs put it where the chin would be under the
# beard, and their neck lands anywhere from 4% below the shoulders to 7% above them. Measured down from the
# top of the head it varies half as much, and less again scaled by how bulky the head is: hoods and pelts
# make it both taller and wider. Width of the head 12% of H below its top -> distance from the top, fit over
# all 12 reference rigs (leave-one-out on the 7 without a chin notch: neck 2.9 -> 2.3% of H, head
# 2.2 -> 1.6; a tall narrow helmet like Raider's is what it can't see).
HEAD_WIDTH_BELOW_TOP = 0.12
NECK_BELOW_TOP = (0.1312, 0.5463)    # intercept, per unit of head width (both fractions of H)
HEAD_BELOW_TOP = (0.1294, 0.3786)
HEAD_WIDTH_RANGE = (0.14, 0.32)      # widths seen on the reference rigs, a little extended
CLAVICLE_FROM_NECK = -0.012      # Mixamo's clavicle follows its neck; halfway between this and the arm's
UPLEG_Z = 0.409
UPLEG_X = 0.090
HIPS_ABOVE_UPLEG = 0.033
KNEE_RATIO = 0.527
ANKLE_Z = 0.117
SPINE_FRACTIONS = (0.2, 0.433, 0.7)  # Spine, Spine1, Spine2 between Hips and Neck
TOE_BASE_FRACTION = 0.65             # ankle -> toe tip, along depth
TOE_Z = 0.005
SPINE_DEPTH_BIAS = 0.55              # 0 front, 1 back

# Finger joints in the measured hand frame (hands.py): (along the hand, toward the thumb, palm side), in
# units of hand length (wrist -> fingertip). Thumb and index are medians of Mixamo's rigs of the Tripo
# characters (dev/calib_hands.py). Index runs a little thumbward of the hand's center line so a mitten
# (two-chain) hand curls evenly; the other fingers fan across the palm.
FINGER_LAYOUT = {
    'Thumb': [(0.169, 0.177, 0.029), (0.304, 0.318, 0.053), (0.429, 0.44, 0.083), (0.53, 0.5, 0.087)],
    'Index': [(0.55, 0.06, 0.0), (0.70, 0.065, 0.0), (0.84, 0.07, 0.0), (0.97, 0.075, 0.0)],
    'Middle': [(0.56, -0.01, 0.0), (0.72, -0.01, 0.0), (0.87, -0.01, 0.0), (1.0, -0.01, 0.0)],
    'Ring': [(0.54, -0.08, 0.0), (0.69, -0.085, 0.0), (0.83, -0.09, 0.0), (0.95, -0.09, 0.0)],
    'Pinky': [(0.51, -0.15, 0.0), (0.64, -0.16, 0.0), (0.75, -0.165, 0.0), (0.86, -0.17, 0.0)],
}
# The deliberate fallback when the hand can't be measured (hands.py finds no hand frame: a fist, a hand in a sleeve
# or fused to a prop), so every finger joint of the level still gets a place (_add_fingers): laid in the forearm frame
# (x along the forearm, y forward, z = x cross forward), in units of forearm length. Kept on purpose, not left over:
# the user then places the fingers on the marker board's hand views or in 3D.
FOREARM_FINGER_LAYOUT = {
    'Thumb': [(0.196, 0.15, 0.128), (0.353, 0.271, 0.231), (0.503, 0.363, 0.343), (0.635, 0.406, 0.388)],
    'Index': [(0.556, 0.004, 0.071), (0.806, -0.025, 0.087), (1.015, -0.012, 0.153), (1.207, 0.123, 0.234)],
    'Middle': [(0.565, 0.0, 0.0), (0.82, -0.02, 0.0), (1.03, -0.01, 0.0), (1.22, 0.1, 0.0)],
    'Ring': [(0.55, 0.0, -0.065), (0.79, -0.02, -0.075), (0.98, -0.01, -0.08), (1.15, 0.08, -0.085)],
    'Pinky': [(0.52, 0.0, -0.125), (0.72, -0.02, -0.14), (0.87, -0.01, -0.15), (1.0, 0.06, -0.16)],
}


class ArmModel:
    """Arm axis in the front plane (x, z) with the measured shoulder/tip parameters."""

    def __init__(self, arm, height, x_center, z_min, side):
        center, direction = arm['axis']
        self.center, self.dir = center, direction
        tip = np.array([arm['tip'][0], arm['tip'][2]])
        armpit = np.array([arm['armpit'][0], arm['armpit'][2]])
        self.t_tip = float((tip - center) @ direction)
        t_armpit = float((armpit - center) @ direction)
        t_shoulder = t_armpit - SHOULDER_ABOVE_ARMPIT * height
        length = self.t_tip - t_shoulder
        armpit_z = arm['armpit'][2]
        # Wide sleeves that merge with a robe stop the trace early (low armpit): fall back to proportions.
        self.reliable = 0.3 * height < length < 0.6 * height and arm['armpit_rel_z'] > 0.47
        if not self.reliable:
            # Re-anchor the axis on a proportional shoulder and aim it at the fingertips.
            shoulder = np.array([x_center + side * FALLBACK_SHOULDER[0] * height, z_min + FALLBACK_SHOULDER[1] * height])
            self.center = shoulder
            self.dir = (tip - shoulder) / np.linalg.norm(tip - shoulder)
            self.t_tip = float(np.linalg.norm(tip - shoulder))
            t_shoulder = 0.0
        self.t_shoulder = t_shoulder
        self.armpit_z = armpit_z

    def point(self, t):
        return self.center + t * self.dir

    def joints(self):
        length = self.t_tip - self.t_shoulder
        t_wrist = self.t_tip - WRIST_FROM_TIP * length
        t_elbow = self.t_shoulder + ELBOW_RATIO * (t_wrist - self.t_shoulder)
        return {'Arm': self.point(self.t_shoulder), 'ForeArm': self.point(t_elbow), 'Hand': self.point(t_wrist)}


def _mirror_xz(p, x_center):
    return np.array([2 * x_center - p[0], p[1]])


def symmetric_arm_joints(markers):
    """Left-side arm joints (x, z), averaged with the mirrored right side when both are usable."""
    height, xc = markers['height'], markers['x_center']
    models = {}
    for side in ('left', 'right'):
        arm = markers['arms'].get(side)
        if arm is not None:
            models[side] = ArmModel(arm, height, xc, markers['z_min'], 1 if side == 'left' else -1)
    if not models:
        raise RuntimeError('No arms found. Is the model in A- or T-pose and facing -Y?')
    usable = [s for s, m in models.items() if m.reliable] or list(models)
    estimates = []
    for side in usable:
        joints = models[side].joints()
        if side == 'right':
            joints = {k: _mirror_xz(v, xc) for k, v in joints.items()}
        estimates.append(joints)
    return {k: np.mean([e[k] for e in estimates], axis=0) for k in estimates[0]}


def build_joints(sil, markers, fingers='two'):
    """World-space head position of every Mixamo bone (left/right symmetric)."""
    H, z0, xc = markers['height'], markers['z_min'], markers['x_center']
    joints = {}

    def put(name, x, z, bias=0.5, y=None):
        joints[name] = np.array([x, sil.depth_center(x, z, bias=bias) if y is None else y, z])

    def put_spine(name, z):
        # Capes and backpacks inflate the depth; measure from the front and cap the torso depth.
        front, back = sil.depth_range(xc, z)
        joints[name] = np.array([xc, front + SPINE_DEPTH_BIAS * min(back - front, 0.28 * H), z])

    # Arms
    arm = symmetric_arm_joints(markers)
    arm_z = arm['Arm'][1]
    for name, (x, z) in arm.items():
        put('Left' + name, x, z)

    # Spine and head
    upleg_z = z0 + UPLEG_Z * H
    hips_z = upleg_z + HIPS_ABOVE_UPLEG * H
    head_top = _head_top(sil, xc)
    # Where the face shows, the neck sits in the notch under the chin (side profile); where beards, hoods
    # and pelts hide it, neck and head hang from the top of the head.
    notch = _chin_notch(sil, xc, arm_z, H)
    markers['chin_notch'] = notch
    if notch is not None:
        neck_z = notch
        head_z = neck_z + HEAD_ABOVE_CHIN_NOTCH * H
    else:
        width = np.clip(_head_width(sil, xc, head_top - HEAD_WIDTH_BELOW_TOP * H) / H, *HEAD_WIDTH_RANGE)
        neck_z = head_top - (NECK_BELOW_TOP[0] + NECK_BELOW_TOP[1] * width) * H
        head_z = head_top - (HEAD_BELOW_TOP[0] + HEAD_BELOW_TOP[1] * width) * H
    clavicle_z = 0.5 * (arm_z + CLAVICLE_ABOVE_ARM * H + neck_z + CLAVICLE_FROM_NECK * H)
    put_spine('Hips', hips_z)
    for name, fraction in zip(('Spine', 'Spine1', 'Spine2'), SPINE_FRACTIONS):
        put_spine(name, hips_z + fraction * (neck_z - hips_z))
    put_spine('Neck', neck_z)
    put_spine('Head', head_z)
    put('HeadTop_End', xc, head_top, 0.5)
    put('LeftShoulder', xc + CLAVICLE_X * H, clavicle_z, SPINE_DEPTH_BIAS)

    # Legs
    legs = markers.get('legs')
    leg_x = xc + UPLEG_X * H
    if legs is not None and len(legs['centers']['left']) > 4:
        centers = legs['centers']['left']
        # Line x(z) through the tracked leg centers; read off at hip/knee/ankle heights.
        slope, intercept = np.polyfit(centers[:, 1], centers[:, 0], 1)
        leg_at = lambda z: float(slope * z + intercept)  # noqa: E731
        right = legs['centers']['right']
        r_slope, r_intercept = np.polyfit(right[:, 1], right[:, 0], 1)
        right_at = lambda z: float(r_slope * z + r_intercept)  # noqa: E731
        sym_at = lambda z: 0.5 * (leg_at(z) + (2 * xc - right_at(z)))  # noqa: E731
    else:
        sym_at = lambda z: leg_x  # noqa: E731
    ankle_z = z0 + ANKLE_Z * H
    knee_z = upleg_z + KNEE_RATIO * (ankle_z - upleg_z)
    put('LeftUpLeg', 0.5 * (sym_at(upleg_z) + leg_x), upleg_z)
    put('LeftLeg', sym_at(knee_z), knee_z)
    put('LeftFoot', sym_at(ankle_z), ankle_z)
    toe_x = sym_at(z0 + 0.02 * H)
    toe_tip_y = _toe_tip_y(sil, toe_x, z0, H)
    ankle_y = joints['LeftFoot'][1]
    toe_end_y = toe_tip_y + 0.009 * H
    put('LeftToeBase', toe_x, z0 + TOE_Z * H, y=ankle_y + TOE_BASE_FRACTION * (toe_end_y - ankle_y))
    put('LeftToe_End', toe_x, z0 + TOE_Z * H, y=toe_end_y)

    # Fingers, in the measured hand frame (both hands measured, averaged mirrored).
    hand = None
    if mixamo.FINGER_LEVELS[fingers]:
        both = dict(joints)
        for name in ('LeftHand', 'LeftForeArm'):
            p = joints[name]
            both[mixamo.mirror_name(name)] = np.array([2 * xc - p[0], p[1], p[2]])
        hand = symmetric_hand(sil.verts, sil.tris, both, H, xc)
    _add_fingers(joints, fingers, hand)
    if mixamo.FINGER_LEVELS[fingers]:
        detected = detect_finger_joints(sil.verts, sil.tris, both, H, xc)
        markers['fingers_traced'] = bool(detected)
        if detected:
            joints.update(fit_finger_level(detected, fingers, joints))

    # Mirror every Left* joint to Right*.
    for name in list(joints):
        if name.startswith('Left'):
            p = joints[name]
            joints[mixamo.mirror_name(name)] = np.array([2 * xc - p[0], p[1], p[2]])
    order = [b for b, _ in mixamo.hierarchy(fingers)]
    return {b: joints[b] for b in order}


def _chin_notch(sil, xc, arm_z, H):
    """Height of the notch under the chin in the side profile, or None when there's no clear one.

    The front of the body's central band, from just below the shoulders to above them: the face juts
    forward, the neck recedes under it, the chest juts forward again. The deepest recess relative to
    both sides is the under-chin notch."""
    pts = sil.points
    band = np.abs(pts[:, 0] - xc) < 0.06 * H
    zs = np.arange(arm_z - 0.08 * H, arm_z + 0.2 * H, 0.004 * H)
    front = np.full(len(zs), np.nan)
    for i, z in enumerate(zs):
        near = band & (np.abs(pts[:, 2] - z) < 0.004 * H)
        if near.sum() > 3:
            front[i] = np.percentile(pts[near, 1], 2)  # front = smallest Y
    ok = np.isfinite(front)
    if ok.sum() < len(zs) * 0.6:
        return None
    front = np.interp(zs, zs[ok], front[ok])
    depth = np.array([front[i] - max(front[:i].min() if i else front[i], front[i + 1:].min() if i + 1 < len(zs) else front[i])
                      for i in range(len(zs))])
    k = int(np.argmax(depth))
    if depth[k] < CHIN_NOTCH_DEPTH * H or not (arm_z - 0.06 * H <= zs[k] <= arm_z + 0.12 * H):
        return None
    return float(zs[k])


def _head_top(sil, xc):
    """Top of the silhouette near the center column (skips ears/antlers off to the side)."""
    band = np.abs(sil.points[:, 0] - xc) < 0.04 * sil.height
    return float(np.percentile(sil.points[band, 2], 99.5))


def _head_width(sil, xc, z):
    """Width of the front silhouette's central run at height z (the head and whatever it wears)."""
    row = sil.front[sil.row(z)]
    col = sil.center_col
    if not row[col]:
        return 0.0
    left, right = col, col
    while left > 0 and row[left - 1]:
        left -= 1
    while right < len(row) - 1 and row[right + 1]:
        right += 1
    return (right - left + 1) * sil.pixel


def _toe_tip_y(sil, toe_x, z0, H):
    near = (np.abs(sil.points[:, 0] - toe_x) < 0.05 * H) & (sil.points[:, 2] < z0 + 0.08 * H)
    return float(np.percentile(sil.points[near, 1], 0.5))


def _layout(table, finger, fingers):
    """A finger's layout at a level: at three the Middle chain is a mitten down the middle of middle, ring and pinky."""
    if fingers == 'three' and finger == 'Middle':
        return [tuple(np.mean([table[f][i] for f in ('Middle', 'Ring', 'Pinky')], axis=0)) for i in range(len(table['Middle']))]
    return table[finger]


def _add_fingers(joints, fingers, hand=None):
    wrist = joints['LeftHand']
    if hand is not None:
        frame = np.stack([hand['axis'], hand['thumb'], hand['palm']])
        for finger in mixamo.FINGER_LEVELS[fingers]:
            for i, offset in enumerate(_layout(FINGER_LAYOUT, finger, fingers), start=1):
                joints[f'LeftHand{finger}{i}'] = wrist + hand['length'] * (np.array(offset) @ frame)
        return
    elbow = joints['LeftForeArm']
    x_axis = wrist - elbow
    length = np.linalg.norm(x_axis)
    x_axis /= length
    forward = np.array([0.0, -1.0, 0.0])
    y_axis = forward - (forward @ x_axis) * x_axis
    y_axis /= np.linalg.norm(y_axis)
    z_axis = np.cross(x_axis, y_axis)  # matches the ground-truth frame (z = x × forward)
    for finger in mixamo.FINGER_LEVELS[fingers]:
        for i, (fx, fy, fz) in enumerate(_layout(FOREARM_FINGER_LAYOUT, finger, fingers), start=1):
            joints[f'LeftHand{finger}{i}'] = wrist + length * (fx * x_axis + fy * y_axis + fz * z_axis)


def detect_finger_joints(verts, tris, joints, height, x_center):
    """Left-hand finger joints traced from the mesh (both hands, the right one mirrored and averaged).

    {'LeftHandThumb2': p, ..., 'LeftHandPinky4': p}; empty when neither hand shows five fingers."""
    per_side = []
    for prefix, side in (('Left', 1), ('Right', -1)):
        wrist, elbow = joints[prefix + 'Hand'], joints[prefix + 'ForeArm']
        hand = measure_hand(verts, tris, wrist, elbow, side, height)
        if hand is None:
            continue
        labeled = hand_fingers(verts, tris, hand, wrist, height)
        if not labeled:
            continue
        chains = space_evenly(finger_chains(labeled, wrist, hand['axis']), verts, hand, wrist)
        out = {}
        for finger, points in chains.items():
            for i, p in enumerate(points, start=1):
                if p is not None:
                    out[f'LeftHand{finger}{i}'] = p if side > 0 else np.array([2 * x_center - p[0], p[1], p[2]])
        per_side.append(out)
    if not per_side:
        return {}
    keys = set.intersection(*(set(d) for d in per_side))
    return {k: np.mean([d[k] for d in per_side], axis=0) for k in keys}


def fit_finger_level(detected, fingers, joints):
    """Detected five-finger joints reduced to the requested level. Mitten levels (Mixamo's one/two
    chains) drive all four fingers from the Index chain, so it runs down the middle of them; at three the Index chain
    is the index finger and the Middle chain runs down the middle of middle, ring and pinky."""
    out = {}
    wanted = mixamo.FINGER_LEVELS[fingers]
    for finger in wanted:
        for i in range(1, 5):
            name = f'LeftHand{finger}{i}'
            together = (('Index', 'Middle', 'Ring', 'Pinky') if finger == 'Index' and fingers in ('one', 'two') else
                        ('Middle', 'Ring', 'Pinky') if finger == 'Middle' and fingers == 'three' else None)
            if together:
                pts = [detected.get(f'LeftHand{f}{i}') for f in together]
                pts = [p for p in pts if p is not None]
                if pts:
                    out[name] = np.mean(pts, axis=0)
            elif name in detected:
                out[name] = detected[name]
    return out


def complete_joints(verts, tris, supplied, fingers):
    """Fill only missing joints, tracing new fingers at the edited wrists.

    Switching finger level must not mix a fitted body with fingers from the
    original, unedited detection, or report bones that the rig does not contain.
    """
    expected = [b for b, _ in mixamo.hierarchy(fingers)]
    joints = {k: np.array(v, dtype=float).copy() for k, v in supplied.items() if k in expected}
    missing = set(expected) - joints.keys()
    if not missing:
        return joints
    core = [b for b, _ in mixamo.hierarchy('none')]
    if any(b not in joints for b in core):
        from landmarks import detect_markers
        sil, markers = detect_markers(verts, tris)
        auto = build_joints(sil, markers, fingers=fingers)
        joints.update({b: auto[b] for b in core if b not in joints})
    height = float(np.ptp(verts[:, 2]))
    for prefix, side in [('Left', 1), ('Right', -1)]:
        if not any(b.startswith(prefix + 'Hand') for b in missing):
            continue
        wrist, elbow = joints[prefix + 'Hand'], joints[prefix + 'ForeArm']
        hand = measure_hand(verts, tris, wrist, elbow, side, height)
        local = {'LeftHand': wrist.copy(), 'LeftForeArm': elbow.copy()}
        _add_fingers(local, fingers, hand)
        if hand is not None:
            labeled = hand_fingers(verts, tris, hand, wrist, height)
            detected = {f'LeftHand{f}{i}': point for f, points in space_evenly(finger_chains(labeled, wrist, hand['axis']), verts, hand, wrist).items()
                        for i, point in enumerate(points, 1) if point is not None}
            local.update(fit_finger_level(detected, fingers, local))
        for b in expected:
            if b.startswith(prefix + 'Hand') and b not in joints:
                joints[b] = local['Left' + b[len(prefix):]]
    return {b: joints[b] for b in expected}
