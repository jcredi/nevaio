"""Tests for publishing the sharded OSM object index to R2.

Style follows ``test_publish.py``: a small in-memory fake S3 client records
call order, and every test builds its own tiny artifact directory rather than
depending on a real one. No network.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from nevaio_pipeline.publish_object_index import (
    publish_object_index_to_r2,
    validate_object_index_dir,
)

ENV = {
    "R2_ACCOUNT_ID": "account",
    "R2_BUCKET": "snow",
    "R2_PUBLIC_BASE_URL": "https://snow.example.test/",
    "R2_ACCESS_KEY_ID": "key",
    "R2_SECRET_ACCESS_KEY": "secret",
}


def shard_document(tile: str, objects: list[dict]) -> dict:
    return {"schemaVersion": 1, "tile": tile, "objects": objects}


def serialize(document: dict) -> bytes:
    return (json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def make_object(object_id: str, longitude: float, latitude: float, **extra) -> dict:
    return {
        "id": object_id,
        "kind": "peak",
        "name": f"Object {object_id}",
        "longitude": longitude,
        "latitude": latitude,
        "elevationMeters": None,
        **extra,
    }


def write_artifact(root: Path, shards: dict[str, list[dict]]) -> None:
    """Write a valid sharded index artifact - the shape build_sharded_index produces."""
    import hashlib

    (root / "objects").mkdir(parents=True, exist_ok=True)
    shard_entries = []
    for tile, objects in shards.items():
        payload = serialize(shard_document(tile, objects))
        (root / "objects" / f"{tile}.json").write_bytes(payload)
        longitudes = [o["longitude"] for o in objects]
        latitudes = [o["latitude"] for o in objects]
        shard_entries.append({
            "tile": tile,
            "path": f"objects/{tile}.json",
            "objectCount": len(objects),
            "bounds": [min(longitudes), min(latitudes), max(longitudes), max(latitudes)],
            "bytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        })
    index = {
        "schemaVersion": 1,
        "objectCount": sum(len(v) for v in shards.values()),
        "shards": sorted(shard_entries, key=lambda e: e["tile"]),
    }
    (root / "object-index.json").write_bytes(serialize(index))


class ValidateObjectIndexDirTests(unittest.TestCase):
    def test_accepts_a_well_formed_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_artifact(root, {
                "32TLR": [make_object("node/1", 7.1, 45.9), make_object("node/9", 7.15, 45.95)],
                "31TGL": [make_object("node/2", 6.9, 45.9), make_object("way/3", 6.95, 45.92)],
            })
            files = validate_object_index_dir(root)
        self.assertEqual(
            set(files),
            {"object-index.json", "objects/32TLR.json", "objects/31TGL.json"},
        )

    def test_rejects_missing_index_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, "missing object-index.json"):
                validate_object_index_dir(Path(tmp))

    def test_rejects_shard_byte_count_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_artifact(root, {"32TLR": [make_object("node/1", 7.1, 45.9), make_object("node/9", 7.15, 45.95)]})
            index_path = root / "object-index.json"
            index = json.loads(index_path.read_text())
            index["shards"][0]["bytes"] += 1
            index_path.write_bytes(serialize(index))
            with self.assertRaisesRegex(ValueError, "bytes, index says"):
                validate_object_index_dir(root)

    def test_rejects_shard_content_not_matching_its_sha256(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_artifact(root, {"32TLR": [make_object("node/1", 7.1, 45.9), make_object("node/9", 7.15, 45.95)]})
            shard_path = root / "objects" / "32TLR.json"
            tampered = shard_document("32TLR", [make_object("node/1", 7.1, 45.9), make_object("node/2", 7.2, 45.9)])
            payload = serialize(tampered)
            index = json.loads((root / "object-index.json").read_text())
            index["shards"][0]["bytes"] = len(payload)  # bytes match, but not the digest
            (root / "object-index.json").write_bytes(serialize(index))
            shard_path.write_bytes(payload)
            with self.assertRaisesRegex(ValueError, "does not match its published sha256"):
                validate_object_index_dir(root)

    def test_rejects_object_count_mismatch_between_index_and_shards(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_artifact(root, {"32TLR": [make_object("node/1", 7.1, 45.9), make_object("node/9", 7.15, 45.95)]})
            index_path = root / "object-index.json"
            index = json.loads(index_path.read_text())
            index["objectCount"] = 99
            index_path.write_bytes(serialize(index))
            with self.assertRaisesRegex(ValueError, "shards list 2 objects but objectCount is 99"):
                validate_object_index_dir(root)

    def test_rejects_orphan_shard_file_not_named_by_the_index(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_artifact(root, {"32TLR": [make_object("node/1", 7.1, 45.9), make_object("node/9", 7.15, 45.95)]})
            (root / "objects" / "33TUN.json").write_bytes(serialize(shard_document("33TUN", [])))
            with self.assertRaisesRegex(ValueError, "objects/ directory holds files"):
                validate_object_index_dir(root)

    def test_rejects_malformed_tile_designator(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_artifact(root, {"32TLR": [make_object("node/1", 7.1, 45.9), make_object("node/9", 7.15, 45.95)]})
            index_path = root / "object-index.json"
            index = json.loads(index_path.read_text())
            index["shards"][0]["tile"] = "not-a-tile"
            index_path.write_bytes(serialize(index))
            with self.assertRaisesRegex(ValueError, "not an MGRS square"):
                validate_object_index_dir(root)

    def test_rejects_duplicate_object_id_within_a_shard(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_artifact(root, {"32TLR": [make_object("node/1", 7.1, 45.9), make_object("node/1", 7.2, 45.8)]})
            with self.assertRaisesRegex(ValueError, "duplicate object id"):
                validate_object_index_dir(root)

    def test_rejects_unknown_kind(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_artifact(root, {"32TLR": [
                make_object("node/1", 7.1, 45.9, kind="volcano"),
                make_object("node/9", 7.15, 45.95),
            ]})
            with self.assertRaisesRegex(ValueError, "unknown kind"):
                validate_object_index_dir(root)


class FakePaginator:
    def __init__(self, client: "FakeS3Client") -> None:
        self.client = client

    def paginate(self, **kwargs):
        prefix = kwargs["Prefix"]
        keys = sorted(k for k in self.client.objects if k.startswith(prefix))
        return [{"Contents": [{"Key": key} for key in keys]}]


class FakeS3Client:
    def __init__(self, existing_keys: list[str] | None = None) -> None:
        self.objects: dict[str, bytes] = {key: b"{}" for key in existing_keys or []}
        self.calls: list[tuple[str, str]] = []
        self.puts: list[dict[str, object]] = []
        self.deletes: list[dict[str, object]] = []

    def put_object(self, **kwargs) -> None:
        self.calls.append(("put", kwargs["Key"]))
        self.puts.append(kwargs)
        self.objects[kwargs["Key"]] = kwargs["Body"]

    def get_paginator(self, _name: str) -> FakePaginator:
        return FakePaginator(self)

    def delete_objects(self, **kwargs) -> None:
        self.deletes.append(kwargs)
        for item in kwargs["Delete"]["Objects"]:
            self.calls.append(("delete", item["Key"]))
            self.objects.pop(item["Key"], None)

    def order(self, op: str, key: str) -> int:
        return self.calls.index((op, key))

    def deleted_keys(self) -> list[str]:
        return [key for op, key in self.calls if op == "delete"]


def publish(root: Path, client: FakeS3Client, **kwargs):
    with patch.dict("os.environ", ENV, clear=True), patch(
        "nevaio_pipeline.publish_object_index.boto3.client", return_value=client
    ) as make_client:
        return publish_object_index_to_r2(root, **kwargs), make_client


class PublishObjectIndexTests(unittest.TestCase):
    def test_uploads_shards_before_the_entry_point(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_artifact(root, {
                "32TLR": [make_object("node/1", 7.1, 45.9), make_object("node/9", 7.15, 45.95)],
                "31TGL": [make_object("node/2", 6.9, 45.9), make_object("node/8", 6.95, 45.92)],
            })
            client = FakeS3Client()
            result, make_client = publish(root, client)

        make_client.assert_called_once_with(
            "s3",
            endpoint_url="https://account.r2.cloudflarestorage.com",
            aws_access_key_id="key",
            aws_secret_access_key="secret",
            region_name="auto",
        )
        self.assertEqual(
            sorted(key for op, key in client.calls if op == "put"),
            [
                "object-index/object-index.json",
                "object-index/objects/31TGL.json",
                "object-index/objects/32TLR.json",
            ],
        )
        last_shard = max(
            client.order("put", f"object-index/objects/{t}.json") for t in ("31TGL", "32TLR")
        )
        self.assertLess(last_shard, client.order("put", "object-index/object-index.json"))
        self.assertEqual(result["indexUrl"], "https://snow.example.test/object-index/object-index.json")
        self.assertEqual(result["objectCount"], 4)
        self.assertEqual(result["shardCount"], 2)
        self.assertEqual(result["deletedStaleKeys"], [])

    def test_deletes_stale_shards_no_longer_named_by_a_shrunk_footprint(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_artifact(root, {"32TLR": [make_object("node/1", 7.1, 45.9), make_object("node/9", 7.15, 45.95)]})
            client = FakeS3Client(existing_keys=[
                "object-index/object-index.json",
                "object-index/objects/32TLR.json",
                "object-index/objects/99ZZZ.json",  # stale: not in the new build
            ])
            result, _ = publish(root, client)

        self.assertEqual(result["deletedStaleKeys"], ["object-index/objects/99ZZZ.json"])
        self.assertNotIn("object-index/objects/99ZZZ.json", client.objects)
        # Deletion of the stale key happens after the new pointer is live.
        self.assertLess(
            client.order("put", "object-index/object-index.json"),
            client.order("delete", "object-index/objects/99ZZZ.json"),
        )

    def test_never_touches_slot_maps_when_footprint_shrinks(self) -> None:
        """Regression guard: stale-shard cleanup must never sweep slots/.

        `nevaio_pipeline.publish_object_series` publishes permanent per-tile
        slot maps to `object-index/slots/<TILE>.json` - beside this
        publisher's own artifact, in the same bucket prefix. A slot map is
        never named by anything this publisher uploads, so if stale-key
        cleanup ever went back to diffing the *whole* `object-index/` prefix
        instead of just its `objects/` subdirectory, every slot map would
        look exactly like an orphaned shard and get deleted the next time the
        OSM extracts refresh - silently invalidating every previously
        published series byte offset. That is exactly the kind of bug that
        never surfaces as an error, so it is pinned here.
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_artifact(root, {"32TLR": [make_object("node/1", 7.1, 45.9), make_object("node/9", 7.15, 45.95)]})
            client = FakeS3Client(existing_keys=[
                "object-index/object-index.json",
                "object-index/objects/32TLR.json",
                "object-index/slots/32TLR.json",
                "object-index/slots/31TGL.json",
            ])
            result, _ = publish(root, client)

        self.assertEqual(result["deletedStaleKeys"], [])
        self.assertIn("object-index/slots/32TLR.json", client.objects)
        self.assertIn("object-index/slots/31TGL.json", client.objects)

    def test_never_touches_snow_snapshot_keys(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_artifact(root, {"32TLR": [make_object("node/1", 7.1, 45.9), make_object("node/9", 7.15, 45.95)]})
            client = FakeS3Client(existing_keys=[
                "latest.json", "dates.json", "runs/20260101T000000Z/run.json",
            ])
            publish(root, client)

        for untouched in ("latest.json", "dates.json", "runs/20260101T000000Z/run.json"):
            self.assertIn(untouched, client.objects)
        self.assertEqual(client.deleted_keys(), [])

    def test_custom_prefix_is_honoured(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_artifact(root, {"32TLR": [make_object("node/1", 7.1, 45.9), make_object("node/9", 7.15, 45.95)]})
            client = FakeS3Client()
            result, _ = publish(root, client, prefix="objects-preview")

        self.assertTrue(all(key.startswith("objects-preview/") for key in client.objects))
        self.assertEqual(result["indexUrl"], "https://snow.example.test/objects-preview/object-index.json")

    def test_a_bad_artifact_is_never_uploaded(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_artifact(root, {"32TLR": [make_object("node/1", 7.1, 45.9), make_object("node/9", 7.15, 45.95)]})
            index_path = root / "object-index.json"
            index = json.loads(index_path.read_text())
            index["objectCount"] = 99
            index_path.write_bytes(serialize(index))
            client = FakeS3Client()
            with patch.dict("os.environ", ENV, clear=True), patch(
                "nevaio_pipeline.publish_object_index.boto3.client", return_value=client
            ):
                with self.assertRaises(ValueError):
                    publish_object_index_to_r2(root)
        self.assertEqual(client.puts, [])


if __name__ == "__main__":
    unittest.main()
