from __future__ import annotations
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zlib

from pipeline.artifact_validation import validate_artifact, validate_run
from pipeline.publish import publish_to_r2
from pipeline.tests.artifact_fixture import make_run


class ArtifactValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.run, self.metadata = make_run(self.root)
        self.tile = self.run / "tiles/8/1/2.png"

    def rewrite(self):
        (self.run / "run.json").write_text(json.dumps(self.metadata))

    def reject_before_client(self):
        with patch("pipeline.publish.boto3.client") as client:
            with self.assertRaises((ValueError, TypeError, zlib.error)):
                publish_to_r2(self.run, self.metadata)
            client.assert_not_called()

    def test_accepts_real_pillow_output_and_expected_request(self):
        self.assertEqual(validate_artifact(self.root, tiles=["32tps"], as_of="2026-02-10"),
                         (self.run, self.metadata))

    def test_rejects_secret_code_and_unexpected_paths_before_client(self):
        for name in (".env", "sitecustomize.py", "tiles/8/1/secret.txt"):
            with self.subTest(name=name):
                path = self.run / name
                path.write_text("synthetic marker")
                self.reject_before_client()
                path.unlink()

    def test_rejects_file_directory_and_root_symlinks(self):
        outside = self.root / "outside.png"
        self.tile.rename(outside)
        self.tile.symlink_to(outside)
        self.reject_before_client()
        self.tile.unlink()
        outside.rename(self.tile)
        link = self.run / "tiles/9"
        link.symlink_to(self.run / "tiles/8", target_is_directory=True)
        self.reject_before_client()
        link.unlink()
        alias = self.root / "alias"
        alias.symlink_to(self.run, target_is_directory=True)
        with self.assertRaises(ValueError):
            validate_run(alias)

    def test_rejects_hardlinks(self):
        outside = self.root / "outside.png"
        os.link(self.tile, outside)
        self.reject_before_client()

    def test_rejects_malformed_and_oversized_png_without_upload(self):
        original = self.tile.read_bytes()
        for data in (b"not an image", original + b"appended secret", original[:-1],
                     b"x" * (1024**2 + 1)):
            with self.subTest(length=len(data)):
                self.tile.write_bytes(data)
                self.reject_before_client()

    def test_rejects_decompression_bomb_with_valid_chunk_crc(self):
        def chunk(kind, payload):
            return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))
        self.tile.write_bytes(b"\x89PNG\r\n\x1a\n" +
            chunk(b"IHDR", struct.pack(">IIBBBBB", 256, 256, 8, 6, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(b"\0" * 2_000_000)) + chunk(b"IEND", b""))
        self.reject_before_client()

    def test_rejects_invalid_metadata_and_unknown_fields(self):
        original = dict(self.metadata)
        changes = [("runId", "../../elsewhere"), ("schemaVersion", True),
                   ("bounds", [0, 0, float("nan"), 20]), ("tileCount", 99),
                   ("sourceProductCounts", {"32TPS": 999}), ("notice", "private text"),
                   ("secret", "synthetic secret")]
        for key, value in changes:
            with self.subTest(key=key):
                self.metadata = {**original, key: value}
                self.rewrite()
                self.reject_before_client()

    def test_rejects_duplicate_json_keys(self):
        path = self.run / "run.json"
        path.write_text(path.read_text().replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1'))
        self.reject_before_client()

    def test_rejects_missing_metadata_and_out_of_range_tile(self):
        self.tile.rename(self.tile.with_name("999.png"))
        self.reject_before_client()
        (self.run / "run.json").unlink()
        self.reject_before_client()

    def test_rejects_different_request_or_multiple_runs(self):
        for kwargs in ({}, {"tiles": ["33TUM"]}, {"tiles": ["32TPS"], "as_of": "2026-02-09"}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                validate_artifact(self.root, **kwargs)
        make_run(self.root, "20260211T120000Z")
        with self.assertRaises(ValueError):
            validate_artifact(self.root, tiles=["32TPS"])

    def test_cli_validation_needs_no_credentials_and_does_not_import_native_stack(self):
        script = '''
import sys
import pipeline.publish
assert not {'rasterio', 'numpy', 'PIL'} & sys.modules.keys()
sys.argv = ['publish', '--runs-dir', sys.argv[1], '--tiles', '32TPS', '--check-only']
pipeline.publish.main()
'''
        result = subprocess.run([sys.executable, "-c", script, str(self.root)],
            env={"PATH": os.environ.get("PATH", ""), "PYTHONDONTWRITEBYTECODE": "1"},
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Validated run", result.stdout)

    def test_metadata_mismatch_and_invalid_retention_fail_before_client(self):
        for metadata, keep in (({**self.metadata, "tileCount": 2}, 7), (self.metadata, 0)):
            with patch("pipeline.publish.boto3.client") as client, self.assertRaises(ValueError):
                publish_to_r2(self.run, metadata, keep_runs=keep)
            client.assert_not_called()


if __name__ == "__main__":
    unittest.main()
