"""Recognize known skeletons by bone names and normalize their naming."""
import re

MIXAMO_CORE = {'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand',
               'RightArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg',
               'RightLeg', 'RightFoot'}
PREFIX = re.compile(r'^mixamorig\d*[:_]')


def bare(name):
    return PREFIX.sub('', name.split('|')[-1])


def detect_preset(names):
    bare_names = {bare(n) for n in names}
    if any(PREFIX.match(n) for n in names) or len(MIXAMO_CORE & bare_names) >= 15:
        return 'mixamo'
    if any(n.startswith('tripo::') for n in names):
        return 'tripo'
    if any(n.startswith('DEF-') for n in names):
        return 'rigify'
    if {'pelvis', 'spine_01', 'clavicle_l'} <= {n.lower() for n in names}:
        return 'unreal'
    return 'unknown'


def normalize_bone_names(armature, meshes):
    """Strip mixamorig: prefixes from bones and the matching vertex groups."""
    renames = {b.name: bare(b.name) for b in armature.data.bones if bare(b.name) != b.name}
    for old, new in renames.items():
        armature.data.bones[old].name = new
    for ob in meshes:
        for group in ob.vertex_groups:
            if group.name in renames:
                group.name = renames[group.name]
