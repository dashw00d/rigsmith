# Pictures of a unit's clips as the game file has them (a game export, tools/game_export.ts): one sheet per clip, its
# frames across, its views down; orthographic, so a weapon's line or a foot's contact reads true. A rider and his horse
# are one file, one picture. The ground is a grey floor at the soles' height (0).
#
#   blender -b --factory-startup -P tools/render.py -- UNIT.glb OUT_DIR [--clips Idle,Walk] [--at 0,0.25,0.5,0.75]
#       [--views right,front] [--size 320] [--hide REGEX]
#
# Views: front, back, left, right (the side his right hand is on), level with the ground; three (front-right, from
# above), top. Colours:
# the body grey, weapons and tools orange, a horse brown, its gear tan. Writes OUT_DIR/<clip>.png and prints each.
import argparse
import math
import os
import re
import sys

import bpy
import numpy as np
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument('glb')
ap.add_argument('out')
ap.add_argument('--clips', default='')
ap.add_argument('--at', default='0,0.25,0.5,0.75')
ap.add_argument('--views', default='right,front')
ap.add_argument('--size', type=int, default=320)
ap.add_argument('--hide', default='')
a = ap.parse_args(argv)
os.makedirs(a.out, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=a.glb)
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
hide = re.compile(a.hide) if a.hide else None
meshes = []
for o in bpy.data.objects:
    if o.type != 'MESH':
        continue
    # (every part of a unit rides the armature: a mesh it doesn't drive is the importer's own, a bone's display shape)
    if re.search(r'_LOD\d', o.name) or (hide is not None and hide.search(o.name)) or not any(m.type == 'ARMATURE' for m in o.modifiers):
        o.hide_render = True
        o.hide_set(True)
        continue
    meshes.append(o)
    n = o.name
    # (a companion's body is named for its surface, raider_horse, caravan_pony; its gear Horse_<piece>)
    o.color = ((0.85, 0.72, 0.45, 1) if re.match(r'(Horse|Pony)_', n) else
               (0.55, 0.36, 0.22, 1) if re.search(r'horse|pony', n, re.I) else
               (0.95, 0.55, 0.2, 1) if re.match(r'(Weapons|Gear|Prop)', n) else (0.76, 0.76, 0.79, 1))

sc = bpy.context.scene
sc.render.engine = 'BLENDER_WORKBENCH'
sc.display.shading.light = 'STUDIO'
sc.display.shading.color_type = 'OBJECT'
sc.display.shading.show_object_outline = True
sc.render.resolution_x = sc.render.resolution_y = a.size
sc.render.film_transparent = False
world = bpy.data.worlds.new('w')
sc.world = world
world.color = (0.02, 0.022, 0.03)
sc.view_settings.view_transform = 'Standard'
# (a slab whose top is the ground: seen level, a band under the feet)
floor = bpy.data.objects.new('floor', bpy.data.meshes.new('floor'))
s, t = 50, 0.04
floor.data.from_pydata([(x, y, z) for z in (-t, 0) for x, y in ((-s, -s), (s, -s), (s, s), (-s, s))], [],
                       [(0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)])
floor.color = (0.36, 0.37, 0.4, 1)
sc.collection.objects.link(floor)
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
cam.data.type = 'ORTHO'
sc.collection.objects.link(cam)
sc.camera = cam

actions = {act.name: act for act in bpy.data.actions}
wanted = [c for c in a.clips.split(',') if c] or sorted(actions)
arm.animation_data_create()
for t in arm.animation_data.nla_tracks:
    t.mute = True
at = [float(x) for x in a.at.split(',')]
# where the camera stands: the unit faces -Y in Blender (+Z in glTF), his right hand is on -X
VIEWS = {'front': (0, -1, 0), 'back': (0, 1, 0), 'right': (-1, 0, 0), 'left': (1, 0, 0), 'three': (-0.7, -1, 0.45), 'top': (0, -0.01, 1)}


def bounds():
    lo = Vector((1e9, 1e9, 1e9))
    hi = -lo
    dg = bpy.context.evaluated_depsgraph_get()
    for o in meshes:
        ev = o.evaluated_get(dg)
        m = ev.to_mesh()
        co = np.empty(len(m.vertices) * 3, dtype=np.float32)
        m.vertices.foreach_get('co', co)
        ev.to_mesh_clear()
        if len(co) == 0:
            continue
        mw = np.array(o.matrix_world)
        p = co.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3]
        lo = Vector(map(min, lo, p.min(axis=0)))
        hi = Vector(map(max, hi, p.max(axis=0)))
    return lo, hi


for name in wanted:
    act = actions.get(name) or next((x for n, x in actions.items() if n.startswith(name)), None)
    if act is None:
        print('NO CLIP', name)
        continue
    arm.animation_data.action = act
    if hasattr(arm.animation_data, 'action_slot') and len(getattr(act, 'slots', [])) > 0:
        arm.animation_data.action_slot = act.slots[0]
    f0, f1 = act.frame_range
    frames = [f0 + (f1 - f0) * u for u in at]
    # one frame for the whole clip: everything it reaches, so the sheet's pictures line up
    lo = Vector((1e9, 1e9, 1e9))
    hi = -lo
    for f in frames:
        sc.frame_set(int(f), subframe=f - int(f))
        l, h = bounds()
        lo = Vector(map(min, lo, l))
        hi = Vector(map(max, hi, h))
    lo.z = min(lo.z, -0.04)
    centre = (lo + hi) / 2
    extent = max(hi - lo)
    tiles = []
    for view in a.views.split(','):
        # (where the camera stands, from the middle of the clip: it looks back at it)
        d = Vector(VIEWS[view]).normalized()
        rot = (-d).to_track_quat('-Z', 'Y')
        # framed on what the clip reaches as this view sees it (the box's corners across and up the picture)
        right, up = rot @ Vector((1, 0, 0)), rot @ Vector((0, 1, 0))
        corners = [Vector((x, y, z)) for x in (lo.x, hi.x) for y in (lo.y, hi.y) for z in (lo.z, hi.z)]
        xs, ys = [c.dot(right) for c in corners], [c.dot(up) for c in corners]
        mid = centre + right * ((max(xs) + min(xs)) / 2 - centre.dot(right)) + up * ((max(ys) + min(ys)) / 2 - centre.dot(up))
        cam.location = mid + d * (extent * 4)
        cam.rotation_euler = rot.to_euler()
        cam.data.ortho_scale = max(max(xs) - min(xs), max(ys) - min(ys)) * 1.1
        cam.data.clip_end = 1000
        row = []
        for k, f in enumerate(frames):
            sc.frame_set(int(f), subframe=f - int(f))
            path = os.path.join(a.out, f'.{name}_{view}_{k}.png')
            sc.render.filepath = path
            bpy.ops.render.render(write_still=True)
            img = bpy.data.images.load(path)
            px = np.array(img.pixels[:], dtype=np.float32).reshape(img.size[1], img.size[0], 4)
            bpy.data.images.remove(img)
            os.remove(path)
            # a thin bar between frames
            px[:, -2:, :3] = 0.05
            row.append(px)
        tiles.append(np.concatenate(row, axis=1))
        tiles[-1][:2, :, :3] = 0.05
    # (Blender's pixels run bottom row first: the first view goes on top)
    sheet = np.concatenate(tiles[::-1], axis=0)
    h, w = sheet.shape[:2]
    out = bpy.data.images.new(name, w, h)
    out.pixels = sheet.ravel()
    out.filepath_raw = os.path.join(a.out, f'{name}.png')
    out.file_format = 'PNG'
    out.save()
    print('SHEET', name, out.filepath_raw, f'{f1 - f0:.0f} frames, at', ','.join(f'{u:g}' for u in at), 'views', a.views)
