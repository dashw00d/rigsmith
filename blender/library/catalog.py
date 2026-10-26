"""Pinned, checksum-verified named Mixamo sources. No authentication or extra packages needed.

python3 blender/library/catalog.py sync   # full collection, including static poses
python3 blender/library/catalog.py verify # sources + converted manifest/GLBs
"""
import argparse
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import struct
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import urlopen

REPO = "Linzhan/Mixamo-Animations-Characters"
REVISION = "7f134bc734557b1d9516cb476d25ea1f577e45c1"
SOURCE = "mixamo-catalog"
OUT = Path(os.environ.get("RIGSMITH_WORKSPACE", Path(__file__).resolve().parents[2] / "workspace")) / "library"
BASE = f"https://huggingface.co/datasets/{REPO}/resolve/{REVISION}"


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2) + "\n")
    tmp.replace(path)


def fetch(url):
    for attempt in range(8):
        try:
            with urlopen(url, timeout=90) as response:
                return response.read(), response.headers
        except (HTTPError, URLError, TimeoutError) as error:
            if isinstance(error, HTTPError) and error.code not in (408, 429, 500, 502, 503, 504):
                raise
            if attempt == 7:
                raise
            delay = min(60, 2 ** (attempt + 1))
            if isinstance(error, HTTPError):
                delay = max(delay, min(120, int(error.headers.get("Retry-After", "0"))))
            time.sleep(delay)


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def source_dir(out):
    return Path(out) / "sources" / "mixamo-named"


def read_index(out):
    path = source_dir(out) / "index.json"
    return json.loads(path.read_text()) if path.exists() else None


def catalog_rows(metadata, files):
    """Require a one-to-one metadata/file inventory; never infer a hash-to-name mapping."""
    rows = list(csv.DictReader(io.StringIO(metadata)))
    by_path = {f["path"]: f for f in files if f["path"].endswith(".fbx")}
    if len(rows) != len(by_path) or {r["file"] for r in rows} != set(by_path):
        raise ValueError("Metadata and publisher FBX inventory differ")
    result = []
    for row in rows:
        stem = Path(row["file"]).stem
        if (not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]*", stem) or ".." in stem
                or row["file"] != f"animation/{stem}.fbx" or not row["prompt"].strip()):
            raise ValueError(f"Invalid catalog filename/name: {row['file']}")
        f = by_path[row["file"]]
        result.append({**row, "frames": int(row["frames"]), "id": f"mixamo-{stem}",
                       "name": stem.replace("_", " "), "sha256": f["lfs"]["oid"], "bytes": f["size"]})
    if len({r["motion_id"] for r in result}) != len(result):
        raise ValueError("Duplicate publisher motion IDs")
    return result


def sync(out=OUT, workers=4):
    directory = source_dir(out)
    directory.mkdir(parents=True, exist_ok=True)
    metadata, _ = fetch(f"{BASE}/metadata.csv")
    files = []
    url = f"https://huggingface.co/api/datasets/{REPO}/tree/{REVISION}/animation?limit=1000"
    while url:
        data, headers = fetch(url)
        files.extend(json.loads(data))
        match = re.search(r'<([^>]+)>; rel="next"', headers.get("Link", ""))
        url = match[1] if match else None
    rows = catalog_rows(metadata.decode("utf-8"), files)
    (directory / "metadata.csv").write_bytes(metadata)

    def download(row):
        path = directory / row["file"]
        if path.exists() and path.stat().st_size == row["bytes"] and digest(path) == row["sha256"]:
            return False
        data, _ = fetch(f"{BASE}/{quote(row['file'])}?download=true")
        if len(data) != row["bytes"] or hashlib.sha256(data).hexdigest() != row["sha256"]:
            raise ValueError(f"Checksum mismatch: {row['file']}")
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".fbx.part")
        tmp.write_bytes(data)
        tmp.replace(path)
        return True

    downloaded = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(download, row) for row in rows]
        for count, future in enumerate(as_completed(futures), 1):
            downloaded += future.result()
            if count % 100 == 0 or count == len(rows):
                print(f"Sources verified: {count}/{len(rows)} ({downloaded} downloaded)", flush=True)
    index = {"repository": REPO, "revision": REVISION, "metadataSha256": hashlib.sha256(metadata).hexdigest(),
             "count": len(rows), "motionCount": sum(r["frames"] > 2 for r in rows),
             "poseCount": sum(r["frames"] <= 2 for r in rows), "clips": rows}
    atomic_json(directory / "index.json", index)
    return index


def jobs(out):
    index = read_index(out)
    if index is None:
        return []
    return [{"kind": "clip", "source": SOURCE, "sourcePath": str(source_dir(out) / r["file"]),
             "sourceName": Path(r["file"]).stem, "name": r["name"], "tags": [],
             "id": r["id"], "sha256": r["sha256"], "description": r["description"],
             "originalName": r["prompt"], "motionId": r["motion_id"], "catalogFrames": r["frames"],
             "sourceRevision": index["revision"]} for r in index["clips"]]


def coverage(out, clips):
    index = read_index(out)
    if index is None:
        return None
    converted = {c["id"]: c for c in clips if c["source"] == SOURCE}
    expected = {r["id"] for r in index["clips"]}
    missing = []
    for row in index["clips"]:
        c = converted.get(row["id"])
        if (c is None or c.get("nameSource") != "catalog" or c.get("motionId") != row["motion_id"]
                or c.get("name") != row["name"] or c.get("duplicateOf")
                or not (Path(out) / c["file"]).exists()):
            missing.append(row["id"])
    extra = sorted(set(converted) - expected)
    return {k: index[k] for k in ("repository", "revision", "count", "motionCount", "poseCount")} | {
        "complete": not missing and not extra, "converted": len(converted), "missing": missing, "extra": extra}


def verify(out=OUT):
    index = read_index(out)
    if index is None:
        raise ValueError("No catalog index; run npm run library:sync first")
    manifest = json.loads((Path(out) / "manifest.json").read_text())
    report = coverage(out, manifest["clips"])
    errors = []
    frame_differences = []
    by_id = {c["id"]: c for c in manifest["clips"]}
    for row in index["clips"]:
        src = source_dir(out) / row["file"]
        if not src.exists() or src.stat().st_size != row["bytes"] or digest(src) != row["sha256"]:
            errors.append(f"Source checksum: {row['file']}")
        clip = by_id.get(row["id"])
        if clip is None:
            continue
        try:
            data = (Path(out) / clip["file"]).read_bytes()
            magic, version, length = struct.unpack_from("<III", data)
            if magic != 0x46546C67 or version != 2 or length != len(data):
                raise ValueError("invalid GLB header")
            doc = json.loads(data[20:20 + struct.unpack_from("<I", data, 12)[0]])
            if len(doc["animations"]) != 1 or doc["animations"][0]["name"] != row["name"]:
                raise ValueError("animation name mismatch")
            if len(doc["skins"][0]["joints"]) != 65 or not doc["animations"][0]["channels"]:
                raise ValueError("missing skeleton or tracks")
            if clip["fps"] != 30:
                raise ValueError(f"unexpected source FPS: {clip['fps']}")
            # The publisher CSV has stale frame counts for some files (e.g. Digging/Dying).
            # Use the imported FBX timing and validate it against the actual animation keys.
            anim = doc["animations"][0]
            times = [doc["accessors"][s["input"]] for s in anim["samplers"]]
            duration = max(a["max"][0] for a in times)
            if abs(duration - (clip["frames"] - 1) / clip["fps"]) > 1e-4:
                raise ValueError("converted keys do not match source timing")
            if clip["frames"] != row["frames"]:
                frame_differences.append({"file": row["file"], "metadataFrames": row["frames"], "fbxFrames": clip["frames"]})
        except (OSError, KeyError, ValueError, struct.error) as error:
            errors.append(f"{row['file']}: {error}")
    report.update({"verifiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "errors": errors,
                   "metadataFrameDifferences": frame_differences})
    report["complete"] = report["complete"] and not errors
    atomic_json(Path(out) / "catalog-verification.json", report)
    print(json.dumps(report, indent=2))
    if not report["complete"]:
        raise SystemExit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["sync", "verify"])
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    if args.command == "sync":
        sync(workers=args.workers)
    else:
        verify()
