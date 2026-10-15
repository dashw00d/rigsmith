"""Protocol for talking to the job runner (server/jobs.ts) and coordinate conversion helpers."""
import json
import sys


def progress(value, message):
    print('@@PROGRESS ' + json.dumps({'progress': float(value), 'message': message}), flush=True)


def result(payload):
    print('@@RESULT ' + json.dumps(payload), flush=True)


def args():
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


# Blender world space is Z up / -Y forward; glTF (and the browser) is Y up / +Z forward.
def to_gltf(v):
    return [float(v[0]), float(v[2]), float(-v[1])]


def from_gltf(v):
    return [float(v[0]), float(-v[2]), float(v[1])]
