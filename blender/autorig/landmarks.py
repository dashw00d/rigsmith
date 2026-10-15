"""Humanoid landmark detection from a mesh in A- or T-pose (numpy only).

Frame: Z up, character faces -Y, character's left = +X. See raster.py.

detect_markers() finds the measurable anatomy (hand tips, wrists, armpits, crotch, feet, head top,
limb centerlines) from front/side silhouettes and depth cross-sections. skeleton.py turns markers into
a Mixamo joint layout.
"""
import numpy as np

from raster import Grid2D, close, distance_transform, fill_holes, runs, sample_surface


class Silhouettes:
    def __init__(self, verts, tris, resolution=400):
        self.verts = verts
        self.tris = tris
        self.z_min = float(verts[:, 2].min())
        self.z_max = float(verts[:, 2].max())
        self.height = self.z_max - self.z_min
        self.pixel = self.height / resolution
        self.points = sample_surface(verts, tris, self.pixel)
        self.front_grid = Grid2D.fit(self.points, 0, 2, self.pixel)
        self.front = fill_holes(close(self.front_grid.rasterize(self.points), 2))
        self.side_grid = Grid2D.fit(self.points, 1, 2, self.pixel)
        self.side = fill_holes(close(self.side_grid.rasterize(self.points), 2))
        self.x_center = 0.5 * (self.points[:, 0].min() + self.points[:, 0].max())
        self.center_col = int(round(self.front_grid.to_pixel(self.x_center, 0)[1]))

    def row(self, z):
        return int(round((z - self.front_grid.v_min) / self.pixel))

    def z(self, row):
        return self.front_grid.v_min + row * self.pixel

    def x(self, col):
        return self.front_grid.h_min + col * self.pixel

    def col(self, x):
        return int(round((x - self.front_grid.h_min) / self.pixel))

    def depth_range(self, x, z, radius_fraction=0.02):
        """(front, back) Y of the surface near (x, z); front is the smaller Y."""
        radius = radius_fraction * self.height
        for _ in range(4):
            near = (np.abs(self.points[:, 0] - x) < radius) & (np.abs(self.points[:, 2] - z) < radius)
            if near.sum() >= 8:
                ys = self.points[near, 1]
                return float(np.percentile(ys, 2)), float(np.percentile(ys, 98))
            radius *= 2
        y = float(np.median(self.points[:, 1]))
        return y, y

    def depth_center(self, x, z, radius_fraction=0.02, bias=0.5):
        """Y at fraction `bias` between front (0) and back (1) of the surface near (x, z)."""
        front, back = self.depth_range(x, z, radius_fraction)
        return front + bias * (back - front)


def _overlap(a, b):
    return min(a[1], b[1]) - max(a[0], b[0])


def _track_run(image, start_row, start_run, direction, stop_row, merge_test):
    """Follow one run row by row; returns list of (row, run) until merge_test(row, run, prev) is True."""
    path = [(start_row, start_run)]
    current = start_run
    row = start_row
    while row != stop_row:
        row += direction
        candidates = [r for r in runs(image[row]) if _overlap(r, current) > 0]
        if not candidates:
            break
        best = max(candidates, key=lambda r: _overlap(r, current))
        if merge_test(row, best, current):
            return path, row, best
        path.append((row, best))
        current = best
    return path, None, None


def detect_legs(sil):
    """Feet, leg centerlines and crotch. Returns dict or None when feet are not separable."""
    F = sil.front
    h = sil.height
    foot_row = sil.row(sil.z_min + 0.03 * h)
    stop_row = sil.row(sil.z_min + 0.65 * h)
    candidates = [r for r in runs(F[foot_row]) if r[1] - r[0] > 2]
    left = [r for r in candidates if (r[0] + r[1]) / 2 > sil.center_col]
    right = [r for r in candidates if (r[0] + r[1]) / 2 < sil.center_col]
    if not left or not right:
        return None
    left_run = max(left, key=lambda r: r[1] - r[0])
    right_run = max(right, key=lambda r: r[1] - r[0])

    centers = {'left': [], 'right': []}
    current = {'left': left_run, 'right': right_run}
    crotch_row = None
    for row in range(foot_row, stop_row):
        row_runs = runs(F[row])
        picked = {}
        for side in ('left', 'right'):
            options = [r for r in row_runs if _overlap(r, current[side]) > 0]
            if not options:
                break
            picked[side] = max(options, key=lambda r: _overlap(r, current[side]))
        if len(picked) < 2:
            break
        if picked['left'] == picked['right']:
            crotch_row = row
            break
        for side in ('left', 'right'):
            run = picked[side]
            # Ignore rows where a hand touches the leg (sudden widening).
            if run[1] - run[0] > 1.6 * (current[side][1] - current[side][0]) + 4:
                continue
            current[side] = run
            centers[side].append((sil.x(0.5 * (run[0] + run[1] - 1)), sil.z(row), run[1] - run[0]))
    if crotch_row is None:
        return None
    crotch_x = sil.x(0.5 * (current['left'][0] + current['right'][1] - 1))
    gap_center = 0.5 * (current['left'][0] + current['right'][1] - 1)
    return {
        'crotch': np.array([sil.x(gap_center), 0.0, sil.z(crotch_row)]),
        'crotch_z': sil.z(crotch_row),
        'crotch_x': crotch_x,
        'centers': {k: np.array(v) for k, v in centers.items()},
    }


def detect_arm(sil, side):
    """Hand tip, arm centerline, armpit and wrist for one side (+1 = left/+X, -1 = right)."""
    F = sil.front
    h = sil.height
    band = np.zeros_like(F)
    band[sil.row(sil.z_min + 0.25 * h):sil.row(sil.z_min + 0.95 * h)] = True
    cols = np.flatnonzero((F & band).any(axis=0))
    tip_col = cols.max() if side > 0 else cols.min()
    tip_rows = np.flatnonzero(F[:, tip_col] & band[:, tip_col])
    tip_row = int(np.round(tip_rows.mean()))
    tip = np.array([sil.x(tip_col), 0.0, sil.z(tip_row)])

    def outermost(row_runs):
        return max(row_runs, key=lambda r: r[1]) if side > 0 else min(row_runs, key=lambda r: r[0])

    start_run = outermost(runs(F[tip_row]))
    inner = (lambda r: r[0]) if side > 0 else (lambda r: -r[1])
    jump = 0.05 * h / sil.pixel

    def merged(row, run, previous):
        return inner(previous) - inner(run) > jump

    path, armpit_row, armpit_run = _track_run(F, tip_row, start_run, +1, sil.row(sil.z_max) - 1, merged)
    # Hands hanging below the tip row (fingers pointing down): extend downward too.
    down, _, _ = _track_run(F, tip_row, start_run, -1, 0, lambda row, run, prev: False)
    path = list(reversed(down[1:])) + path
    if armpit_row is None:
        return None
    rows = np.array([p[0] for p in path], dtype=np.float64)
    mids = np.array([0.5 * (p[1][0] + p[1][1] - 1) for p in path])
    widths = np.array([p[1][1] - p[1][0] for p in path], dtype=np.float64)
    centerline = np.stack([sil.x(mids), sil.z(rows)], axis=1)
    inner_edge = sil.x(armpit_run[0] if side > 0 else armpit_run[1] - 1)
    # Armpit point: the inner edge of the arm at the merge row.
    last = path[-1][1]
    armpit = np.array([sil.x(last[0] if side > 0 else last[1] - 1), 0.0, sil.z(armpit_row)])
    return {
        'tip': tip,
        'centerline': centerline,
        'widths': widths * sil.pixel,
        'armpit': armpit,
        'armpit_rel_z': (armpit[2] - sil.z_min) / h,
        'armpit_inner_edge_x': inner_edge,
    }


def _fit_line(points):
    center = points.mean(axis=0)
    _, _, vt = np.linalg.svd(points - center)
    direction = vt[0]
    return center, direction


def arm_axis(arm):
    """Straight-line model of the arm in the front plane: origin near the armpit, unit dir toward the hand."""
    pts = arm['centerline']
    # Use the middle 15%..75% of the tracked length (skip the hand blob and the shoulder merge).
    order = np.argsort(pts[:, 1])  # by z ascending: hand first
    pts = pts[order]
    n = len(pts)
    core = pts[int(n * 0.25):int(n * 0.85)]
    center, direction = _fit_line(core)
    hand_dir = pts[0] - center
    if np.dot(direction, hand_dir) < 0:
        direction = -direction
    return center, direction


def detect_markers(verts, tris):
    sil = Silhouettes(verts, tris)
    markers = {'height': sil.height, 'z_min': sil.z_min, 'z_max': sil.z_max, 'x_center': sil.x_center}
    arms = {}
    for side, name in ((1, 'left'), (-1, 'right')):
        arm = detect_arm(sil, side)
        if arm is not None:
            arm['axis'] = arm_axis(arm)
        arms[name] = arm
    markers['arms'] = arms
    markers['legs'] = detect_legs(sil)
    return sil, markers
