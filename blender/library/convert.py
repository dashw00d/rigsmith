"""Blender-side converter: Mixamo FBX -> canonical bones-only clip GLB (+ meta).

Run (normally via build.py):
  blender -b --factory-startup --python convert.py -- --jobs JOBS.json --out OUTDIR --shard NAME

JOBS.json is a list of jobs:
  {"kind": "clip"|"mannequin", "id": "<sha256[:12]>", "sha256": "...", "path": "/abs/src.fbx",
   "source": "mixamo-pack", "name": "...", "tags": [...]}

Per job writes (atomically, meta last so meta existence == job complete):
  OUTDIR/clips/<id>.glb  (or OUTDIR/mannequin/ybot.glb for the mannequin)
  OUTDIR/cache/<id>.npz  joint positions (features.FEATURE_JOINTS) for re-featuring
  OUTDIR/meta/<id>.json  conversion record, rest skeleton, features, signature
Failures are appended to OUTDIR/failures/<shard>.jsonl and the batch continues.

Canonical output: glTF space (Y-up, meters, faces +Z), bare Mixamo bone names,
node 0 = "Armature" (identity transform), nodes 1..65 = the 65 canonical bones in
CANON order. Non-canonical bones (e.g. LeftEye/RightEye in the pack) are dropped.
"""
import json
import math
import os
import re
import struct
import sys
import time
import traceback

import bpy
import numpy as np

sys.dont_write_bytecode = True  # keep blender/library free of __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import features as F  # noqa: E402

CONVERTER_VERSION = 1

PREFIX_RE = re.compile(r"^mixamorig\d*[:_]")
FINGERS = ["Thumb", "Index", "Middle", "Ring", "Pinky"]


def _arm(s):
    out = [f"{s}Shoulder", f"{s}Arm", f"{s}ForeArm", f"{s}Hand"]
    for f in FINGERS:
        out += [f"{s}Hand{f}{i}" for i in range(1, 5)]
    return out


def _leg(s):
    return [f"{s}UpLeg", f"{s}Leg", f"{s}Foot", f"{s}ToeBase", f"{s}Toe_End"]


CANON = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "HeadTop_End"] + _arm("Left") + _arm("Right") + _leg("Left") + _leg("Right")
assert len(CANON) == 65
CANON_PARENT = {"Hips": None, "Spine": "Hips", "Spine1": "Spine", "Spine2": "Spine1", "Neck": "Spine2",
                "Head": "Neck", "HeadTop_End": "Head"}
for _s in ("Left", "Right"):
    CANON_PARENT.update({f"{_s}Shoulder": "Spine2", f"{_s}Arm": f"{_s}Shoulder", f"{_s}ForeArm": f"{_s}Arm",
                         f"{_s}Hand": f"{_s}ForeArm", f"{_s}UpLeg": "Hips", f"{_s}Leg": f"{_s}UpLeg",
                         f"{_s}Foot": f"{_s}Leg", f"{_s}ToeBase": f"{_s}Foot", f"{_s}Toe_End": f"{_s}ToeBase"})
    for _f in FINGERS:
        CANON_PARENT[f"{_s}Hand{_f}1"] = f"{_s}Hand"
        for _i in range(2, 5):
            CANON_PARENT[f"{_s}Hand{_f}{_i}"] = f"{_s}Hand{_f}{_i - 1}"
CI = {n: i for i, n in enumerate(CANON)}

# Blender world (Z-up, -Y forward) -> glTF (Y-up, +Z forward): (x, y, z) -> (x, z, -y)
C_BL2GL = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], dtype=np.float64)

ROT_EPS = 1e-5     # rad   - tolerance for "constant" / "equal to rest"
POS_EPS = 1e-5     # m
SCL_EPS = 1e-5


def canon_name(n):
    return PREFIX_RE.sub("", n)


# --------------------------------------------------------------------------- scene

def clear_scene():
    for coll in (bpy.data.objects, bpy.data.armatures, bpy.data.actions, bpy.data.meshes,
                 bpy.data.materials, bpy.data.images, bpy.data.textures, bpy.data.node_groups):
        if len(coll):
            bpy.data.batch_remove(list(coll))
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)
    bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)


def import_fbx(path):
    clear_scene()
    bpy.ops.import_scene.fbx(filepath=path, use_anim=True, use_image_search=False,
                             ignore_leaf_bones=False, automatic_bone_orientation=False)
    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    if len(arms) != 1:
        raise RuntimeError(f"expected 1 armature, found {len(arms)}")
    return arms[0]


# --------------------------------------------------------------------------- math

def canon_xform(arm):
    """Return (A3, At, RA): canonical = A3 @ p_armature + At; frames rotate by RA."""
    A = C_BL2GL @ np.array(arm.matrix_world, dtype=np.float64)
    A3 = A[:3, :3]
    s = np.cbrt(np.linalg.det(A3))
    u, _, vt = np.linalg.svd(A3 / s)
    RA = u @ vt
    if np.abs(RA - np.eye(3)).max() < 1e-6:
        RA = np.eye(3)
    if np.abs(A3 / s - RA).max() > 1e-5:
        raise RuntimeError("armature object has non-uniform scale/shear")
    return s * RA, A[:3, 3].copy(), RA


def to_canon(M, A3, At, RA):
    out = np.array(M, dtype=np.float64, copy=True)
    out[..., :3, :3] = RA @ out[..., :3, :3]
    out[..., :3, 3] = np.einsum("ij,...j->...i", A3, out[..., :3, 3]) + At
    return out


def mat_to_quat(R):
    """(...,3,3) rotation -> (...,4) quaternion xyzw (w >= 0 not enforced)."""
    m00, m01, m02 = R[..., 0, 0], R[..., 0, 1], R[..., 0, 2]
    m10, m11, m12 = R[..., 1, 0], R[..., 1, 1], R[..., 1, 2]
    m20, m21, m22 = R[..., 2, 0], R[..., 2, 1], R[..., 2, 2]
    cand = np.stack([1 + m00 + m11 + m22, 1 + m00 - m11 - m22, 1 - m00 + m11 - m22, 1 - m00 - m11 + m22], -1)
    k = np.argmax(cand, axis=-1)
    q = np.empty(R.shape[:-2] + (4,))
    with np.errstate(divide="ignore", invalid="ignore"):
        w = 0.5 * np.sqrt(np.maximum(cand[..., 0], 1e-300)); f = 0.25 / w
        qw = np.stack([(m21 - m12) * f, (m02 - m20) * f, (m10 - m01) * f, w], -1)
        x = 0.5 * np.sqrt(np.maximum(cand[..., 1], 1e-300)); f = 0.25 / x
        qx = np.stack([x, (m01 + m10) * f, (m02 + m20) * f, (m21 - m12) * f], -1)
        y = 0.5 * np.sqrt(np.maximum(cand[..., 2], 1e-300)); f = 0.25 / y
        qy = np.stack([(m01 + m10) * f, y, (m12 + m21) * f, (m02 - m20) * f], -1)
        z = 0.5 * np.sqrt(np.maximum(cand[..., 3], 1e-300)); f = 0.25 / z
        qz = np.stack([(m02 + m20) * f, (m12 + m21) * f, z, (m10 - m01) * f], -1)
    for i, cq in enumerate((qw, qx, qy, qz)):
        sel = k == i
        q[sel] = cq[sel]
    return q / np.linalg.norm(q, axis=-1, keepdims=True)


def decompose(L):
    t = L[..., :3, 3]
    M = L[..., :3, :3]
    s = np.linalg.norm(M, axis=-2)
    R = M / s[..., None, :]
    neg = np.linalg.det(R) < 0
    if neg.any():
        s[neg, 0] *= -1
        R[neg, :, 0] *= -1
    return t, mat_to_quat(R), s


def rigid_inv(M):
    return np.linalg.inv(M)


def local_from_world(W, parents):
    """W (..., B, 4, 4) canonical world matrices -> local matrices w.r.t. parent (identity root)."""
    L = np.empty_like(W)
    for b, p in enumerate(parents):
        L[..., b, :, :] = W[..., b, :, :] if p is None else rigid_inv(W[..., p, :, :]) @ W[..., b, :, :]
    return L


def quat_continuity(q, ref):
    """Make q (N,4) sign-continuous over time, first key on ref's hemisphere."""
    q = q.copy()
    if np.dot(q[0], ref) < 0:
        q[0] = -q[0]
    d = np.einsum("ij,ij->i", q[1:], q[:-1])
    flip = np.cumprod(np.where(d < 0, -1.0, 1.0))
    q[1:] *= flip[:, None]
    return q


def quat_angle(q, ref):
    d = np.clip(np.abs(q @ ref), 0.0, 1.0)
    return 2.0 * np.arccos(d)


# --------------------------------------------------------------------------- GLB

class GLB:
    def __init__(self):
        self.bin = bytearray()
        self.views, self.accessors = [], []

    def add(self, arr, gltf_type, comp=5126, minmax=False, target=None):
        arr = np.ascontiguousarray(arr)
        while len(self.bin) % 4:
            self.bin.append(0)
        off = len(self.bin)
        self.bin += arr.tobytes()
        view = {"buffer": 0, "byteOffset": off, "byteLength": arr.nbytes}
        if target:
            view["target"] = target
        self.views.append(view)
        ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[gltf_type]
        acc = {"bufferView": len(self.views) - 1, "componentType": comp,
               "count": int(arr.size // ncomp), "type": gltf_type}
        if minmax:
            a2 = arr.reshape(-1, ncomp)
            acc["min"] = [float(v) if comp == 5126 else int(v) for v in a2.min(axis=0)]
            acc["max"] = [float(v) if comp == 5126 else int(v) for v in a2.max(axis=0)]
        self.accessors.append(acc)
        return len(self.accessors) - 1

    def write(self, path, doc):
        doc["accessors"] = self.accessors
        doc["bufferViews"] = self.views
        while len(self.bin) % 4:
            self.bin.append(0)
        doc["buffers"] = [{"byteLength": len(self.bin)}]
        js = json.dumps(doc, separators=(",", ":")).encode("utf-8")
        js += b" " * ((4 - len(js) % 4) % 4)
        total = 12 + 8 + len(js) + 8 + len(self.bin)
        tmp = path + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(struct.pack("<III", 0x46546C67, 2, total))
            fh.write(struct.pack("<II", len(js), 0x4E4F534A)); fh.write(js)
            fh.write(struct.pack("<II", len(self.bin), 0x004E4942)); fh.write(self.bin)
        os.replace(tmp, path)
        return total


def r6(v):
    return [round(float(x), 7) for x in v]


def skeleton_nodes(rest_local, parents):
    """glTF nodes for Armature + bones; returns (nodes, rest list for meta)."""
    t, q, s = decompose(rest_local)
    q = np.where(q[:, 3:4] < 0, -q, q)
    nodes = [{"name": "Armature", "children": [1]}]
    rest = []
    for b, name in enumerate(CANON):
        nd = {"name": name, "translation": r6(t[b]), "rotation": r6(q[b])}
        if np.abs(s[b] - 1).max() > SCL_EPS:
            nd["scale"] = r6(s[b])
        kids = [c + 1 for c, p in enumerate(parents) if p == b]
        if kids:
            nd["children"] = kids
        nodes.append(nd)
        rest.append({"name": name, "parent": None if parents[b] is None else CANON[parents[b]],
                     "translation": r6(t[b]), "rotation": r6(q[b]), "scale": r6(s[b])})
    return nodes, rest, (t, q, s)


# --------------------------------------------------------------------------- bones

def canonical_bones(arm):
    bones = arm.data.bones
    by_canon = {}
    dropped = []
    for b in bones:
        cn = canon_name(b.name)
        if cn in CI:
            if cn in by_canon:
                raise RuntimeError(f"duplicate canonical bone {cn}")
            by_canon[cn] = b.name
        else:
            dropped.append(b.name)
    missing = [n for n in CANON if n not in by_canon]
    if missing:
        raise RuntimeError(f"missing canonical bones: {missing}")
    parents, mismatches = [], []
    for n in CANON:
        b = bones[by_canon[n]].parent
        while b is not None and canon_name(b.name) not in CI:
            b = b.parent
        p = None if b is None else canon_name(b.name)
        if p != CANON_PARENT[n]:
            mismatches.append(f"{n}: parent {p} (expected {CANON_PARENT[n]})")
        parents.append(None if p is None else CI[p])
    if parents[0] is not None:
        raise RuntimeError("Hips is not the root")
    src_names = [by_canon[n] for n in CANON]
    return src_names, parents, dropped, mismatches


def rest_world(arm, src_names, xf):
    M = np.array([np.array(arm.data.bones[n].matrix_local, dtype=np.float64) for n in src_names])
    return to_canon(M, *xf)


# --------------------------------------------------------------------------- clip

def convert_clip(job, out_dir):
    t0 = time.time()
    arm = import_fbx(job["sourcePath"])
    t_import = time.time() - t0
    scene = bpy.context.scene
    fps = scene.render.fps / scene.render.fps_base
    ad = arm.animation_data
    if not ad or not ad.action:
        raise RuntimeError("no action on armature")
    act = ad.action
    f0 = int(round(act.frame_range[0])); f1 = int(round(act.frame_range[1]))
    N = f1 - f0 + 1
    src_names, parents, dropped, mismatches = canonical_bones(arm)
    xf = canon_xform(arm)

    # rest
    Wr = rest_world(arm, src_names, xf)
    Lr = local_from_world(Wr, parents)
    nodes, rest_meta, (rt, rq, rs) = skeleton_nodes(Lr, parents)

    # sample every source frame
    pb = arm.pose.bones
    order = np.array([pb.find(n) for n in src_names])
    nb = len(pb)
    buf = np.empty(nb * 16, dtype=np.float32)
    Wp = np.empty((N, nb, 4, 4), dtype=np.float64)
    for i in range(N):
        scene.frame_set(f0 + i)
        pb.foreach_get("matrix", buf)
        Wp[i] = buf.reshape(nb, 4, 4).transpose(0, 2, 1)
    Wp = to_canon(Wp[:, order], *xf)
    Lp = local_from_world(Wp, parents)
    pt, pq, ps = decompose(Lp)

    # animation tracks
    g = GLB()
    times = (np.arange(N, dtype=np.float64) / fps).astype(np.float32)
    acc_t = g.add(times, "SCALAR", minmax=True)
    acc_t2 = None

    def const_input():
        nonlocal acc_t2
        if acc_t2 is None:
            tt = np.array([0.0, times[-1]] if N > 1 else [0.0], dtype=np.float32)
            acc_t2 = g.add(tt, "SCALAR", minmax=True)
        return acc_t2

    channels, samplers = [], []
    stats = {"rotation": [0, 0, 0], "translation": [0, 0, 0], "scale": [0, 0, 0]}  # full, const, dropped

    def emit(b, path, vals, kind):
        # "const" tracks (constant but != rest) get 2 keys [0, end] instead of N
        data = np.repeat(vals[:1], 2 if N > 1 else 1, axis=0) if kind == "const" else vals
        inp = const_input() if kind == "const" else acc_t
        acc = g.add(data.astype(np.float32), "VEC4" if path == "rotation" else "VEC3")
        samplers.append({"input": inp, "output": acc, "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers) - 1, "target": {"node": b + 1, "path": path}})

    max_scale_dev = float(np.abs(ps - 1).max())
    is_leaf = [all(p != b for p in parents) for b in range(len(CANON))]
    for b in range(len(CANON)):
        # rotation: rest-equal tracks are dropped only on leaf bones (end effectors can't move
        # any joint). Rest skeletons differ between sources, so articulated bones always carry
        # a track (constant ones as 2 keys) and the clip fully defines the pose on any target.
        q = quat_continuity(pq[:, b], rq[b])
        if is_leaf[b] and quat_angle(q, rq[b]).max() < ROT_EPS:
            stats["rotation"][2] += 1
        elif quat_angle(q, q[0]).max() < ROT_EPS:
            emit(b, "rotation", q, "const"); stats["rotation"][1] += 1
        else:
            emit(b, "rotation", q, "full"); stats["rotation"][0] += 1
        # translation (Hips always full: root motion)
        tr = pt[:, b]
        if b == 0:
            emit(b, "translation", tr, "full"); stats["translation"][0] += 1
        elif np.abs(tr - rt[b]).max() < POS_EPS:
            stats["translation"][2] += 1
        elif np.abs(tr - tr[0]).max() < POS_EPS:
            emit(b, "translation", tr, "const"); stats["translation"][1] += 1
        else:
            emit(b, "translation", tr, "full"); stats["translation"][0] += 1
        # scale
        sc = ps[:, b]
        if np.abs(sc - rs[b]).max() < SCL_EPS:
            stats["scale"][2] += 1
        elif np.abs(sc - sc[0]).max() < SCL_EPS:
            emit(b, "scale", sc, "const"); stats["scale"][1] += 1
        else:
            emit(b, "scale", sc, "full"); stats["scale"][0] += 1

    ibm = np.linalg.inv(Wr).transpose(0, 2, 1).astype(np.float32)  # column-major
    acc_ibm = g.add(ibm, "MAT4")
    anim_name = job.get("name") or job["sourceName"]
    doc = {
        "asset": {"version": "2.0", "generator": f"mesh2motion library convert.py v{CONVERTER_VERSION}"},
        "scene": 0,
        "scenes": [{"name": anim_name, "nodes": [0]}],
        "nodes": nodes,
        "skins": [{"name": "mixamo", "joints": list(range(1, 66)), "inverseBindMatrices": acc_ibm, "skeleton": 1}],
        "animations": [{"name": anim_name, "channels": channels, "samplers": samplers,
                        "extras": {"fps": fps, "frames": N, "id": job["id"], "source": job["source"],
                                   "sourceName": job["sourceName"]}}],
    }
    rel = f"clips/{job['id']}.glb"
    nbytes = g.write(os.path.join(out_dir, rel), doc)

    # features / signature from world joint positions (canonical)
    fj = np.array([CI[n] for n in F.FEATURE_JOINTS])
    P = Wp[:, fj][..., :3, 3]
    Prest = Wr[fj][:, :3, 3]
    feats = F.compute(P, Prest, fps)
    sig = F.signature(P, fps, Prest)
    tmp = os.path.join(out_dir, "cache", job["id"] + ".tmp.npz")
    np.savez_compressed(tmp, P=P.astype(np.float32), rest=Prest.astype(np.float32), fps=np.float64(fps))
    os.replace(tmp, os.path.join(out_dir, "cache", job["id"] + ".npz"))

    return {
        "file": rel, "bytes": nbytes, "fps": fps, "frames": N, "frameStart": f0,
        "actionRange": [float(act.frame_range[0]), float(act.frame_range[1])],
        "rest": rest_meta, "droppedBones": dropped, "hierarchyMismatches": mismatches,
        "tracks": stats, "maxPoseScaleDev": max_scale_dev,
        "features": feats, "featuresVersion": F.FEATURES_VERSION, "signature": sig,
        "timing": {"import": round(t_import, 3), "total": round(time.time() - t0, 3)},
    }


# --------------------------------------------------------------------------- mannequin

def principled_values(mat):
    col, metal, rough = [0.8, 0.8, 0.8, 1.0], 0.0, 0.5
    if mat and mat.node_tree:
        node = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if node:
            col = list(node.inputs["Base Color"].default_value)
            metal = float(node.inputs["Metallic"].default_value)
            rough = float(node.inputs["Roughness"].default_value)
    elif mat:
        col = list(mat.diffuse_color)
    return col, metal, rough


def convert_mannequin(job, out_dir):
    t0 = time.time()
    arm = import_fbx(job["sourcePath"])
    src_names, parents, dropped, mismatches = canonical_bones(arm)
    xf = canon_xform(arm)
    Wr = rest_world(arm, src_names, xf)
    Lr = local_from_world(Wr, parents)
    nodes, rest_meta, _ = skeleton_nodes(Lr, parents)
    g = GLB()
    ibm = np.linalg.inv(Wr).transpose(0, 2, 1).astype(np.float32)
    acc_ibm = g.add(ibm, "MAT4")
    skin = {"name": "mixamo", "joints": list(range(1, 66)), "inverseBindMatrices": acc_ibm, "skeleton": 1}
    meshes, materials, mat_index = [], [], {}
    src2joint = {sn: CI[canon_name(sn)] for sn in src_names}
    mesh_stats = []
    for ob in sorted((o for o in bpy.data.objects if o.type == "MESH"), key=lambda o: o.name):
        me = ob.data
        me.calc_loop_triangles()
        nv, nl, nt = len(me.vertices), len(me.loops), len(me.loop_triangles)
        co = np.empty(nv * 3); me.vertices.foreach_get("co", co); co = co.reshape(nv, 3)
        lv = np.empty(nl, dtype=np.int64); me.loops.foreach_get("vertex_index", lv)
        ln = np.empty(nl * 3); me.corner_normals.foreach_get("vector", ln); ln = ln.reshape(nl, 3)
        tl = np.empty(nt * 3, dtype=np.int64); me.loop_triangles.foreach_get("loops", tl); tl = tl.reshape(nt, 3)
        tm = np.empty(nt, dtype=np.int64); me.loop_triangles.foreach_get("material_index", tm)
        W = C_BL2GL @ np.array(ob.matrix_world, dtype=np.float64)
        pos = co @ W[:3, :3].T + W[:3, 3]
        nrm = ln @ np.linalg.inv(W[:3, :3])  # inverse-transpose
        nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
        # weights
        joints = np.zeros((nv, 4), dtype=np.uint8); weights = np.zeros((nv, 4), dtype=np.float32)
        gname = {vg.index: vg.name for vg in ob.vertex_groups}
        unweighted, ignored = 0, set()
        for v in me.vertices:
            ws = []
            for ge in v.groups:
                n = gname.get(ge.group)
                if n in src2joint and ge.weight > 0:
                    ws.append((ge.weight, src2joint[n]))
                elif ge.weight > 0:
                    ignored.add(n)
            ws.sort(reverse=True)
            ws = ws[:4]
            tot = sum(w for w, _ in ws)
            if tot <= 0:
                ws, tot = [(1.0, 0)], 1.0
                unweighted += 1
            for k, (w, j) in enumerate(ws):
                joints[v.index, k] = j + 0  # joint index in skin.joints
                weights[v.index, k] = w / tot
        # split vertices by corner normal
        key = np.concatenate([lv[:, None].astype(np.float64), np.round(ln * 1e4)], axis=1)
        _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
        inv = inv.reshape(-1)
        vsrc = lv[first]
        P = pos[vsrc].astype(np.float32)
        Nn = nrm[first].astype(np.float32)
        a_pos = g.add(P, "VEC3", minmax=True, target=34962)
        a_nrm = g.add(Nn, "VEC3", target=34962)
        a_j = g.add(joints[vsrc], "VEC4", comp=5121, target=34962)
        a_w = g.add(weights[vsrc], "VEC4", target=34962)
        prims = []
        for mi in sorted(set(tm.tolist())):
            idx = inv[tl[tm == mi]].reshape(-1)
            comp = 5125 if len(first) > 65535 else 5123
            a_i = g.add(idx.astype(np.uint32 if comp == 5125 else np.uint16), "SCALAR", comp=comp, target=34963)
            mat = ob.material_slots[mi].material if mi < len(ob.material_slots) else None
            mkey = mat.name if mat else "__default"
            if mkey not in mat_index:
                col, metal, rough = principled_values(mat)
                mat_index[mkey] = len(materials)
                materials.append({"name": mkey, "pbrMetallicRoughness": {
                    "baseColorFactor": r6(col), "metallicFactor": metal, "roughnessFactor": rough}})
            prims.append({"attributes": {"POSITION": a_pos, "NORMAL": a_nrm, "JOINTS_0": a_j, "WEIGHTS_0": a_w},
                          "indices": a_i, "material": mat_index[mkey], "mode": 4})
        meshes.append({"name": ob.name, "primitives": prims})
        nodes.append({"name": ob.name, "mesh": len(meshes) - 1, "skin": 0})
        nodes[0]["children"].append(len(nodes) - 1)
        mesh_stats.append({"name": ob.name, "vertices": int(len(first)), "sourceVertices": nv,
                           "triangles": nt, "unweighted": unweighted, "ignoredGroups": sorted(i for i in ignored if i)})
    doc = {"asset": {"version": "2.0", "generator": f"mesh2motion library convert.py v{CONVERTER_VERSION}"},
           "scene": 0, "scenes": [{"name": job["name"], "nodes": [0]}], "nodes": nodes, "skins": [skin],
           "meshes": meshes, "materials": materials}
    rel = "mannequin/ybot.glb"
    nbytes = g.write(os.path.join(out_dir, rel), doc)
    return {"file": rel, "bytes": nbytes, "rest": rest_meta, "droppedBones": dropped,
            "hierarchyMismatches": mismatches, "meshes": mesh_stats,
            "timing": {"total": round(time.time() - t0, 3)}}


# --------------------------------------------------------------------------- main

def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    opts = {"--jobs": None, "--out": None, "--shard": "0"}
    for i in range(0, len(argv), 2):
        opts[argv[i]] = argv[i + 1]
    jobs = json.load(open(opts["--jobs"]))
    out_dir = opts["--out"]
    for d in ("clips", "meta", "cache", "failures", "mannequin", "work"):
        os.makedirs(os.path.join(out_dir, d), exist_ok=True)
    fail_path = os.path.join(out_dir, "failures", f"shard-{opts['--shard']}.jsonl")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    done = 0
    for k, job in enumerate(jobs):
        meta_path = os.path.join(out_dir, "meta", job["id"] + ".json")
        if os.path.exists(meta_path):
            try:
                m = json.load(open(meta_path))
                if m.get("converterVersion") == CONVERTER_VERSION and m.get("sha256") == job["sha256"]:
                    continue
            except Exception:
                pass
        with open(os.path.join(out_dir, "work", f"shard-{opts['--shard']}.current"), "w") as fh:
            fh.write(job["id"])
        try:
            res = convert_mannequin(job, out_dir) if job["kind"] == "mannequin" else convert_clip(job, out_dir)
            meta = {k2: job[k2] for k2 in ("id", "sha256", "kind", "source", "sourcePath", "sourceName", "name", "tags")
                    if k2 in job}
            meta.update({"converterVersion": CONVERTER_VERSION, "convertedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
            meta.update(res)
            tmp = meta_path + ".tmp"
            with open(tmp, "w") as fh:
                json.dump(meta, fh, separators=(",", ":"))
            os.replace(tmp, meta_path)
            done += 1
        except Exception as e:  # record and continue
            with open(fail_path, "a") as fh:
                fh.write(json.dumps({"id": job["id"], "sourcePath": job["sourcePath"], "source": job["source"],
                                     "error": f"{type(e).__name__}: {e}",
                                     "trace": traceback.format_exc()[-1500:],
                                     "converterVersion": CONVERTER_VERSION}) + "\n")
        print(f"[shard {opts['--shard']}] {k + 1}/{len(jobs)} {job['sourceName']}", flush=True)
    cur = os.path.join(out_dir, "work", f"shard-{opts['--shard']}.current")
    if os.path.exists(cur):
        os.remove(cur)
    print(f"[shard {opts['--shard']}] done, converted {done}", flush=True)


if __name__ == "__main__":
    main()
