"""Silhouette rasterization and binary-image helpers (numpy only, runs inside Blender too).

Frame convention for everything in autorig/: Blender world space, Z up, character faces -Y,
character's left side is +X. Units are whatever the mesh uses; algorithms normalize by height.
"""
import numpy as np


def sample_surface(verts, tris, spacing, seed=0):
    """Area-weighted random points on the surface, roughly one per spacing^2 / 2."""
    rng = np.random.default_rng(seed)
    a, b, c = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    count = np.minimum(np.ceil(area / (spacing * spacing) * 2.0), 400).astype(np.int64)
    tri_index = np.repeat(np.arange(len(tris)), count)
    r1 = np.sqrt(rng.random(len(tri_index)))
    r2 = rng.random(len(tri_index))
    u, v, w = 1.0 - r1, r1 * (1.0 - r2), r1 * r2
    points = a[tri_index] * u[:, None] + b[tri_index] * v[:, None] + c[tri_index] * w[:, None]
    return np.concatenate([points, verts])


class Grid2D:
    """Maps a world plane (two axes) onto a pixel grid; row 0 is the minimum of the vertical axis."""

    def __init__(self, h_axis, v_axis, h_min, v_min, pixel, width, height):
        self.h_axis, self.v_axis = h_axis, v_axis
        self.h_min, self.v_min, self.pixel = h_min, v_min, pixel
        self.width, self.height = width, height

    @classmethod
    def fit(cls, points, h_axis, v_axis, pixel, margin=4):
        h_min = points[:, h_axis].min() - margin * pixel
        v_min = points[:, v_axis].min() - margin * pixel
        width = int(np.ceil((points[:, h_axis].max() - h_min) / pixel)) + margin + 1
        height = int(np.ceil((points[:, v_axis].max() - v_min) / pixel)) + margin + 1
        return cls(h_axis, v_axis, h_min, v_min, pixel, width, height)

    def to_pixel(self, h, v):
        return (np.asarray(v) - self.v_min) / self.pixel, (np.asarray(h) - self.h_min) / self.pixel

    def to_world(self, row, col):
        return self.h_min + np.asarray(col, dtype=np.float64) * self.pixel, self.v_min + np.asarray(row, dtype=np.float64) * self.pixel

    def rasterize(self, points):
        rows = np.floor((points[:, self.v_axis] - self.v_min) / self.pixel).astype(np.int64)
        cols = np.floor((points[:, self.h_axis] - self.h_min) / self.pixel).astype(np.int64)
        ok = (rows >= 0) & (rows < self.height) & (cols >= 0) & (cols < self.width)
        image = np.zeros((self.height, self.width), dtype=bool)
        image[rows[ok], cols[ok]] = True
        return image


def shift_or(image, cross_only=False):
    out = image.copy()
    out[1:] |= image[:-1]
    out[:-1] |= image[1:]
    out[:, 1:] |= image[:, :-1]
    out[:, :-1] |= image[:, 1:]
    if not cross_only:
        out[1:, 1:] |= image[:-1, :-1]
        out[1:, :-1] |= image[:-1, 1:]
        out[:-1, 1:] |= image[1:, :-1]
        out[:-1, :-1] |= image[1:, 1:]
    return out


def dilate(image, steps):
    for _ in range(steps):
        image = shift_or(image)
    return image


def erode(image, steps):
    for _ in range(steps):
        image = ~shift_or(~image)
    return image


def close(image, steps):
    return erode(dilate(image, steps), steps)


def fill_holes(image):
    """Flood the background from the border; anything not reached is inside."""
    outside = np.zeros_like(image)
    outside[0, :] = ~image[0, :]
    outside[-1, :] = ~image[-1, :]
    outside[:, 0] = ~image[:, 0]
    outside[:, -1] = ~image[:, -1]
    background = ~image
    while True:
        grown = shift_or(outside, cross_only=True) & background
        if (grown == outside).all():
            break
        outside = grown
    return ~outside


def distance_transform(image):
    """Approximate Euclidean distance to the background in pixels (alternating 4/8 erosions)."""
    dist = np.zeros(image.shape, dtype=np.float32)
    current = image.copy()
    step = 0
    while current.any():
        dist[current] += 1.0
        current = ~shift_or(~current, cross_only=(step % 2 == 0))
        step += 1
    return dist


def runs(row):
    """(start, end_exclusive) column intervals of True values in a 1-D boolean array."""
    padded = np.concatenate([[0], row.astype(np.int8), [0]])
    delta = np.diff(padded)
    return list(zip(np.flatnonzero(delta == 1), np.flatnonzero(delta == -1)))


def components(image):
    """Label 8-connected components. Returns (labels, count). Small images only."""
    labels = np.zeros(image.shape, dtype=np.int32)
    count = 0
    remaining = image.copy()
    while remaining.any():
        count += 1
        seed = np.unravel_index(np.argmax(remaining), image.shape)
        region = np.zeros_like(image)
        region[seed] = True
        while True:
            grown = shift_or(region) & remaining
            if (grown == region).all():
                break
            region = grown
        labels[region] = count
        remaining &= ~region
    return labels, count
