"""Turn static/rigs/rig-*.glb into static/templates/<rig>.json: joint rest positions (glTF space) and hierarchy.

python3 -I tools/extract_templates.py
"""
import json
import math
import os
import struct

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
LABELS = {'horse': 'Horse', 'fox': 'Fox', 'bird': 'Bird', 'dragon': 'Dragon', 'kaiju': 'Kaiju', 'spider': 'Spider', 'snake': 'Snake', 'shark': 'Fish'}


def glb_json(path):
    data = open(path, 'rb').read()
    n = struct.unpack('<I', data[12:16])[0]
    return json.loads(data[20:20 + n])


def quat_matrix(q):
    x, y, z, w = q
    return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]


def compose(node):
    if 'matrix' in node:
        m = node['matrix']
        return [[m[0], m[4], m[8], m[12]], [m[1], m[5], m[9], m[13]], [m[2], m[6], m[10], m[14]], [0, 0, 0, 1]]
    r = quat_matrix(node.get('rotation', [0, 0, 0, 1]))
    s = node.get('scale', [1, 1, 1])
    t = node.get('translation', [0, 0, 0])
    return [[r[i][0] * s[0], r[i][1] * s[1], r[i][2] * s[2], t[i]] for i in range(3)] + [[0, 0, 0, 1]]


def mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def mirror_name(name):
    for a, b in (('_L', '_R'), ('_l', '_r'), ('.L', '.R'), ('.l', '.r'), ('Left', 'Right')):
        for x, y in ((a, b), (b, a)):
            if name.endswith(x) and not a.startswith('Left'):
                return name[:-len(x)] + y
            if a.startswith('Left') and name.startswith(x):
                return y + name[len(x):]
            # names like ear_1_r / leg_a_1_l carry the side as a suffix token
            if not a.startswith('Left') and (x + '_') in name:
                return name.replace(x + '_', y + '_', 1)
    return name


for file in sorted(os.listdir(os.path.join(ROOT, 'static', 'rigs'))):
    if not file.startswith('rig-') or file == 'rig-human.glb':
        continue
    rig = file[4:-4]
    j = glb_json(os.path.join(ROOT, 'static', 'rigs', file))
    nodes = j['nodes']
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get('children', []):
            parent[c] = i
    world = {}

    def get_world(i):
        if i not in world:
            local = compose(nodes[i])
            world[i] = mul(get_world(parent[i]), local) if i in parent else local
        return world[i]

    joints = j['skins'][0]['joints']
    joint_set = set(joints)
    names = {i: nodes[i]['name'] for i in joints}
    out = {'id': rig, 'label': LABELS.get(rig, rig.title()), 'joints': {}, 'parents': {}, 'order': []}
    for i in joints:
        w = get_world(i)
        out['joints'][names[i]] = [round(w[0][3], 5), round(w[1][3], 5), round(w[2][3], 5)]
        p = parent.get(i)
        out['parents'][names[i]] = names[p] if p in joint_set else None
        out['order'].append(names[i])
    ys = [p[1] for p in out['joints'].values()]
    out['height'] = round(max(ys) - min(ys), 5)
    out['mirror'] = {n: mirror_name(n) for n in out['order'] if mirror_name(n) != n and mirror_name(n) in out['joints']}
    out['animations'] = f'animations/{rig}-animations.glb'
    # Bounds of the template's own mesh (static/models/model-<rig>.glb), used to fit it onto new models.
    model = glb_json(os.path.join(ROOT, 'static', 'models', f'model-{rig}.glb'))
    lo, hi = [math.inf] * 3, [-math.inf] * 3
    for mesh in model['meshes']:
        for prim in mesh['primitives']:
            acc = model['accessors'][prim['attributes']['POSITION']]
            lo = [min(a, b) for a, b in zip(lo, acc['min'])]
            hi = [max(a, b) for a, b in zip(hi, acc['max'])]
    out['meshBox'] = [[round(v, 5) for v in lo], [round(v, 5) for v in hi]]
    json.dump(out, open(os.path.join(ROOT, 'static', 'templates', f'{rig}.json'), 'w'), indent=1)
    print(rig, len(out['order']), 'joints, height', out['height'], 'mirror pairs', len(out['mirror']) // 2, 'root', out['order'][0])
