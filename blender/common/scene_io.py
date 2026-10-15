"""Import/export helpers shared by Blender jobs."""
import os
import shutil
import tempfile
import zipfile

import bpy
import numpy as np

MODEL_EXTENSIONS = ('.fbx', '.glb', '.gltf', '.obj', '.dae')


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def _safe_extract(archive, target):
    """Extract a zip without letting entries escape `target` (absolute paths, '..')."""
    root = os.path.realpath(target)
    with zipfile.ZipFile(archive) as zf:
        for info in zf.infolist():
            dest = os.path.realpath(os.path.join(root, info.filename))
            if not dest.startswith(root + os.sep) and dest != root:
                raise ValueError(f'Unsafe path in zip: {info.filename}')
            if info.is_dir():
                os.makedirs(dest, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with zf.open(info) as src, open(dest, 'wb') as out:
                shutil.copyfileobj(src, out)


def resolve_model_file(path):
    """A model file path; zips are extracted to a temp dir and the first model inside is returned."""
    if not path.lower().endswith('.zip'):
        return path
    target = tempfile.mkdtemp(prefix='rigtool-')
    _safe_extract(path, target)
    found = []
    for base, _, files in os.walk(target):
        for name in files:
            if name.lower().endswith(MODEL_EXTENSIONS):
                found.append(os.path.join(base, name))
    if not found:
        raise ValueError('No model file inside ' + path)
    found.sort(key=lambda f: (MODEL_EXTENSIONS.index(os.path.splitext(f)[1].lower()), len(f)))
    return found[0]


def apply_texture_overrides(meshes, directory):
    """Swap material images for edited versions (<directory>/<clean image name>.png), e.g. filled holes."""
    if not directory or not os.path.isdir(directory):
        return 0
    swapped = 0
    for ob in meshes:
        for slot in ob.material_slots:
            m = slot.material
            if m is None or not m.use_nodes:
                continue
            for node in m.node_tree.nodes:
                if node.type != 'TEX_IMAGE' or node.image is None:
                    continue
                original = node.image.name
                candidate = os.path.join(directory, bpy.path.clean_name(original) + '.png')
                if os.path.exists(candidate) and node.image.filepath != candidate:
                    image = bpy.data.images.load(candidate, check_existing=True)
                    # Keep the original name so later edits (and the GLB) keep pointing at the same image.
                    node.image.name = original + '.replaced'
                    image.name = original
                    node.image = image
                    swapped += 1
    return swapped


def import_any(path, overrides=None):
    """Import a model file; returns the mesh objects that were added."""
    model = resolve_model_file(path)
    before = set(bpy.data.objects)
    ext = os.path.splitext(model)[1].lower()
    if ext == '.fbx':
        bpy.ops.import_scene.fbx(filepath=model, automatic_bone_orientation=False, ignore_leaf_bones=False)
    elif ext in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=model)
    elif ext == '.obj':
        bpy.ops.wm.obj_import(filepath=model)
    elif ext == '.dae':
        bpy.ops.wm.collada_import(filepath=model)
    else:
        raise ValueError('Unsupported model type: ' + ext)
    added = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in added if o.type == 'MESH']
    clean_materials(meshes)
    apply_texture_overrides(meshes, overrides)
    return meshes


def clean_materials(meshes):
    """Opaque, game-ready materials: Tripo and many FBX exporters wire the texture's alpha into the
    material, which turns whole characters see-through. Also reset the inflated FBX specular."""
    seen = set()
    for ob in meshes:
        for slot in ob.material_slots:
            m = slot.material
            if m is None or m.name in seen or not m.use_nodes:
                continue
            seen.add(m.name)
            tree = m.node_tree
            bsdf = next((n for n in tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            if bsdf is None:
                continue
            alpha = bsdf.inputs['Alpha']
            for link in list(alpha.links):
                tree.links.remove(link)
            alpha.default_value = 1.0
            specular = bsdf.inputs.get('Specular IOR Level')
            if specular is not None and not specular.is_linked:
                specular.default_value = 0.5
            for node in [n for n in tree.nodes if n.type == 'TEX_IMAGE' and not any(o.links for o in n.outputs)]:
                tree.nodes.remove(node)
            if hasattr(m, 'surface_render_method'):
                m.surface_render_method = 'DITHERED'


def strip_existing_rigs(meshes):
    """Detach meshes from any imported armature, bake world transforms into vertices, drop old weights."""
    for ob in meshes:
        for mod in [m for m in ob.modifiers if m.type == 'ARMATURE']:
            ob.modifiers.remove(mod)
        world = ob.matrix_world.copy()
        ob.parent = None
        ob.matrix_world = world
        ob.vertex_groups.clear()
    for ob in [o for o in bpy.data.objects if o.type in ('ARMATURE', 'EMPTY')]:
        bpy.data.objects.remove(ob, do_unlink=True)
    for ob in meshes:
        ob.data.transform(ob.matrix_world)
        ob.matrix_world.identity()


def mesh_arrays(meshes):
    """World-space vertices and triangles of all meshes, concatenated in order."""
    verts, tris, offset = [], [], 0
    for ob in meshes:
        me = ob.data
        co = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get('co', co)
        co = co.reshape(-1, 3)
        mw = np.array(ob.matrix_world)
        co = co @ mw[:3, :3].T + mw[:3, 3]
        me.calc_loop_triangles()
        tri = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
        me.loop_triangles.foreach_get('vertices', tri)
        verts.append(co)
        tris.append(tri.reshape(-1, 3) + offset)
        offset += len(co)
    return np.concatenate(verts), np.concatenate(tris)


def apply_rig_scale(armature, meshes):
    """Bake object transforms (e.g. Mixamo's 0.01 armature scale) into bones and vertices."""
    bpy.ops.object.select_all(action='DESELECT')
    armature.select_set(True)
    for ob in meshes:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def export_glb(path, armature, meshes, animations=False):
    bpy.ops.object.select_all(action='DESELECT')
    if armature is not None:
        armature.select_set(True)
    for ob in meshes:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = armature if armature is not None else meshes[0]
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_yup=True,
        export_skins=True,
        export_animations=animations,
        export_materials='EXPORT',
    )
