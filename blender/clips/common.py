"""What the made clips share (blender/clips/*.py): keying an armature with canonical poses, and writing the clip into
the library with the library's own converter.

Canonical space is the library's (glTF: Y up, metres, facing +Z): convert.py's map from Blender's armature space,
run backwards. A made clip's line in work/sources.json names its script (`make`, with its `args`) and the files it is
made from (`inputs`, this file among them): build.py convert remakes it when any changes (sha256 over the script and
the inputs)."""
import hashlib
import json
import os
import sys
import time

import bpy
import numpy as np
from mathutils import Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(REPO, 'blender', 'library'))
import convert as C  # noqa: E402

COMMON = os.path.abspath(__file__)


def sha_of(make, inputs):
    """What build.py checks a made clip by: the script, then each input."""
    h = hashlib.sha256(open(os.path.join(REPO, make), 'rb').read())
    for path in inputs:
        h.update(open(path, 'rb').read())
    return h.hexdigest()


def fk(L, parents):
    W = np.empty_like(L)
    for b, p in enumerate(parents):
        W[b] = L[b] if p is None else W[p] @ L[b]
    return W


def key_poses(arm, names, parents, xf, poses, fps, action_name):
    """Key the armature with canonical world poses (one (65, 4, 4) per frame): each pose matrix in armature space is the
    converter's map run backwards, each bone's basis taken from its parent's."""
    A3, At, RA = xf
    A3i = np.linalg.inv(A3)
    pb = arm.pose.bones
    rest = {n: np.array(arm.data.bones[n].matrix_local, dtype=np.float64) for n in names}
    act = bpy.data.actions.new(action_name)
    arm.animation_data_create()
    arm.animation_data.action = act
    scene = bpy.context.scene
    scene.render.fps = int(round(fps))
    scene.frame_start = 0
    scene.frame_end = len(poses) - 1
    for p in pb:
        p.rotation_mode = 'QUATERNION'
    for k, W in enumerate(poses):
        P = {}
        for b, name in enumerate(names):
            M = np.eye(4)
            M[:3, :3] = RA.T @ W[b, :3, :3]
            M[:3, 3] = A3i @ (W[b, :3, 3] - At)
            P[name] = M
        for b, name in enumerate(names):
            parent = parents[b]
            B = rest[name]
            if parent is None:
                basis = np.linalg.inv(B) @ P[name]
            else:
                pn = names[parent]
                basis = np.linalg.inv(np.linalg.inv(rest[pn]) @ B) @ (np.linalg.inv(P[pn]) @ P[name])
            bone = pb[name]
            bone.matrix_basis = Matrix(basis.tolist())
            bone.keyframe_insert('rotation_quaternion', frame=k)
            bone.keyframe_insert('location', frame=k)


META_KEYS = ('id', 'sha256', 'kind', 'source', 'sourcePath', 'sourceName', 'name', 'tags', 'description', 'originalName', 'category')


def into_library(arm, library, job):
    """The library's converter on this armature as it is (its rest, the new action), then the clip's meta and its line in
    the sources."""
    for d in ('clips', 'meta', 'cache', 'work'):
        os.makedirs(os.path.join(library, d), exist_ok=True)
    C.import_fbx = lambda path: arm   # (convert_clip reads the armature this way: it is already here)
    res = C.convert_clip(job, library)
    meta = {k: job[k] for k in META_KEYS if k in job}
    meta.update({'converterVersion': C.CONVERTER_VERSION, 'convertedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'make': job['make']})
    meta.update(res)
    with open(os.path.join(library, 'meta', job['id'] + '.json'), 'w') as fh:
        json.dump(meta, fh, separators=(',', ':'))
    sources_path = os.path.join(library, 'work', 'sources.json')
    sources = json.load(open(sources_path)) if os.path.exists(sources_path) else []
    sources = [x for x in sources if x.get('id') != job['id']] + [job]
    with open(sources_path, 'w') as fh:
        json.dump(sources, fh, indent=1)
