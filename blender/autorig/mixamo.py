"""The canonical Mixamo skeleton: bone names (bare, no `mixamorig:` prefix), hierarchy by finger level, and where a
long finger's joints sit along the hand.

All of it is read from static/templates/human-skeleton.json, the one table the app (src/model/skeletons.ts,
src/engine/mixamo.ts) reads too.
"""
import json
import os

_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'static', 'templates', 'human-skeleton.json')
with open(_FILE) as _f:
    _HUMAN = json.load(_f)

FINGERS = list(_HUMAN['fingers'])

# Finger chains included per detail level (Mixamo's skeleton LOD options).
FINGER_LEVELS = {level: list(chains) for level, chains in _HUMAN['fingerLevels'].items()}

# [bone, parent] or [bone, parent, finger] at the full level, parents first.
_BONES = _HUMAN['bones']

# Where a long finger's joints sit along the hand (Mixamo's proportions): the knuckle's reach along the hand as a
# fraction of the tip's, then the two middle joints as fractions of knuckle -> tip.
ANATOMY = {finger: tuple(v) for finger, v in _HUMAN['anatomy'].items()}

SPINE = [bone for bone, *rest in _BONES[:7]]


def hierarchy(fingers='two'):
    """Ordered list of (bone, parent) with parents before children."""
    wanted = FINGER_LEVELS[fingers]
    return [(b[0], b[1]) for b in _BONES if len(b) < 3 or b[2] in wanted]


def is_leaf_end(name):
    """End joints that carry no skin weight (they only give the parent bone its length)."""
    return name.endswith('_End') or name.endswith('4')


def mirror_name(name):
    if name.startswith('Left'):
        return 'Right' + name[4:]
    if name.startswith('Right'):
        return 'Left' + name[5:]
    return name
