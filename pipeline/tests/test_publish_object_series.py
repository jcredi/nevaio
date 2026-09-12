"""Tests for publishing the per-object GFSC series and slot maps to R2.

Style follows ``test_publish_object_index.py``: a small in-memory fake S3
client records call order, and every test builds its own tiny local
directory rather than depending on a real one. No network.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from nevaio_pipeline.object_series import CELL_SIZE, days_in_month
from nevaio_pipeline.publish_object_series import (
    publish_object_series_to_r2,
    validate_object_series_dirs,
)

ENV = {
    "R2_ACCOUNT_ID": "account",
    "R2_BUCKET": "snow",
    "R2_PUBLIC_BASE_URL": "https://snow.example.test/",
    "R2_ACCESS_KEY_ID": "key",
    "R2_SECRET_ACCESS_KEY": "secret",
}


def slot_document(tile: str, slot_ids: list[str]) -> dict:
    return {"schemaVersion": 1, "tile": tile, "slotCount": len(slot_ids), "slotIds": slot_ids}


def month_bytes(slot_count: int, year: int, month: int) -> bytes:
    return b"\x00" * (slot_count * days_in_month(year, month) * CELL_SIZE)


def write_series(series_dir: Path, tile: str, year: int, month: int, slot_count: int) -> None:
    (series_dir / tile).mkdir(parents=True, exist_ok=True)
    (series_dir / tile / f"{year:04d}-{month:02d}.bin").write_bytes(month_bytes(slot_count, year, month))


def write_slots(slots_dir: Path, tile: str, slot_ids: list[str]) -> None:
    slots_dir.mkdir(parents=True, exist_ok=True)
    (slots_dir / f"{tile}.json").write_text(json.dumps(slot_document(tile, slot_ids)))


class ValidateObjectSeriesDirsTests(unittest.TestCase):
    def test_both_directories_absent_is_not_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            series_files, slot_files = validate_object_series_dirs(root / "series", root / "slots")
        self.assertEqual(series_files, {})
        self.assertEqual(slot_files, {})

    def test_accepts_a_well_formed_batch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_series(root / "series", "32TLR", 2026, 3, slot_count=2)
            write_slots(root / "slots", "32TLR", ["node/1", "node/9"])
            series_files, slot_files = validate_object_series_dirs(root / "series", root / "slots")
        self.assertEqual(set(series_files), {"32TLR/2026-03.bin"})
        self.assertEqual(set(slot_files), {"32TLR.json"})

    def test_rejects_a_month_file_not_a_whole_number_of_slots(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            series_dir = root / "series" / "32TLR"
            series_dir.mkdir(parents=True)
            (series_dir / "2026-03.bin").write_bytes(b"\x00" * 3)  # not a multiple of 31*2
            with self.assertRaisesRegex(ValueError, "not a whole number of object slots"):
                validate_object_series_dirs(root / "series", root / "slots")

    def test_rejects_a_malformed_month_filename(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            series_dir = root / "series" / "32TLR"
            series_dir.mkdir(parents=True)
            (series_dir / "not-a-month.bin").write_bytes(month_bytes(1, 2026, 3))
            with self.assertRaisesRegex(ValueError, "not a <YYYY-MM>.bin name"):
                validate_object_series_dirs(root / "series", root / "slots")

    def test_rejects_a_malformed_tile_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            series_dir = root / "series" / "not-a-tile"
            series_dir.mkdir(parents=True)
            (series_dir / "2026-03.bin").write_bytes(month_bytes(1, 2026, 3))
            with self.assertRaisesRegex(ValueError, "is not an MGRS tile"):
                validate_object_series_dirs(root / "series", root / "slots")

    def test_rejects_a_slot_map_whose_tile_field_does_not_match_its_filename(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            slots_dir = root / "slots"
            slots_dir.mkdir(parents=True)
            (slots_dir / "32TLR.json").write_text(json.dumps(slot_document("31TGL", ["node/1"])))
            with self.assertRaisesRegex(ValueError, "does not match its filename"):
                validate_object_series_dirs(root / "series", slots_dir)

    def test_rejects_a_month_file_implying_more_slots_than_the_slot_map_has(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_series(root / "series", "32TLR", 2026, 3, slot_count=3)
            write_slots(root / "slots", "32TLR", ["node/1"])  # only 1 slot published
            with self.assertRaisesRegex(ValueError, "implies more object slots"):
                validate_object_series_dirs(root / "series", root / "slots")

    def test_a_series_file_with_no_matching_slot_map_is_accepted(self) -> None:
        """The slot map for a tile can be absent from this batch (unchanged today)."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_series(root / "series", "32TLR", 2026, 3, slot_count=2)
            series_files, slot_files = validate_object_series_dirs(root / "series", root / "slots")
        self.assertEqual(set(series_files), {"32TLR/2026-03.bin"})
        self.assertEqual(slot_files, {})


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

    def put_object(self, **kwargs) -> None:
        self.calls.append(("put", kwargs["Key"]))
        self.puts.append(kwargs)
        self.objects[kwargs["Key"]] = kwargs["Body"]

    def get_paginator(self, _name: str) -> FakePaginator:
        return FakePaginator(self)

    def order(self, op: str, key: str) -> int:
        return self.calls.index((op, key))


def publish(root: Path, client: FakeS3Client, series_subdir="series", slots_subdir="slots", **kwargs):
    with patch.dict("os.environ", ENV, clear=True), patch(
        "nevaio_pipeline.publish_object_series.boto3.client", return_value=client
    ) as make_client:
        return publish_object_series_to_r2(root / series_subdir, root / slots_subdir, **kwargs), make_client


class PublishObjectSeriesTests(unittest.TestCase):
    def test_publishes_nothing_and_touches_no_network_when_both_dirs_are_absent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            client = FakeS3Client()
            with patch.dict("os.environ", {}, clear=True), patch(
                "nevaio_pipeline.publish_object_series.boto3.client", return_value=client
            ) as make_client:
                result = publish_object_series_to_r2(root / "series", root / "slots")
        self.assertEqual(result, {"seriesFilesPublished": 0, "slotFilesPublished": 0, "tiles": []})
        make_client.assert_not_called()
        self.assertEqual(client.puts, [])

    def test_uploads_series_before_slot_maps(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_series(root / "series", "32TLR", 2026, 3, slot_count=2)
            write_slots(root / "slots", "32TLR", ["node/1", "node/9"])
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
            ["object-index/slots/32TLR.json", "series/32TLR/2026-03.bin"],
        )
        self.assertLess(
            client.order("put", "series/32TLR/2026-03.bin"),
            client.order("put", "object-index/slots/32TLR.json"),
        )
        self.assertEqual(result["seriesFilesPublished"], 1)
        self.assertEqual(result["slotFilesPublished"], 1)
        self.assertEqual(result["tiles"], ["32TLR"])
        self.assertEqual(result["seriesBaseUrl"], "https://snow.example.test/series")
        self.assertEqual(result["slotsBaseUrl"], "https://snow.example.test/object-index/slots")

    def test_never_touches_snow_snapshot_or_object_index_keys(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_series(root / "series", "32TLR", 2026, 3, slot_count=1)
            client = FakeS3Client(existing_keys=[
                "latest.json", "dates.json", "runs/20260101T000000Z/run.json",
                "object-index/object-index.json", "object-index/objects/32TLR.json",
            ])
            publish(root, client)

        for untouched in (
            "latest.json", "dates.json", "runs/20260101T000000Z/run.json",
            "object-index/object-index.json", "object-index/objects/32TLR.json",
        ):
            self.assertIn(untouched, client.objects)

    def test_nothing_is_ever_deleted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_series(root / "series", "32TLR", 2026, 3, slot_count=1)
            client = FakeS3Client(existing_keys=["series/32TLR/2026-02.bin", "object-index/slots/31TGL.json"])
            publish(root, client)

        self.assertIn("series/32TLR/2026-02.bin", client.objects)
        self.assertIn("object-index/slots/31TGL.json", client.objects)

    def test_a_bad_batch_is_never_uploaded(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_series(root / "series", "32TLR", 2026, 3, slot_count=3)
            write_slots(root / "slots", "32TLR", ["node/1"])  # inconsistent: too few slots
            client = FakeS3Client()
            with patch.dict("os.environ", ENV, clear=True), patch(
                "nevaio_pipeline.publish_object_series.boto3.client", return_value=client
            ):
                with self.assertRaises(ValueError):
                    publish_object_series_to_r2(root / "series", root / "slots")
        self.assertEqual(client.puts, [])


if __name__ == "__main__":
    unittest.main()
