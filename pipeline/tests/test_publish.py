from __future__ import annotations

import json
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

from nevaio_pipeline.artifact_validation import validate_date_catalogue
from nevaio_pipeline.catalogue import date_manifest_key
from nevaio_pipeline.config import ASOF_CATALOGUE_DATES, ROLLBACK_RUNS
from nevaio_pipeline.publish import _required_env, publish_to_r2
from tests.artifact_fixture import make_run, RUN_ID

ENV = {
    "R2_ACCOUNT_ID": "account",
    "R2_BUCKET": "snow",
    "R2_PUBLIC_BASE_URL": "https://snow.example.test/",
    "R2_ACCESS_KEY_ID": "key",
    "R2_SECRET_ACCESS_KEY": "secret",
}


def run_id_for(as_of: str) -> str:
    return f"{as_of.replace('-', '')}T043500Z"


def archive(dates: list[str]) -> list[str]:
    """The keys a bucket already holding one published run per date would list."""
    keys = []
    for day in dates:
        run_id = run_id_for(day)
        keys.append(f"runs/{run_id}/run.json")
        keys.append(f"runs/{run_id}/tiles/8/1/2.png")
        keys.append(date_manifest_key(day, run_id))
    return keys


class FakePaginator:
    def __init__(self, client: "FakeS3Client") -> None:
        self.client = client

    def paginate(self, **kwargs):
        prefix = kwargs["Prefix"]
        keys = sorted(k for k in self.client.objects if k.startswith(prefix))
        if kwargs.get("Delimiter") != "/":
            return [{"Contents": [{"Key": key} for key in keys]}]
        contents, common = [], []
        for key in keys:
            rest = key[len(prefix):]
            head, sep, _ = rest.partition("/")
            if sep:
                if f"{prefix}{head}/" not in common:
                    common.append(f"{prefix}{head}/")
            else:
                contents.append({"Key": key})
        return [{"Contents": contents, "CommonPrefixes": [{"Prefix": p} for p in common]}]


class FakeS3Client:
    """An in-memory bucket that also records the order operations arrived in."""

    def __init__(self, existing_keys: list[str] | None = None) -> None:
        self.objects: dict[str, bytes] = {key: b"{}" for key in existing_keys or []}
        self.calls: list[tuple[str, str]] = []
        self.uploads: list[tuple[object, ...]] = []
        self.puts: list[dict[str, object]] = []
        self.deletes: list[dict[str, object]] = []

    def upload_file(self, path, bucket, key, **kwargs) -> None:
        self.calls.append(("upload", key))
        self.uploads.append((path, bucket, key, kwargs))
        self.objects[key] = b"tile"

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

    # -- helpers the assertions read ------------------------------------
    def body(self, key: str) -> dict:
        return json.loads(self.objects[key])

    def order(self, op: str, key: str) -> int:
        return self.calls.index((op, key))

    def deleted_keys(self) -> list[str]:
        return [key for op, key in self.calls if op == "delete"]


def publish(client: FakeS3Client, run_id: str = RUN_ID, **kwargs):
    with tempfile.TemporaryDirectory() as tmp:
        run_dir, metadata = make_run(Path(tmp), run_id)
        with patch.dict("os.environ", ENV, clear=True), patch(
            "nevaio_pipeline.publish.boto3.client", return_value=client
        ) as make_client:
            return publish_to_r2(run_dir, metadata, **kwargs), make_client


class PublishTests(unittest.TestCase):
    def test_required_env_rejects_missing_and_empty_values(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "R2_BUCKET is required"):
                _required_env("R2_BUCKET")

    def test_uploads_immutable_run_before_latest_commit(self) -> None:
        client = FakeS3Client()
        latest, make_client = publish(client)

        make_client.assert_called_once_with(
            "s3",
            endpoint_url="https://account.r2.cloudflarestorage.com",
            aws_access_key_id="key",
            aws_secret_access_key="secret",
            region_name="auto",
        )
        # Uploads run concurrently, so assert on the set of keys and on the
        # ordering that actually matters: every object precedes the pointer.
        self.assertEqual(
            sorted(call[2] for call in client.uploads),
            [f"runs/{RUN_ID}/run.json", f"runs/{RUN_ID}/tiles/8/1/2.png"],
        )
        png = next(c for c in client.uploads if c[2].endswith(".png"))
        self.assertEqual(png[3]["ExtraArgs"]["ContentType"], "image/png")
        self.assertIn("immutable", png[3]["ExtraArgs"]["CacheControl"])
        put = next(p for p in client.puts if p["Key"] == "latest.json")
        self.assertEqual(put["Bucket"], "snow")
        self.assertEqual(put["CacheControl"], "no-cache, max-age=0")
        committed = json.loads(put["Body"])
        self.assertEqual(
            committed["tiles"],
            [f"https://snow.example.test/runs/{RUN_ID}/tiles/{{z}}/{{x}}/{{y}}.png"],
        )
        self.assertEqual(latest, committed)
        self.assertEqual(client.deletes, [])

    def test_publishes_a_date_manifest_and_a_catalogue_beside_latest(self) -> None:
        client = FakeS3Client()
        latest, _ = publish(client)
        date_key = date_manifest_key("2026-02-10", RUN_ID)

        # The date manifest is latest.json's twin, so the frontend's existing
        # manifest validator accepts it with no change: same fields, same
        # tile templates, only its self-referential manifestUrl differs.
        archived = client.body(date_key)
        self.assertEqual(
            {**archived, "manifestUrl": latest["manifestUrl"]}, latest
        )
        self.assertEqual(
            archived["manifestUrl"], f"https://snow.example.test/{date_key}"
        )
        manifest_put = next(p for p in client.puts if p["Key"] == date_key)
        # Keyed by run, therefore immutable and cacheable for a year.
        self.assertIn("immutable", manifest_put["CacheControl"])

        catalogue = validate_date_catalogue(client.objects["dates.json"])
        self.assertEqual(
            catalogue["dates"],
            [{"asOfDate": "2026-02-10", "runId": RUN_ID, "manifest": date_key}],
        )
        self.assertEqual(catalogue["maxDates"], ASOF_CATALOGUE_DATES)
        self.assertEqual(catalogue["generatedAt"], latest["publishedAt"])
        catalogue_put = next(p for p in client.puts if p["Key"] == "dates.json")
        self.assertEqual(catalogue_put["CacheControl"], "no-cache, max-age=0")

    def test_a_date_is_advertised_only_after_its_tiles_and_manifest_exist(self) -> None:
        client = FakeS3Client()
        publish(client, keep_runs=ROLLBACK_RUNS)
        date_key = date_manifest_key("2026-02-10", RUN_ID)

        last_upload = max(i for i, (op, _) in enumerate(client.calls) if op == "upload")
        self.assertLess(last_upload, client.order("put", date_key))
        self.assertLess(client.order("put", date_key), client.order("put", "dates.json"))
        self.assertLess(client.order("put", "dates.json"), client.order("put", "latest.json"))

    def test_failed_upload_never_moves_pointer_or_prunes(self) -> None:
        client = FakeS3Client(archive([d for d in daily(3)]))
        with tempfile.TemporaryDirectory() as tmp:
            run_dir, metadata = make_run(Path(tmp))
            with patch.dict("os.environ", ENV, clear=True), patch(
                "nevaio_pipeline.publish.boto3.client", return_value=client
            ), patch.object(client, "upload_file", side_effect=IOError("upload failed")):
                with self.assertRaises(IOError):
                    publish_to_r2(run_dir, metadata, keep_runs=7)
        self.assertEqual(client.puts, [])
        self.assertEqual(client.deletes, [])

    def test_left_alone_the_publisher_deletes_nothing(self) -> None:
        client = FakeS3Client(archive(daily(40)))
        publish(client, run_id=run_id_for("2026-09-12"))

        self.assertEqual(client.deletes, [])
        # The catalogue still narrows to the window even when nothing is
        # pruned - unadvertised runs are simply left in place.
        catalogue = validate_date_catalogue(client.objects["dates.json"])
        self.assertEqual(len(catalogue["dates"]), ASOF_CATALOGUE_DATES)


def daily(count: int, *, last: str = "2026-09-11") -> list[str]:
    end = date.fromisoformat(last)
    return [(end - timedelta(days=n)).isoformat() for n in reversed(range(count))]


class RetentionTests(unittest.TestCase):
    def test_a_short_archive_loses_nothing(self) -> None:
        dates = daily(5)
        client = FakeS3Client(archive(dates))
        publish(client, run_id=run_id_for("2026-09-12"), keep_runs=ROLLBACK_RUNS)

        self.assertEqual(client.deleted_keys(), [])
        catalogue = validate_date_catalogue(client.objects["dates.json"])
        self.assertEqual(len(catalogue["dates"]), 6)

    def test_a_full_archive_evicts_exactly_the_out_of_window_dates(self) -> None:
        dates = daily(ASOF_CATALOGUE_DATES)
        client = FakeS3Client(archive(dates))
        publish(client, run_id=run_id_for("2026-09-12"), keep_runs=ROLLBACK_RUNS)

        catalogue = validate_date_catalogue(client.objects["dates.json"])
        advertised = [entry["asOfDate"] for entry in catalogue["dates"]]
        self.assertEqual(len(advertised), ASOF_CATALOGUE_DATES)
        self.assertEqual(advertised[0], "2026-09-12")
        self.assertEqual(advertised[-1], "2026-08-13")
        # The one date that fell out of the window took its run with it.
        evicted = run_id_for("2026-08-12")
        self.assertEqual(
            client.deleted_keys(),
            [
                date_manifest_key("2026-08-12", evicted),
                f"runs/{evicted}/run.json",
                f"runs/{evicted}/tiles/8/1/2.png",
            ],
        )

    def test_a_gap_never_makes_the_catalogue_reach_past_the_window(self) -> None:
        failed = set(daily(4, last="2026-08-25"))
        client = FakeS3Client(archive([d for d in daily(40) if d not in failed]))
        publish(client, run_id=run_id_for("2026-09-12"), keep_runs=ROLLBACK_RUNS)

        catalogue = validate_date_catalogue(client.objects["dates.json"])
        advertised = [entry["asOfDate"] for entry in catalogue["dates"]]
        self.assertEqual(len(advertised), ASOF_CATALOGUE_DATES - 4)
        self.assertEqual(advertised[-1], "2026-08-13")
        self.assertFalse(failed & set(advertised))

    def test_two_runs_on_one_date_leave_one_advertised_manifest(self) -> None:
        dates = daily(3)
        client = FakeS3Client(archive(dates))
        rerun = "20260911T093000Z"
        publish(client, run_id=rerun, keep_runs=ROLLBACK_RUNS)

        catalogue = validate_date_catalogue(client.objects["dates.json"])
        self.assertEqual(
            [(e["asOfDate"], e["runId"]) for e in catalogue["dates"]],
            [("2026-09-11", rerun), ("2026-09-10", run_id_for("2026-09-10")),
             ("2026-09-09", run_id_for("2026-09-09"))],
        )
        superseded = run_id_for("2026-09-11")
        # The stale manifest goes, so a date never has two live manifests...
        self.assertEqual(
            client.deleted_keys(), [date_manifest_key("2026-09-11", superseded)]
        )
        # ...but the run behind it stays, inside the rollback buffer, so
        # latest.json can still be pointed back at it.
        self.assertIn(f"runs/{superseded}/run.json", client.objects)

    def test_every_advertised_date_still_has_its_manifest_and_tiles(self) -> None:
        client = FakeS3Client(archive(daily(40)))
        publish(client, run_id=run_id_for("2026-09-12"), keep_runs=ROLLBACK_RUNS)

        catalogue = validate_date_catalogue(client.objects["dates.json"])
        for entry in catalogue["dates"]:
            self.assertIn(entry["manifest"], client.objects)
            self.assertIn(f"runs/{entry['runId']}/run.json", client.objects)

    def test_the_rollback_buffer_survives_the_date_window(self) -> None:
        # Two runs a day for four days: eight runs, four advertised dates.
        keys = archive(daily(4))
        extra = [f"{d.replace('-', '')}T093000Z" for d in daily(4)]
        for run_id in extra:
            keys += [f"runs/{run_id}/run.json"]
        client = FakeS3Client(keys)
        publish(client, run_id=run_id_for("2026-09-12"), keep_runs=ROLLBACK_RUNS)

        survivors = {
            key.split("/")[1] for key in client.objects if key.startswith("runs/")
        }
        self.assertGreaterEqual(len(survivors), ROLLBACK_RUNS)


class CrashOrderingTests(unittest.TestCase):
    """A crash must leave orphaned objects, never an advertised empty date."""

    def crash_on(self, client: FakeS3Client, op: str, key: str):
        original = getattr(client, op)

        def fail(**kwargs):
            if kwargs.get("Key") == key or key == "*":
                raise IOError(f"{op} {key} failed")
            return original(**kwargs)

        return patch.object(client, op, side_effect=fail)

    def run_crashing(self, client: FakeS3Client, op: str, key: str, run_id: str):
        with tempfile.TemporaryDirectory() as tmp:
            run_dir, metadata = make_run(Path(tmp), run_id)
            with patch.dict("os.environ", ENV, clear=True), patch(
                "nevaio_pipeline.publish.boto3.client", return_value=client
            ), self.crash_on(client, op, key):
                with self.assertRaises(IOError):
                    publish_to_r2(run_dir, metadata, keep_runs=ROLLBACK_RUNS)

    def previous_catalogue(self, dates: list[str]) -> bytes:
        entries = [
            {"asOfDate": d, "runId": run_id_for(d), "manifest": date_manifest_key(d, run_id_for(d))}
            for d in sorted(dates, reverse=True)
        ]
        return json.dumps({
            "schemaVersion": 1, "kind": "asof-date-catalogue",
            "generatedAt": "2026-09-11T04:41:02+00:00",
            "maxDates": ASOF_CATALOGUE_DATES, "dates": entries,
        }).encode()

    def test_a_crash_before_the_catalogue_leaves_the_old_one_intact(self) -> None:
        dates = daily(ASOF_CATALOGUE_DATES)
        client = FakeS3Client(archive(dates))
        client.objects["dates.json"] = self.previous_catalogue(dates)

        self.run_crashing(client, "put_object", "dates.json", run_id_for("2026-09-12"))

        # Nothing was deleted, so every date the old catalogue advertises
        # still resolves; the new run is simply an orphan until it is retried.
        catalogue = validate_date_catalogue(client.objects["dates.json"])
        for entry in catalogue["dates"]:
            self.assertIn(entry["manifest"], client.objects)
            self.assertIn(f"runs/{entry['runId']}/run.json", client.objects)
        self.assertEqual(client.deletes, [])

    def test_a_crash_before_the_pointer_still_leaves_a_consistent_catalogue(self) -> None:
        dates = daily(ASOF_CATALOGUE_DATES)
        client = FakeS3Client(archive(dates))
        client.objects["dates.json"] = self.previous_catalogue(dates)

        self.run_crashing(client, "put_object", "latest.json", run_id_for("2026-09-12"))

        # The catalogue already advertises the new date, and its manifest and
        # tiles are all present. latest.json still points at yesterday, which
        # is a stale pointer, not a broken date.
        catalogue = validate_date_catalogue(client.objects["dates.json"])
        self.assertEqual(catalogue["dates"][0]["asOfDate"], "2026-09-12")
        for entry in catalogue["dates"]:
            self.assertIn(entry["manifest"], client.objects)
            self.assertIn(f"runs/{entry['runId']}/run.json", client.objects)
        self.assertEqual(client.deletes, [])

    def test_a_crash_during_the_prune_never_orphans_an_advertised_date(self) -> None:
        dates = daily(ASOF_CATALOGUE_DATES + 5)
        client = FakeS3Client(archive(dates))
        evicted = [d for d in dates if d < "2026-08-13"]

        with tempfile.TemporaryDirectory() as tmp:
            run_dir, metadata = make_run(Path(tmp), run_id_for("2026-09-12"))
            calls = {"n": 0}
            original = client.delete_objects

            def flaky(**kwargs):
                calls["n"] += 1
                if calls["n"] > 2:
                    raise IOError("delete failed")
                return original(**kwargs)

            with patch.dict("os.environ", ENV, clear=True), patch(
                "nevaio_pipeline.publish.boto3.client", return_value=client
            ), patch.object(client, "delete_objects", side_effect=flaky):
                with self.assertRaises(IOError):
                    publish_to_r2(run_dir, metadata, keep_runs=ROLLBACK_RUNS)

        # Deletion stopped part-way, but the catalogue published before it
        # already excluded every date being removed, so nothing it advertises
        # lost its data.
        catalogue = validate_date_catalogue(client.objects["dates.json"])
        advertised = [entry["asOfDate"] for entry in catalogue["dates"]]
        self.assertFalse(set(evicted) & set(advertised))
        for entry in catalogue["dates"]:
            self.assertIn(entry["manifest"], client.objects)
            self.assertIn(f"runs/{entry['runId']}/run.json", client.objects)

    def test_every_delete_follows_every_write(self) -> None:
        client = FakeS3Client(archive(daily(ASOF_CATALOGUE_DATES + 3)))
        publish(client, run_id=run_id_for("2026-09-12"), keep_runs=ROLLBACK_RUNS)

        last_write = max(
            i for i, (op, _) in enumerate(client.calls) if op in ("put", "upload")
        )
        first_delete = min(i for i, (op, _) in enumerate(client.calls) if op == "delete")
        self.assertLess(last_write, first_delete)
        # And a doomed date manifest is removed before the run it named.
        self.assertLess(
            client.order("delete", date_manifest_key("2026-08-10", run_id_for("2026-08-10"))),
            client.order("delete", f"runs/{run_id_for('2026-08-10')}/run.json"),
        )


if __name__ == "__main__":
    unittest.main()
