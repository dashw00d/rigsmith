"""The canonical Mixamo skeleton: bone names (bare, no `mixamorig:` prefix) and hierarchy."""

SPINE = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'HeadTop_End']
FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']

# Finger chains included per detail level (Mixamo's skeleton LOD options).
FINGER_LEVELS = {
    'none': [],
    'one': ['Index'],
    'two': ['Thumb', 'Index'],
    'full': FINGERS,
}


def hierarchy(fingers='two'):
    """Ordered list of (bone, parent) with parents before children."""
    bones = [('Hips', None), ('Spine', 'Hips'), ('Spine1', 'Spine'), ('Spine2', 'Spine1'),
             ('Neck', 'Spine2'), ('Head', 'Neck'), ('HeadTop_End', 'Head')]
    for side in ('Left', 'Right'):
        bones += [(f'{side}Shoulder', 'Spine2'), (f'{side}Arm', f'{side}Shoulder'),
                  (f'{side}ForeArm', f'{side}Arm'), (f'{side}Hand', f'{side}ForeArm')]
        for finger in FINGER_LEVELS[fingers]:
            parent = f'{side}Hand'
            for i in range(1, 5):
                name = f'{side}Hand{finger}{i}'
                bones.append((name, parent))
                parent = name
    for side in ('Left', 'Right'):
        bones += [(f'{side}UpLeg', 'Hips'), (f'{side}Leg', f'{side}UpLeg'), (f'{side}Foot', f'{side}Leg'),
                  (f'{side}ToeBase', f'{side}Foot'), (f'{side}Toe_End', f'{side}ToeBase')]
    return bones


def is_leaf_end(name):
    """End joints that carry no skin weight (they only give the parent bone its length)."""
    return name.endswith('_End') or name.endswith('4')


def mirror_name(name):
    if name.startswith('Left'):
        return 'Right' + name[4:]
    if name.startswith('Right'):
        return 'Left' + name[5:]
    return name
