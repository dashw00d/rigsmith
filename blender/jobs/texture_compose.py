"""Compose a character's texture: each of the source model's own images with its look layers laid over it, in order.

blender -b --factory-startup --python texture_compose.py -- --input <source model> --layers <layers.json>
    --textures <character>/textures --restore <dir>

layers.json: [{"image": clean image name, "file": absolute path of an RGBA PNG}], the enabled layers, bottom to top.
The source is imported as uploaded (no texture overrides). For each of its images (texture_images.py says by which
names; a layer may use any of them):
- with layers: <textures>/<name>.png, under each of its names, is the image with each layer laid over it by the
  layer's alpha (resampled to the image's size); the image's own alpha stays.
- without: its <textures>/<name>.png files are deleted and, if there were any (the model files carry them), the image
  as the source has it is written to <restore>/<name>.png, which server/glbimages.ts swapImages puts back.
Files the same image had under a name cleaned before the rebuild ('-' made _) go too. When a layer's image is none of
the source's, nothing is written and the layer is reported. Never runs the import job's joint detection.
Reports {"images": [{"names", "layers": n, "composed": bool, "restored": bool}], "unmatched": [layer images]}.
"""
import argparse
import json
import os
import shutil
import sys

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
sys.path.insert(0, HERE)

from common import report, scene_io  # noqa: E402
from texture_images import images_of, loose, names_of, pixels_of, resample, save_png  # noqa: E402

BAND = 512  # rows blended at a time, so a large texture needs no full-size temporaries


def lay_over(out, layer):
    """`layer` (RGBA, straight alpha) over `out` in place: the colour mixed by the layer's alpha, `out`'s alpha kept."""
    for y in range(0, out.shape[0], BAND):
        o = out[y:y + BAND]
        top = layer[y:y + BAND]
        a = top[..., 3:4]
        o[..., :3] *= 1 - a
        o[..., :3] += top[..., :3] * a


def existing(textures, names):
    """The composite files the image has now: under its names, and under names that are its loosely (made before the
    rebuild cleaned '-' as well)."""
    if not os.path.isdir(textures):
        return []
    keys = {loose(n) for n in names}
    out = []
    for entry in sorted(os.listdir(textures)):
        stem, ext = os.path.splitext(entry)
        if ext.lower() != '.png' or stem.endswith('.mask') or not os.path.isfile(os.path.join(textures, entry)):
            continue
        if loose(stem) in keys:
            out.append(os.path.join(textures, entry))
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--input', required=True)
    p.add_argument('--layers', required=True)
    p.add_argument('--textures', required=True)
    p.add_argument('--restore', required=True)
    a = p.parse_args(report.args())
    with open(a.layers, encoding='utf-8') as f:
        layers = json.load(f)
    scene_io.reset()
    report.progress(0.05, 'Importing the source model')
    meshes = scene_io.import_any(a.input)
    images = [(image, names_of(image)) for image in images_of(meshes) if image.size[0] > 0 and image.size[1] > 0]

    # Each layer's image first: one that is none of the source's stops the job before anything is written.
    mine = {i: [] for i in range(len(images))}
    unmatched = []
    for layer in layers:
        key = loose(layer['image'])
        hits = [i for i, (_, names) in enumerate(images) if key in {loose(n) for n in names}]
        if not hits:
            unmatched.append(layer['image'])
        for i in hits:
            mine[i].append(layer)
    if unmatched:
        report.result({'images': [{'names': names, 'layers': 0, 'composed': False, 'restored': False} for _, names in images], 'unmatched': unmatched})
        return

    os.makedirs(a.textures, exist_ok=True)
    os.makedirs(a.restore, exist_ok=True)
    results = []
    for i, (image, names) in enumerate(images):
        report.progress(0.15 + 0.8 * i / max(len(images), 1), f'Composing {image.name}')
        had = existing(a.textures, names)
        on = mine[i]
        w, h = image.size
        if not on:
            for path in had:
                os.remove(path)
            if had:
                # (the model files carry the old composite: the source's own goes back in)
                first = os.path.join(a.restore, names[0] + '.png')
                save_png(pixels_of(image), first)
                for name in names[1:]:
                    shutil.copyfile(first, os.path.join(a.restore, name + '.png'))
            results.append({'names': names, 'layers': 0, 'composed': False, 'restored': bool(had)})
            continue
        out = pixels_of(image)
        for layer in on:
            loaded = bpy.data.images.load(layer['file'], check_existing=False)
            try:
                top = resample(pixels_of(loaded), w, h)
            finally:
                bpy.data.images.remove(loaded)
            lay_over(out, top)
        # (written under every name, then the spellings of them from before gone)
        written = [os.path.join(a.textures, name + '.png') for name in names]
        save_png(out, written[0])
        for path in written[1:]:
            shutil.copyfile(written[0], path)
        for path in had:
            if path not in written:
                os.remove(path)
        results.append({'names': names, 'layers': len(on), 'composed': True, 'restored': False})
    report.result({'images': results, 'unmatched': []})


main()
