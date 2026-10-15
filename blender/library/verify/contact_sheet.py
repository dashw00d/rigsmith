#!/usr/bin/env python3
"""Stick-figure contact sheets from the cached joint positions (numpy only, writes PNG).

  python3 contact_sheet.py OUT.png ID [ID ...] [--frames 8]

One row per clip: `frames` evenly spaced poses, each drawn front view (left half, viewer
looking at the character's front: character-left on the right) and side view (right half,
character facing right). Red = left limbs, blue = right, dark = spine/head. Grey line = ground
(y=0). Panels are centred on the hips horizontally; a small bar at the bottom shows time.
"""
import os
import struct
import sys
import zlib

import numpy as np

sys.dont_write_bytecode = True  # keep blender/library free of __pycache__
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import features as F  # noqa: E402

LIB = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "workspace", "library"))
SEGS = [("Hips", "Spine"), ("Spine", "Spine1"), ("Spine1", "Spine2"), ("Spine2", "Neck"), ("Neck", "Head"),
        ("Head", "HeadTop_End")]
for s in ("Left", "Right"):
    SEGS += [("Spine2", f"{s}Shoulder"), (f"{s}Shoulder", f"{s}Arm"), (f"{s}Arm", f"{s}ForeArm"),
             (f"{s}ForeArm", f"{s}Hand"), (f"{s}Hand", f"{s}HandMiddle1"), ("Hips", f"{s}UpLeg"),
             (f"{s}UpLeg", f"{s}Leg"), (f"{s}Leg", f"{s}Foot"), (f"{s}Foot", f"{s}ToeBase"),
             (f"{s}ToeBase", f"{s}Toe_End")]
PW, PH, SCALE = 90, 150, 62.0


def color(a, b):
    n = a + b
    if "Left" in n:
        return (220, 40, 40)
    if "Right" in n:
        return (40, 80, 230)
    return (30, 30, 30)


def line(img, x0, y0, x1, y1, c, t=1):
    n = int(max(abs(x1 - x0), abs(y1 - y0))) + 1
    xs = np.linspace(x0, x1, n).round().astype(int)
    ys = np.linspace(y0, y1, n).round().astype(int)
    for dx in range(-t + 1, t):
        for dy in range(-t + 1, t):
            xx, yy = xs + dx, ys + dy
            ok = (xx >= 0) & (xx < img.shape[1]) & (yy >= 0) & (yy < img.shape[0])
            img[yy[ok], xx[ok]] = c


def png(path, img):
    h, w, _ = img.shape
    raw = b"".join(b"\x00" + img[y].tobytes() for y in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
    open(path, "wb").write(data)


def draw_clip(P, nframes):
    N = len(P)
    idx = np.linspace(0, N - 1, nframes).round().astype(int)
    row = np.full((PH, PW * 2 * nframes, 3), 255, np.uint8)
    yaw0 = F.facing_yaw(P)[0][0]
    Q = F.rot_y(P, -yaw0)  # initial facing -> +Z
    for k, f in enumerate(idx):
        for view in (0, 1):
            ox = (2 * k + view) * PW
            hx = Q[f, F.JI["Hips"]]
            # front view: screen x = -X (character's left appears on viewer's right)... use +X to the right
            # so that character-left is on the right as when facing the viewer
            def proj(p):
                sx = (p[0] - hx[0]) if view == 0 else (p[2] - hx[2])
                return ox + PW / 2 + sx * SCALE, PH - 12 - p[1] * SCALE
            line(row, ox, PH - 12, ox + PW - 1, PH - 12, (190, 190, 190))
            for a, b in SEGS:
                x0, y0 = proj(Q[f, F.JI[a]]); x1, y1 = proj(Q[f, F.JI[b]])
                line(row, x0, y0, x1, y1, color(a, b), 2)
            if view == 1:
                line(row, ox + PW - 1, 0, ox + PW - 1, PH - 1, (120, 120, 120))
        bar = int((f / max(N - 1, 1)) * (2 * PW - 4))
        line(row, k * 2 * PW + 2, PH - 4, k * 2 * PW + 2 + bar, PH - 4, (0, 160, 0), 2)
    return row


def main():
    args = sys.argv[1:]
    nframes = 8
    if "--frames" in args:
        i = args.index("--frames"); nframes = int(args[i + 1]); del args[i:i + 2]
    out, ids = args[0], args[1:]
    rows = []
    for cid in ids:
        z = np.load(os.path.join(LIB, "cache", cid + ".npz"))
        rows.append(draw_clip(z["P"].astype(np.float64), nframes))
        rows.append(np.full((4, rows[-1].shape[1], 3), 0, np.uint8))
    png(out, np.concatenate(rows, axis=0))
    print("wrote", out)


if __name__ == "__main__":
    main()
