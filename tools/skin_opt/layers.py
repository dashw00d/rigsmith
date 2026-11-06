"""Layer order for the pose optimizer: a sheet that lies over another at rest (a coat over the thigh, a shirt over the
belly, a cape over the back) stays over it in every pose.

Generated characters are one surface: the coat's hem, the trousers under it and the legs are all the same mesh, each
layer weighted by the auto-rig to its nearest bones. Linear skinning then moves a coat panel with the hips and the
thigh under it with the leg, and in a squat the thigh comes up through the panel (the designer, 2026-11-01: "this is
an issue many of the models have for many animations"). Nothing in the optimizer saw it: stretch, volume and rigid
limbs are all happy with a thigh through a coat.

Pairs are found once, at rest: from each point, along its normal both ways, the nearest triangle whose front faces
it, within a few percent of the height, not in its own neighbourhood (`find_pairs`). A pair's gap in a pose is the
point's height over that triangle's plane, the triangle as skinned in that pose (`gaps`); it must keep a quarter of
its rest gap (the brushes' rule, docs/rigging.md "Brush integrity"). A point that slid off its triangle is no longer
over it and isn't scored. Only pairs that weights can answer are kept: the trunk over the trunk or a leg, a leg over
its own leg; an arm and the body, or one leg and the other, meet because the clip moves them there (`keep_pair`).
"""
import numpy as np
import torch

# The limbs a bone belongs to: its first ancestor (or itself) among these, else the trunk.
LIMBS = ('LeftArm', 'RightArm', 'LeftShoulder', 'RightShoulder', 'LeftUpLeg', 'RightUpLeg', 'Neck', 'Head')


def limb_of(names, parents):
    out = []
    for b in range(len(names)):
        c, limb = b, 'trunk'
        while c >= 0:
            if names[c] in LIMBS:
                limb = names[c].replace('Shoulder', 'Arm').replace('Neck', 'Head')
                break
            c = parents[c]
        out.append(limb)
    return out


def keep_pair(a, b):
    """Whether the weights can keep these limbs' layers apart (a: the point's limb, b: the triangle's)."""
    if 'Arm' in a or 'Arm' in b or a == 'Head' or b == 'Head':
        return False
    return a == b or a == 'trunk' or b == 'trunk'


def vertex_normals(V, T):
    fn = torch.cross(V[T[:, 1]] - V[T[:, 0]], V[T[:, 2]] - V[T[:, 0]], dim=-1)
    vn = torch.zeros_like(V)
    for k in range(3):
        vn.index_add_(0, T[:, k], fn)
    return vn / vn.norm(dim=1, keepdim=True).clamp_min(1e-12)


def find_pairs(V, T, dominant, names, parents, reach=0.03, chunk=256):
    """V (n, 3) rest points in units of the height, T (t, 3) triangles, dominant (n,) each point's main bone.
    Returns the pairs as a dict of tensors: point, tri (its three corners), bary (where the ray met it) and gap (the
    rest gap, > 0), plus counts for the report."""
    dev = V.device
    n = len(V)
    N = vertex_normals(V, T)
    A, B, C = V[T[:, 0]], V[T[:, 1]], V[T[:, 2]]
    e1, e2 = B - A, C - A
    fn = torch.cross(e1, e2, dim=-1)
    fn = fn / fn.norm(dim=1, keepdim=True).clamp_min(1e-12)
    # The neighbourhood a point never pairs with: two rings of edges (a fold's own triangles).
    ring = torch.zeros(n, n, dtype=torch.bool, device=dev) if n <= 20000 else None
    if ring is None:
        raise ValueError('too many points for the dense neighbourhood')
    for i, j in ((0, 1), (1, 2), (2, 0)):
        ring[T[:, i], T[:, j]] = True
        ring[T[:, j], T[:, i]] = True
    ring |= torch.eye(n, dtype=torch.bool, device=dev)
    ring2 = (ring.float() @ ring.float()) > 0
    del ring
    limb = limb_of(names, parents)
    limbs = sorted(set(limb))
    code = torch.tensor([limbs.index(limb[b]) for b in range(len(names))], device=dev)
    allowed = torch.tensor([[keep_pair(x, y) for y in limbs] for x in limbs], device=dev)
    pt_limb = code[dominant]
    tri_limb = code[torch.mode(dominant[T], dim=1).values]
    points, tris, barys, gaps = [], [], [], []
    for s in range(0, n, chunk):
        idx = torch.arange(s, min(s + chunk, n), device=dev)
        O = V[idx]
        best_t = torch.full((len(idx),), float('inf'), device=dev)
        best_f = torch.full((len(idx),), -1, dtype=torch.long, device=dev)
        best_uv = torch.zeros(len(idx), 2, device=dev)
        near = ring2[idx][:, T].any(-1)  # (c, t): the triangle touches the point's neighbourhood
        ok_limb = allowed[pt_limb[idx]][:, tri_limb]
        for sign in (1.0, -1.0):
            D = N[idx] * sign
            p = torch.cross(D[:, None, :].expand(-1, len(T), -1), e2[None].expand(len(idx), -1, -1), dim=-1)
            det = (e1[None] * p).sum(-1)
            inv = 1.0 / torch.where(det.abs() < 1e-12, torch.full_like(det, 1e-12), det)
            tv = O[:, None, :] - A[None]
            u = (tv * p).sum(-1) * inv
            q = torch.cross(tv, e1[None].expand(len(idx), -1, -1), dim=-1)
            v = (D[:, None, :] * q).sum(-1) * inv
            t = (e2[None] * q).sum(-1) * inv
            facing = (D[:, None, :] * fn[None]).sum(-1) < -0.3  # the ray goes in at the triangle's front
            hit = (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-5) & (t < reach) & facing & ~near & ok_limb
            t = torch.where(hit, t, torch.full_like(t, float('inf')))
            tmin, f = t.min(1)
            better = tmin < best_t
            best_t = torch.where(better, tmin, best_t)
            best_f = torch.where(better, f, best_f)
            gu = u.gather(1, f[:, None])[:, 0]
            gv = v.gather(1, f[:, None])[:, 0]
            best_uv = torch.where(better[:, None], torch.stack([gu, gv], 1), best_uv)
        found = best_f >= 0
        if found.any():
            f = best_f[found]
            uv = best_uv[found]
            bary = torch.stack([1 - uv[:, 0] - uv[:, 1], uv[:, 0], uv[:, 1]], 1)
            h = (bary[:, :, None] * V[T[f]]).sum(1)
            g = ((O[found] - h) * fn[f]).sum(-1)
            points.append(idx[found]); tris.append(T[f]); barys.append(bary); gaps.append(g)
    if not points:
        z = torch.zeros(0, device=dev)
        return {'point': z.long(), 'tri': torch.zeros(0, 3, dtype=torch.long, device=dev), 'bary': torch.zeros(0, 3, device=dev), 'gap': z}
    out = {'point': torch.cat(points), 'tri': torch.cat(tris), 'bary': torch.cat(barys), 'gap': torch.cat(gaps)}
    keep = out['gap'] > 1e-5
    return {k: v[keep] for k, v in out.items()}


def gaps(Xp, pairs):
    """Each pair's gap in each pose (P, m): the point's height over its triangle's plane as posed, and whether it is
    still over the triangle (its foot within the triangle grown by the rest gap and a bit)."""
    tri = Xp[:, pairs['tri']]  # (P, m, 3, 3)
    a, b, c = tri[:, :, 0], tri[:, :, 1], tri[:, :, 2]
    fn = torch.cross(b - a, c - a, dim=-1)
    fn = fn / fn.norm(dim=-1, keepdim=True).clamp_min(1e-12)
    h = (pairs['bary'][None, :, :, None] * tri).sum(2)
    d = Xp[:, pairs['point']] - h
    g = (d * fn).sum(-1)
    lateral = (d - g[..., None] * fn).norm(dim=-1)
    over = lateral < 2 * pairs['gap'][None] + 0.01
    return g, over


def penalty(Xp, pairs, keep=0.25):
    """Root mean square of how far each pair is under its kept gap, over every pair and pose (in heights)."""
    if len(pairs['gap']) == 0:
        return torch.zeros((), device=Xp.device)
    g, over = gaps(Xp, pairs)
    short = torch.relu(keep * pairs['gap'][None] - g) * over
    return short.square().mean().clamp_min(1e-12).sqrt()


def report(Xp, pairs, keep=0.25):
    """Per pose: the share of pairs crossed (the outer sheet through the inner) and of pairs under the kept gap."""
    if len(pairs['gap']) == 0:
        z = torch.zeros(Xp.shape[0], device=Xp.device)
        return z, z
    g, over = gaps(Xp, pairs)
    crossed = ((g < 0) & over).float().mean(1)
    short = ((g < keep * pairs['gap'][None]) & over).float().mean(1)
    return crossed, short
