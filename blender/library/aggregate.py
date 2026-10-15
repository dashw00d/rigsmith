"""Aggregate step (system python3 + numpy): features -> categories/tags, duplicate detection,
name recovery, provisional names, rest-skeleton groups, GLB name patching, manifest + README.

Called by `build.py aggregate` (or `build.py all`).
"""
import json
import math
import os
import re
import struct
import time
from collections import Counter, defaultdict
from multiprocessing import Pool

import numpy as np

import features as F

CATEGORIES = [
    ("locomotion", "Locomotion"), ("idle", "Idle"), ("combat", "Combat"), ("reactions", "Reactions"),
    ("jump", "Jump & Acrobatics"), ("crouch-prone", "Crouch & Prone"), ("sit-lie", "Sit & Lie"),
    ("dance", "Dance"), ("gesture", "Gesture"), ("work", "Work"), ("transition", "Transition"), ("pose", "Pose"),
]
CAT_LABEL = dict(CATEGORIES)
CAT_ORDER = {c: i for i, (c, _) in enumerate(CATEGORIES)}

# Name keywords, checked in order (first hit wins), used for named / recovered names.
KEYWORDS = [
    ("pose", [r"\bpose\b"]),
    ("transition", [r"\bto (stand|sit|crouch|idle|prone|lie)", r"stand(ing)? up", r"get(ting)? up", r"sit(ting)? down",
                    r"lie down"]),
    ("work", [r"\bdig", r"fish", r"pick(ing)? up", r"\bcarr(y|ying)", r"\bpull", r"\brope", r"working", r"device",
              r"hammer", r"\bchop", r"\bmin(e|ing)\b", r"\bpush", r"\blift", r"repair", r"\bplant", r"typing",
              r"harvest", r"\bbuild"]),
    ("reactions", [r"\bdie\b", r"dying", r"death", r"\bhit\b", r"reaction", r"knock", r"\bfall", r"stumbl",
                   r"electrocut", r"stagger"]),
    ("combat", [r"attack", r"slash", r"punch", r"kick", r"sword", r"draw arrow", r"\barrow", r"shoot", r"\bblock",
                r"fight", r"boxing", r"\bstab", r"strike", r"combo", r"spell", r"\bcast", r"rifle", r"pistol",
                r"parry", r"dodge"]),
    ("jump", [r"jump", r"flip", r"somersault", r"vault", r"leap", r"cartwheel"]),
    ("crouch-prone", [r"crouch", r"crawl", r"prone", r"sneak"]),
    ("sit-lie", [r"\bsit", r"\blying\b", r"\blie\b", r"laying", r"sleep"]),
    ("dance", [r"danc", r"samba", r"hip hop", r"salsa", r"twerk"]),
    ("gesture", [r"talk", r"\bwav(e|ing)", r"\bpoint", r"\bclap", r"cheer", r"\bnod", r"shrug", r"gesture",
                 r"salut", r"\bbow(ing)?\b", r"agree", r"argu", r"\byell", r"laugh"]),
    ("idle", [r"idle", r"breathing"]),
    ("locomotion", [r"walk", r"\brun", r"\bjog", r"sprint", r"strafe", r"\bturn"]),
]


def keyword_category(name):
    n = (name or "").lower()
    for cat, pats in KEYWORDS:
        if any(re.search(p, n) for p in pats):
            return cat
    return None


def ramp(x, lo, hi):
    if hi == lo:
        return float(x >= hi)
    return float(min(1.0, max(0.0, (x - lo) / (hi - lo))))


# --------------------------------------------------------------------------- features -> category

def feature_scores(f):
    """Soft heuristic scores in [0,1] per category from motion features (all lengths are
    relative to a 1 m hips height; features are already normalised where it matters)."""
    s = f["restHipsHeight"]
    e, g, p, hh, tp = f["energy"], f["gait"], f["posture"], f["hipsHeight"], f["torsoPitch"]
    dur = f["duration"]
    speed = max(f["speed"], f["moveSpeed"]) / s
    lying = p["lyingFrac"]
    elevated = p["elevatedHorizontalFrac"]
    upright = 1 - ramp(tp["mean"], 35, 55)
    standing = ramp(hh["mean"], 0.76, 0.84)
    inverted = ramp(f["invertedFrames"] / f["fps"], 0.05, 0.3)
    ends_lying = float(posture_state(f, "end") == "lying" and posture_state(f, "start") == "standing")
    legs, arms, spine, total = e["legs"] / s, e["arms"] / s, e["spine"] / s, e["total"] / s
    gait = g["score"]
    dh = hh["end"] - hh["start"]
    fast_drop = ramp(f["hipsDropSpeed"] / s, 0.9, 1.6)
    sc = {}
    # locomotion: travelling with alternating feet, or stepping/turning in place
    travel_gait = ramp(speed, 0.25, 0.6) * max(ramp(gait, 0.1, 0.35), ramp(g["steps"], 0.5, 2) * 0.7,
                                               0.6 * ramp(legs - arms, 0.0, 0.3)) * standing
    turn_in_place = ramp(abs(f["netYawDeg"]), 35, 80) * float(f["inPlace"]) * ramp(legs, 0.08, 0.2) * \
        ramp(legs - 0.5 * arms, 0.0, 0.1) * (1 - ramp(dur, 3.5, 6)) * standing
    in_place_gait = ramp(gait, 0.3, 0.5) * ramp(legs - arms, 0.0, 0.4) * float(f["loop"]["loopable"]) * standing * \
        (1 - ramp(dur, 4, 8))
    swim = ramp(elevated, 0.5, 0.8) * ramp(p["airborneFrac"], 0.5, 0.8)
    sc["locomotion"] = max(travel_gait, turn_in_place * 0.85, in_place_gait * 0.8, swim * ramp(speed, 0.2, 0.5) * 0.6) * \
        (1 - 0.6 * ramp(p["guardFrac"], 0.4, 0.8)) * (1 - ramp(f["airborneMaxRun"], 0.3, 0.6))
    # idle: in place, standing, low energy, not too short
    sc["idle"] = float(f["inPlace"]) * standing * upright * (1 - ramp(total, 0.12, 0.3)) * ramp(dur, 0.6, 1.5) * \
        (1 - 0.6 * ramp(arms, 0.12, 0.25)) * \
        (1 - ramp(abs(f["netYawDeg"]), 30, 60)) * (1 - 0.5 * ramp(p["guardFrac"], 0.5, 0.9))
    sc["idle"] = max(sc["idle"], swim * (1 - ramp(speed, 0.2, 0.5)) * 0.5)
    # combat: fast strikes / kicks, guard stance, wide bent-knee stance
    strike = max(ramp(e["handPeak"] / s, 3.0, 6.0), ramp(e["footPeak"] / s, 4.0, 8.0))
    stance = ramp(p["stanceWidth"], 0.45, 0.6) * ramp(0.95 - hh["mean"], 0.0, 0.08)
    guard = ramp(p["guardFrac"], 0.3, 0.7)
    sc["combat"] = max(strike * (0.55 + 0.45 * max(guard, stance)),
                       guard * (0.35 + 0.45 * stance),
                       0.6 * ramp(p["stanceWidth"], 0.7, 0.9) * ramp(hh["mean"], 0.6, 0.7) * ramp(arms, 0.2, 0.4)) * \
        (1 - lying) * (1 - ramp(dur, 8, 14) * 0.5) * \
        (1 - ramp(speed, 1.0, 2.0) * 0.5) * (1 - 0.5 * inverted)
    # reactions: falls / deaths (fast drop and end low), knock-backs
    ends_low_from_high = float(f["endsLow"] and not f["startsLow"])
    sc["reactions"] = max(ends_low_from_high * max(fast_drop, 0.5 * ramp(-dh, 0.4, 0.7)), 0.7 * ends_lying + 0.3 * fast_drop * ends_lying,
                          0.45 * ramp(e["burstiness"], 0.8, 1.4) * ramp(spine / max(arms, 1e-3), 0.6, 1.0) *
                          (1 - ramp(dur, 3.5, 6)))
    # jump / acrobatics: sustained flight, inverted body
    sc["jump"] = max(ramp(f["airborneMaxRun"], 0.2, 0.45), inverted) * \
        (1 - ramp(elevated, 0.4, 0.7)) * (1 - ramp(lying, 0.4, 0.7))
    # transition: big, controlled change of posture between start and end
    sc["transition"] = max(ramp(abs(dh), 0.18, 0.32), ramp(abs(tp["end"] - tp["start"]), 40, 70) * 0.8) * \
        (1 - fast_drop * ends_low_from_high) * (1 - 0.7 * ends_lying) * (1 - ramp(dur, 8, 15) * 0.5)
    # sit / lie: low hips (or lying) with little leg motion
    sitting = ramp(p["thighsFlatFrac"], 0.5, 0.8) * ramp(p["feetForward"], 0.15, 0.3) * ramp(0.75 - hh["mean"], 0.0, 0.1)
    still_legs = 1 - ramp(legs, 0.15, 0.4)
    sc["sit-lie"] = max(sitting, ramp(lying, 0.6, 0.9)) * still_legs * (1 - ramp(abs(dh), 0.25, 0.4))
    # crouch / prone: low hips with leg activity or travel (crouch walk, crawl), or kneeling/squatting
    low = ramp(p["lowFrac"], 0.5, 0.8) if hh["mean"] > 0.3 else 0.0
    crouch_walk = ramp(0.84 - hh["mean"], 0.0, 0.06) * ramp(hh["mean"], 0.45, 0.55) * ramp(speed, 0.25, 0.6) * \
        max(ramp(gait, 0.1, 0.35), ramp(g["steps"], 1, 3) * 0.7)
    sc["crouch-prone"] = max(low * (1 - sitting) * 0.7 + low * ramp(legs + speed, 0.2, 0.6) * 0.3,
                             ramp(lying, 0.5, 0.8) * ramp(legs + speed, 0.25, 0.6), crouch_walk) * \
        (1 - ramp(abs(dh), 0.25, 0.4)) * (1 - 0.6 * ramp(total, 1.2, 2.0)) * (1 - 0.5 * ramp(abs(f["totalYawDeg"]), 270, 540))
    # dance: sustained whole-body energy, long, steady
    whole = min(ramp(legs, 0.25, 0.6), ramp(arms, 0.25, 0.6))
    sc["dance"] = whole * ramp(dur, 3.0, 7.0) * (1 - ramp(e["burstiness"], 0.7, 1.1)) * \
        (1 - 0.6 * ramp(p["guardFrac"], 0.3, 0.7)) * max(ramp(hh["mean"], 0.55, 0.75), 0.8 * ramp(total, 1.2, 1.8)) * \
        max(0.6, ramp(abs(f["totalYawDeg"]), 90, 360))
    # gesture: standing, upper body only, moderate speed
    sc["gesture"] = standing * (1 - ramp(tp["mean"], 18, 32)) * (1 - ramp(p["bentFrac"], 0.2, 0.5)) * \
        float(f["inPlace"]) * ramp(e["upperRatio"], 0.62, 0.78) * \
        (1 - ramp(legs, 0.15, 0.35)) * ramp(arms, 0.08, 0.2) * (1 - ramp(e["handPeak"] / s, 3.5, 5.5)) * \
        (1 - 0.6 * ramp(p["guardFrac"], 0.3, 0.7))
    # work: bending with arm activity, hands low, in place, not strike-fast
    sc["work"] = float(f["inPlace"]) * ramp(p["bentFrac"], 0.3, 0.6) * ramp(arms, 0.1, 0.25) * \
        (1 - ramp(e["handPeak"] / s, 4, 6)) * ramp(-e["handMinHeight"], 0.2, 0.45) * (1 - lying) * \
        (1 - ramp(abs(dh), 0.25, 0.4))
    return sc


def classify(f, frames):
    if frames <= 10:
        return "pose", 0.95, {"pose": 1.0}
    sc = feature_scores(f)
    ranked = sorted(sc.items(), key=lambda kv: -kv[1])
    (c1, s1), (_, s2) = ranked[0], ranked[1]
    if s1 < 0.12:
        # nothing fits well: fall back on broad posture / activity
        if f["energy"]["upperRatio"] > 0.65 and f["hipsHeight"]["mean"] > 0.8:
            return "gesture", 0.15, sc
        return ("idle" if f["energy"]["total"] < 0.3 else "dance"), 0.12, sc
    raw = min(0.85, s1 * (0.55 + 0.45 * (1 - s2 / s1)))
    # remap fitted on 93 hand-labelled random clips (accuracy ~0.93 at raw >= 0.8, ~0.45 below 0.6)
    conf = float(np.interp(raw, [0.0, 0.3, 0.6, 0.8, 0.85], [0.0, 0.25, 0.45, 0.75, 0.85]))
    return c1, round(conf, 2), sc


# --------------------------------------------------------------------------- tags / labels

def posture_state(f, which):
    hh = f["hipsHeight"][which]
    tp = f["torsoPitch"][which]
    if tp > 60 and hh < 0.45:
        return "lying"
    if hh < 0.45:
        return "low"
    if hh < 0.72:
        return "sitting/crouched"
    return "standing"


def direction_tag(f):
    if f["travel"] < 0.3 * f["restHipsHeight"]:
        return None
    d = f["moveDirDeg"]
    if abs(d) <= 45:
        return "forward"
    if abs(d) >= 135:
        return "backward"
    return "strafe-left" if d > 0 else "strafe-right"


def tags_for(f, cat):
    t = []
    if cat != "pose":
        t.append("loop" if f["loop"]["loopable"] else "one-shot")
    t.append("in-place" if f["inPlace"] else "root-motion")
    e = f["energy"]
    s = f["restHipsHeight"]
    if cat not in ("pose", "sit-lie") and e["legs"] / s < 0.12 and f["inPlace"] and e["arms"] / s > 0.08 and \
            f["hipsHeight"]["mean"] > 0.75:
        t.append("upper-body")
    if cat == "locomotion":
        sp = max(f["speed"], f["moveSpeed"]) / s
        if sp > 2.2:
            t.append("fast")
        elif 0 < sp < 0.9 and not f["inPlace"]:
            t.append("slow")
    elif cat != "pose":
        if e["total"] / s > 0.9 or e["handPeak"] / s > 7:
            t.append("fast")
        elif e["total"] / s < 0.08:
            t.append("slow")
    if f["netYawDeg"] > 45:
        t.append("turn-left")
    elif f["netYawDeg"] < -45:
        t.append("turn-right")
    d = direction_tag(f)
    if d:
        t.append(d)
    if f["posture"]["elevatedHorizontalFrac"] > 0.5 and f["posture"]["airborneFrac"] > 0.5:
        t.append("swim-like")
    return t


def limb_label(f):
    e = f["energy"]
    if e["footPeak"] > 1.3 * e["handPeak"] and e["legs"] > 0.6 * e["arms"]:
        return "kicks" if e["footPeak"] > 4 else "legs"
    a = e["armAsym"]
    if a > 0.25:
        return "left arm"
    if a < -0.25:
        return "right arm"
    return "both arms"


def provisional_name(f, cat, frames):
    dur = f"{f['duration']:.1f}s"
    L = CAT_LABEL[cat].split(" & ")[0] if cat not in ("sit-lie", "crouch-prone") else CAT_LABEL[cat].replace(" & ", "/")
    s = f["restHipsHeight"]
    if cat == "pose":
        return f"Pose · {posture_state(f, 'start')}"
    if cat == "locomotion":
        yaw = f["netYawDeg"]
        d = direction_tag(f)
        sp = max(f["speed"], f["moveSpeed"]) / s
        if f["inPlace"] and abs(yaw) > 35:
            parts = [f"turn {'left' if yaw > 0 else 'right'} {abs(round(yaw / 15) * 15):.0f}°"]
        else:
            parts = [d or ("in place" if f["inPlace"] else "moving")]
            if sp > 0.2:
                parts.append(f"{sp:.1f} m/s")
            if abs(yaw) > 35:
                parts.append(f"turn {'left' if yaw > 0 else 'right'}")
        if f["posture"]["elevatedHorizontalFrac"] > 0.5:
            parts.insert(0, "swim-like")
        return f"{L} · {' · '.join(parts)} · {dur}"
    if cat == "combat":
        extra = []
        if f["posture"]["guardFrac"] > 0.5:
            extra.append("guard")
        if not f["inPlace"]:
            extra.append(direction_tag(f) or "moving")
        return f"{L} · {limb_label(f)}{' · ' + ' · '.join(extra) if extra else ''} · {dur}"
    if cat == "reactions":
        if f["endsLow"] and not f["startsLow"]:
            what = "falls, ends lying" if posture_state(f, "end") == "lying" else "falls, ends low"
        else:
            what = "knock-back" if not f["inPlace"] else "flinch"
        return f"{L} · {what} · {dur}"
    if cat == "jump":
        if f["invertedFrames"] > 0.05 * f["fps"]:
            what = "flip/inverted"
        else:
            what = f"airborne {f['airborneMaxRun']:.1f}s"
        d = direction_tag(f)
        return f"{L} · {what}{' · ' + d if d else ''} · {dur}"
    if cat == "transition":
        a, b = posture_state(f, "start"), posture_state(f, "end")
        if a == b:
            a, b = f"{f['hipsHeight']['start']:.1f}h", f"{f['hipsHeight']['end']:.1f}h"
        return f"{L} · {a} → {b} · {dur}"
    if cat == "sit-lie":
        st = "lying" if f["posture"]["lyingFrac"] > 0.5 else "sitting"
        return f"{L} · {st}{' · ' + limb_label(f) if f['energy']['arms'] / s > 0.15 else ''} · {dur}"
    if cat == "crouch-prone":
        st = "prone/lying" if f["posture"]["lyingFrac"] > 0.5 else "crouched"
        mv = direction_tag(f) or ("in place" if f["inPlace"] else "moving")
        return f"{L} · {st} · {mv} · {dur}"
    if cat == "dance":
        spin = abs(f["totalYawDeg"])
        return f"{L}{' · spins' if spin > 300 else ''}{' · travelling' if not f['inPlace'] else ''} · {dur}"
    if cat == "gesture":
        return f"{L} · {limb_label(f)} · {dur}"
    if cat == "work":
        return f"{L} · bending · {limb_label(f)} · {dur}"
    if cat == "idle":
        st = posture_state(f, "start")
        return f"{L} · {st}{' · ' + limb_label(f) if f['energy']['arms'] / s > 0.12 else ''} · {dur}"
    return f"{L} · {dur}"


# --------------------------------------------------------------------------- refeature

def _refeature(args):
    out, mpath = args
    m = json.load(open(mpath))
    z = np.load(os.path.join(out, "cache", m["id"] + ".npz"))
    P, rest, fps = z["P"].astype(np.float64), z["rest"].astype(np.float64), float(z["fps"])
    m["features"] = F.compute(P, rest, fps)
    m["signature"] = F.signature(P, fps, rest)
    m["featuresVersion"] = F.FEATURES_VERSION
    tmp = mpath + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(m, fh, separators=(",", ":"))
    os.replace(tmp, mpath)
    return m["id"]


# --------------------------------------------------------------------------- matching

def sig_dist(a, b):
    """Mean chord distance (deg-equivalent) between segment directions; robust to rounding."""
    return np.degrees(np.linalg.norm(a - b, axis=-1).mean(axis=(-1, -2)))


def find_duplicates(out, pack):
    """Pack-internal duplicates: same frame count, signature within 0.5 deg and all cached
    joint positions within 2 mm. Returns {id: canonical_id} for non-canonical members."""
    parent = {}

    def find(x):
        while parent.get(x, x) != x:
            x = parent[x]
        return x
    by = defaultdict(list)
    for m in pack:
        by[m["frames"]].append(m)
    checked = 0
    for g in by.values():
        if len(g) < 2:
            continue
        D = np.array([m["signature"]["dirs"] for m in g])
        T = np.array([m["signature"]["traj"] for m in g])
        for i in range(len(g)):
            d = sig_dist(D[i + 1:], D[i])
            t = np.abs(T[i + 1:] - T[i]).max(axis=(1, 2))
            for j in np.where((d < 0.5) & (t < 0.01))[0]:
                a, b = g[i], g[i + 1 + j]
                Pa = np.load(os.path.join(out, "cache", a["id"] + ".npz"))["P"]
                Pb = np.load(os.path.join(out, "cache", b["id"] + ".npz"))["P"]
                checked += 1
                if np.linalg.norm(Pa - Pb, axis=2).max() < 0.002:
                    ra, rb = find(a["id"]), find(b["id"])
                    if ra != rb:
                        parent[max(ra, rb)] = min(ra, rb)
    dup = {}
    for x in list(parent):
        r = find(x)
        if r != x:
            dup[x] = r
    return dup, checked


def match_named(named, pack_canon):
    """Named clip -> pack clip with the same motion (different rest skeleton, fps may differ)."""
    D = np.array([m["signature"]["dirs"] for m in pack_canon])
    T = np.array([m["signature"]["traj"] for m in pack_canon])
    dur = np.array([m["features"]["duration"] for m in pack_canon])
    res = {}
    for n in named:
        d = sig_dist(D, np.array(n["signature"]["dirs"]))
        tol = max(2.5 / 30, 0.03 * n["features"]["duration"])
        d = np.where(np.abs(dur - n["features"]["duration"]) <= tol, d, np.inf)
        o = np.argsort(d)
        best, second = d[o[0]], d[o[1]] if len(o) > 1 else np.inf
        info = {"best": pack_canon[o[0]]["id"], "dist": round(float(best), 2),
                "second": round(float(second), 2) if np.isfinite(second) else None}
        if best < 9.0 and second - best > 3.0:
            tr = float(np.abs(T[o[0]] - np.array(n["signature"]["traj"])).mean())
            info.update({"matched": True, "trajDiff": round(tr, 3)})
        else:
            info["matched"] = False
        res[n["id"]] = info
    return res


# --------------------------------------------------------------------------- rest skeletons

def rest_arrays(rest):
    t = np.array([b["translation"] for b in rest])
    q = np.array([b["rotation"] for b in rest])
    return t, q


def rest_diff(ra, rb):
    ta, qa = rest_arrays(ra)
    tb, qb = rest_arrays(rb)
    dt = np.linalg.norm(ta - tb, axis=1)
    dq = np.degrees(2 * np.arccos(np.clip(np.abs((qa * qb).sum(1)), 0, 1)))
    la, lb = np.linalg.norm(ta[1:], axis=1), np.linalg.norm(tb[1:], axis=1)
    rel = np.where(lb > 0.01, np.abs(la - lb) / np.maximum(lb, 1e-9), 0)
    names = [b["name"] for b in ra]
    k = int(np.argmax(rel)); kr = int(np.argmax(dq))
    return {"maxOffsetDiffMM": round(float(dt.max() * 1000), 3), "maxRotDiffDeg": round(float(dq.max()), 3),
            "worstRotBone": names[kr], "maxBoneLengthRelDiff": round(float(rel.max()), 4),
            "worstLengthBone": names[k + 1], "meanBoneLengthRatio": round(float((la / np.maximum(lb, 1e-9))[lb > 0.01].mean()), 4),
            "hipsHeight": [round(float(ta[0, 1]), 4), round(float(tb[0, 1]), 4)]}


def same_rest(ra, rb):
    d = rest_diff(ra, rb)
    return d["maxOffsetDiffMM"] < 0.5 and d["maxRotDiffDeg"] < 0.1


# --------------------------------------------------------------------------- GLB patch

def patch_glb_name(path, name, extras):
    b = open(path, "rb").read()
    jl = struct.unpack("<I", b[12:16])[0]
    doc = json.loads(b[20:20 + jl])
    anim = doc["animations"][0]
    new_extras = dict(anim.get("extras", {}))
    new_extras.update(extras)
    if anim.get("name") == name and doc["scenes"][0].get("name") == name and anim.get("extras") == new_extras:
        return len(b)
    anim["name"] = name
    anim["extras"] = new_extras
    doc["scenes"][0]["name"] = name
    js = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    js += b" " * ((4 - len(js) % 4) % 4)
    rest = b[20 + jl:]  # BIN chunk header + data
    total = 12 + 8 + len(js) + len(rest)
    tmp = path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, total))
        fh.write(struct.pack("<II", len(js), 0x4E4F534A))
        fh.write(js)
        fh.write(rest)
    os.replace(tmp, path)
    return total


# --------------------------------------------------------------------------- manifest

MANIFEST_FEATURES = [
    "duration", "frames", "fps", "hipsStart", "hipsEnd", "travel", "travelPath", "headingDeg", "moveDirDeg",
    "speed", "netYawDeg", "hipsHeight", "endsLow", "airborneFrames", "airborneMaxRun", "torsoPitch", "energy",
    "gait", "loop", "inPlace", "posture",
]


def run(out):
    t0 = time.time()
    meta_dir = os.path.join(out, "meta")
    paths = sorted(os.path.join(meta_dir, f) for f in os.listdir(meta_dir) if f.endswith(".json"))
    metas = [json.load(open(p)) for p in paths]
    stale = [(out, p) for p, m in zip(paths, metas) if m.get("kind") == "clip" and m.get("featuresVersion") != F.FEATURES_VERSION]
    if stale:
        print(f"re-featuring {len(stale)} clips (features v{F.FEATURES_VERSION}) from cache", flush=True)
        with Pool(8) as pool:
            pool.map(_refeature, stale, chunksize=16)
        metas = [json.load(open(p)) for p in paths]
    mannequin = next((m for m in metas if m.get("kind") == "mannequin"), None)
    clips = [m for m in metas if m.get("kind") == "clip"]
    sources = json.load(open(os.path.join(out, "work", "sources.json"))) if os.path.exists(
        os.path.join(out, "work", "sources.json")) else []
    live = {s["id"] for s in sources}
    if live:
        clips = [m for m in clips if m["id"] in live]

    pack = sorted([m for m in clips if m["source"] == "mixamo-pack"], key=lambda m: m["sourceName"])
    named = sorted([m for m in clips if m["source"] == "mixamo"], key=lambda m: m["name"])
    dup, checked = find_duplicates(out, pack)
    canon = [m for m in pack if m["id"] not in dup]
    matches = match_named(named, canon)
    by_id = {m["id"]: m for m in clips}

    # names / categories
    entries = {}
    recovered = {}
    for n in named:
        mt = matches[n["id"]]
        if mt["matched"]:
            recovered[mt["best"]] = n
    for m in clips:
        f = m["features"]
        e = {"id": m["id"], "sourceName": m["sourceName"], "source": m["source"], "sourcePath": m["sourcePath"],
             "file": m["file"], "fps": m["fps"], "frames": m["frames"], "duration": f["duration"],
             "duplicateOf": None}
        name_src = None
        if m.get("name"):
            e["name"], name_src = m["name"], "source"
        elif m["id"] in recovered:
            e["name"], name_src = recovered[m["id"]]["name"], "matched"
            e["matchedFrom"] = recovered[m["id"]]["id"]
        kc = keyword_category(e.get("name")) if name_src else None
        fc, fconf, scores = classify(f, m["frames"])
        if kc:
            e["category"], e["confidence"], e["categorySource"] = kc, (0.95 if name_src == "source" else 0.9), "name"
        else:
            e["category"], e["confidence"], e["categorySource"] = fc, fconf, "features"
        e["featureCategory"] = fc
        e["nameSource"] = name_src or "provisional"
        tags = tags_for(f, e["category"])
        tags += [t for t in m.get("tags", []) if t not in tags]
        if m["id"] in recovered:
            tags += [t for t in recovered[m["id"]].get("tags", []) if t not in tags]
        e["tags"] = tags
        e["loop"] = bool(f["loop"]["loopable"])
        e["inPlace"] = bool(f["inPlace"])
        top = sorted(scores.items(), key=lambda kv: -kv[1])[:3]
        e["features"] = {k: f[k] for k in MANIFEST_FEATURES if k in f}
        e["features"]["categoryScores"] = {k: round(v, 3) for k, v in top}
        entries[m["id"]] = e

    # duplicates: pack-internal (share canonical's name/category) and named -> pack match
    for d, c in dup.items():
        entries[d]["duplicateOf"] = c
    for n in named:
        mt = matches[n["id"]]
        if mt["matched"]:
            entries[n["id"]]["duplicateOf"] = mt["best"]
            entries[n["id"]]["matchDistanceDeg"] = mt["dist"]
            if mt.get("trajDiff", 0) > 0.05:
                entries[n["id"]]["duplicateNote"] = "same body motion; root motion differs (e.g. Mixamo 'In Place' option)"
    # provisional names for unnamed canonical clips, then copy to their duplicates
    for m in pack:
        e = entries[m["id"]]
        if e["nameSource"] == "provisional" and e["duplicateOf"] is None:
            e["name"] = provisional_name(m["features"], e["category"], m["frames"])
    for d, c in dup.items():
        src = entries[c]
        for k in ("name", "category", "confidence", "categorySource", "nameSource"):
            entries[d][k] = src[k]
        if src.get("matchedFrom"):
            entries[d]["matchedFrom"] = src["matchedFrom"]
            entries[d]["tags"] += [t for t in by_id[src["matchedFrom"]].get("tags", []) if t not in entries[d]["tags"]]
    # disambiguate identical provisional names (#2, #3 ... by source hash order)
    groups = defaultdict(list)
    for e in entries.values():
        if e["nameSource"] == "provisional" and e["duplicateOf"] is None:
            groups[e["name"]].append(e)
    for nm, es in groups.items():
        if len(es) > 1:
            for k, e in enumerate(sorted(es, key=lambda e: e["sourceName"]), start=1):
                e["name"] = f"{nm} #{k}"
    for d, c in dup.items():
        entries[d]["name"] = entries[c]["name"]

    # rest skeletons
    rest_groups = []
    ref = mannequin["rest"] if mannequin else None
    for m in sorted(clips, key=lambda m: (m["source"] != "mixamo", m["sourceName"])):
        for g in rest_groups:
            if same_rest(m["rest"], g["rest"]):
                g["ids"].append(m["id"]); entries[m["id"]]["rest"] = g["key"]
                break
        else:
            key = "ybot" if ref and same_rest(m["rest"], ref) else None
            if key is None:
                key = {"mixamo-pack": "pack", "mixamo-pack-extra": "pack-extra-" + m["sourceName"]}.get(m["source"], "rest-" + m["id"][:6])
            rest_groups.append({"key": key, "rest": m["rest"], "ids": [m["id"]], "source": m["source"]})
            entries[m["id"]]["rest"] = key
    rest_skeletons = {}
    for g in rest_groups:
        rest_skeletons[g["key"]] = {
            "clipCount": len(g["ids"]), "firstSource": g["source"],
            "hipsHeight": round(g["rest"][0]["translation"][1], 4),
            "vsMannequin": rest_diff(g["rest"], ref) if ref else None,
            "bones": [{k: b[k] for k in ("name", "parent", "translation", "rotation")} for b in g["rest"]],
        }

    # patch GLB animation names, sizes
    for e in entries.values():
        e["bytes"] = patch_glb_name(os.path.join(out, e["file"]), e["name"],
                                    {"name": e["name"], "category": e["category"]})

    order = ["id", "name", "sourceName", "source", "sourcePath", "file", "bytes", "fps", "frames", "duration",
             "category", "confidence", "tags", "loop", "inPlace", "rest", "duplicateOf", "nameSource",
             "categorySource", "featureCategory", "matchedFrom", "matchDistanceDeg", "duplicateNote", "features"]
    clip_list = sorted(entries.values(), key=lambda e: (CAT_ORDER[e["category"]], e["name"].lower(), e["id"]))
    clip_list = [{k: e[k] for k in order if k in e} for e in clip_list]
    cat_counts = Counter(e["category"] for e in clip_list)
    manifest = {
        "version": 1,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "skeleton": "mixamo",
        "space": "y-up-meters-+z-forward",
        "restSkeleton": {"source": "mannequin/ybot.glb",
                         "bones": [{k: b[k] for k in ("name", "parent", "translation", "rotation")} for b in ref]} if ref else None,
        "restSkeletons": rest_skeletons,
        "mannequin": {"file": mannequin["file"], "bytes": mannequin["bytes"], "sourcePath": mannequin["sourcePath"],
                      "meshes": mannequin["meshes"], "rest": "ybot"} if mannequin else None,
        "categories": [{"id": c, "label": l, "count": cat_counts.get(c, 0)} for c, l in CATEGORIES],
        "clips": clip_list,
    }
    with open(os.path.join(out, "manifest.json.tmp"), "w") as fh:
        json.dump(manifest, fh, separators=(",", ":"))
    os.replace(os.path.join(out, "manifest.json.tmp"), os.path.join(out, "manifest.json"))

    stats = {
        "clips": len(clip_list),
        "bySource": dict(Counter(e["source"] for e in clip_list)),
        "byCategory": {c: cat_counts.get(c, 0) for c, _ in CATEGORIES},
        "byCategoryUnique": dict(Counter(e["category"] for e in clip_list if not e["duplicateOf"])),
        "byTag": dict(Counter(t for e in clip_list for t in e["tags"]).most_common()),
        "categorySource": dict(Counter(e["categorySource"] for e in clip_list)),
        "nameSource": dict(Counter(e["nameSource"] for e in clip_list)),
        "packDuplicates": len(dup), "duplicatePairsChecked": checked,
        "namedMatches": {by_id[k]["name"]: v for k, v in matches.items()},
        "packNamedByMatch": sum(1 for e in clip_list if e["source"] == "mixamo-pack" and e["nameSource"] == "matched"),
        "restSkeletons": {k: {kk: vv for kk, vv in v.items() if kk != "bones"} for k, v in rest_skeletons.items()},
        "totalBytes": sum(e["bytes"] for e in clip_list) + (mannequin["bytes"] if mannequin else 0),
        "meanConfidenceFeatures": round(float(np.mean([e["confidence"] for e in clip_list if e["categorySource"] == "features"])), 3),
        "aggregateSeconds": round(time.time() - t0, 1),
    }
    json.dump(stats, open(os.path.join(out, "work", "stats.json"), "w"), indent=1)
    write_readme(out, stats, manifest)
    print(json.dumps({k: v for k, v in stats.items() if k not in ("namedMatches", "restSkeletons")}, indent=1))
    return stats


def write_readme(out, st, manifest):
    try:
        conv = json.load(open(os.path.join(out, "work", "last-convert.json")))
    except Exception:
        conv = {}
    cats = "\n".join(f"| {c['label']} (`{c['id']}`) | {c['count']} | {st['byCategoryUnique'].get(c['id'], 0)} |"
                     for c in manifest["categories"])
    rs = "\n".join(f"| `{k}` | {v['clipCount']} | {v['hipsHeight']} | "
                   f"{v['vsMannequin']['maxOffsetDiffMM'] if v['vsMannequin'] else '-'} mm | "
                   f"{v['vsMannequin']['maxRotDiffDeg'] if v['vsMannequin'] else '-'}° ({v['vsMannequin']['worstRotBone'] if v['vsMannequin'] else ''}) |"
                   for k, v in manifest["restSkeletons"].items())
    txt = f"""# Local animation library (generated)

Generated {manifest['generatedAt']} by `blender/library/build.py`. Do not edit by hand.

## Rebuild

```sh
python3 blender/library/build.py all                # convert (resumable, 8 Blender procs) + aggregate
python3 blender/library/build.py aggregate          # re-classify / re-name / manifest only (no Blender)
python3 blender/library/verify/run_verify.py --all-named --random 6   # fidelity check (Blender + three.js)
```

Conversion skips sources whose `meta/<id>.json` has the same source sha256 + converter version;
failures go to `failures.json` and do not stop the batch. Bump `CONVERTER_VERSION` in
`convert.py` to force a rebuild; bump `FEATURES_VERSION` in `features.py` to recompute features
from `cache/` without Blender.

## Contents

- `clips/<id>.glb` - {st['clips']} bones-only clips (`<id>` = first 12 hex of sha256 of the source FBX).
  glTF space (Y-up, meters, character faces +Z). Node 0 `Armature` (identity), nodes 1..65 the 65
  canonical Mixamo bones (bare names, fixed order) with the source's rest pose as node TRS, plus a
  mesh-less skin so three.js creates `Bone`s. One animation named after the clip; every source frame
  sampled (LINEAR); `Hips.translation` always present (root motion, meters). Rotation tracks that
  are constant become 2-key tracks; rest-equal tracks are only dropped for leaf bones and for
  non-root translations (so targets keep their own proportions).
- `mannequin/ybot.glb` - skinned Y Bot (2 meshes, 65-joint skin, no animation), same node layout.
- `manifest.json` - all clips sorted by category then name, with features, tags, confidence.
- `meta/<id>.json` - full per-clip record (rest skeleton, track stats, features, signature);
  `cache/<id>.npz` - world joint positions used for features; `verify/` - fidelity reports.

Sources: {json.dumps(st['bySource'])}. Total size {st['totalBytes'] / 1e6:.0f} MB.
Last conversion: {conv.get('converted', '?')} converted, {conv.get('failed', '?')} failed in {conv.get('seconds', '?')} s.

| Category | clips | excl. duplicates |
|---|---|---|
{cats}

## Decisions / caveats

- **Rest skeletons differ by source** (kept as the source's rest, per spec). Apply clips to another
  skeleton by retargeting rotations relative to rest, e.g. per bone
  `q_target = q_targetRest * inverse(q_srcRest) * q_src(t)` with `q_srcRest` = the clip's node rest
  rotation (or world-space delta retargeting), and scale `Hips` translation by the hips-height ratio.
  Directly copying local rotations from a `pack` clip onto Y Bot is wrong by up to the rest
  rotation difference listed below.

| rest key | clips | hips height (m) | max bone offset diff vs Y Bot | max rest rotation diff vs Y Bot |
|---|---|---|---|---|
{rs}

- The pack's skeleton has two extra non-Mixamo bones (`LeftEye`, `RightEye`, never animated); they are
  dropped so every clip has exactly the canonical 65 bones.
- `~/Downloads/mixamo/Y Bot.fbx` contains no mesh (it is a bone-only 264-frame clip, same length as
  Fishing Cast), so the mannequin is built from `~/Downloads/Mixamo/character/Y_Bot.fbx`
  (Linzhan/Mixamo-Animations-Characters, see `ybot-source.json`), whose skeleton matches the named clips.
- Pack clips are 60 fps (named clips 30 fps); `duration` = (frames-1)/fps = GLB clip length.
- **Categories for hashed clips are heuristic** (`categorySource: "features"`, confidence <= 0.85,
  mean {st['meanConfidenceFeatures']}); named or name-recovered clips use name keywords (0.9-0.95).
  `featureCategory` is always the feature-based guess; `features.categoryScores` shows the top scores.
  Spot-checked by eye (stick-figure contact sheets, `blender/library/verify/contact_sheet.py`) on 93
  random pack clips: ~93% agreement at confidence >= 0.75, ~45-60% below; about 1 in 5 random clips
  was ambiguous even visually. Two untouched hold-out samples gave 64% overall agreement.
- **Name recovery**: pack clips whose motion matches a named clip (segment-direction signature,
  same duration) take its name ({st['packNamedByMatch']} pack clips); the named entry gets
  `duplicateOf` = that pack clip. Exact duplicates inside the pack ({st['packDuplicates']} clips, all joints
  within 2 mm on every frame) get `duplicateOf` = the lowest-hash copy and share its name.
  Other pack clips get provisional names "Category · key features · duration" (`nameSource:
  "provisional"`, `sourceName` = original hash).
- `loop` means seamlessly loopable (start/end pose within 5 cm RMS and no acceleration spike at the
  seam, ignoring root translation/yaw); many attacks that return to their stance qualify.
"""
    open(os.path.join(out, "README.md"), "w").write(txt)
