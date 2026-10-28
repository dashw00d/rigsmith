#!/usr/bin/env python3
"""Build the local Mixamo animation library (driver; system python3 + numpy).

  python3 blender/library/build.py convert   [--procs 8] [--limit N] [--sources a,b]
  python3 blender/library/build.py aggregate  # features -> categories, names, manifest
  python3 blender/library/build.py all        # convert + aggregate (npm run library)

Pack clips are named from a motion-match names file when present (--names, default
$RIGSMITH_ANIMATION_NAMES or ~/Downloads/Mixamo/animation-names.json; --names '' to skip).

Outputs go to workspace/library/ (see README.md written there).
"""
import argparse
import glob
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(os.environ.get("RIGSMITH_WORKSPACE", os.path.join(REPO, "workspace")), "library")
BLENDER = os.environ.get("BLENDER", "/snap/bin/blender")
DL = os.path.expanduser("~/Downloads")

sys.dont_write_bytecode = True  # keep blender/library free of __pycache__
sys.path.insert(0, HERE)

# Game actions each named clip was picked for (from ~/Downloads/mixamo/replacements.md).
NAMED_TAGS = {
    "Digging": ["mine", "work"],
    "Working On Device": ["build"],
    "Pulling A Rope": ["harvest"],
    "Carrying": ["carry"],
    "Fishing Idle": ["fish"],
    "Fishing Cast": ["fish"],
    "Picking Up": ["forage"],
    "Talking": ["trade"],
    "Standing Draw Arrow": ["hunt"],
    "Dying": ["die"],
    "Happy Idle": ["crowd-variant"],
    "Happy Idle (1)": ["crowd-variant"],
}
NAMED_EXCLUDE = {"Y Bot.fbx", "villager_open_rigged.fbx"}
# ~/Downloads/mixamo/Y Bot.fbx turned out to be a bone-only 264-frame clip (no mesh),
# so the skinned Y Bot comes from the HF character folder (see ybot-source.json there).
MANNEQUIN_SRC = os.path.join(DL, "Mixamo", "character", "Y_Bot.fbx")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# --------------------------------------------------------------------------- sources

def sha256_file(path, cache):
    st = os.stat(path)
    key = f"{path}|{st.st_size}|{int(st.st_mtime)}"
    if key in cache:
        return cache[key]
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    cache[key] = h.hexdigest()
    return cache[key]


def enumerate_sources(selected=None):
    import catalog
    items = []
    include_legacy = catalog.read_index(OUT) is None or bool(selected and selected & {"mixamo", "mixamo-pack", "mixamo-pack-extra"})
    for p in sorted(glob.glob(os.path.join(DL, "Mixamo", "animation", "*.fbx"))) if include_legacy else []:
        items.append({"kind": "clip", "source": "mixamo-pack", "sourcePath": p,
                      "sourceName": os.path.basename(p)[:-4], "name": None, "tags": []})
    for fn, nm in (("a-pose.fbx", "A-Pose"), ("da-pose.fbx", "DA-Pose")) if include_legacy else []:
        p = os.path.join(DL, "Mixamo", "animation_extra", fn)
        if os.path.exists(p):
            items.append({"kind": "clip", "source": "mixamo-pack-extra", "sourcePath": p,
                          "sourceName": fn[:-4], "name": nm, "tags": []})
    for p in sorted(glob.glob(os.path.join(DL, "mixamo", "*.fbx"))) if include_legacy else []:
        fn = os.path.basename(p)
        if fn in NAMED_EXCLUDE:
            continue
        nm = fn[:-4]
        items.append({"kind": "clip", "source": "mixamo", "sourcePath": p, "sourceName": nm,
                      "name": nm, "tags": list(NAMED_TAGS.get(nm, []))})
    if os.path.exists(MANNEQUIN_SRC):
        items.append({"kind": "mannequin", "source": "mixamo-character", "sourcePath": MANNEQUIN_SRC,
                      "sourceName": "Y_Bot", "name": "Y Bot", "tags": []})
    cache_path = os.path.join(OUT, "work", "hashcache.json")
    try:
        cache = json.load(open(cache_path))
    except Exception:
        cache = {}
    for it in items:
        it["sha256"] = sha256_file(it["sourcePath"], cache)
        it["id"] = it["sha256"][:12]
    items += catalog.jobs(OUT)
    # Downloads may be moved/deleted after conversion. Keep those cached clips and their IDs;
    # a rebuild or a --sources subset must never silently remove them from the library.
    saved_path = os.path.join(OUT, "work", "sources.json")
    saved = json.loads(Path(saved_path).read_text()) if os.path.exists(saved_path) else []
    items = list({i["id"]: i for i in saved + items}.values())
    # (a source listed by hand in sources.json, as the custom FBX clips are: hashed here like a found one)
    for it in items:
        if not it.get("make") and not it.get("sha256") and os.path.isfile(it["sourcePath"]):
            it["sha256"] = sha256_file(it["sourcePath"], cache)
    # (a clip made by a script, `make`, from library sources, `inputs`: remade when the script or a source changes)
    for it in items:
        if it.get("make"):
            h = hashlib.sha256(open(os.path.join(REPO, it["make"]), "rb").read())
            for path in it.get("inputs", []):
                h.update(open(path, "rb").read())
            it["sha256"] = h.hexdigest()
    if selected:
        items = [i for i in items if i["source"] in selected or (i["kind"] == "mannequin" and "mannequin" in selected)]
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    with open(cache_path, "w") as fh:
        json.dump(cache, fh)
    return items


def is_done(job, version):
    mp = os.path.join(OUT, "meta", job["id"] + ".json")
    if not os.path.exists(mp):
        return False
    try:
        m = json.load(open(mp))
    except Exception:
        return False
    return m.get("converterVersion") == version and m.get("sha256") == job["sha256"] and \
        os.path.exists(os.path.join(OUT, m["file"]))


# --------------------------------------------------------------------------- convert

def converter_version():
    for line in open(os.path.join(HERE, "convert.py")):
        if line.startswith("CONVERTER_VERSION"):
            return int(line.split("=")[1])
    raise RuntimeError("no CONVERTER_VERSION")


def run_shards(jobs, procs):
    """Run jobs in <= procs Blender processes; relaunch after crashes."""
    work = os.path.join(OUT, "work")
    os.makedirs(work, exist_ok=True)
    # balance by file size (~ frame count)
    shards = [[] for _ in range(min(procs, len(jobs)))]
    load = [0] * len(shards)
    for j in sorted(jobs, key=lambda j: -os.path.getsize(j["sourcePath"])):
        k = load.index(min(load))
        shards[k].append(j)
        load[k] += os.path.getsize(j["sourcePath"])
    pending = {i: s for i, s in enumerate(shards) if s}
    crashes = []
    attempt = 0
    while pending and attempt < 50:
        attempt += 1
        running = {}
        for i, sjobs in pending.items():
            jf = os.path.join(work, f"shard-{i}.json")
            json.dump(sjobs, open(jf, "w"))
            cur = os.path.join(work, f"shard-{i}.current")
            if os.path.exists(cur):
                os.remove(cur)
            logf = open(os.path.join(work, f"shard-{i}.log"), "a")
            cmd = [BLENDER, "-b", "--threads", "1", "--factory-startup", "--python", os.path.join(HERE, "convert.py"), "--",
                   "--jobs", jf, "--out", OUT, "--shard", str(i)]
            running[i] = (subprocess.Popen(cmd, stdout=logf, stderr=subprocess.STDOUT), logf)
        total = sum(len(s) for s in pending.values())
        t0 = time.time()
        while any(p.poll() is None for p, _ in running.values()):
            time.sleep(5)
            n_meta = len(os.listdir(os.path.join(OUT, "meta"))) if os.path.isdir(os.path.join(OUT, "meta")) else 0
            log(f"  {n_meta} meta files, {sum(p.poll() is None for p, _ in running.values())} procs running, "
                f"{time.time() - t0:.0f}s")
        new_pending = {}
        for i, (p, logf) in running.items():
            logf.close()
            cur = os.path.join(work, f"shard-{i}.current")
            if p.returncode != 0 or os.path.exists(cur):
                # crashed: the job named in .current killed Blender; record it and resume after it
                bad = open(cur).read().strip() if os.path.exists(cur) else None
                sjobs = pending[i]
                ids = [j["id"] for j in sjobs]
                if bad in ids:
                    k = ids.index(bad)
                    crashes.append({"id": bad, "sourcePath": sjobs[k]["sourcePath"], "source": sjobs[k]["source"],
                                    "error": f"Blender process crashed (exit {p.returncode}) while converting"})
                    rest = sjobs[k + 1:]
                else:
                    failed = set()
                    for f in glob.glob(os.path.join(OUT, "failures", "*.jsonl")):
                        failed |= {json.loads(x)["id"] for x in open(f) if x.strip()}
                    rest = [j for j in sjobs if j["id"] not in failed and
                            not os.path.exists(os.path.join(OUT, "meta", j["id"] + ".json"))]
                if rest:
                    new_pending[i] = rest
        pending = new_pending
        del total
    return crashes


def cmd_convert(args):
    version = converter_version()
    sel = set(args.sources.split(",")) if args.sources else None
    items = enumerate_sources(sel)
    if args.limit:
        keep = [i for i in items if i["source"] != "mixamo-pack"]
        pack = [i for i in items if i["source"] == "mixamo-pack"][: args.limit]
        items = keep + pack
    ids = {}
    for it in items:
        if it["id"] in ids:
            log(f"duplicate source bytes: {it['sourcePath']} == {ids[it['id']]['sourcePath']}")
        ids[it["id"]] = it
    todo = [i for i in items if not is_done(i, version)]
    missing = [i["sourcePath"] for i in todo if not os.path.isfile(i["sourcePath"])]
    if missing:
        raise FileNotFoundError(f"{len(missing)} uncached source files are missing: {missing[:5]}")
    log(f"{len(items)} sources, {len(todo)} to convert (converter v{version})")
    fdir = os.path.join(OUT, "failures")
    os.makedirs(fdir, exist_ok=True)
    for f in glob.glob(os.path.join(fdir, "*.jsonl")):
        os.remove(f)
    t0 = time.time()
    made = [i for i in todo if i.get("make")]
    todo_fbx = [i for i in todo if not i.get("make")]
    crashes = run_shards(todo_fbx, args.procs) if todo_fbx else []
    for it in made:
        # a made clip: its script writes it (clip, meta, cache, its sources line) with the converter's own code
        log(f"making {it['id']} ({it['make']})")
        r = subprocess.run([BLENDER, "-b", "--factory-startup", "--python-exit-code", "1", "--python",
                            os.path.join(REPO, it["make"]), "--", *it.get("args", []), "--library", OUT], capture_output=True, text=True)
        if r.returncode != 0:
            crashes.append({"id": it["id"], "sourcePath": it["sourcePath"], "source": it["source"],
                            "error": f"{it['make']} failed: {(r.stdout + r.stderr)[-600:]}"})
    dt = time.time() - t0
    failures = []
    for f in sorted(glob.glob(os.path.join(fdir, "*.jsonl"))):
        failures += [json.loads(line) for line in open(f) if line.strip()]
    failures += crashes
    failures = [f for f in failures if not is_done({"id": f["id"], "sha256": next(
        (i["sha256"] for i in items if i["id"] == f["id"]), "")}, version)]
    json.dump({"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "converterVersion": version,
               "count": len(failures), "failures": failures}, open(os.path.join(OUT, "failures.json"), "w"), indent=1)
    stats = {"sources": len(items), "converted": len(todo) - len(failures), "failed": len(failures),
             "seconds": round(dt, 1), "procs": args.procs}
    if todo:  # keep the record of the last run that actually converted something
        stats["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        json.dump(stats, open(os.path.join(OUT, "work", "last-convert.json"), "w"), indent=1)
    log(f"convert done in {dt:.1f}s: {stats}")
    sources_path = os.path.join(OUT, "work", "sources.json")
    previous = json.load(open(sources_path)) if os.path.exists(sources_path) else []
    sources = list({i["id"]: i for i in previous + items}.values())
    with open(sources_path + ".tmp", "w") as fh:
        json.dump(sources, fh, indent=1)
    os.replace(sources_path + ".tmp", sources_path)
    if failures:
        raise RuntimeError(f"{len(failures)} conversions failed; see {OUT}/failures.json")
    return items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["convert", "aggregate", "all"])
    ap.add_argument("--procs", type=int, default=8)
    ap.add_argument("--limit", type=int, default=0, help="only the first N pack clips (testing)")
    ap.add_argument("--sources", default="", help="comma list: mixamo-catalog,mixamo,mixamo-pack,mixamo-pack-extra,mannequin")
    ap.add_argument("--names", default=os.environ.get("RIGSMITH_ANIMATION_NAMES", os.path.join(DL, "Mixamo", "animation-names.json")),
                    help="names file for the hashed pack clips ('' = provisional names)")
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    if args.cmd in ("convert", "all"):
        cmd_convert(args)
    if args.cmd in ("aggregate", "all"):
        import aggregate
        aggregate.run(OUT, names_path=os.path.expanduser(args.names) if args.names else None)


if __name__ == "__main__":
    main()
