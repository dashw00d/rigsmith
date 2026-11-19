"""Landmark detection invariants, runnable without Blender: python3 -m unittest discover -s blender/autorig."""
import json
import os
import struct
import unittest
import numpy as np
from landmarks import detect_markers
from skeleton import build_joints

HERE = os.path.dirname(__file__)
HUMAN = os.path.join(HERE, '..', '..', 'static', 'models', 'model-human.glb')


def box(lo, hi):
    """A closed box as (verts, tris)."""
    x, y, z = zip(lo, hi)
    verts = np.array([[a, b, c] for a in x for b in y for c in z], dtype=np.float64)
    quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    tris = [t for a, b, c, d in quads for t in ((a, b, c), (a, c, d))]
    return verts, np.array(tris)


def merge(parts):
    verts, tris, offset = [], [], 0
    for v, t in parts:
        verts.append(v)
        tris.append(t + offset)
        offset += len(v)
    return np.concatenate(verts), np.concatenate(tris)


def blocky_human(arm_drop=0.0):
    """A 1.8 m figure in a T-pose facing -Y (Z up); `arm_drop`: how far each fingertip hangs below the shoulder."""
    parts = [
        box((-0.17, -0.1, 0.9), (0.17, 0.1, 1.5)),       # torso
        box((-0.09, -0.09, 1.55), (0.09, 0.09, 1.8)),    # head
    ]
    for sign in (1, -1):
        legs = sorted((sign * 0.03, sign * 0.15))
        parts.append(box((legs[0], -0.06, 0.0), (legs[1], 0.08, 0.9)))
        # (the arm is a stack of short level slabs, stepping down toward the hand when it is not level)
        steps = 40
        for i in range(steps):
            x0, x1 = 0.17 + 0.63 * i / steps, 0.17 + 0.63 * (i + 1) / steps
            z = 1.38 - arm_drop * i / steps
            lo, hi = sorted((sign * x0, sign * x1))
            parts.append(box((lo, -0.04, z), (hi, 0.04, z + 0.08)))
    return merge(parts)


def bundled_human():
    """The mannequin in static/models, as Blender sees it (Z up, facing -Y)."""
    with open(HUMAN, 'rb') as f:
        raw = f.read()
    json_length = struct.unpack('<I', raw[12:16])[0]
    gltf = json.loads(raw[20:20 + json_length])
    blob = raw[20 + json_length + 8:]

    def accessor(index, columns, dtype):
        a = gltf['accessors'][index]
        view = gltf['bufferViews'][a['bufferView']]
        offset = view.get('byteOffset', 0) + a.get('byteOffset', 0)
        return np.frombuffer(blob, dtype=dtype, count=a['count'] * columns, offset=offset).reshape(-1, columns)

    primitive = gltf['meshes'][0]['primitives'][0]
    v = accessor(primitive['attributes']['POSITION'], 3, '<f4').astype(np.float64)
    indices = gltf['accessors'][primitive['indices']]
    tris = accessor(primitive['indices'], 1, {5123: '<u2', 5125: '<u4'}[indices['componentType']]).reshape(-1, 3).astype(np.int64)
    return np.stack([v[:, 0], -v[:, 2], v[:, 1]], axis=1), tris


class LevelArmTests(unittest.TestCase):
    def assert_level_arms(self, verts, tris, tip_x, torso_x, shoulder_z):
        sil, markers = detect_markers(verts, tris)
        for name, side in (('left', 1), ('right', -1)):
            arm = markers['arms'][name]
            self.assertIsNotNone(arm, f'{name} arm of a T-pose with level arms was not traced')
            self.assertAlmostEqual(arm['tip'][0], side * tip_x, delta=0.02)
            # the armpit is at the torso's side, under the arm
            self.assertAlmostEqual(arm['armpit'][0], side * torso_x, delta=0.05)
            self.assertLess(arm['armpit'][2], shoulder_z)
            origin, direction = arm['axis']
            self.assertGreater(side * direction[0], 0.999)  # the axis runs level, out toward the hand
            self.assertAlmostEqual(origin[1], shoulder_z, delta=0.05)
        joints = build_joints(sil, markers, fingers='two')
        for prefix, side in (('Left', 1), ('Right', -1)):
            xs = [side * joints[prefix + n][0] for n in ('Arm', 'ForeArm', 'Hand')]
            self.assertTrue(0.05 < xs[0] < xs[1] < xs[2] < tip_x, f'{prefix} arm joints out of order: {xs}')
            for n in ('Arm', 'ForeArm', 'Hand'):
                self.assertAlmostEqual(joints[prefix + n][2], shoulder_z, delta=0.06)
        return markers

    def test_exactly_horizontal_arms_are_traced(self):
        verts, tris = blocky_human()
        markers = self.assert_level_arms(verts, tris, tip_x=0.8, torso_x=0.17, shoulder_z=1.46)
        self.assertTrue(all(m['level'] for m in markers['arms'].values()))

    def test_slightly_sloped_arms_are_still_traced(self):
        verts, tris = blocky_human(arm_drop=0.25)
        _, markers = detect_markers(verts, tris)
        self.assertTrue(all(markers['arms'][s] is not None for s in ('left', 'right')))

    def test_bundled_mannequin_arms_are_traced(self):
        verts, tris = bundled_human()
        self.assert_level_arms(verts, tris, tip_x=0.96, torso_x=0.17, shoulder_z=1.46)


if __name__ == '__main__':
    unittest.main()
