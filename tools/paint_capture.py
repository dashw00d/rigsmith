#!/usr/bin/env python3
"""A Look capture's views repainted by Qwen Image 2.1 in the local ComfyUI, in place of Codex (server/routes/look.ts,
POST .../projections/<id>/qwen). Per view N (views.json): the masked area of view-N-flat.png cropped (its box and a
quarter round it, square, at least 128 px), edited at --size px by Qwen from the capture's notes, the painting sized back
and laid over the view inside the feathered mask only (outside it the view is untouched), written as result-N.png (1024, the view's size; its alpha kept). The capture's notes (views.json) are
what to paint. A spot painted at 512 has more texels than in the 1024 view, at a twentieth of a Codex call's time.

    python3 tools/paint_capture.py CAPTURE_DIR [--size 512] [--steps 16] [--seed N] [--comfy http://127.0.0.1:8188]

Progress lines for the job: "@@PROGRESS {json}". ComfyUI must be running with Qwen Image 2.1 (its models as named in
tools/comfy/qwen_edit.json: qwen_image_2.1_int8_convrot, qwen3vl_8b_int8_convrot, qwen_image_2.1_vae_bf16).
"""
import argparse
import hashlib
import io
import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SAVE, ENCODE, SAMPLER = "461", "459:474", "459:458"
PROMPT = ("Repaint only the area to fix in this unlit, hand-painted, stylized game character texture: {notes}. Match the "
          "colours, brushwork and detail of the texture around it exactly, so the repair is invisible. Keep every shape, "
          "edge and feature where it is; no new lighting, shadows, text or outlines.")
DEFAULT_NOTES = "clean up the smeared or broken paint there so it continues the texture around it"


def progress(p, message):
    print("@@PROGRESS " + json.dumps({"progress": round(p, 3), "message": message}), flush=True)


def upload(url, image, name):
    buf = io.BytesIO()
    image.save(buf, "PNG")
    data = buf.getvalue()
    fname = hashlib.sha1(data).hexdigest()[:12] + "_" + name
    b = uuid.uuid4().hex
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{fname}\"\r\nContent-Type: image/png\r\n\r\n").encode() \
        + data + f"\r\n--{b}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{b}--\r\n".encode()
    req = urllib.request.Request(url + "/upload/image", body, {"Content-Type": f"multipart/form-data; boundary={b}"})
    return json.load(urllib.request.urlopen(req, timeout=60))["name"]


def paint(url, crop, mask, prompt, seed, steps, mode="edit", timeout=600):
    """Qwen's edit of `crop` (RGB) where `mask` (L) is white; the painting (RGB, crop's size). mode: "edit" (the default:
    no mask given to Qwen, the whole crop edited by the instruction, the mask applied only when it is laid back), "hard"
    (a latent noise mask), "soft" (the mask blurred, Differential Diffusion). With Qwen 2.1 both noise masks left an olive
    ring along the mask, the soft one wider (the Archer's eye, 2026-10-31); the edit is clean."""
    g = json.load(open(os.path.join(HERE, "comfy", "qwen_edit.json")))
    g.pop("472", None)
    g.pop("13", None)
    g["470"]["inputs"]["image"] = upload(url, crop, "crop.png")
    g[ENCODE]["inputs"]["prompt"] = prompt
    g["459:456"]["inputs"]["width"], g["459:456"]["inputs"]["height"] = crop.size
    g["459:468"]["inputs"]["switch"] = False  # (the view's own latent: an edit, not a fresh canvas)
    if mode != "edit":
        if mode == "soft":
            mask = mask.filter(ImageFilter.GaussianBlur(mask.size[0] / 40))
            g["dd"] = {"class_type": "DifferentialDiffusion", "inputs": {"model": g[SAMPLER]["inputs"]["model"]}}
            g[SAMPLER]["inputs"]["model"] = ["dd", 0]
        g["mimg"] = {"class_type": "LoadImage", "inputs": {"image": upload(url, mask.convert("RGB"), "mask.png")}}
        g["mask"] = {"class_type": "ImageToMask", "inputs": {"image": ["mimg", 0], "channel": "red"}}
        g["noise"] = {"class_type": "SetLatentNoiseMask", "inputs": {"samples": ["459:468", 0], "mask": ["mask", 0]}}
        g[SAMPLER]["inputs"]["latent_image"] = ["noise", 0]
    g[SAMPLER]["inputs"]["seed"] = seed
    g[SAMPLER]["inputs"]["steps"] = steps
    g[SAVE]["inputs"]["filename_prefix"] = "rigsmith/paint"
    req = urllib.request.Request(url + "/prompt", json.dumps({"prompt": g, "client_id": "rigsmith"}).encode(),
                                 {"Content-Type": "application/json"})
    try:
        pid = json.load(urllib.request.urlopen(req, timeout=60))["prompt_id"]
    except urllib.error.HTTPError as e:
        raise SystemExit("ComfyUI refused the graph: " + e.read().decode()[:1500])
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = json.load(urllib.request.urlopen(f"{url}/history/{pid}", timeout=60)).get(pid)
        if h:
            if h.get("status", {}).get("status_str") == "error":
                raise SystemExit("ComfyUI error: " + json.dumps(h["status"].get("messages"))[:1500])
            imgs = h["outputs"].get(SAVE, {}).get("images", [])
            if imgs:
                q = urllib.parse.urlencode({k: imgs[0][k] for k in ("filename", "subfolder", "type")})
                return Image.open(io.BytesIO(urllib.request.urlopen(f"{url}/view?{q}", timeout=60).read())).convert("RGB")
        time.sleep(0.5)
    raise SystemExit("ComfyUI timed out")


def box_of(mask, w, h):
    """The mask's box with a quarter round it, square, at least 128 px, inside the view."""
    ys, xs = np.nonzero(mask > 127)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    side = max(128, int(max(x1 - x0, y1 - y0) * 1.5))
    side = min(side, w, h)
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    left = int(np.clip(cx - side // 2, 0, w - side))
    top = int(np.clip(cy - side // 2, 0, h - side))
    return left, top, left + side, top + side


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("capture")
    ap.add_argument("--size", type=int, default=512, help="the crop is painted at this size (Qwen works near 1 MP: under ~384 it smears)")
    ap.add_argument("--steps", type=int, default=16)
    ap.add_argument("--seed", type=int)
    ap.add_argument("--mode", default="edit", choices=("soft", "hard", "edit"), help="how the mask reaches Qwen (paint())")
    ap.add_argument("--comfy", default=os.environ.get("COMFY_URL", "http://127.0.0.1:8188"))
    a = ap.parse_args()
    views = json.load(open(os.path.join(a.capture, "views.json")))
    notes = (views.get("notes") or "").strip()
    if not notes and os.path.exists(os.path.join(a.capture, "prompt.md")):  # (an older capture: its notes only in the prompt)
        for line in open(os.path.join(a.capture, "prompt.md")):
            if line.startswith("What it should look like:"):
                notes = line.split(":", 1)[1].strip()
    notes = notes or DEFAULT_NOTES
    prompt = PROMPT.format(notes=notes)
    seed = a.seed if a.seed is not None else random.randrange(2 ** 48)
    n = len(views["views"])
    t0 = time.time()
    for i in range(n):
        k = i + 1
        progress(0.05 + 0.9 * i / n, f"Qwen is painting view {k} of {n}")
        flat = Image.open(os.path.join(a.capture, f"view-{k}-flat.png")).convert("RGBA")
        m = np.asarray(Image.open(os.path.join(a.capture, f"view-{k}-mask.png")).convert("L"))
        out = flat.copy()
        if (m > 127).any():
            box = box_of(m, *flat.size)
            side = box[2] - box[0]
            crop = flat.crop(box)
            rgb = Image.new("RGB", crop.size, (128, 128, 128))
            rgb.paste(crop, mask=crop.getchannel("A"))
            mcrop = Image.fromarray(m).crop(box)
            # (a little wider for the noise: the new paint meets the old a few pixels outside the mask, not on its edge)
            noise = mcrop.filter(ImageFilter.MaxFilter(5)).resize((a.size, a.size), Image.BILINEAR)
            painted = paint(a.comfy, rgb.resize((a.size, a.size), Image.LANCZOS), noise, prompt, seed + i, a.steps, a.mode)
            painted = painted.resize((side, side), Image.LANCZOS)
            feather = mcrop.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(2))
            alpha = np.asarray(feather, np.float32)[..., None] / 255
            base = np.asarray(crop, np.float32)
            mixed = base.copy()
            mixed[..., :3] = base[..., :3] * (1 - alpha) + np.asarray(painted, np.float32) * alpha
            out.paste(Image.fromarray(mixed.round().astype(np.uint8), "RGBA"), box[:2])
        out.save(os.path.join(a.capture, f"result-{k}.png"))
        with open(os.path.join(a.capture, f"result-{k}-prompt.txt"), "w") as f:
            f.write(f"Qwen Image 2.1 (ComfyUI), tools/paint_capture.py: crop painted at {a.size} px, {a.steps} steps, seed {seed + i}, "
                    f"mask {a.mode}\n\n{prompt}\n")
    progress(1.0, f"Qwen painted {n} view{'s' if n != 1 else ''} in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
