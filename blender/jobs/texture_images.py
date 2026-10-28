"""What texture_fill.py and texture_compose.py share: the model's images, the names each goes by, and their pixels.

An image has more than one name. Blender's (an FBX's texture name, "Diffuse Texture"), that name without an
extension, and its file's stem: Blender's glTF export names an image after its file when it has one
("tripo_rgb_….png" -> "tripo_rgb_…"), so the model files Rigsmith makes may call it either. Texture overrides
(blender/common/scene_io.py) look for textures/<clean Blender name>.png, server/glbimages.ts swapImages for
textures/<clean GLB name>.png: a composite is written under every name, so both find it. A layer names its image by
any of them, compared loosely (`loose`), as names cleaned before the rebuild made '-' _ too.
"""
import os
import re

import bpy
import numpy as np

IMAGE_FILES = ('.png', '.jpg', '.jpeg')


def images_of(meshes):
    """Every image an image node of the meshes' materials shows, by name."""
    found = {n.image for ob in meshes for s in ob.material_slots if s.material and s.material.use_nodes
             for n in s.material.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image is not None}
    return sorted(found, key=lambda im: im.name)


def names_of(image):
    """The clean names (bpy.path.clean_name) the image goes by, Blender's own first."""
    out = []

    def add(name):
        clean = bpy.path.clean_name(name)
        if clean and clean not in out:
            out.append(clean)

    add(image.name)
    add(os.path.splitext(image.name)[0])
    source = image.filepath_raw or image.filepath
    if source:
        stem, ext = os.path.splitext(os.path.basename(bpy.path.abspath(source)))
        if ext.lower() in IMAGE_FILES:
            add(stem)
    return out


def loose(name):
    """A name as both cleanings agree on it."""
    return re.sub(r'[^A-Za-z0-9_]', '_', name)


def srgb(linear):
    return np.where(linear <= 0.0031308, linear * 12.92, 1.055 * np.power(np.maximum(linear, 0), 1 / 2.4) - 0.055)


def pixels_of(image):
    """RGBA as stored (rows bottom-up, as Blender keeps them; every image read here the same way), 0..1, straight
    alpha. A float image (a 16-bit PNG, an EXR) holds scene-linear colour: made sRGB like the 8-bit images it meets
    (8-bit pixels read as stored)."""
    w, h = image.size
    px = np.empty(w * h * 4, dtype=np.float32)
    image.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)
    if image.is_float and image.colorspace_settings.name not in ('Non-Color', 'Raw'):
        px[..., :3] = srgb(px[..., :3])
    return px


def save_png(pixels, path):
    """An 8-bit PNG of RGBA pixels (rows bottom-up); without alpha when it is opaque everywhere."""
    h, w = pixels.shape[:2]
    alpha = bool((pixels[..., 3] < 0.999).any())
    image = bpy.data.images.new('rigsmith_out', w, h, alpha=alpha)
    image.pixels.foreach_set(np.clip(pixels, 0, 1).ravel())
    image.filepath_raw = path
    image.file_format = 'PNG'
    image.save()
    bpy.data.images.remove(image)


def resample(pixels, w, h):
    """RGBA resampled (bilinear) to w x h, colour weighted by alpha, so a decal's clear texels don't darken its edge."""
    sh, sw = pixels.shape[:2]
    if (sh, sw) == (h, w):
        return pixels
    pre = pixels.copy()
    pre[..., :3] *= pre[..., 3:4]
    y = np.clip((np.arange(h) + 0.5) * sh / h - 0.5, 0, sh - 1)
    x = np.clip((np.arange(w) + 0.5) * sw / w - 0.5, 0, sw - 1)
    y0 = np.floor(y).astype(int)
    x0 = np.floor(x).astype(int)
    y1 = np.minimum(y0 + 1, sh - 1)
    x1 = np.minimum(x0 + 1, sw - 1)
    fy = (y - y0)[:, None, None].astype(np.float32)
    fx = (x - x0)[None, :, None].astype(np.float32)
    top = pre[y0][:, x0] * (1 - fx) + pre[y0][:, x1] * fx
    bottom = pre[y1][:, x0] * (1 - fx) + pre[y1][:, x1] * fx
    out = top * (1 - fy) + bottom * fy
    a = out[..., 3:4]
    out[..., :3] = np.where(a > 1e-6, out[..., :3] / np.maximum(a, 1e-6), 0)
    return out
