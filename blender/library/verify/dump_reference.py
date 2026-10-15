"""Dump reference world joint positions from the ORIGINAL FBX files (Blender).

  blender -b --factory-startup --python dump_reference.py -- OUT.json SPEC.json

SPEC.json: [{"id": "...", "path": "/abs/src.fbx", "frames": 8}, ...]
For every clip, picks `frames` frames (first, last and evenly spaced/random in between),
evaluates the original FBX in Blender and writes, per frame, the world-space head of every
canonical bone converted from Blender world (Z-up, -Y forward, meters after the importer's
object scale) to glTF canonical (Y-up, +Z forward): (x, y, z) -> (x, z, -y).
Deliberately independent of convert.py: uses Blender's own object/bone world transforms.
"""
import json
import random
import re
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
out_path, spec_path = argv[0], argv[1]
spec = json.load(open(spec_path))
PREFIX = re.compile(r"^mixamorig\d*[:_]")


def to_gl(v):
    return [v[0], v[2], -v[1]]


result = {}
for item in spec:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=item["path"])
    arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    sc = bpy.context.scene
    fps = sc.render.fps / sc.render.fps_base
    rest = {PREFIX.sub("", b.name): to_gl(arm.matrix_world @ b.head_local) for b in arm.data.bones}
    entry = {"path": item["path"], "fps": fps, "rest": rest, "frames": []}
    if arm.animation_data and arm.animation_data.action:
        r = arm.animation_data.action.frame_range
        f0, f1 = int(round(r[0])), int(round(r[1]))
        n = item.get("frames", 8)
        rng = random.Random(item["id"])
        frames = sorted(set([f0, f1] + [round(f0 + (f1 - f0) * k / (n - 1)) for k in range(n)] +
                            [rng.randint(f0, f1) for _ in range(3)]))
        for f in frames:
            sc.frame_set(f)
            mw = arm.matrix_world
            pos = {PREFIX.sub("", pb.name): to_gl(mw @ pb.head) for pb in arm.pose.bones}
            entry["frames"].append({"frame": f, "time": (f - f0) / fps, "joints": pos})
    result[item["id"]] = entry
json.dump(result, open(out_path, "w"))
print("wrote", out_path, len(result))
