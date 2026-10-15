"""Fill unpainted areas of AI-generated textures (Tripo marks them magenta).

Holes are filled from nearby painted *surface* (in 3D, not UV space), so UV seams and fragmented
atlases don't bleed unrelated colors in.

blender -b --factory-startup --python texture_fill.py -- --input <model> --out <dir> [--overrides <dir>]
Writes <out>/<image>.png (filled) and <out>/<image>.mask.png (what was filled), reports coverage.
"""
import argparse
import os
import sys

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))

from common import report, scene_io  # noqa: E402

WORK = 1024  # resolution the fill is computed at; composited back at full resolution


def magenta_mask(rgb):
    """Tripo's hole color is a saturated magenta (~0.69, 0.30, 0.69) plus anti-aliased fringes."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    core = (r > 0.5) & (b > 0.5) & (g < 0.5 * np.minimum(r, b)) & (np.abs(r - b) < 0.25)
    return core


def dilate(mask, steps):
    for _ in range(steps):
        m = mask.copy()
        m[1:] |= mask[:-1]
        m[:-1] |= mask[1:]
        m[:, 1:] |= mask[:, :-1]
        m[:, :-1] |= mask[:, 1:]
        mask = m
    return mask


def resize(img, size):
    """Area-average downscale (or nearest upscale) of an HxWxC array to size x size."""
    h, w = img.shape[:2]
    if h % size == 0 and w % size == 0 and h >= size:
        f = h // size
        return img.reshape(size, f, size, f, -1).mean(axis=(1, 3))
    ys = (np.arange(size) * h / size).astype(int)
    xs = (np.arange(size) * w / size).astype(int)
    return img[ys][:, xs]


def upsample_bilinear(img, size):
    h, w = img.shape[:2]
    y = (np.arange(size) + 0.5) * h / size - 0.5
    x = (np.arange(size) + 0.5) * w / size - 0.5
    y0 = np.clip(np.floor(y).astype(int), 0, h - 1)
    x0 = np.clip(np.floor(x).astype(int), 0, w - 1)
    y1 = np.clip(y0 + 1, 0, h - 1)
    x1 = np.clip(x0 + 1, 0, w - 1)
    fy = np.clip(y - y0, 0, 1)[:, None, None]
    fx = np.clip(x - x0, 0, 1)[None, :, None]
    top = img[y0][:, x0] * (1 - fx) + img[y0][:, x1] * fx
    bottom = img[y1][:, x0] * (1 - fx) + img[y1][:, x1] * fx
    return top * (1 - fy) + bottom * fy


def texel_positions(meshes, image, size):
    """World position of the surface under each texel (size x size), plus coverage."""
    pos = np.zeros((size, size, 3), dtype=np.float32)
    covered = np.zeros((size, size), dtype=bool)
    for ob in meshes:
        uses = any(slot.material and slot.material.use_nodes and any(n.type == 'TEX_IMAGE' and n.image == image for n in slot.material.node_tree.nodes) for slot in ob.material_slots)
        if not uses or not ob.data.uv_layers:
            continue
        me = ob.data
        me.calc_loop_triangles()
        uv_layer = me.uv_layers.active.data
        mw = np.array(ob.matrix_world)
        verts = np.array([list(v.co) for v in me.vertices]) @ mw[:3, :3].T + mw[:3, 3]
        for tri in me.loop_triangles:
            uv = np.array([list(uv_layer[li].uv) for li in tri.loops]) * size
            uv[:, 1] = size - uv[:, 1]  # image rows go down
            p = verts[list(tri.vertices)]
            x0, y0 = np.floor(uv.min(0)).astype(int)
            x1, y1 = np.ceil(uv.max(0)).astype(int)
            x0, y0 = max(x0, 0), max(y0, 0)
            x1, y1 = min(x1, size - 1), min(y1, size - 1)
            if x1 < x0 or y1 < y0:
                continue
            gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
            a, b, c = uv
            v0, v1 = b - a, c - a
            d = v0[0] * v1[1] - v1[0] * v0[1]
            if abs(d) < 1e-12:
                continue
            px, py = gx - a[0], gy - a[1]
            l1 = (px * v1[1] - v1[0] * py) / d
            l2 = (v0[0] * py - px * v0[1]) / d
            l0 = 1 - l1 - l2
            inside = (l0 >= -0.02) & (l1 >= -0.02) & (l2 >= -0.02)
            if not inside.any():
                continue
            world = l0[..., None] * p[0] + l1[..., None] * p[1] + l2[..., None] * p[2]
            ys, xs = np.nonzero(inside)
            pos[ys + y0, xs + x0] = world[ys, xs]
            covered[ys + y0, xs + x0] = True
    return pos, covered


def fill_from_surface(colors, holes, pos, covered, height):
    """Color each hole texel from painted texels nearby on the surface (3D voxel grid diffusion)."""
    cell = height / 160.0
    valid = covered & ~holes
    target = covered & holes
    if not target.any() or not valid.any():
        return colors
    lo = pos[covered].min(0) - 2 * cell
    dims = np.ceil((pos[covered].max(0) + 2 * cell - lo) / cell).astype(int) + 1
    idx = np.clip(((pos - lo) / cell).astype(int), 0, dims - 1)
    flat = np.ravel_multi_index((idx[..., 0], idx[..., 1], idx[..., 2]), dims)
    sums = np.zeros((np.prod(dims), 3))
    counts = np.zeros(np.prod(dims))
    np.add.at(sums, flat[valid], colors[valid])
    np.add.at(counts, flat[valid], 1)
    sums = sums.reshape(*dims, 3)
    counts = counts.reshape(*dims)
    needed = np.zeros(np.prod(dims), dtype=bool)
    needed[flat[target]] = True
    needed = needed.reshape(dims)
    for _ in range(64):
        missing = needed & (counts == 0)
        if not missing.any():
            break
        grown_sums = np.zeros_like(sums)
        grown_counts = np.zeros_like(counts)
        for axis in range(3):
            for shift in (-1, 1):
                grown_sums += np.roll(sums, shift, axis)
                grown_counts += np.roll(counts, shift, axis)
        fill = missing & (grown_counts > 0)
        sums[fill] = grown_sums[fill] / grown_counts[fill, None]
        counts[fill] = 1
    mean = sums / np.maximum(counts, 1e-9)[..., None]
    out = colors.copy()
    out[target] = mean.reshape(-1, 3)[flat[target]]
    return out


def fill_gutters(colors, holes, covered, iterations=96):
    """Holes outside any UV island still bleed into mipmaps: grow neighboring colors into them."""
    todo = holes & ~covered
    known = ~todo
    out = colors.copy()
    for _ in range(iterations):
        if not todo.any():
            break
        acc = np.zeros_like(out)
        cnt = np.zeros(todo.shape)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            k = np.roll(known, (dy, dx), (0, 1))
            acc += np.roll(out, (dy, dx), (0, 1)) * k[..., None]
            cnt += k
        grow = todo & (cnt > 0)
        out[grow] = acc[grow] / cnt[grow, None]
        known = known | grow
        todo = todo & ~grow
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--input', required=True)
    p.add_argument('--out', required=True)
    a = p.parse_args(report.args())
    os.makedirs(a.out, exist_ok=True)
    scene_io.reset()
    report.progress(0.05, 'Importing')
    meshes = scene_io.import_any(a.input)
    verts, _ = scene_io.mesh_arrays(meshes)
    height = float(np.ptp(verts[:, 2])) or 1.0
    images = {n.image for ob in meshes for s in ob.material_slots if s.material and s.material.use_nodes
              for n in s.material.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image is not None}
    results = []
    for i, image in enumerate(sorted(images, key=lambda im: im.name)):
        report.progress(0.1 + 0.8 * i / max(len(images), 1), f'Analyzing {image.name}')
        w, h = image.size
        if w == 0 or h == 0:
            continue
        pixels = np.empty(w * h * 4, dtype=np.float32)
        image.pixels.foreach_get(pixels)
        full = pixels.reshape(h, w, 4)[::-1]  # Blender stores rows bottom-up
        holes_full = magenta_mask(full[..., :3])
        coverage = float(holes_full.mean())
        name = bpy.path.clean_name(image.name)
        if coverage < 0.0005:
            results.append({'image': image.name, 'coverage': coverage, 'file': None})
            continue
        size = min(WORK, w)
        colors = resize(full[..., :3], size)
        holes = resize(dilate(holes_full, 2)[..., None].astype(np.float32), size)[..., 0] > 0.05
        report.progress(0.1 + 0.8 * (i + 0.4) / max(len(images), 1), 'Mapping texels to the surface')
        pos, covered = texel_positions(meshes, image, size)
        report.progress(0.1 + 0.8 * (i + 0.7) / max(len(images), 1), 'Filling from nearby paint')
        filled = fill_from_surface(colors, holes, pos, covered, height)
        filled = fill_gutters(filled, holes, covered)
        # Composite back at full resolution with a soft edge around each hole.
        fill_full = upsample_bilinear(filled, w) if size != w else filled
        mask_full = dilate(holes_full, 3).astype(np.float32)
        soft = upsample_bilinear(resize(mask_full[..., None], size), w)[..., 0] if size != w else mask_full
        alpha = np.clip(np.maximum(mask_full, soft * 1.5), 0, 1)[..., None]
        out = full.copy()
        out[..., :3] = full[..., :3] * (1 - alpha) + fill_full * alpha
        out[..., 3] = 1.0
        result = bpy.data.images.new(name + '_filled', w, h, alpha=False)
        result.pixels.foreach_set(out[::-1].ravel())
        result.filepath_raw = os.path.join(a.out, name + '.png')
        result.file_format = 'PNG'
        result.save()
        mask_image = bpy.data.images.new(name + '_mask', size, size, alpha=False)
        m = np.zeros((size, size, 4), dtype=np.float32)
        m[..., 0] = holes
        m[..., 1] = holes * 0.4
        m[..., 3] = 1
        mask_image.pixels.foreach_set(m[::-1].ravel())
        mask_image.filepath_raw = os.path.join(a.out, name + '.mask.png')
        mask_image.file_format = 'PNG'
        mask_image.save()
        results.append({'image': image.name, 'coverage': coverage, 'file': name + '.png', 'mask': name + '.mask.png'})
    report.result({'images': results})


main()
