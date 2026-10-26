"""Run with python3 -m unittest discover -s blender/library -p 'test_*.py'."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import build
import catalog


class CatalogTests(unittest.TestCase):
    def test_rejects_partial_publisher_inventory(self):
        with self.assertRaisesRegex(ValueError, "inventory differ"):
            catalog.catalog_rows("file,prompt,frames,motion_id\nanimation/Walk.fbx,Walk,30,one\n", [])

    def test_keeps_numbered_variant_and_publisher_name(self):
        rows = catalog.catalog_rows(
            "file,prompt,description,frames,motion_id\nanimation/Jab_Cross_2.fbx,Jab Cross,Long Jab Cross,30,one\n",
            [{"path": "animation/Jab_Cross_2.fbx", "size": 5, "lfs": {"oid": "a" * 64}}])
        self.assertEqual(rows[0]["name"], "Jab Cross 2")
        self.assertEqual(rows[0]["prompt"], "Jab Cross")
        self.assertEqual(rows[0]["id"], "mixamo-Jab_Cross_2")

    def test_missing_glb_cannot_be_complete(self):
        with tempfile.TemporaryDirectory() as temp:
            row = {"id": "mixamo-Walk", "name": "Walk", "motion_id": "one"}
            index = {"repository": catalog.REPO, "revision": catalog.REVISION, "count": 1,
                     "motionCount": 1, "poseCount": 0, "clips": [row]}
            catalog.atomic_json(catalog.source_dir(temp) / "index.json", index)
            clips = [{"id": row["id"], "name": row["name"], "motionId": "one", "source": catalog.SOURCE,
                      "nameSource": "catalog", "file": "clips/mixamo-Walk.glb"}]
            self.assertFalse(catalog.coverage(temp, clips)["complete"])
            path = Path(temp) / clips[0]["file"]
            path.parent.mkdir()
            path.touch()
            self.assertTrue(catalog.coverage(temp, clips)["complete"])
            clips[0]["duplicateOf"] = "something-else"
            self.assertFalse(catalog.coverage(temp, clips)["complete"])

    def test_rebuild_keeps_sources_when_download_folder_is_gone(self):
        with tempfile.TemporaryDirectory() as temp:
            job = {"id": "existing", "source": "mixamo-pack", "kind": "clip", "sourcePath": "/missing.fbx"}
            catalog.atomic_json(Path(temp) / "work" / "sources.json", [job])
            with patch.object(build, "OUT", temp), patch.object(build, "DL", temp), patch.object(build, "MANNEQUIN_SRC", "/missing.fbx"):
                self.assertEqual(build.enumerate_sources(), [job])
                self.assertEqual(json.loads((Path(temp) / "work" / "sources.json").read_text()), [job])


if __name__ == "__main__":
    unittest.main()
