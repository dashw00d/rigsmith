"""Turn detected markers into Mixamo joint positions (numpy only).

Proportions are calibrated against Mixamo's own auto-rigs of the Tripo characters in
workspace/rigdev/gt (see dev/fit_stats in the rig notes). All lengths are fractions of model height H.
"""
import numpy as np

import mixamo

# Calibrated against Mixamo rigs (mean over 11 stylized A-pose characters).
SHOULDER_ABOVE_ARMPIT = 0.100      # along the arm axis, from the armpit's projection
ELBOW_RATIO = 0.554                # shoulder -> wrist
WRIST_FROM_TIP = 0.334             # fraction of shoulder -> fingertip length
FALLBACK_SHOULDER = (0.150, 0.698)  # (|x| from center, z above ground) when the armpit can't be found
CLAVICLE_X = 0.051
CLAVICLE_ABOVE_ARM = 0.026
NECK_ABOVE_CLAVICLE = 0.014
HEAD_ABOVE_NECK = 0.037
UPLEG_Z = 0.409
UPLEG_X = 0.090
HIPS_ABOVE_UPLEG = 0.033
KNEE_RATIO = 0.527
ANKLE_Z = 0.117
SPINE_FRACTIONS = (0.2, 0.433, 0.7)  # Spine, Spine1, Spine2 between Hips and Neck
TOE_BASE_FRACTION = 0.65             # ankle -> toe tip, along depth
TOE_Z = 0.005
SPINE_DEPTH_BIAS = 0.55              # 0 front, 1 back

# Finger joints in the hand frame (x: along forearm, y: forward, z: x × forward), units of forearm length.
FINGER_LAYOUT = {
    'Thumb': [(0.196, 0.15, 0.128), (0.353, 0.271, 0.231), (0.503, 0.363, 0.343), (0.635, 0.406, 0.388)],
    'Index': [(0.556, 0.004, 0.071), (0.806, -0.025, 0.087), (1.015, -0.012, 0.153), (1.207, 0.123, 0.234)],
    # Not in the ground truth (Mixamo used two chains). Spread from Index toward the back of the hand.
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
    clavicle_z = arm_z + CLAVICLE_ABOVE_ARM * H
    neck_z = clavicle_z + NECK_ABOVE_CLAVICLE * H
    head_z = neck_z + HEAD_ABOVE_NECK * H
    put_spine('Hips', hips_z)
    for name, fraction in zip(('Spine', 'Spine1', 'Spine2'), SPINE_FRACTIONS):
        put_spine(name, hips_z + fraction * (neck_z - hips_z))
    put_spine('Neck', neck_z)
    put_spine('Head', head_z)
    head_top = _head_top(sil, xc)
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

    # Fingers, in a frame built from the forearm direction.
    _add_fingers(joints, fingers)

    # Mirror every Left* joint to Right*.
    for name in list(joints):
        if name.startswith('Left'):
            p = joints[name]
            joints[mixamo.mirror_name(name)] = np.array([2 * xc - p[0], p[1], p[2]])
    order = [b for b, _ in mixamo.hierarchy(fingers)]
    return {b: joints[b] for b in order}


def _head_top(sil, xc):
    """Top of the silhouette near the center column (skips ears/antlers off to the side)."""
    band = np.abs(sil.points[:, 0] - xc) < 0.04 * sil.height
    return float(np.percentile(sil.points[band, 2], 99.5))


def _toe_tip_y(sil, toe_x, z0, H):
    near = (np.abs(sil.points[:, 0] - toe_x) < 0.05 * H) & (sil.points[:, 2] < z0 + 0.08 * H)
    return float(np.percentile(sil.points[near, 1], 0.5))


def _add_fingers(joints, fingers):
    wrist, elbow = joints['LeftHand'], joints['LeftForeArm']
    x_axis = wrist - elbow
    length = np.linalg.norm(x_axis)
    x_axis /= length
    forward = np.array([0.0, -1.0, 0.0])
    y_axis = forward - (forward @ x_axis) * x_axis
    y_axis /= np.linalg.norm(y_axis)
    z_axis = np.cross(x_axis, y_axis)  # matches the ground-truth frame (z = x × forward)
    for finger in mixamo.FINGER_LEVELS[fingers]:
        for i, (fx, fy, fz) in enumerate(FINGER_LAYOUT[finger], start=1):
            joints[f'LeftHand{finger}{i}'] = wrist + length * (fx * x_axis + fy * y_axis + fz * z_axis)
