"""Spear Thrust: a one-handed underhand spear thrust behind a shield, made from Mixamo clips (none of the libraries we
draw from has a spear thrust: Mixamo, Meshy, Tripo).

  blender -b --factory-startup --python blender/clips/spear_thrust.py -- [--library DIR]

(`python3 blender/library/build.py convert` runs it when it or its sources change: work/sources.json names it.)

Made from two library sources (workspace/library/sources/mixamo-named/animation/):
  Stabbing 2 (a knife stab with the rear hand)  the body: the stance, the lunge, its timing; retimed to a jab
  Sword And Shield Idle 4                       the shield arm, held before him, turning with the torso
and the spear arm worked out again: the fist runs on one straight line from the guard (low by the hip) to the
strike (the arm at full stretch), the shaft along that line all the way (forward, rising a little, and in). The fist is turned
for the shaft: GRIP is the spear's axis in the canonical RightHand frame, measured on the Spearman's spear
(identical on every frame of every clip: the retargeter keeps a hand's frame). The forearm takes the twist that
keeps the wrist straightest.

Written straight into the library (DIR, default workspace/library) by the library's own converter (convert.py
convert_clip), run on Stabbing 2's armature as Blender holds it with the new motion keyed: so the clip keeps that
source's exact rest skeleton (an FBX written by Blender and read back moves the rest bones, and the retargeter reads
them) and is in every way a library clip: clips/custom-Spear_Thrust.glb, its meta and cache, its line in
work/sources.json (with `make`: this script, and `inputs`: its sources, for the build to remake it); then
`python3 blender/library/build.py aggregate` lists it.
"""
import math
import os
import sys

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(REPO, 'blender', 'library'))
sys.path.insert(0, HERE)
import convert as C  # noqa: E402
import common  # noqa: E402

WORKSPACE = os.environ.get('RIGSMITH_WORKSPACE', os.path.join(REPO, 'workspace'))
SOURCES = os.path.join(WORKSPACE, 'library', 'sources')
STAB = os.path.join(SOURCES, 'mixamo-named', 'animation', 'Stabbing_2.fbx')
SHIELD = os.path.join(SOURCES, 'mixamo-named', 'animation', 'Sword_And_Shield_Idle_4.fbx')
ID = 'custom-Spear_Thrust'

FPS = 30
# The spear's axis (towards its head) in the canonical RightHand frame: tools measure it from the Spearman's spear.
GRIP = np.array([0.896, 0.418, -0.153])
# Canonical space (Y up, metres, facing +Z; the Y Bot's 1.8 m): the fist at the guard, low by his right hip, and at
# the strike, the arm at full stretch before him; the shaft runs along the line between them, rising and turning in
# some 5 degrees each, to an enemy's chest. (Underhand: the Spearman's spear comes out of his fist on the thumb's side, a hammer grip, and an
# overhand thrust from by the ear bent his wrist 90-115 degrees.)
GUARD = np.array([-0.26, 1.06, -0.14])
STRIKE = np.array([-0.19, 1.13, 0.66])
# The jab's timing: new time (s) -> Stabbing 2's frame. The drive (its frames 6-15) in 0.2 s, a short hold at full
# stretch, the pull back; then a blend from its frame 33 to its guard (63), leaving out its dip and second follow-through.
TIME_MAP = [(0.0, 0.0), (0.22, 6.0), (0.42, 15.0), (0.58, 27.0), (0.78, 33.0)]
BLEND = (0.78, 1.25, 33.0, 63.0)
DURATION = 1.25
# A small draw back before the drive (share of the thrust's length, at this time, over this half width).
DRAW = (0.16, 0.17, 0.09)
# Where the elbow goes (canonical world): out to his right, a little down and back.
POLE = np.array([-1.0, -0.45, -0.15])
# How far the forearm may roll about itself (degrees) to keep the wrist straight.
FOREARM_ROLL = 90
SHIELD_FRAME = 0
# The shield arm turns back against this share of the torso's twist (Stabbing 2 swings the right shoulder forward
# some 40 degrees: the shield went out to his side, edge on).
SHIELD_HOLD = 0.75
LEFT_ARM = [n for n in C.CANON if n.startswith('Left') and ('Arm' in n or 'Hand' in n or n == 'LeftShoulder')]


def args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    return argv[argv.index('--library') + 1] if '--library' in argv else os.path.join(WORKSPACE, 'library')


# --------------------------------------------------------------------------- sampling (canonical space)

def sample(arm, frames):
    """Canonical world matrices (len(frames), 65, 4, 4) of the armature's canonical bones at (fractional) frames."""
    names, parents, _, _ = C.canonical_bones(arm)
    xf = C.canon_xform(arm)
    pb = arm.pose.bones
    order = np.array([pb.find(n) for n in names])
    buf = np.empty(len(pb) * 16, dtype=np.float32)
    out = np.empty((len(frames), len(C.CANON), 4, 4))
    scene = bpy.context.scene
    for i, f in enumerate(frames):
        whole = int(math.floor(f))
        scene.frame_set(whole, subframe=float(f - whole))
        pb.foreach_get('matrix', buf)
        out[i] = C.to_canon(buf.reshape(len(pb), 4, 4).transpose(0, 2, 1)[order].astype(np.float64), *xf)
    return out, names, parents, xf


def fk(L, parents):
    return common.fk(L, parents)


def quat(R):
    return C.mat_to_quat(R)


def quat_to_mat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def slerp(a, b, t):
    if np.dot(a, b) < 0:
        b = -b
    d = np.clip(np.dot(a, b), -1, 1)
    if d > 0.9995:
        q = a + t * (b - a)
        return q / np.linalg.norm(q)
    th = math.acos(d)
    return (math.sin((1 - t) * th) * a + math.sin(t * th) * b) / math.sin(th)


def blend_local(La, Lb, t):
    """Per-bone blend of local matrices: rotations slerped, translations lerped."""
    out = La.copy()
    for b in range(len(La)):
        q = slerp(quat(La[b, :3, :3]), quat(Lb[b, :3, :3]), t)
        out[b, :3, :3] = quat_to_mat(q)
        out[b, :3, 3] = (1 - t) * La[b, :3, 3] + t * Lb[b, :3, 3]
    return out


def turn(a, b):
    """The smallest rotation (3x3) taking direction a onto direction b."""
    a = a / np.linalg.norm(a); b = b / np.linalg.norm(b)
    v = np.cross(a, b); c = float(np.dot(a, b))
    if c < -0.999999:
        axis = np.cross(a, [1, 0, 0]) if abs(a[0]) < 0.9 else np.cross(a, [0, 1, 0])
        axis /= np.linalg.norm(axis)
        return 2 * np.outer(axis, axis) - np.eye(3)
    K = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + K + K @ K / (1 + c)


def about(axis, angle):
    axis = axis / np.linalg.norm(axis)
    K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + math.sin(angle) * K + (1 - math.cos(angle)) * K @ K


def smooth(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


# --------------------------------------------------------------------------- the jab

def source_frame(t):
    for (t0, f0), (t1, f1) in zip(TIME_MAP, TIME_MAP[1:]):
        if t <= t1:
            return f0 + (f1 - f0) * smooth((t - t0) / (t1 - t0)) if t1 > t0 else f1
    return TIME_MAP[-1][1]


def solve_arm(W, idx, target, shaft, base, pole, rest_wrist, last):
    """Two bones (RightArm, RightForeArm) put the RightHand joint on `target`, the elbow towards `pole`. The fist
    holds the shaft along `shaft`: its turn is `base` rolled about the shaft, the roll (and the forearm's own roll)
    the pair that leaves the wrist straightest, kept near the last frame's (`last`: (roll, forearm roll) degrees, or
    None). W is changed; returns (wrist bend in degrees, (roll, forearm roll))."""
    a, f, h = idx['RightArm'], idx['RightForeArm'], idx['RightHand']
    S = W[a, :3, 3]; E = W[f, :3, 3]; H = W[h, :3, 3]
    l1 = np.linalg.norm(E - S); l2 = np.linalg.norm(H - E)
    d = target - S
    dist = min(np.linalg.norm(d), (l1 + l2) * 0.999)
    dn = d / np.linalg.norm(d)
    # the elbow: in the plane of the target and the pole, at the law of cosines' angle
    cos_a = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist)
    side = pole - np.dot(pole, dn) * dn
    side /= np.linalg.norm(side)
    elbow = S + l1 * (cos_a * dn + math.sqrt(max(1 - cos_a * cos_a, 0)) * side)
    hand = S + dist * dn
    # upper arm: aimed at the new elbow (the smallest turn: its roll stays the source's); the forearm rides it
    Rd = turn(E - S, elbow - S)
    W[a, :3, :3] = Rd @ W[a, :3, :3]
    Rf0 = turn(Rd @ (H - E), hand - elbow) @ Rd @ W[f, :3, :3]
    axis = (hand - elbow) / np.linalg.norm(hand - elbow)
    best = None
    for r in range(0, 360, 5):
        Rh = about(shaft, math.radians(r)) @ base
        for k in range(-FOREARM_ROLL, FOREARM_ROLL + 1, 5):
            Rf = about(axis, math.radians(k)) @ Rf0
            rel = rest_wrist.T @ (Rf.T @ Rh)
            bend = math.degrees(math.acos(np.clip((np.trace(rel) - 1) / 2, -1, 1)))
            jump = 0.0 if last is None else abs((r - last[0] + 180) % 360 - 180) + abs(k - last[1])
            cost = bend + 0.4 * jump
            if best is None or cost < best[0]:
                best = (cost, bend, r, k, Rf, Rh)
    _, bend, r, k, Rf, Rh = best
    W[f, :3, :3] = Rf
    W[f, :3, 3] = elbow
    W[h, :3, :3] = Rh
    W[h, :3, 3] = hand
    return bend, (r, k)


def main():
    library = args()
    # the shield arm: Sword And Shield Idle 4's left arm, as local turns (they ride the torso)
    shield_arm = C.import_fbx(SHIELD)
    Ws, _, parents, _ = sample(shield_arm, [SHIELD_FRAME])
    Ls = C.local_from_world(Ws, parents)[0]
    # the body: Stabbing 2
    arm = C.import_fbx(STAB)
    act = arm.animation_data.action
    f_end = int(round(act.frame_range[1]))
    src_frames = list(range(int(round(act.frame_range[0])), f_end + 1))
    W_src, names, parents, xf = sample(arm, src_frames)
    L_src = C.local_from_world(W_src, parents)
    idx = {n: i for i, n in enumerate(C.CANON)}
    f_first = src_frames[0]
    Wr = C.rest_world(arm, names, xf)
    rest_wrist = Wr[idx['RightForeArm'], :3, :3].T @ Wr[idx['RightHand'], :3, :3]
    bend = lambda W: math.degrees(math.acos(np.clip((np.trace(rest_wrist.T @ (W[idx['RightForeArm'], :3, :3].T @ W[idx['RightHand'], :3, :3])) - 1) / 2, -1, 1)))  # noqa: E731
    print('SPEAR source wrist bend: ' + ', '.join(f'f{f} {bend(W_src[f - f_first]):.0f}' for f in (0, 9, 15, 24, 33, 45)))

    def src_local(f):
        f = min(max(f - f_first, 0), len(src_frames) - 1)
        i = int(math.floor(f)); t = f - i
        return L_src[i] if t < 1e-6 or i + 1 >= len(src_frames) else blend_local(L_src[i], L_src[i + 1], t)

    n = int(round(DURATION * FPS)) + 1
    poses = []
    # the shaft's line and the fist's turn (constant: the spear stays on its line)
    line = STRIKE - GUARD
    d = line / np.linalg.norm(line)
    strike_src = W_src[int(round(TIME_MAP[2][1])) - f_first]
    R0 = strike_src[idx['RightHand'], :3, :3]
    hand_rot = turn(R0 @ GRIP, d) @ R0
    # the source fist's progress forward, guard (0) to strike (1), from its depth
    z_guard = W_src[0, idx['RightHand'], 2, 3]
    z_strike = strike_src[idx['RightHand'], 2, 3]
    wrist = []
    last = None
    W_guard = W_src[0]
    across0 = W_guard[idx['LeftArm'], :3, 3] - W_guard[idx['RightArm'], :3, 3]
    yaw0 = math.atan2(-across0[2], across0[0])
    for k in range(n):
        t = k / FPS
        if t <= BLEND[0]:
            f = source_frame(t)
            L = src_local(f).copy()
            Wf = fk(L, parents)
            progress = (Wf[idx['RightHand'], 2, 3] - z_guard) / (z_strike - z_guard)
        else:
            u = smooth((t - BLEND[0]) / (BLEND[1] - BLEND[0]))
            La = src_local(BLEND[2]); Lb = src_local(BLEND[3])
            L = blend_local(La, Lb, u)
            Wa = fk(La, parents)
            pa = (Wa[idx['RightHand'], 2, 3] - z_guard) / (z_strike - z_guard)
            progress = (1 - u) * pa
        # the draw back before the drive
        progress -= DRAW[0] * max(0.0, 1 - ((t - DRAW[1]) / DRAW[2]) ** 2) ** 2
        progress = min(max(progress, -0.35), 1.0)
        # the shield arm, before him: the idle's, turned back against the torso's twist since the guard
        for name in LEFT_ARM:
            L[idx[name]] = Ls[idx[name]]
        W = fk(L, parents)
        across = W[idx['LeftArm'], :3, 3] - W[idx['RightArm'], :3, 3]
        yaw = math.atan2(-across[2], across[0]) - yaw0
        la = idx['LeftArm']
        Wl = W[la].copy()
        Wl[:3, :3] = about(np.array([0.0, 1.0, 0.0]), -SHIELD_HOLD * yaw) @ Wl[:3, :3]
        L[la] = np.linalg.inv(W[parents[la]]) @ Wl
        W = fk(L, parents)
        target = GUARD + progress * line
        bend_k, last = solve_arm(W, idx, target, d, hand_rot, POLE / np.linalg.norm(POLE), rest_wrist, last)
        wrist.append(bend_k)
        # the fingers ride the hand: their world matrices from their (unchanged) local ones
        Lw = C.local_from_world(W, parents)
        for name in C.CANON:
            if name.startswith('RightHand') and name != 'RightHand':
                Lw[idx[name]] = L[idx[name]]
        poses.append(fk(Lw, parents))
    print(f'SPEAR wrist bend: max {max(wrist):.0f} deg, mean {sum(wrist) / len(wrist):.0f}')
    common.key_poses(arm, names, parents, xf, poses, FPS, 'Spear Thrust')
    common.into_library(arm, library, job())
    print(f'SPEAR wrote {ID} into {library} ({n} frames, {DURATION} s)')


# --------------------------------------------------------------------------- back onto the FBX skeleton

def job():
    """The clip's line in the library's sources: made by this script from its inputs."""
    make = os.path.relpath(os.path.abspath(__file__), REPO)
    inputs = [STAB, SHIELD, common.COMMON]
    return {'id': ID, 'sha256': common.sha_of(make, inputs), 'kind': 'clip', 'source': 'custom', 'sourcePath': os.path.abspath(__file__),
            'make': make, 'inputs': inputs, 'sourceName': 'Spear_Thrust', 'name': 'Spear Thrust', 'originalName': 'Spear Thrust',
            'description': 'One-handed underhand spear thrust behind a shield: the fist on one straight line, the shaft along it (made from Stabbing 2 and Sword And Shield Idle 4 by blender/clips/spear_thrust.py).',
            'tags': ['spear', 'thrust', 'attack', 'one-handed', 'shield', 'melee']}


if __name__ == '__main__':
    main()
