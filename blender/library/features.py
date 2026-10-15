"""Motion features + matching signature for one clip (pure numpy).

Shared by convert.py (runs inside Blender while converting) and build.py
(system python3; re-computes from the cached joint positions when
FEATURES_VERSION changes, so heuristics can be tuned without Blender).

Input is world-space joint positions in canonical space (glTF: Y-up, meters,
character initially faces +Z, character's left = +X) for FEATURE_JOINTS.
"""
import math

import numpy as np

FEATURES_VERSION = 6

FEATURE_JOINTS = [
    "Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "HeadTop_End",
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand", "LeftHandMiddle1",
    "RightShoulder", "RightArm", "RightForeArm", "RightHand", "RightHandMiddle1",
    "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase", "LeftToe_End",
    "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase", "RightToe_End",
]
JI = {n: i for i, n in enumerate(FEATURE_JOINTS)}

# Segments used for the matching signature (parent joint -> child joint).
SIG_SEGMENTS = [
    ("Hips", "Spine2"), ("Spine2", "Head"), ("Head", "HeadTop_End"),
    ("LeftShoulder", "LeftArm"), ("LeftArm", "LeftForeArm"), ("LeftForeArm", "LeftHand"), ("LeftHand", "LeftHandMiddle1"),
    ("RightShoulder", "RightArm"), ("RightArm", "RightForeArm"), ("RightForeArm", "RightHand"), ("RightHand", "RightHandMiddle1"),
    ("LeftUpLeg", "LeftLeg"), ("LeftLeg", "LeftFoot"), ("LeftFoot", "LeftToeBase"),
    ("RightUpLeg", "RightLeg"), ("RightLeg", "RightFoot"), ("RightFoot", "RightToeBase"),
    ("RightUpLeg", "LeftUpLeg"),  # pelvis left vector (carries hips yaw/roll)
]
SIG_SAMPLES = 32

REGIONS = {
    "armL": ["LeftArm", "LeftForeArm", "LeftHand"],
    "armR": ["RightArm", "RightForeArm", "RightHand"],
    "legL": ["LeftLeg", "LeftFoot", "LeftToeBase"],
    "legR": ["RightLeg", "RightFoot", "RightToeBase"],
    "spine": ["Spine1", "Spine2", "Neck", "Head", "HeadTop_End"],
}


def _r(x, nd=4):
    if isinstance(x, (list, tuple, np.ndarray)):
        return [_r(v, nd) for v in x]
    x = float(x)
    if not math.isfinite(x):
        return None
    return round(x, nd)


def facing_yaw(P):
    """Unwrapped yaw (rad, about +Y) of the pelvis per frame. 0 = facing +Z,
    positive = turned toward the character's (initial) left (+X)."""
    left = P[:, JI["LeftUpLeg"]] - P[:, JI["RightUpLeg"]]
    lx, lz = left[:, 0], left[:, 2]
    norm = np.hypot(lx, lz)
    width = np.linalg.norm(left, axis=1)
    valid = norm > 0.35 * np.maximum(width, 1e-6)
    yaw = np.arctan2(-lz, lx)  # forward = (-lz, lx) -> atan2(fx, fz)
    # forward-fill invalid (pelvis rolled onto its side)
    if not valid.any():
        return np.zeros(len(P)), valid
    idx = np.where(valid, np.arange(len(P)), 0)
    np.maximum.accumulate(idx, out=idx)
    first = np.argmax(valid)
    idx[:first] = first
    yaw = yaw[idx]
    return np.unwrap(yaw), valid


def rot_y(v, ang):
    """Rotate vectors v (...,3) about +Y by ang (broadcast over leading axis)."""
    c, s = np.cos(ang), np.sin(ang)
    x, y, z = v[..., 0], v[..., 1], v[..., 2]
    return np.stack([x * c + z * s, y, -x * s + z * c], axis=-1)


def alternations(sig, thr):
    state, count = 0, 0
    for v in sig:
        if v > thr:
            if state == -1:
                count += 1
            state = 1
        elif v < -thr:
            if state == 1:
                count += 1
            state = -1
    return count


def runs(mask):
    best, cur = 0, 0
    for m in mask:
        cur = cur + 1 if m else 0
        best = max(best, cur)
    return best


def compute(P, rest, fps):
    """P: (N, J, 3) positions of FEATURE_JOINTS per frame; rest: (J, 3)."""
    P = np.asarray(P, dtype=np.float64)
    rest = np.asarray(rest, dtype=np.float64)
    N = P.shape[0]
    dt = 1.0 / fps
    duration = (N - 1) / fps
    h = float(rest[JI["Hips"], 1])  # rest hips height (m)
    s = h  # length scale: thresholds below are written for a 1 m hips height
    hips = P[:, JI["Hips"]]
    yaw, yaw_valid = facing_yaw(P)
    yaw0 = yaw[0]
    feats = {"fps": _r(fps, 3), "frames": int(N), "duration": _r(duration), "restHipsHeight": _r(h)}

    # ---- root motion -------------------------------------------------
    d = hips - hips[0]
    d0 = rot_y(d, -yaw0)  # in the initial facing frame (+Z forward, +X left)
    net = float(np.hypot(d[-1, 0], d[-1, 2]))
    step = np.hypot(np.diff(hips[:, 0]), np.diff(hips[:, 2])) if N > 1 else np.zeros(1)
    path = float(step.sum())
    max_disp = float(np.hypot(d[:, 0], d[:, 2]).max())
    heading = math.degrees(math.atan2(d0[-1, 0], d0[-1, 2])) if net > 1e-4 else 0.0
    # body-frame velocity direction (relative to the current facing)
    if N > 2:
        vh = np.diff(hips, axis=0) / dt
        vb = rot_y(vh, -yaw[1:])
        mv = vb[:, [0, 2]].mean(axis=0)
        local_dir = math.degrees(math.atan2(mv[0], mv[1]))
        local_speed = float(np.hypot(*mv))
    else:
        local_dir, local_speed = 0.0, 0.0
    feats.update({
        "hipsStart": _r(hips[0]), "hipsEnd": _r(hips[-1]),
        "travel": _r(net), "travelPath": _r(path), "maxHorizontalDisp": _r(max_disp),
        "headingDeg": _r(heading, 1),  # 0 fwd, +90 character-left, -90 character-right, 180 back
        "moveDirDeg": _r(local_dir, 1), "moveSpeed": _r(local_speed),
        "speed": _r(net / duration if duration > 0 else 0.0),
        "netYawDeg": _r(math.degrees(yaw[-1] - yaw[0]), 1),
        "totalYawDeg": _r(math.degrees(np.abs(np.diff(yaw)).sum()) if N > 1 else 0.0, 1),
        "verticalTravel": _r(d[-1, 1]),
    })

    # ---- heights / ground ---------------------------------------------
    hy = hips[:, 1] / h
    low = P[:, :, 1].min(axis=1)
    rest_low = float(rest[:, 1].min())
    ground = min(float(np.percentile(low, 2)), rest_low + 0.05 * s)
    clear = low - ground
    airborne = clear > 0.10 * s
    feet = {k: np.minimum(P[:, JI[k + "Foot"], 1], P[:, JI[k + "ToeBase"], 1]) - ground for k in ("Left", "Right")}
    both_feet_up = (feet["Left"] > 0.12 * s) & (feet["Right"] > 0.12 * s)
    hands_y = np.minimum(P[:, JI["LeftHand"], 1], P[:, JI["RightHand"], 1]) - ground
    torso = P[:, JI["Neck"]] - hips
    pitch = np.degrees(np.arccos(np.clip(torso[:, 1] / np.maximum(np.linalg.norm(torso, axis=1), 1e-9), -1, 1)))
    knee_l = P[:, JI["LeftLeg"], 1] - ground
    knee_r = P[:, JI["RightLeg"], 1] - ground
    feats.update({
        "hipsHeight": {"min": _r(hy.min()), "max": _r(hy.max()), "mean": _r(hy.mean()),
                       "start": _r(hy[0]), "end": _r(hy[-1])},
        "groundY": _r(ground),
        "endsLow": bool(hy[-1] < 0.55),
        "startsLow": bool(hy[0] < 0.55),
        "airborneFrames": int(airborne.sum()),
        "airborneMaxRun": _r(runs(airborne) / fps, 3),
        "feetUpFrames": int(both_feet_up.sum()),
        "feetUpMaxRun": _r(runs(both_feet_up) / fps, 3),
        "maxClearance": _r(clear.max()),
        "torsoPitch": {"mean": _r(pitch.mean(), 1), "max": _r(pitch.max(), 1),
                       "start": _r(pitch[0], 1), "end": _r(pitch[-1], 1)},
        "invertedFrames": int((pitch > 120).sum()),
        "handsNearGroundFrac": _r(float((hands_y < 0.12 * s).mean()), 3),
        "kneeNearGroundFrac": _r(float((np.minimum(knee_l, knee_r) < 0.15 * s).mean()), 3),
        "hipsDropSpeed": _r(float(-(np.diff(hips[:, 1]) / dt).min()) if N > 1 else 0.0),
        "hipsRiseSpeed": _r(float((np.diff(hips[:, 1]) / dt).max()) if N > 1 else 0.0),
    })

    # ---- body-local motion energy -------------------------------------
    rel = P - hips[:, None, :]
    B = rot_y(rel, -yaw[:, None])
    if N > 1:
        V = np.diff(B, axis=0) / dt
        sp = np.linalg.norm(V, axis=2)
    else:
        sp = np.zeros((1, P.shape[1]))
    energy = {k: float(sp[:, [JI[j] for j in js]].mean()) for k, js in REGIONS.items()}
    arms = energy["armL"] + energy["armR"]
    legs = energy["legL"] + energy["legR"]
    hand_sp = np.maximum(sp[:, JI["LeftHand"]], sp[:, JI["RightHand"]])
    foot_sp = np.maximum(sp[:, JI["LeftFoot"]], sp[:, JI["RightFoot"]])
    world_sp = np.linalg.norm(np.diff(P, axis=0), axis=2) / dt if N > 1 else np.zeros((1, P.shape[1]))
    hand_h = np.maximum(B[:, JI["LeftHand"], 1], B[:, JI["RightHand"], 1])  # relative to hips height
    feats["energy"] = {
        "arms": _r(arms / 2), "legs": _r(legs / 2), "spine": _r(energy["spine"]),
        "armL": _r(energy["armL"]), "armR": _r(energy["armR"]),
        "legL": _r(energy["legL"]), "legR": _r(energy["legR"]),
        "armAsym": _r((energy["armL"] - energy["armR"]) / (arms + 1e-6), 3),   # +1 = left only
        "legAsym": _r((energy["legL"] - energy["legR"]) / (legs + 1e-6), 3),
        "upperRatio": _r((arms / 2 + energy["spine"]) / (arms / 2 + energy["spine"] + legs / 2 + 1e-6), 3),
        "total": _r(float(sp.mean())),
        "handPeak": _r(float(np.percentile(hand_sp, 98))),
        "footPeak": _r(float(np.percentile(foot_sp, 98))),
        "worldPeak": _r(float(np.percentile(world_sp.max(axis=1), 98))),
        "handMaxHeight": _r(float(hand_h.max() / h)),   # hands above hips, in hips-heights
        "handMinHeight": _r(float(np.minimum(B[:, JI["LeftHand"], 1], B[:, JI["RightHand"], 1]).min() / h)),
        "activeFrac": _r(float((sp.mean(axis=1) > 0.15 * s).mean()), 3),
    }
    # temporal variation of activity (bursty = combat/reactions, steady = loops/dance)
    act = sp.mean(axis=1)
    feats["energy"]["burstiness"] = _r(float(act.std() / (act.mean() + 1e-6)), 3)

    # ---- loopability (body-local pose incl. hips height; root translation/yaw excluded) ---
    Bh = B.copy()
    Bh[:, :, 1] += hips[:, None, 1]
    loop_pose = float(np.sqrt(((Bh[0] - Bh[-1]) ** 2).sum(axis=1).mean()))
    dup = loop_pose < 0.01 * s
    if N >= 4:
        v0 = (Bh[1] - Bh[0]) / dt; v1 = (Bh[-1] - Bh[-2]) / dt
        loop_vel = float(np.sqrt(((v0 - v1) ** 2).sum(axis=1).mean()))
        acc = np.linalg.norm(Bh[2:] - 2 * Bh[1:-1] + Bh[:-2], axis=2).mean(axis=1) / dt ** 2
        if dup:   # last frame repeats the first: ... N-2, [N-1 == 0], 1 ...
            seam = np.linalg.norm(Bh[1] - 2 * Bh[0] + Bh[-2], axis=1).mean() / dt ** 2
        else:     # frame 0 would follow frame N-1
            seam = np.linalg.norm(Bh[0] - 2 * Bh[-1] + Bh[-2], axis=1).mean() / dt ** 2
        typ = float(np.percentile(acc, 95))
        seam_ok = seam <= max(1.5 * typ, 1.0 * s)
    else:
        loop_vel, seam, typ, seam_ok = 0.0, 0.0, 0.0, True
    loopable = bool(loop_pose < 0.05 * s and seam_ok)
    feats["loop"] = {"poseDist": _r(loop_pose), "velDist": _r(loop_vel), "seamAccel": _r(seam, 3),
                     "typAccel": _r(typ, 3), "lastFrameRepeatsFirst": bool(dup), "loopable": loopable}

    # ---- gait (alternating feet) --------------------------------------
    hd = feet["Left"] - feet["Right"]
    zd = B[:, JI["LeftFoot"], 2] - B[:, JI["RightFoot"], 2]
    xd = B[:, JI["LeftFoot"], 0] - B[:, JI["RightFoot"], 0]
    reps = 3 if loopable and N > 3 else 1
    n_clip = (N - 1) if (loopable and dup) else N

    def tile(x):
        if reps == 1:
            return x
        body = x[:-1] if dup else x
        return np.concatenate([body] * reps)

    alt_h = alternations(tile(hd), 0.025 * s) / reps
    alt_z = alternations(tile(zd), 0.06 * s) / reps
    steps = max(alt_h, alt_z)
    sigsel = tile(hd) if alt_h >= alt_z else tile(zd)
    # regularity: left/right antisymmetry one step (= half a gait cycle) apart
    anti = 0.0
    if steps >= 1.5 and n_clip > 6:
        lag = int(round(n_clip / steps))
        if 2 <= lag < len(sigsel) - 3:
            a, b = sigsel[:-lag], sigsel[lag:]
            if a.std() > 1e-6 and b.std() > 1e-6:
                anti = float(-np.corrcoef(a, b)[0, 1])
    step_rate = steps / duration if duration > 0 else 0.0
    amp_h = float(np.percentile(hd, 95) - np.percentile(hd, 5)) / 2
    amp_z = float(np.percentile(zd, 95) - np.percentile(zd, 5)) / 2
    amp_ok = min(1.0, max(amp_h / (0.05 * s), amp_z / (0.15 * s)))
    rate_ok = 1.0 if 0.7 <= step_rate <= 5.0 else 0.3
    gait = min(1.0, steps / 2.0) * max(0.0, anti) * amp_ok * rate_ok
    feats["gait"] = {
        "steps": _r(steps, 2), "stepRate": _r(step_rate, 3),
        "altHeight": _r(alt_h, 2), "altStride": _r(alt_z, 2), "antisymmetry": _r(anti, 3),
        "ampHeight": _r(amp_h), "ampStride": _r(amp_z),
        "lateralAmp": _r(float(np.percentile(xd, 95) - np.percentile(xd, 5)) / 2),
        "score": _r(gait, 3),
    }
    feats["inPlace"] = bool(max_disp < 0.25 * s and net < 0.15 * s)
    feats["startEndPoseDist"] = _r(loop_pose)

    # ---- posture descriptors (fractions of frames) -----------------------
    hl, hr = B[:, JI["LeftHand"]], B[:, JI["RightHand"]]
    upright = pitch < 45
    # fighting guard: both hands near chin/face height, in front of the body, elbows bent
    arm_len = {k: np.linalg.norm(rest[JI[k + "ForeArm"]] - rest[JI[k + "Arm"]]) +
               np.linalg.norm(rest[JI[k + "Hand"]] - rest[JI[k + "ForeArm"]]) for k in ("Left", "Right")}
    reach = sum(np.linalg.norm(P[:, JI[k + "Hand"]] - P[:, JI[k + "Arm"]], axis=1) / arm_len[k]
                for k in ("Left", "Right")) / 2
    guard = (np.minimum(hl[:, 1], hr[:, 1]) > 0.30 * s) & (np.maximum(hl[:, 1], hr[:, 1]) < 0.70 * s) & \
        (np.minimum(hl[:, 2], hr[:, 2]) > 0.0) & (np.maximum(hl[:, 2], hr[:, 2]) < 0.45 * s) & \
        (reach < 0.8) & upright
    head_y = B[:, JI["Head"], 1]
    feet_mid = 0.5 * (B[:, JI["LeftFoot"]] + B[:, JI["RightFoot"]])
    thigh = {k: P[:, JI[k + "Leg"]] - P[:, JI[k + "UpLeg"]] for k in ("Left", "Right")}
    thigh_ang = {k: np.degrees(np.arccos(np.clip(-v[:, 1] / np.maximum(np.linalg.norm(v, axis=1), 1e-9), -1, 1)))
                 for k, v in thigh.items()}
    thighs_flat = (thigh_ang["Left"] > 55) & (thigh_ang["Right"] > 55)
    feet_d = np.hypot(*(P[:, JI["LeftFoot"]] - P[:, JI["RightFoot"]])[:, [0, 2]].T)
    feats["posture"] = {
        "guardFrac": _r(float(guard.mean()), 3),
        "handsAboveHeadFrac": _r(float((np.maximum(hl[:, 1], hr[:, 1]) > head_y).mean()), 3),
        "stanceWidth": _r(float(feet_d.mean() / s), 3),
        "feetForward": _r(float(feet_mid[:, 2].mean() / s), 3),
        "thighsFlatFrac": _r(float(thighs_flat.mean()), 3),
        "lowFrac": _r(float((hy < 0.70).mean()), 3),
        "lyingFrac": _r(float(((pitch > 60) & (hy < 0.45)).mean()), 3),
        "elevatedHorizontalFrac": _r(float(((pitch > 60) & (hy > 0.75)).mean()), 3),
        "airborneFrac": _r(float(airborne.mean()), 3),
        "bentFrac": _r(float(((pitch > 30) & (pitch < 100)).mean()), 3),
    }
    return feats


def signature(P, fps, rest):
    """Compact matching signature: unit directions of SIG_SEGMENTS (in the
    initial-facing frame) at SIG_SAMPLES normalized times, plus the hips
    trajectory scaled by rest hips height. Returns dict of lists."""
    P = np.asarray(P, dtype=np.float64)
    N = P.shape[0]
    h = float(np.asarray(rest)[JI["Hips"], 1])
    yaw, _ = facing_yaw(P)
    Q = rot_y(P - P[0, JI["Hips"]] * np.array([1, 0, 1]), -yaw[0])
    u = np.linspace(0, N - 1, SIG_SAMPLES)
    i0 = np.floor(u).astype(int); i1 = np.minimum(i0 + 1, N - 1); w = (u - i0)[:, None, None]
    S = Q[i0] * (1 - w) + Q[i1] * w
    a = np.array([JI[x] for x, _ in SIG_SEGMENTS]); b = np.array([JI[y] for _, y in SIG_SEGMENTS])
    dirs = S[:, b] - S[:, a]
    dirs /= np.maximum(np.linalg.norm(dirs, axis=2, keepdims=True), 1e-9)
    traj = S[:, JI["Hips"]] / h
    return {"dirs": np.round(dirs, 4).tolist(), "traj": np.round(traj, 4).tolist()}
