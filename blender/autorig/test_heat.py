"""Numerical skinning invariants, runnable without Blender: python3 -m unittest discover -s blender/autorig."""
import unittest
import numpy as np
import heat
from skeleton import complete_joints
import mixamo
from regions import match_fingers


class HeatTests(unittest.TestCase):
    def test_vertex_areas_and_weights_do_not_depend_on_triangle_order(self):
        v = np.array([[0., 0, 0], [2., 0, 0], [0, 1., 0], [0, 0, 4.]])
        t = np.array([[0, 1, 2], [0, 2, 3]])  # areas 1 and 2
        mass = heat.laplacian(v, t, 1e-6)[3]
        np.testing.assert_allclose(mass, [1, 1/3, 1, 2/3])
        labels = np.array([0, 0, 1, 1])
        a = heat.diffuse(v, t, labels, np.ones(4), 2)
        b = heat.diffuse(v, t[::-1], labels, np.ones(4), 2)
        np.testing.assert_allclose(a, b, atol=1e-6)

    def test_isolated_vertex_and_empty_graph(self):
        v = np.array([[0., 0, 0], [1., 0, 1]])
        w = heat.diffuse(v, np.empty((0, 3), dtype=int), np.array([0, 1]), np.ones(2), 2)
        np.testing.assert_allclose(w, np.eye(2), atol=1e-6)

    def test_final_skin_is_finite_normalized_and_seam_identical(self):
        v = np.array([[0., 0, 0], [0., 0, 0], [1., 0, 1], [2., 0, 1]])
        w = np.zeros((4, 65))
        w[0, :5] = [.3, .25, .2, .15, .1]
        w[1, :5] = [.1, .15, .2, .25, .3]
        w[2, :] = 1/65  # every weight is below the pruning threshold
        w[3, :] = np.nan
        out = heat.finalize(v, w, np.array([0, 4, 2, 3]))
        np.testing.assert_array_equal(out[0], out[1])
        np.testing.assert_allclose(out.sum(axis=1), 1)
        self.assertTrue(np.isfinite(out).all())
        self.assertTrue(((out > 0).sum(axis=1) <= 4).all())
        self.assertEqual(out[3, 3], 1)

    def test_switching_to_no_fingers_reports_only_actual_bones(self):
        supplied = {b: np.array([i, 1., 0.]) for i, (b, _) in enumerate(mixamo.hierarchy('full'))}
        out = complete_joints(np.zeros((1, 3)), np.empty((0, 3), int), supplied, 'none')
        self.assertEqual(set(out), {b for b, _ in mixamo.hierarchy('none')})
        for b in out:
            np.testing.assert_array_equal(out[b], supplied[b])

    def test_finger_skin_uses_placed_chains_when_detection_swaps_labels(self):
        fingers = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']
        idx = {f'LeftHand{f}{i}': k * 3 + i - 1 for k, f in enumerate(fingers) for i in (1, 2, 3)}
        distances = np.ones((5, 15))
        for k in range(5):
            distances[k, k * 3:(k + 1) * 3] = 0
        labeled = {f: {'members': [k]} for k, f in enumerate(['Thumb', 'Middle', 'Index', 'Ring', 'Pinky'])}
        match = match_fingers(labeled, 'Left', idx, distances)
        self.assertEqual(match['Middle'], 'Index')
        self.assertEqual(match['Index'], 'Middle')


if __name__ == '__main__':
    unittest.main()
