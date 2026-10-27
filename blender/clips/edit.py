"""A clip made in Rigsmith's animation editor (src/state/clipedit.svelte.ts), into the library.

  blender -b --factory-startup --python blender/clips/edit.py -- --edit EDIT.json [--library DIR]

EDIT.json (written by the server, workspace/library/sources/custom/<id>.edit.json): the clip's id, name, category and
tags, `restFrom` (the FBX of the skeleton it was edited from: the base clip's source, its exact rest), and `frames`:
per frame the local turn of every bone of that skeleton and the hips' local position, in the library's canonical space
(the editor took the clip back off the character: src/engine/clipedit.ts unretarget). The frames are keyed on that
armature and written by the library's converter (blender/clips/common.py), so the clip is a library clip like any.
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common  # noqa: E402
from common import C  # noqa: E402


def quat_to_mat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    edit_path = argv[argv.index('--edit') + 1]
    library = argv[argv.index('--library') + 1] if '--library' in argv else os.path.join(os.environ.get('RIGSMITH_WORKSPACE', os.path.join(common.REPO, 'workspace')), 'library')
    edit = json.load(open(edit_path))
    frames = edit['frames']
    arm = C.import_fbx(edit['restFrom'])
    names, parents, _, _ = C.canonical_bones(arm)
    xf = C.canon_xform(arm)
    Lr = C.local_from_world(C.rest_world(arm, names, xf), parents)
    index = {n: i for i, n in enumerate(C.CANON)}
    order = [index[n] for n in frames['bones'] if n in index]
    poses = []
    for rot, hips in zip(frames['rotations'], frames['hips']):
        L = Lr.copy()
        for k, b in zip(order, [r for n, r in zip(frames['bones'], rot) if n in index]):
            L[k, :3, :3] = quat_to_mat(b)
        L[0, :3, 3] = hips
        poses.append(common.fk(L, parents))
    common.key_poses(arm, names, parents, xf, poses, frames['fps'], edit['name'])
    make = 'blender/clips/edit.py'
    inputs = [edit_path, edit['restFrom'], common.COMMON]
    job = {'id': edit['id'], 'sha256': common.sha_of(make, inputs), 'kind': 'clip', 'source': 'custom', 'sourcePath': edit_path,
           'make': make, 'args': ['--edit', edit_path], 'inputs': inputs, 'sourceName': edit['id'], 'name': edit['name'],
           'originalName': edit['name'], 'description': edit.get('description', ''), 'tags': edit.get('tags', ['custom']), 'category': edit.get('category'),
           'loop': bool(edit.get('loop', True))}
    if edit.get('propPaths'):
        job['propPaths'] = edit['propPaths']   # (each leading prop's path: the library lists it with the clip)
    common.into_library(arm, library, job)
    print(f'EDIT wrote {edit["id"]} ({len(poses)} frames) into {library}')


if __name__ == '__main__':
    main()
