"""Pose-optimized skin weights: minimize as-rigid-as-possible distortion over hundreds of real poses.

python optimize.py <prefix> [--iters 400] [--smooth 0.1] [--prior 0.05] [--device cuda]
reads <prefix>.json/.bin from tools/dev/pose_set.ts, writes <prefix>.opt.bin (per GLB vertex: 4 uint32
bone indices into the json's boneNames, then 4 float32 weights) and prints the energy before/after.

Linear blend skinning is what Godot runs, so the only freedom is the weights. Each vertex chooses its
weights among its existing influences (optionally its main bone's neighbors). The quality objective
combines symmetric edge strain, an extreme-strain penalty, volume of individually closed shells and
rigid limb regions over the training poses, plus weight smoothness and a weak prior. Open cloth has
no volume constraint. Layers keep their order (layers.py): a sheet over another at rest (a coat over the thigh)
stays over it, and a point over a leg may take that leg's bones. --only-layers fits nothing else: the points over
another layer, the triangles under them and two rings of edges round them, the arms and head left out; every other
point keeps its weights exactly (the rig job's pass after the optimizer, so the coat is fixed without the head's or the
arms' weights moving). An ARAP objective (one-ring distortion with rotations factored out) is optional.
"""
import argparse
import json
import time

import numpy as np
import torch

from layers import find_pairs, limb_of, penalty as layer_penalty, report as layer_report

LEAF = ('_End', '4')


def extreme_strain(log_ratio):
    """Symmetric stretch/compression tail beyond 1.5x (or its reciprocal).

    RMS alone can spread a few collapsed edges into many stretched ones. This
    term starts before the 2x acceptance threshold and penalizes both directions.
    The small floor keeps the derivative finite when no edge exceeds the margin.
    """
    return torch.relu(log_ratio.abs() - np.log(1.5)).square().mean().clamp_min(1e-12).sqrt()


def closed_volume_regions(vertices, triangles):
    """Only consistently oriented closed surfaces have a signed volume.

    Open robes and capes must not be inflated to preserve a fictitious volume;
    disconnected shells must not cancel one another's volume changes either.
    Components meet across edges, not merely at a shared vertex.
    """
    parent = list(range(len(triangles)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    edges = {}
    for i, tri in enumerate(triangles):
        for a, b in zip(tri, np.roll(tri, -1)):
            key = (min(a, b), max(a, b))
            edges.setdefault(key, []).append((i, 1 if a < b else -1))
    for uses in edges.values():
        for i, _ in uses[1:]:
            parent[find(i)] = find(uses[0][0])
    invalid = set()
    for uses in edges.values():
        if len(uses) != 2 or sum(direction for _, direction in uses) != 0:
            invalid.add(find(uses[0][0]))
    groups = {}
    for i in range(len(triangles)):
        root = find(i)
        if root not in invalid:
            groups.setdefault(root, []).append(i)
    regions = []
    for faces in groups.values():
        tri = triangles[faces]
        points = vertices[tri]
        points = points - points.mean(axis=(0, 1))
        volume = np.einsum('ij,ij->i', points[:, 0], np.cross(points[:, 1], points[:, 2])).sum() / 6
        extent = np.ptp(points.reshape(-1, 3), axis=0)
        if abs(volume) > max(float(np.prod(extent)) * 1e-6, 1e-12):
            regions.append(tri)
    return regions


def region_volumes(positions, regions):
    """Differentiable signed volume of each closed shell, per pose."""
    volumes = []
    for tri in regions:
        p = positions[:, tri]
        p = p - p.mean(dim=(1, 2), keepdim=True)
        volumes.append((p[:, :, 0] * torch.cross(p[:, :, 1], p[:, :, 2], dim=-1)).sum(dim=-1).sum(dim=-1) / 6)
    return torch.stack(volumes, dim=-1)


def load(prefix):
    meta = json.load(open(prefix + '.json'))
    raw = open(prefix + '.bin', 'rb').read()
    arrays = {}
    for name, info in meta['layout'].items():
        dtype = np.float32 if info['type'] == 'f4' else np.uint32
        arrays[name] = np.frombuffer(raw, dtype=dtype, count=info['length'], offset=info['offset'])
    return meta, arrays


def main():
    p = argparse.ArgumentParser()
    p.add_argument('prefix')
    p.add_argument('--iters', type=int, default=400)
    p.add_argument('--smooth', type=float, default=0.1)
    p.add_argument('--prior', type=float, default=0.05)
    p.add_argument('--lr', type=float, default=0.05)
    p.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'cpu')
    p.add_argument('--objective', default='quality', choices=['quality', 'arap'])
    p.add_argument('--batch', type=int, default=64, help='poses per step (memory)')
    p.add_argument('--w-stretch', type=float, default=1.0)
    p.add_argument('--w-volume', type=float, default=1.0)
    p.add_argument('--w-rigid', type=float, default=1.0)
    p.add_argument('--w-extreme', type=float, default=1.0)
    p.add_argument('--w-layers', type=float, default=1.0, help='layer order: a sheet over another at rest stays over it (0: off)')
    p.add_argument('--layer-reach', type=float, default=0.05, help='how far apart two layers may be at rest (of the height)')
    p.add_argument('--only-layers', action='store_true', help='fit only the layers and the band round them; the rest keeps its weights')
    p.add_argument('--no-mirror', action='store_true', help='let the two sides of the body differ')
    p.add_argument('--stretch-norm', default='rms', choices=['rms', 'abs'])
    p.add_argument('--add-neighbors', action='store_true', help="let a vertex take its main bone's parent and children too")
    a = p.parse_args()
    started = time.time()
    meta, arr = load(a.prefix)
    dev = torch.device(a.device)
    print(f'device {dev.type}', flush=True)
    names = meta['boneNames']
    B = len(names)
    rest = arr['rest'].reshape(-1, 3).astype(np.float64)
    tris = arr['tris'].reshape(-1, 3).astype(np.int64)
    skin_i = arr['skinIndex'].reshape(-1, 4).astype(np.int64)
    skin_w = arr['skinWeight'].reshape(-1, 4).astype(np.float64)
    P = meta['poses']
    M = arr['matrices'].reshape(P, B, 4, 4).transpose(0, 1, 3, 2)  # column-major -> row-major

    # Weld UV-seam duplicates: optimize one weight vector per position.
    H = float(np.ptp(rest[:, 1]))
    keys = np.round(rest / (1e-6 * H)).astype(np.int64)
    _, first, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    inverse = inverse.reshape(-1)
    V = rest[first]
    n = len(V)
    W0 = np.zeros((n, B))
    np.add.at(W0, (inverse[:, None].repeat(4, 1), skin_i), skin_w)
    counts = np.bincount(inverse, minlength=n)[:, None]
    W0 /= counts
    W0 /= np.maximum(W0.sum(1, keepdims=True), 1e-12)
    T = inverse[tris]
    T = T[(T[:, 0] != T[:, 1]) & (T[:, 1] != T[:, 2]) & (T[:, 0] != T[:, 2])]

    # Candidate bones: current ones plus parent/children of the main bone (deforming bones only).
    deform = np.array([not n_.endswith(LEAF) for n_ in names])
    children = [[] for _ in range(B)]
    for b, par in enumerate(meta['parents']):
        if par >= 0:
            children[par].append(b)
    # Layers at rest (a coat over the thigh): the point's candidates include the bones of the skin under it, so the
    # coat can go with the leg it covers.
    dominant = W0.argmax(1)
    under = {}
    if a.w_layers > 0:
        tl = lambda x, dt=torch.float32: torch.as_tensor(x, device=dev, dtype=dt)  # noqa: E731
        layers = find_pairs(tl(V / H), tl(T, torch.int64), tl(dominant, torch.int64), names, meta['parents'], reach=a.layer_reach)
        for i, tri in zip(layers['point'].tolist(), layers['tri'].tolist()):
            under[i] = [int(dominant[j]) for j in tri]
        print(f'layers: {len(under)} points over another layer', flush=True)
    else:
        layers = None
    free = None
    if a.only_layers:
        if layers is None:
            raise SystemExit('--only-layers needs --w-layers above 0')
        # The layers, the triangles under them and two rings of edges round them.
        free = np.zeros(n, dtype=bool)
        free[layers['point'].cpu().numpy()] = True
        free[layers['tri'].cpu().numpy().reshape(-1)] = True
        ring_e = np.unique(np.sort(np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]]), axis=1), axis=0)
        for _ in range(2):
            grow = free.copy()
            grow[ring_e[free[ring_e[:, 0]], 1]] = True
            grow[ring_e[free[ring_e[:, 1]], 0]] = True
            free = grow
        # (never an arm or the head: generated bodies fuse the hands to the coat at the hips, and the band would reach
        # them; the layers are the trunk's and the legs')
        limbs = limb_of(names, meta['parents'])
        free &= np.array([limbs[b] == 'trunk' or limbs[b].endswith('UpLeg') for b in dominant])
    K = 8 if under else 6
    cand = np.zeros((n, K), dtype=np.int64)
    mask = np.zeros((n, K), dtype=bool)
    # Skeleton distance, so a vertex can't keep weight from bones far from its main one (bleed).
    adjacent = [set(children[b]) | ({meta['parents'][b]} if meta['parents'][b] >= 0 else set()) for b in range(B)]
    within2 = []
    for b in range(B):
        reach = {b} | adjacent[b]
        reach |= {m for r in list(reach) for m in adjacent[r]}
        within2.append(reach)
    for i in range(n):
        have = list(np.flatnonzero(W0[i] > 1e-4)[np.argsort(-W0[i][W0[i] > 1e-4])])
        main = have[0]
        have = [b for b in have if b in within2[main]]
        near = ([meta['parents'][main]] + children[main] if a.add_neighbors else []) + under.get(i, [])
        for b in near:
            if b >= 0 and deform[b] and b not in have:
                have.append(b)
        have = have[:K]
        cand[i, :len(have)] = have
        mask[i, :len(have)] = True

    # The body's two sides: a vertex and its mirror twin share one set of weights (each bone swapped for its other
    # side's), so the optimizer can't make them differ (the Archer's sides were 2.8% apart before it, 6.5% after);
    # a vertex on the middle line is averaged with its own mirror at the end. Twins: within 0.2% of the height.
    bi_ = {n_: i for i, n_ in enumerate(names)}
    swap_b = np.arange(B)
    for b, n_ in enumerate(names):
        other = 'Right' + n_[4:] if n_.startswith('Left') else 'Left' + n_[5:] if n_.startswith('Right') else n_
        swap_b[b] = bi_.get(other, b)
    src = np.arange(n)
    middle = np.zeros(n, dtype=bool)
    if not a.no_mirror and 'Hips' in bi_:
        xc = float(np.array(meta['heads'])[bi_['Hips']][0])
        tol = 0.002 * H
        cell = np.floor(V / tol).astype(np.int64)
        grid = {}
        for i, c in enumerate(map(tuple, cell)):
            grid.setdefault(c, []).append(i)
        middle = np.abs(V[:, 0] - xc) <= tol
        pairs = 0
        for i in np.flatnonzero(V[:, 0] > xc + tol):
            m = V[i].copy(); m[0] = 2 * xc - m[0]
            c = np.floor(m / tol).astype(np.int64)
            best, bd = -1, tol
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for dz in (-1, 0, 1):
                        for j in grid.get((c[0] + dx, c[1] + dy, c[2] + dz), ()):
                            d = float(np.linalg.norm(V[j] - m))
                            if d < bd and V[j, 0] < xc - tol and src[j] == j:
                                best, bd = j, d
            if best >= 0:
                src[best] = i
                cand[best] = swap_b[cand[i]]
                mask[best] = mask[i]
                pairs += 1
        print(f'mirror: {pairs} twin pairs, {int(middle.sum())} on the middle line', flush=True)
    if free is not None:
        # A twin of a free point is free too; a fixed point keeps its own bones and weights, unlinked from its twin.
        linked = np.flatnonzero(src != np.arange(n))
        either = free[linked] | free[src[linked]]
        free[linked[either]] = True
        free[src[linked[either]]] = True
        for i in np.flatnonzero(~free):
            src[i] = i
            have = list(np.flatnonzero(W0[i] > 0)[np.argsort(-W0[i][W0[i] > 0])])[:K]
            cand[i] = 0
            mask[i] = False
            cand[i, :len(have)] = have
            mask[i, :len(have)] = True
        print(f'only the layers: {int(free.sum())} of {n} points fitted', flush=True)

    # Edges and cotangent-free (uniform) one-rings, normalized by height.
    E = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    E = np.unique(np.sort(E, axis=1), axis=0)
    t = lambda x, dt=torch.float32: torch.as_tensor(x, device=dev, dtype=dt)  # noqa: E731
    Vt = t(V / H)
    Ei, Ej = t(E[:, 0], torch.int64), t(E[:, 1], torch.int64)
    rest_e = Vt[Ei] - Vt[Ej]  # (e, 3)

    # Every candidate's transform of every vertex, for every pose: (P, n, K, 3).
    Mt = t(M)
    Mt[:, :, :3, 3] /= H
    cand_t = t(cand, torch.int64)
    Vh = torch.cat([Vt, torch.ones(n, 1, device=dev)], 1)
    # Built in pose chunks: gathering every candidate matrix for every vertex at once is large.
    X = torch.empty(P, n, K, 3, device=dev)
    for p0 in range(0, P, 16):
        X[p0:p0 + 16] = torch.einsum('pnkij,nj->pnki', Mt[p0:p0 + 16][:, cand_t][:, :, :, :3, :], Vh)
    del Mt

    mask_t = t(mask, torch.bool)
    init = np.take_along_axis(W0, cand, 1)
    twins = np.flatnonzero(src != np.arange(n))
    init[src[twins]] = 0.5 * (init[src[twins]] + init[twins])
    init[twins] = init[src[twins]]
    src_t = t(src, torch.int64)
    logits = torch.log(t(init) + 1e-3).masked_fill(~mask_t, -1e9).requires_grad_(True)
    W0c = t(init)
    if free is not None:
        fixed = np.take_along_axis(W0, cand, 1) * mask
        W0c[~t(free, torch.bool)] = t(fixed / np.maximum(fixed.sum(1, keepdims=True), 1e-12))[~t(free, torch.bool)]
    free_t = None if free is None else t(free, torch.bool)

    def weights():
        W = torch.softmax(logits[src_t], 1)
        return W if free_t is None else torch.where(free_t[:, None], W, W0c)
    opt = torch.optim.Adam([logits], lr=a.lr)

    def energy(W, rotations=None):
        Xp = torch.einsum('nk,pnki->pni', W, X)  # (P, n, 3)
        posed_e = Xp[:, Ei] - Xp[:, Ej]  # (P, e, 3)
        if rotations is None:
            # Per-vertex best rotation of its one-ring (ARAP local step), held fixed for the gradient.
            with torch.no_grad():
                cov = torch.zeros(P, n, 3, 3, device=dev)
                outer = rest_e[None, :, :, None] * posed_e[:, :, None, :]
                cov.index_add_(1, Ei, outer)
                cov.index_add_(1, Ej, outer)
                U, _, Vh_ = torch.linalg.svd(cov)
                R = Vh_.transpose(-1, -2) @ U.transpose(-1, -2)
                det = torch.linalg.det(R)
                fix = torch.ones_like(U)
                fix[..., :, 2] = torch.where(det < 0, -1.0, 1.0)[..., None]
                R = (Vh_.transpose(-1, -2)) @ (U * fix).transpose(-1, -2)
                rotations = R
        R = rotations
        target_i = torch.einsum('peij,ej->pei', R[:, Ei], rest_e)
        target_j = torch.einsum('peij,ej->pei', R[:, Ej], rest_e)
        arap = ((posed_e - target_i) ** 2).sum(-1) + ((posed_e - target_j) ** 2).sum(-1)
        return arap.mean() * 1e4, rotations

    # Rigid groups from our own joints: the middle of each long bone and the top of the head.
    heads = np.array(meta['heads']) / H
    bi = {n_: i for i, n_ in enumerate(names)}
    segs = [(f'{s_}{a_}', f'{s_}{b_}') for s_ in ('Left', 'Right') for a_, b_ in (('Arm', 'ForeArm'), ('ForeArm', 'Hand'), ('UpLeg', 'Leg'), ('Leg', 'Foot'))]
    spine_names = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head']
    Vn = V / H

    def seg_dist(a_, b_):
        ab = b_ - a_
        tt = ((Vn - a_) @ ab) / (ab @ ab)
        return tt, np.linalg.norm(Vn - (a_ + np.clip(tt, 0, 1)[:, None] * ab), axis=1)
    limb = [(seg_dist(heads[bi[a_]], heads[bi[b_]]), a_) for a_, b_ in segs if a_ in bi and b_ in bi]
    spine = [seg_dist(heads[bi[a_]], heads[bi[b_]])[1] for a_, b_ in zip(spine_names, spine_names[1:]) if a_ in bi and b_ in bi]
    groups = []
    if limb and spine:
        spine_d = np.min(spine, axis=0)
        all_d = np.stack([d for (_, d), _ in limb], 1)
        nearest = all_d.argmin(1)
        for k, ((tt, d), name_) in enumerate(limb):
            g = np.flatnonzero((nearest == k) & (d < spine_d) & (d < 0.08) & (tt > 0.35) & (tt < 0.65))
            if len(g) >= 8:
                groups.append(g)
    if not groups:
        # Not a humanoid (creature templates): the middle of every long bone should stay rigid.
        segs2 = [(n_, names[c_]) for n_, c_list in ((names[b_], children[b_]) for b_ in range(B)) for c_ in c_list[:1]
                 if deform[bi[n_]] and np.linalg.norm(heads[bi[n_]] - heads[c_]) > 0.04]
        limb = [(seg_dist(heads[bi[a_]], heads[bi[b_]]), a_) for a_, b_ in segs2]
        if limb:
            all_d = np.stack([d for (_, d), _ in limb], 1)
            nearest = all_d.argmin(1)
            for k, ((tt, d), name_) in enumerate(limb):
                g = np.flatnonzero((nearest == k) & (d < 0.08) & (tt > 0.35) & (tt < 0.65))
                if len(g) >= 8:
                    groups.append(g)
    if 'Head' in bi and 'HeadTop_End' in bi:
        hd, tp = heads[bi['Head']], heads[bi['HeadTop_End']]
        g = np.flatnonzero((Vn[:, 1] > hd[1] + 0.35 * (tp[1] - hd[1])) & (np.hypot(Vn[:, 0] - hd[0], Vn[:, 2] - hd[2]) < 0.1))
        if len(g) >= 8:
            groups.append(g)
    groups_t = [t(g_, torch.int64) for g_ in groups]
    rest_len = rest_e.norm(dim=1)
    closed = [t(tri, torch.int64) for tri in closed_volume_regions(Vn, T)]
    V0 = region_volumes(Vt[None], closed) if closed else None
    volume_share = V0.abs() / V0.abs().sum() if V0 is not None else None

    def rigid_residual(Xp, g_):
        A = Vt[g_]
        Bp = Xp[:, g_]
        A0 = A - A.mean(0)
        B0 = Bp - Bp.mean(1, keepdim=True)
        cov = torch.einsum('ni,pnj->pij', A0, B0)
        U, _, Vh_ = torch.linalg.svd(cov)
        d = torch.sign(torch.linalg.det(Vh_.transpose(-1, -2) @ U.transpose(-1, -2)))
        D = torch.diag_embed(torch.stack([torch.ones_like(d), torch.ones_like(d), d], -1))
        R = Vh_.transpose(-1, -2) @ D @ U.transpose(-1, -2)
        fitted = torch.einsum('pij,nj->pni', R, A0)
        return ((B0 - fitted) ** 2).sum(-1).mean(-1).clamp_min(1e-12).sqrt()  # (P,)

    def quality(W, poses=None):
        Xs = X if poses is None else X[poses]
        Xp = torch.einsum('nk,pnki->pni', W, Xs)
        posed = (Xp[:, Ei] - Xp[:, Ej]).norm(dim=-1)
        log_ratio = torch.log(posed.clamp_min(1e-9) / rest_len.clamp_min(1e-9))
        # rms: the root of the mean square, which spreads a stretch over many edges. The mean of |log| (abs) is
        # cheaper with it gathered on a few: at an armpit it undid the soft shoulders into one hard band that
        # stretched to 2.5-14 times its area with the arms up (the Archer, 2026-10-26).
        stretch = (log_ratio ** 2).mean().clamp_min(1e-12).sqrt() if a.stretch_norm == 'rms' else torch.sqrt(log_ratio ** 2 + 1e-6).mean()
        vol = (((region_volumes(Xp, closed) / V0 - 1) ** 2 * volume_share).sum(-1).mean().clamp_min(1e-12).sqrt()
               if V0 is not None else torch.zeros((), device=dev))
        rig = torch.stack([rigid_residual(Xp, g_) for g_ in groups_t]).mean() if groups_t else torch.zeros((), device=dev)
        extreme = extreme_strain(log_ratio)
        lay = layer_penalty(Xp, layers) if layers is not None else torch.zeros((), device=dev)
        return (a.w_stretch * stretch * 10 + a.w_volume * vol * 10 + a.w_rigid * rig * 100 + a.w_extreme * extreme * 10
                + a.w_layers * lay * 100), (stretch.item(), vol.item(), rig.item(), extreme.item(), lay.item())

    def full(W):
        dense = torch.zeros(n, B, device=dev)
        dense.scatter_add_(1, cand_t, W)
        return dense

    objective = (lambda W: energy(W)) if a.objective == 'arap' else quality
    with torch.no_grad():
        W_start = weights()
        e0, parts0 = objective(W_start)
    print('start', parts0 if a.objective == 'quality' else '', f'{len(groups)} rigid groups, {len(closed)} closed volume regions')
    generator = torch.Generator(device='cpu').manual_seed(0)
    for it in range(a.iters):
        W = weights()
        if a.objective == 'quality' and a.batch < P:
            e, parts = quality(W, torch.randperm(P, generator=generator)[:a.batch].to(dev))
        else:
            e, parts = objective(W)
        dense = full(W)
        smooth = ((dense[Ei] - dense[Ej]) ** 2).sum(1).mean() * 1e2
        prior = ((W - W0c) ** 2).sum(1).mean()
        loss = e + a.smooth * smooth + a.prior * prior
        opt.zero_grad()
        loss.backward()
        opt.step()
        if it % 100 == 0 or it == a.iters - 1:
            print(f'it {it:4d}  objective {e.item():.4f} {parts if a.objective == "quality" else ""}  smooth {smooth.item():.4f}  prior {prior.item():.4f}', flush=True)

    with torch.no_grad():
        W = weights()
        e1, _ = objective(W)
        dense = full(W)
        mid = t(middle, torch.bool)
        swap_t = t(swap_b, torch.int64)
        dense[mid] = 0.5 * (dense[mid] + dense[mid][:, swap_t])
        # Godot skins with 4 influences: keep the top 4, drop slivers, renormalize.
        top = torch.topk(dense, 4, dim=1)
        w4 = torch.where(top.values < 0.01, torch.zeros_like(top.values), top.values)
        w4 = w4 / w4.sum(1, keepdim=True)
        idx4 = top.indices
    w_out = w4.cpu().numpy()[inverse].astype(np.float32)
    i_out = idx4.cpu().numpy()[inverse].astype(np.uint32)
    if free is not None:
        # (every fixed vertex exactly as it was, UV copies included)
        keep = ~free[inverse]
        w_out[keep] = skin_w[keep].astype(np.float32)
        i_out[keep] = skin_i[keep].astype(np.uint32)
    out = np.concatenate([i_out.view(np.uint8).reshape(len(i_out), -1), w_out.view(np.uint8).reshape(len(w_out), -1)], 1)
    open(a.prefix + '.opt.bin', 'wb').write(out.tobytes())
    if layers is not None:
        with torch.no_grad():
            before = layer_report(torch.einsum('nk,pnki->pni', W_start, X), layers)[0].mean().item()
            after = layer_report(torch.einsum('nk,pnki->pni', W, X), layers)[0].mean().item()
        print(f'layers crossed before {100 * before:.2f}% after {100 * after:.2f}% (training poses, before the top-4 cut)')
    print(f'objective before {e0.item():.4f} after {e1.item():.4f}  ({n} verts, {P} poses, {time.time() - started:.1f}s)')


if __name__ == '__main__':
    import sys
    try:
        main()
    except torch.OutOfMemoryError:
        # The GPU is busy with something else: same optimization on the CPU.
        print('GPU out of memory, using the CPU', flush=True)
        torch.cuda.empty_cache()
        sys.argv += ['--device', 'cpu']
        main()
