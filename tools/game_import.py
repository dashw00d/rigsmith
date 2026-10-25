"""Bring a game unit back into Rigsmith from its last build: its clips, scripts and gear, as the game has them.

    python3 tools/game_import.py <game repo> [unit ...] [--replace] [--dry-run]

Rigsmith is where a unit's clips and gear are chosen (tools/game_export.ts builds the game's units from it); this is the
way back, for a character that lacks them (a new workspace, a part rebuilt in the game's Blender pipeline). From the
game's spec (<game>/tools/rigsmith/units.json), its built units (<game>/assets/models/units/<unit>.glb) and their
build records (<game>/assets/textures/models/<unit>/<unit>.json, sources.rigsmith):

  animations  the clips the unit was built with, under the game's names (clip, loop, in place, speed)
  scripts     the clip scripts it was built with (src/engine/scripts.ts)
  garments    every part the built unit carries besides its body (Weapons_<bone>, the villager's Gear* and spare Head*,
              his job wear from <game>/assets/models/kits/<unit>_wear.glb), LOD0, moved from game space back into the
              character's (the export's scale and floor undone, then the placement it was built with: exact), a rigid
              garment on its bone, its surfaces keeping the game's material names with the colour maps the game draws
              them with. Pieces the game swaps by job (Gear*, Head*, Wear*) come in hidden, except the forager's look.

Each part's own origin is where it is held (UnitView.GearHold's rule: a hand item on its handle's line nearest the
hand's joint, anything else the point of its box nearest the joint it rides), so the viewer's gizmo sits there and
turning or sizing it keeps it in the fist. --repivot moves the origin of the parts a character already has there,
leaving each exactly where it is (its position takes up the shift).

By default nothing you made is touched: a garment it brought before (from "emberhold:...") stays as it is, only the
parts the character lacks come in, and clips and scripts are only filled in where the character has none. --replace puts the character back as the game's last build has it (its clips, scripts, gear and placements;
garments and props it didn't bring go). A build from before Rigsmith held the clips reads them from the spec's old
clip table. Each character.json is backed up first (workspace/backups/game-import/<time>/). Writes through the running
app's API when it is up (RIGSMITH_URL, default http://127.0.0.1:5180); reload an open page afterwards.
"""
import argparse
import io
import json
import os
import re
import secrets
import shutil
import struct
import sys
import time
import urllib.error
import urllib.request

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKSPACE = os.environ.get('RIGSMITH_WORKSPACE', os.path.join(ROOT, 'workspace'))
CHARACTERS = os.path.join(WORKSPACE, 'characters')
LIBRARY = os.path.join(WORKSPACE, 'library')
OLD_MANIFEST = os.path.join(LIBRARY, 'backups', 'before-named-catalog', 'manifest.json')
API = os.environ.get('RIGSMITH_URL', 'http://127.0.0.1:5180')
TRIM_SIZE = 1024        # the shared trim sheets (2048) embedded at this size, as JPEG: a hat needs no more
ROUGHNESS = 0.82        # the game's matte (emb_rigsmith.ROUGHNESS)
SWAPPED = ('Gear', 'Head', 'Wear')   # parts the game shows by job or look

# --- glTF in ---------------------------------------------------------------------------------------------------------

CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


class Glb:
    def __init__(self, path):
        b = open(path, 'rb').read()
        n = struct.unpack('<I', b[12:16])[0]
        self.j = json.loads(b[20:20 + n])
        off = 20 + n
        self.bin = b[off + 8: off + 8 + struct.unpack('<I', b[off:off + 4])[0]] if off < len(b) else b''

    def acc(self, i):
        a = self.j['accessors'][i]
        bv = self.j['bufferViews'][a['bufferView']]
        dt = np.dtype(CT[a['componentType']])
        nc = NC[a['type']]
        start = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        stride = bv.get('byteStride', 0) or dt.itemsize * nc
        rows = np.frombuffer(self.bin, dtype=np.uint8, count=stride * (a['count'] - 1) + dt.itemsize * nc, offset=start)
        rows = np.lib.stride_tricks.as_strided(rows, (a['count'], dt.itemsize * nc), (stride, 1))
        out = np.ascontiguousarray(rows).view(dt).reshape(a['count'], nc)
        if a.get('normalized'):
            out = out.astype(np.float64) / np.iinfo(dt).max
        return out.reshape(a['count'], 4, 4).transpose(0, 2, 1) if nc == 16 else out

    def worlds(self):
        nodes = self.j['nodes']
        parent = {c: i for i, nd in enumerate(nodes) for c in nd.get('children', [])}
        out = {}

        def local(nd):
            if 'matrix' in nd:
                return np.array(nd['matrix'], dtype=float).reshape(4, 4).T
            x, y, z, w = nd.get('rotation', [0, 0, 0, 1])
            m = np.eye(4)
            m[:3, :3] = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                                  [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                                  [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]) * np.array(nd.get('scale', [1, 1, 1]))
            m[:3, 3] = nd.get('translation', [0, 0, 0])
            return m

        def world(i):
            if i not in out:
                out[i] = (world(parent[i]) if i in parent else np.eye(4)) @ local(nodes[i])
            return out[i]
        for i in range(len(nodes)):
            world(i)
        return out

    def parts(self):
        """Each mesh node at LOD0: name, world matrix, primitives [(positions, normals, uvs, indices, material name)],
        and the joint carrying most of its weight (None for an unskinned mesh)."""
        W = self.worlds()
        for i, nd in enumerate(self.j['nodes']):
            if 'mesh' not in nd or re.search(r'_LOD\d+$', nd['name']):
                continue
            prims, weight = [], {}
            joints = [self.j['nodes'][k]['name'] for k in self.j['skins'][nd['skin']]['joints']] if 'skin' in nd else []
            for p in self.j['meshes'][nd['mesh']]['primitives']:
                at = p['attributes']
                idx = self.acc(p['indices']).reshape(-1) if 'indices' in p else np.arange(self.j['accessors'][at['POSITION']]['count'])
                mat = self.j['materials'][p['material']]['name'] if 'material' in p else ''
                prims.append((self.acc(at['POSITION']).astype(np.float64), self.acc(at['NORMAL']).astype(np.float64),
                              self.acc(at['TEXCOORD_0']).astype(np.float64), idx.astype(np.uint32), mat))
                if joints and 'JOINTS_0' in at:
                    for jn, wt in zip(self.acc(at['JOINTS_0']).reshape(-1), self.acc(at['WEIGHTS_0']).reshape(-1)):
                        if wt > 0:
                            weight[joints[jn]] = weight.get(joints[jn], 0.0) + float(wt)
            bone = max(weight, key=weight.get) if weight else None
            yield nd['name'], W[i], prims, bone, (weight[bone] / sum(weight.values()) if bone else 1.0)

    def joint_rest(self):
        """Each skin joint's rest position (from the inverse binds; the meshes sit at the origin)."""
        out = {}
        for s in self.j.get('skins', []):
            ibm = self.acc(s['inverseBindMatrices'])
            for k, m in zip(s['joints'], ibm):
                out.setdefault(self.j['nodes'][k]['name'], np.linalg.inv(m)[:3, 3])
        return out

# --- glTF out --------------------------------------------------------------------------------------------------------


def write_glb(path, name, prims):
    """One mesh node `name` at the origin; prims [(positions, normals, uvs, indices, (image bytes, mime), material)]."""
    j = {'asset': {'version': '2.0', 'generator': 'rigsmith tools/game_import.py'}, 'scene': 0, 'scenes': [{'nodes': [0]}],
         'nodes': [{'name': name, 'mesh': 0}], 'meshes': [{'name': name, 'primitives': []}], 'materials': [], 'textures': [],
         'images': [], 'samplers': [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}],
         'accessors': [], 'bufferViews': [], 'buffers': []}
    blob = bytearray()

    def view(data, target=None):
        while len(blob) % 4:
            blob.append(0)
        v = {'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(data)}
        if target:
            v['target'] = target
        blob.extend(data)
        j['bufferViews'].append(v)
        return len(j['bufferViews']) - 1

    def accessor(arr, kind, ctype, target, bounds=False):
        a = {'bufferView': view(arr.tobytes(), target), 'componentType': ctype, 'count': int(len(arr)), 'type': kind}
        if bounds:
            a['min'] = [float(x) for x in arr.min(0)]
            a['max'] = [float(x) for x in arr.max(0)]
        j['accessors'].append(a)
        return len(j['accessors']) - 1
    images = {}
    materials = {}
    for pos, nrm, uv, idx, (img, mime), material in prims:
        if id(img) not in images:
            j['images'].append({'bufferView': view(img), 'mimeType': mime})
            j['textures'].append({'sampler': 0, 'source': len(j['images']) - 1})
            images[id(img)] = len(j['textures']) - 1
        key = (material, images[id(img)])
        if key not in materials:
            # (the game binds a surface's maps by this name: Main, Atlas_<set>, Trim_<sheet>)
            j['materials'].append({'name': material, 'pbrMetallicRoughness': {
                'baseColorTexture': {'index': images[id(img)]}, 'metallicFactor': 0.0, 'roughnessFactor': ROUGHNESS}})
            materials[key] = len(j['materials']) - 1
        j['meshes'][0]['primitives'].append({'attributes': {
            'POSITION': accessor(pos.astype(np.float32), 'VEC3', 5126, 34962, True),
            'NORMAL': accessor(nrm.astype(np.float32), 'VEC3', 5126, 34962),
            'TEXCOORD_0': accessor(uv.astype(np.float32), 'VEC2', 5126, 34962)},
            'indices': accessor(idx.astype(np.uint32), 'SCALAR', 5125, 34963), 'material': materials[key]})
    while len(blob) % 4:
        blob.append(0)
    j['buffers'].append({'byteLength': len(blob)})
    js = json.dumps(j, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob)) + struct.pack('<II', len(js), 0x4E4F534A) + js \
        + struct.pack('<II', len(blob), 0x004E4942) + bytes(blob)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(out)

def shifted_glb(data, offset):
    """A GLB's bytes with every POSITION moved by -offset (its bounds too), all else as it was."""
    n = struct.unpack('<I', data[12:16])[0]
    j = json.loads(data[20:20 + n])
    off = 20 + n
    blen = struct.unpack('<I', data[off:off + 4])[0]
    binary = bytearray(data[off + 8: off + 8 + blen])
    done = set()
    for mesh in j['meshes']:
        for prim in mesh['primitives']:
            ai = prim['attributes']['POSITION']
            if ai in done:
                continue
            done.add(ai)
            a = j['accessors'][ai]
            bv = j['bufferViews'][a['bufferView']]
            if a['componentType'] != 5126 or bv.get('byteStride', 12) != 12:
                raise SystemExit('shifted_glb: only tight float positions')
            start = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
            pos = np.frombuffer(bytes(binary[start:start + 12 * a['count']]), dtype=np.float32).reshape(-1, 3) - np.asarray(offset, np.float32)
            binary[start:start + 12 * a['count']] = pos.astype(np.float32).tobytes()
            a['min'] = [float(x) for x in pos.min(0)]
            a['max'] = [float(x) for x in pos.max(0)]
    js = json.dumps(j, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    return struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binary)) + struct.pack('<II', len(js), 0x4E4F534A) + js \
        + struct.pack('<II', len(binary), 0x004E4942) + bytes(binary)


def garment_file(gid, data):
    """Where a garment's mesh goes: named by its content, so an open page loads the new one, not its cached old one."""
    import hashlib
    return f'garments/{gid}/model.{hashlib.sha256(data).hexdigest()[:8]}.glb'


def repivot(g, mesh_points, joints):
    """The origin shift that puts garment `g`'s pivot where it is held: (offset in its mesh's frame, its new position)."""
    R = euler_matrix(g['rotation'])
    k = float(g['scale'])
    p = np.asarray(g['position'], dtype=np.float64)
    world = p + k * mesh_points @ R.T
    hold = gear_hold(world, joints[g['bone']], g['bone'])
    local = ((hold - p) @ R) / k
    return local, [round(float(x), 6) for x in hold]


# --- the game's side -------------------------------------------------------------------------------------------------


class Game:
    def __init__(self, repo):
        self.repo = repo
        self.spec = json.load(open(os.path.join(repo, 'tools', 'rigsmith', 'units.json')))['units']
        visual = json.load(open(os.path.join(repo, 'data', 'visual.json')))
        self.gear_scale = {k: float(v) for k, v in visual.get('work_gear_scale', {}).items() if not k.startswith('//')}
        self.look_wear = self._look_wear()
        self._images = {}

    def _look_wear(self):
        """UnitView.LookWear: look -> [(wear piece, bone)] (the bone each piece rides, which looks put it on)."""
        src = open(os.path.join(self.repo, 'game', 'view', 'UnitView.cs')).read()
        block = re.search(r'LookWear = new\(\)\s*\{(.*?)\n\s*\};', src, re.S)
        if block is None:
            raise SystemExit('UnitView.cs: LookWear not found')
        out = {}
        for look, pieces in re.findall(r'\["(\w+)"\]\s*=\s*new\[\]\s*\{([^}]*)\}', block.group(1)):
            out[look] = re.findall(r'\("(\w+)",\s*"(\w+)"\)', pieces)
        return out

    def model(self, unit):
        return os.path.join(self.repo, 'assets', 'models', 'units', unit + '.glb')

    def report(self, unit):
        p = os.path.join(self.repo, 'assets', 'textures', 'models', unit, unit + '.json')
        return json.load(open(p)).get('sources', {}).get('rigsmith', {}) if os.path.exists(p) else {}

    def image(self, unit, part, material):
        """The colour map the game draws a part with: (bytes, mime)."""
        tex = os.path.join(self.repo, 'assets', 'textures')
        if material.startswith('Trim_'):
            path, small = os.path.join(tex, 'trim', material[len('Trim_'):], 'albedo.png'), True
        elif material.startswith('Atlas_'):
            path, small = os.path.join(tex, 'models', material[len('Atlas_'):], 'albedo.png'), False
        elif part.startswith('Gear'):     # (UnitView.GearSet: the villager's tools and loads draw from models/villager/gear)
            path, small = os.path.join(tex, 'models', unit, 'gear', 'albedo.png'), False
        else:
            path, small = os.path.join(tex, 'models', unit, 'albedo.png'), False
        if path not in self._images:
            if not os.path.exists(path):
                raise SystemExit(f'{unit} {part}: no colour map {path}')
            if small:
                im = Image.open(path).convert('RGB')
                im = im.resize((TRIM_SIZE, TRIM_SIZE), Image.LANCZOS) if im.width > TRIM_SIZE else im
                buf = io.BytesIO()
                im.save(buf, 'JPEG', quality=90)
                self._images[path] = (buf.getvalue(), 'image/jpeg')
            else:
                self._images[path] = (open(path, 'rb').read(), 'image/png')
        return self._images[path]

# --- the library ---------------------------------------------------------------------------------------------------


class Library:
    def __init__(self):
        self.clips = {c['id']: c for c in json.load(open(os.path.join(LIBRARY, 'manifest.json')))['clips']}
        self.by_motion = {c['motionId']: c['id'] for c in self.clips.values() if c.get('motionId')}
        self._old = None

    def named(self, clip):
        """A library clip id as the catalog names it now."""
        if clip in self.clips:
            return clip
        if not re.fullmatch(r'[0-9a-f]{12}', clip):
            raise SystemExit(f'clip {clip}: not in the library')
        if self._old is None:
            if not os.path.exists(OLD_MANIFEST):
                raise SystemExit(f'clip {clip}: an old pack id, and the old manifest is gone ({OLD_MANIFEST})')
            self._old = {c['id']: c for c in json.load(open(OLD_MANIFEST))['clips']}
        old = self._old.get(clip)
        if old is None:
            raise SystemExit(f'clip {clip}: not in the old pack either')
        # (the designer's own downloads carry no motion id; the old library matched each to its pack twin)
        motion = old.get('motionId') or self._old.get(old.get('duplicateOf') or '', {}).get('motionId')
        if motion not in self.by_motion:
            raise SystemExit(f'clip {clip} "{old["name"]}": no named clip with its motion {motion}')
        return self.by_motion[motion]

# --- Rigsmith's side -------------------------------------------------------------------------------------------------


def api(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def api_up():
    try:
        api('GET', '/api/settings')
        return True
    except (urllib.error.URLError, OSError, ValueError):
        return False


def character(cid):
    return json.load(open(os.path.join(CHARACTERS, cid, 'character.json')))


def rest_frame(cid):
    """The export's placing of this character in game space: x_game = s * (x - (0, floor, 0)). Returns (s, floor) as
    tools/game_export.ts computes them (the skinned mesh's world box), from the character's rigged file."""
    c = character(cid)
    g = Glb(os.path.join(CHARACTERS, cid, c['files'].get('rigged', 'rigged.glb')))
    W = g.worlds()
    skinned = [(i, nd) for i, nd in enumerate(g.j['nodes']) if 'skin' in nd and 'mesh' in nd]
    if len(skinned) != 1:
        raise SystemExit(f'{cid}: expected one skinned mesh, found {len(skinned)}')
    i, nd = skinned[0]
    pos = np.concatenate([g.acc(p['attributes']['POSITION']) for p in g.j['meshes'][nd['mesh']]['primitives']]).astype(np.float64)
    y = pos @ W[i][1, :3] + W[i][1, 3]
    joints = {g.j['nodes'][k]['name']: W[k][:3, 3] for k in g.j['skins'][nd['skin']]['joints']}
    return float(y.min()), float(y.max() - y.min()), joints


def gear_hold(pos, bone_at, bone):
    """Where the game grows a tool or load about (UnitView.GearHold): on a hand tool's handle line (its longest axis)
    nearest the hand's joint; for a load, the point of its box nearest the joint it rides."""
    c = pos.mean(0)
    lo, hi = pos.min(0), pos.max(0)
    if not bone.endswith('Hand'):
        return np.clip(bone_at, lo, hi)
    d = pos - c
    axis = (hi - lo) / np.linalg.norm(hi - lo)
    cov = d.T @ d
    for _ in range(32):
        n = cov @ axis
        if n @ n < 1e-12:
            break
        axis = n / np.linalg.norm(n)
    return c + axis * (axis @ (bone_at - c))


def euler_matrix(deg):
    """three.js Euler (XYZ order, degrees) as a rotation matrix."""
    x, y, z = np.radians(deg)
    rx = np.array([[1, 0, 0], [0, np.cos(x), -np.sin(x)], [0, np.sin(x), np.cos(x)]])
    ry = np.array([[np.cos(y), 0, np.sin(y)], [0, 1, 0], [-np.sin(y), 0, np.cos(y)]])
    rz = np.array([[np.cos(z), -np.sin(z), 0], [np.sin(z), np.cos(z), 0], [0, 0, 1]])
    return rx @ ry @ rz


def game_clips(lib, spec_clips, built, comp=False):
    """The clips a unit (or its companion) was built with: [entry]. From the build record; a build from before
    Rigsmith held them, from the spec's old clip table (game name -> {clip, loop, inPlace, speed, ...})."""
    out = []
    if isinstance(spec_clips, dict):
        for name, c in spec_clips.items():
            if comp:
                anim = c['clip'][len('horse:'):]
                out.append({'clipId': 'horse-' + re.sub(r'[^a-z0-9]+', '-', anim.lower()), 'url': f'/animations/horse-animations.glb#{anim}',
                            'name': name, 'inPlace': True, 'loop': name in ('Idle', 'Walk', 'Run'), 'speed': float(c.get('speed', 1))})
            else:
                speed = float(c.get('speed', 1)) * float(built.get(name, {}).get('retimed', 1))
                out.append({'clipId': lib.named(c['clip']), 'name': name, 'inPlace': c.get('inPlace') is True,
                            'loop': c.get('loop') is True, 'speed': round(speed, 3)})
        return out
    for name in spec_clips:
        b = built.get(name)
        if b is None or 'clip' not in b:
            continue
        e = {'clipId': b['clip'], 'name': name, 'inPlace': b.get('inPlace', True), 'loop': b.get('loop', False), 'speed': b.get('speed', 1)}
        if b.get('url'):
            e['url'] = b['url']
        out.append(e)
    return out


def old_scripts(spec):
    """The scripts a build from before Rigsmith held them had, from the spec's old fields (grip, attack, window, matchStride)."""
    out = []
    for side, clip in (spec.get('grip') or {}).items():
        out.append({'id': secrets.token_hex(4), 'kind': 'grip', 'enabled': True, 'side': side, 'clip': clip})
    for name, c in (spec['clips'] if isinstance(spec['clips'], dict) else {}).items():
        if c.get('attack'):
            b = {'id': secrets.token_hex(4), 'kind': 'blow', 'enabled': True, 'clip': name, 'at': c.get('hit', 0.45), 'hand': c.get('hand', 'RightHand')}
            if 'window' in c:
                b['window'] = c['window']
            out.append(b)
        if c.get('matchStride'):
            out.append({'id': secrets.token_hex(4), 'kind': 'pace', 'enabled': True, 'clip': name, 'like': c['matchStride']})
    return out


def unit_parts(game, unit, spec, cid, built):
    """The parts the built unit carries, in the character's rest space before their placement: [(part, bone, prims,
    placement)], placement {position, rotation, scale} as built (the build record), else as the old game drew it."""
    floor, tall, joints = rest_frame(cid)
    s = float(spec['height']) / tall
    to_char = np.array([1 / s, 1 / s, 1 / s])
    lift = np.array([0.0, floor, 0.0])
    skip = {unit, (spec.get('head') or {}).get('name'), (spec.get('companion') or {}).get('material')}
    model = Glb(game.model(unit))
    game_joints = model.joint_rest()
    if 'Hips' in game_joints and np.abs(game_joints['Hips'] * to_char + lift - joints['Hips']).max() > 1e-4:
        raise SystemExit(f'{unit}: the built unit no longer matches its character {cid} (rebuilt from another rig?)')
    sources = [(model, None)]
    names_in_model = {n for n, *_ in model.parts()}
    kit = os.path.join(game.repo, 'assets', 'models', 'kits', unit + '_wear.glb')
    wear_bone = {piece: bone for pieces in game.look_wear.values() for piece, bone in pieces}
    if os.path.exists(kit):
        sources.append((Glb(kit), wear_bone))
    out = []
    for glb, bones in sources:
        for name, world, prims, bone, share in glb.parts():
            if name in skip or (bones is not None and name in names_in_model):
                continue    # (wear built into the unit comes from it, not the kit)
            if bones is not None:
                if name not in bones:
                    print(f'  {unit}: {name} is worn by no look (UnitView.LookWear): skipped')
                    continue
                bone = bones[name]
            elif bone is None:
                raise SystemExit(f'{unit}: part {name} rides no bone')
            elif share < 0.999:
                print(f'  {unit}: {name} is skinned to more than {bone} ({share:.3f}): carried rigidly on {bone}')
            if bone not in joints:
                raise SystemExit(f'{unit}: part {name} rides {bone}, not in {cid}')
            rec = built.get(name) if bones is None else None
            if rec and 'position' in rec:
                place = {'position': rec['position'], 'rotation': rec['rotation'], 'scale': rec['scale']}
            else:
                place = {'position': [0.0, 0.0, 0.0], 'rotation': [0, 0, 0], 'scale': 1.0}
            R = euler_matrix(place['rotation'])
            mine = []
            for pos, nrm, uv, idx, mat in prims:
                p = (pos @ world[:3, :3].T + world[:3, 3]) * to_char + lift
                n = nrm @ world[:3, :3].T
                # (back out of the placement it was built with: the mesh as it sits in Rigsmith before it)
                p = ((p - np.array(place['position'])) @ R) / float(place['scale'])
                n = n @ R
                n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
                mine.append((p, n, uv, idx, game.image(unit, name, mat), mat))
            k = game.gear_scale.get(name[len('Gear'):], 1.0) if name.startswith('Gear') and not (rec and 'position' in rec) else 1.0
            if k != 1.0:    # (an old build: the game drew this tool k times bigger about its grip, UnitView.ScaleGear)
                hold = gear_hold(np.concatenate([q for q, *_ in mine]), joints[bone], bone)
                place = {'position': [round(float(x), 6) for x in hold * (1 - k)], 'rotation': [0, 0, 0], 'scale': k}
            out.append((name, bone, mine, place))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('game')
    ap.add_argument('units', nargs='*')
    ap.add_argument('--replace', action='store_true', help="as the game's last build has it: drop what it didn't have")
    ap.add_argument('--repivot', action='store_true', help='move the origin of the parts already there to where each is held (nothing moves)')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    game = Game(os.path.abspath(os.path.expanduser(a.game)))
    lib = Library()
    units = a.units or list(game.spec)
    unknown = [u for u in units if u not in game.spec]
    if unknown:
        raise SystemExit(f'not in the spec: {unknown}')
    live = not a.dry_run and api_up()
    stamp = time.strftime('%Y%m%dT%H%M%S')
    backup = os.path.join(WORKSPACE, 'backups', 'game-import', stamp)
    forager = {piece for piece, _ in game.look_wear.get('forager', [])}
    print(f'game {game.repo}; {"through the app at " + API if live else "dry run" if a.dry_run else "the files (the app is not running)"}')
    if a.repivot:
        for unit in units:
            cid = game.spec[unit]['character']
            c = character(cid)
            _, _, joints = rest_frame(cid)
            garments, moved = [], []
            for g in c.get('garments', []):
                if not (g.get('from') or '').startswith('emberhold:') or g.get('mode') != 'rigid' or not g.get('file'):
                    garments.append(g)
                    continue
                path = os.path.join(CHARACTERS, cid, g['file'])
                data = open(path, 'rb').read()
                pts = np.concatenate([q[0] for _, _, prims, _, _ in Glb(path).parts() for q in prims])
                local, position = repivot(g, pts, joints)
                if np.abs(local).max() < 1e-6:
                    garments.append(g)
                    continue
                data = shifted_glb(data, local)
                g = dict(g, position=position, file=garment_file(g['id'], data))
                moved.append(g['name'])
                if not a.dry_run:
                    with open(os.path.join(CHARACTERS, cid, g['file']), 'wb') as f:
                        f.write(data)
                garments.append(g)
            print(f'{unit} -> {cid}: pivots moved to the hold: {", ".join(moved) or "none"}')
            if a.dry_run or not moved:
                continue
            os.makedirs(backup, exist_ok=True)
            shutil.copy2(os.path.join(CHARACTERS, cid, 'character.json'), os.path.join(backup, cid + '.json'))
            if live:
                api('PATCH', f'/api/characters/{cid}', {'garments': garments})
            else:
                c['garments'] = garments
                c['updatedAt'] = int(time.time() * 1000)
                tmp = os.path.join(CHARACTERS, cid, f'character.json.{secrets.token_hex(4)}.tmp')
                with open(tmp, 'w') as f:
                    json.dump(c, f, indent=1)
                os.replace(tmp, os.path.join(CHARACTERS, cid, 'character.json'))
        return
    for unit in units:
        spec = game.spec[unit]
        if not spec['clips'] and not os.path.exists(game.model(unit)):
            print(f'{unit}: no clips and no built unit (posed by the game itself): left as it is')
            continue
        report = game.report(unit)
        todo = [(spec['character'], 'unit')]
        if spec.get('companion'):
            todo.append((spec['companion']['character'], 'companion'))
        for cid, role in todo:
            c = character(cid)
            if role == 'unit':
                built = game_clips(lib, spec['clips'], report.get('clips', {}))
                built_scripts = [{k: v for k, v in x.items() if k != 'did'} for x in report['scripts']] if 'scripts' in report else old_scripts(spec)
                parts = unit_parts(game, unit, spec, cid, report.get('gear', {})) if os.path.exists(game.model(unit)) else []
            else:
                cspec = spec['companion'].get('clips', spec['clips'])
                built = game_clips(lib, cspec, (report.get('companion') or {}).get('clips', {}), comp=True)
                built_scripts, parts = [], []
            have = c.get('animations', [])
            if a.replace:
                anims = built
            else:
                anims = have + [e for e in built if e['name'] not in {x['name'] for x in have}]
            scripts = built_scripts if a.replace or not c.get('scripts') else c['scripts']
            old = {g.get('from'): g for g in c.get('garments', []) if g.get('from')}
            garments = [] if a.replace else [g for g in c.get('garments', []) if not (g.get('from') or '').startswith('emberhold:')]
            made = []
            for name, bone, prims, place in parts:
                tag = f'emberhold:{unit}/{name}'
                was = None if a.replace else old.get(tag)
                if was is not None:    # (yours as it is: where it sits, its mesh, whether it shows)
                    garments.append(was)
                    continue
                gid = old[tag]['id'] if tag in old else secrets.token_hex(4)
                g = {'id': gid, 'name': name, 'file': f'garments/{gid}/model.glb', 'status': 'ready', 'mode': 'rigid',
                     'policy': 'body', 'bone': bone, 'position': place['position'], 'rotation': place['rotation'],
                     'scale': place['scale'], 'hideBody': False,
                     'hidden': (name.startswith(SWAPPED) and name not in forager) if was is None else was.get('hidden', False), 'from': tag}
                garments.append(g)
                made.append((g, prims))
            brought = {g['from'] for g, _ in made} | {g.get('from') for g in garments}
            gone = [g for t, g in old.items() if t.startswith('emberhold:') and t not in brought]
            if not a.replace:
                garments += gone    # (not in the game's build any more: kept, yours to remove)
                for g in gone:
                    print(f'  {g["name"]}: not in the game\'s build; kept')
            props = [] if a.replace else c.get('props', [])
            shown = [g['name'] for g, _ in made if not g['hidden']]
            print(f'{unit} -> {cid} ({c["name"]}): {len(anims)} clips [{", ".join(x["name"] + "=" + x["clipId"] for x in anims)}]; '
                  f'{len(scripts)} scripts{" (kept)" if scripts is c.get("scripts") else ""}')
            if made:
                print(f'  {len(made)} parts: {", ".join(g["name"] + "@" + g["bone"] + ("" if g["scale"] == 1 else " x%g" % g["scale"]) for g, _ in made)}')
                print(f'  shown: {", ".join(shown) or "none"}; {len(made) - len(shown)} hidden')
            if c.get('props') and not props:
                print(f'  catalog props dropped: {", ".join(p["name"] for p in c["props"])}')
            if a.dry_run:
                continue
            os.makedirs(backup, exist_ok=True)
            shutil.copy2(os.path.join(CHARACTERS, cid, 'character.json'), os.path.join(backup, cid + '.json'))
            _, _, joints = rest_frame(cid)
            for g, prims in made:
                os.makedirs(os.path.join(CHARACTERS, cid, 'garments', g['id']), exist_ok=True)
                tmp = os.path.join(CHARACTERS, cid, 'garments', g['id'], 'model.tmp.glb')
                write_glb(tmp, g['name'], prims)
                data = open(tmp, 'rb').read()
                local, g['position'] = repivot(g, np.concatenate([q[0] for q in prims]), joints)    # (its pivot where it is held)
                data = shifted_glb(data, local)
                g['file'] = garment_file(g['id'], data)
                with open(os.path.join(CHARACTERS, cid, g['file']), 'wb') as f:
                    f.write(data)
                os.remove(tmp)
            patch = {'animations': anims, 'scripts': scripts, 'garments': garments, 'props': props}
            if live:
                api('PATCH', f'/api/characters/{cid}', patch)
            else:
                c.update(patch)
                c['updatedAt'] = int(time.time() * 1000)
                tmp = os.path.join(CHARACTERS, cid, f'character.json.{secrets.token_hex(4)}.tmp')
                with open(tmp, 'w') as f:
                    json.dump(c, f, indent=1)
                os.replace(tmp, os.path.join(CHARACTERS, cid, 'character.json'))
            if a.replace:
                for g in gone:
                    shutil.rmtree(os.path.join(CHARACTERS, cid, 'garments', g['id']), ignore_errors=True)
    if not a.dry_run:
        print(f'backups: {backup}')


if __name__ == '__main__':
    sys.exit(main())
