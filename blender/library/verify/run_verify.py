#!/usr/bin/env python3
"""Fidelity verification driver.

  python3 blender/library/verify/run_verify.py [--random 6] [--seed 7] [--all-named]

Picks the required named clips (Walking, Dying, Standing Draw Arrow, Breathing Idle),
N random converted pack clips (plus any ids given with --ids), dumps reference joint
positions from the ORIGINAL FBX in Blender, then runs verify_clips.mjs (three.js) on the
converted GLBs. Report: workspace/library/verify/report.json
"""
import argparse
import json
import os
import random
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
LIB = os.path.join(REPO, "workspace", "library")
BLENDER = os.environ.get("BLENDER", "/snap/bin/blender")
REQUIRED = ["Walking", "Dying", "Standing Draw Arrow", "Breathing Idle"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--random", type=int, default=6)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--frames", type=int, default=8)
    ap.add_argument("--all-named", action="store_true")
    ap.add_argument("--ids", default="")
    a = ap.parse_args()
    metas = []
    for f in os.listdir(os.path.join(LIB, "meta")):
        if f.endswith(".json"):
            m = json.load(open(os.path.join(LIB, "meta", f)))
            if m.get("kind") == "clip":
                metas.append(m)
    named = [m for m in metas if m["source"] == "mixamo" and (a.all_named or m["name"] in REQUIRED)]
    pack = sorted((m for m in metas if m["source"] == "mixamo-pack"), key=lambda m: m["id"])
    rnd = random.Random(a.seed).sample(pack, min(a.random, len(pack)))
    extra = [m for m in metas if m["id"] in set(filter(None, a.ids.split(",")))]
    chosen = {m["id"]: m for m in named + rnd + extra}
    spec = [{"id": m["id"], "path": m["sourcePath"], "frames": a.frames} for m in chosen.values()]
    vdir = os.path.join(LIB, "verify")
    os.makedirs(vdir, exist_ok=True)
    spec_path = os.path.join(vdir, "spec.json")
    ref_path = os.path.join(vdir, "reference.json")
    json.dump(spec, open(spec_path, "w"), indent=1)
    subprocess.run([BLENDER, "-b", "--factory-startup", "--python", os.path.join(HERE, "dump_reference.py"), "--",
                    ref_path, spec_path], check=True, stdout=subprocess.DEVNULL)
    r = subprocess.run(["node", os.path.join(HERE, "verify_clips.mjs"), ref_path, LIB, "--out",
                        os.path.join(vdir, "report.json")], cwd=REPO)
    sys.exit(r.returncode)


if __name__ == "__main__":
    main()
