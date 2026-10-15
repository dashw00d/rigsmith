"""Bake a textured source's colour onto a retopologized, UV-unwrapped target and write it as a GLB.

blender -b --factory-startup --python bake.py -- --source model.glb --target retopo.obj --output out.glb
    [--size 2048] [--samples 8] [--cage 0.015] [--max-ray 0.04] [--overrides textures/]

Colour only (no lighting), selected-to-active through a cage, Cycles on the GPU when one is free (CPU
otherwise). Cage and ray distances are in metres. The colour goes through an emission bake: Blender 5's
DIFFUSE colour bake comes back black, EMIT reproduces the base colour exactly in every version.
"""
import argparse
import os
import sys
import tempfile
import time

import bpy

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from common import report, scene_io  # noqa: E402


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument('--source', required=True)
    p.add_argument('--target', required=True)
    p.add_argument('--output', required=True)
    p.add_argument('--size', type=int, default=2048)
    p.add_argument('--samples', type=int, default=8)
    p.add_argument('--cage', type=float, default=0.015)
    p.add_argument('--max-ray', type=float, default=0.04)
    p.add_argument('--overrides')
    return p.parse_args(argv)


def use_gpu():
    """Cycles on the GPU if there is one (OptiX, then CUDA); returns the device name used."""
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        for kind in ('OPTIX', 'CUDA', 'HIP', 'ONEAPI'):
            try:
                prefs.compute_device_type = kind
            except TypeError:
                continue
            prefs.get_devices()
            gpus = [d for d in prefs.devices if d.type == kind]
            if gpus:
                for d in prefs.devices:
                    d.use = d.type == kind
                bpy.context.scene.cycles.device = 'GPU'
                return kind
    except Exception as error:  # noqa: BLE001 - any failure means CPU
        print('GPU unavailable:', error)
    bpy.context.scene.cycles.device = 'CPU'
    return 'CPU'


def emit_base_color(objects):
    """Rewire each material so its base colour is emitted (what an EMIT bake records)."""
    for material in {m for ob in objects for m in ob.data.materials if m is not None}:
        material.use_nodes = True
        tree = material.node_tree
        output = next((n for n in tree.nodes if n.type == 'OUTPUT_MATERIAL'), None) or tree.nodes.new('ShaderNodeOutputMaterial')
        bsdf = next((n for n in tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        emission = tree.nodes.new('ShaderNodeEmission')
        if bsdf is not None and bsdf.inputs['Base Color'].is_linked:
            tree.links.new(bsdf.inputs['Base Color'].links[0].from_socket, emission.inputs['Color'])
        elif bsdf is not None:
            emission.inputs['Color'].default_value = bsdf.inputs['Base Color'].default_value
        else:
            emission.inputs['Color'].default_value = tuple(material.diffuse_color)
        tree.links.new(emission.outputs['Emission'], output.inputs['Surface'])


def main():
    a = parse_args()
    started = time.time()
    scene_io.reset()
    report.progress(0.05, 'Loading the source')
    sources = scene_io.import_any(a.source, a.overrides)
    emit_base_color(sources)
    for ob in bpy.data.objects:
        if ob.type == 'ARMATURE':
            ob.data.pose_position = 'REST'
    before = set(bpy.data.objects)
    bpy.ops.wm.obj_import(filepath=a.target)
    target = next(o for o in bpy.data.objects if o not in before and o.type == 'MESH')
    target.name = 'retopo'
    # xatlas splits vertices along UV seams; weld them (UVs live on face corners, so seams survive)
    # so normals are smooth across chart borders instead of faceted per chart.
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(target.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    for face in bm.faces:
        face.smooth = True
    bm.to_mesh(target.data)
    bm.free()

    image = bpy.data.images.new('baked', a.size, a.size, alpha=False)
    material = bpy.data.materials.new('baked')
    material.use_nodes = True
    nodes = material.node_tree.nodes
    bsdf = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = image
    nodes.active = tex
    material.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.8
    target.data.materials.clear()
    target.data.materials.append(material)

    scene = bpy.context.scene
    try:
        scene.render.engine = 'CYCLES'
    except TypeError:
        scene.render.engine = 'CYCLES'
    device = use_gpu()
    scene.cycles.samples = a.samples
    bake = scene.render.bake
    bake.use_selected_to_active = True
    bake.cage_extrusion = a.cage
    bake.max_ray_distance = a.max_ray
    bake.margin = max(4, a.size // 128)

    bpy.ops.object.select_all(action='DESELECT')
    for ob in sources:
        ob.select_set(True)
    target.select_set(True)
    bpy.context.view_layer.objects.active = target
    report.progress(0.3, f'Baking on the {device}')
    t = time.time()
    try:
        bpy.ops.object.bake(type='EMIT')
    except RuntimeError:
        if device == 'CPU':
            raise
        # A busy or out-of-memory GPU: same bake on the CPU.
        scene.cycles.device = 'CPU'
        device = 'CPU'
        bpy.ops.object.bake(type='EMIT')
    bake_seconds = time.time() - t

    # Embed the texture: save it next to the output, reload, pack.
    png = os.path.join(tempfile.mkdtemp(prefix='rigsmith-bake-'), 'baked.png')
    image.filepath_raw = png
    image.file_format = 'PNG'
    image.save()
    image.reload()
    image.pack()

    report.progress(0.9, 'Writing the GLB')
    for ob in sources:
        bpy.data.objects.remove(ob, do_unlink=True)
    for ob in [o for o in bpy.data.objects if o.type == 'ARMATURE']:
        bpy.data.objects.remove(ob, do_unlink=True)
    scene_io.export_glb(a.output, None, [target])
    report.result({'device': device, 'size': a.size, 'bake_seconds': round(bake_seconds, 2),
                   'seconds': round(time.time() - started, 2), 'vertices': len(target.data.vertices),
                   'triangles': sum(len(p.vertices) - 2 for p in target.data.polygons)})


if __name__ == '__main__':
    main()
