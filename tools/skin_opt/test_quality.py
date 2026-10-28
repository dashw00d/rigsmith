"""Objective invariants: python -m unittest discover -s tools/skin_opt -p test_quality.py"""
import unittest
import numpy as np
import torch
from optimize import closed_volume_regions, extreme_strain, region_volumes


class QualityTests(unittest.TestCase):
    def test_volume_ignores_open_or_inconsistently_wound_surfaces(self):
        vertices = np.array([[0.,0,0], [1.,0,0], [0,1.,0], [0,0,1.]])
        tetra = np.array([[0,2,1], [0,1,3], [1,2,3], [2,0,3]])
        self.assertEqual(len(closed_volume_regions(vertices, tetra)), 1)
        self.assertEqual(closed_volume_regions(vertices, tetra[:-1]), [])
        wrong = tetra.copy(); wrong[0] = wrong[0][::-1]
        self.assertEqual(closed_volume_regions(vertices, wrong), [])

    def test_closed_shell_volumes_cannot_cancel_and_are_translation_invariant(self):
        v = np.array([[0.,0,0], [1.,0,0], [0,1.,0], [0,0,1.]])
        t = np.array([[0,2,1], [0,1,3], [1,2,3], [2,0,3]])
        vertices = np.concatenate([v, v + 3])
        regions = [torch.tensor(g) for g in closed_volume_regions(vertices, np.concatenate([t,t+4]))]
        self.assertEqual(len(regions), 2)
        p = torch.tensor(vertices[None], requires_grad=True)
        volumes = region_volumes(p, regions)
        self.assertTrue(torch.allclose(volumes, torch.tensor([[1/6,1/6]], dtype=p.dtype)))
        self.assertTrue(torch.allclose(region_volumes(p + 100, regions), volumes))
        volumes.sum().backward()
        self.assertTrue(torch.isfinite(p.grad).all())

    def test_stretch_and_reciprocal_compression_have_the_same_penalty(self):
        x = torch.tensor(np.log([1., 1.4, 2., 4.]), dtype=torch.float64)
        self.assertAlmostEqual(extreme_strain(x).item(), extreme_strain(-x).item())
        self.assertGreater(extreme_strain(x).item(), 0.1)

    def test_small_strain_has_no_tail_force_and_finite_gradient(self):
        x = torch.tensor(np.log([1., 1.1, 1.4]), requires_grad=True)
        loss = extreme_strain(x)
        loss.backward()
        self.assertLess(loss.item(), 1e-5)
        self.assertTrue(torch.isfinite(x.grad).all())
        self.assertTrue((x.grad == 0).all())

    def test_tail_gradient_pushes_stretch_and_compression_toward_rest(self):
        x = torch.tensor(np.log([.4, 2.5]), requires_grad=True)
        extreme_strain(x).backward()
        self.assertLess(x.grad[0].item(), 0)
        self.assertGreater(x.grad[1].item(), 0)


if __name__ == '__main__':
    unittest.main()
