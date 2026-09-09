from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from nevaio_pipeline.publish import _prune_old_runs, _required_env, publish_to_r2
from tests.artifact_fixture import make_run, RUN_ID


class FakePaginator:
    def __init__(self, existing_runs: dict[str, list[str]]) -> None:
        self.existing_runs = existing_runs

    def paginate(self, **kwargs):
        prefix, delimiter = kwargs["Prefix"], kwargs.get("Delimiter")
        if delimiter == "/":
            return [
                {
                    "CommonPrefixes": [
                        {"Prefix": f"runs/{run_id}/"} for run_id in self.existing_runs
                    ]
                }
            ]
        run_id = prefix.removeprefix("runs/").rstrip("/")
        return [{"Contents": [{"Key": key} for key in self.existing_runs.get(run_id, [])]}]


class FakeS3Client:
    def __init__(self, existing_runs: dict[str, list[str]] | None = None) -> None:
        self.uploads: list[tuple[object, ...]] = []
        self.puts: list[dict[str, object]] = []
        self.deletes: list[dict[str, object]] = []
        self.calls: list[str] = []
        self.existing_runs = existing_runs or {}

    def upload_file(self, *args, **kwargs) -> None:
        self.calls.append("upload")
        self.uploads.append((*args, kwargs))

    def put_object(self, **kwargs) -> None:
        self.calls.append("put")
        self.puts.append(kwargs)

    def get_paginator(self, _name: str) -> FakePaginator:
        return FakePaginator(self.existing_runs)

    def delete_objects(self, **kwargs) -> None:
        self.calls.append("delete")
        self.deletes.append(kwargs)


class PublishTests(unittest.TestCase):
    def test_required_env_rejects_missing_and_empty_values(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "R2_BUCKET is required"):
                _required_env("R2_BUCKET")

    def test_uploads_immutable_run_before_latest_commit(self) -> None:
        client = FakeS3Client()
        env = {
            "R2_ACCOUNT_ID": "account",
            "R2_BUCKET": "snow",
            "R2_PUBLIC_BASE_URL": "https://snow.example.test/",
            "R2_ACCESS_KEY_ID": "key",
            "R2_SECRET_ACCESS_KEY": "secret",
        }
        with tempfile.TemporaryDirectory() as tmp:
            run_dir, metadata = make_run(Path(tmp))
            with patch.dict("os.environ", env, clear=True), patch(
                "nevaio_pipeline.publish.boto3.client", return_value=client
            ) as make_client:
                latest = publish_to_r2(run_dir, metadata)

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
        self.assertEqual(client.calls[-1], "put")
        png = next(c for c in client.uploads if c[2].endswith(".png"))
        self.assertEqual(png[3]["ExtraArgs"]["ContentType"], "image/png")
        self.assertIn("immutable", png[3]["ExtraArgs"]["CacheControl"])
        self.assertEqual(len(client.puts), 1)
        put = client.puts[0]
        self.assertEqual((put["Bucket"], put["Key"]), ("snow", "latest.json"))
        self.assertEqual(put["CacheControl"], "no-cache, max-age=0")
        committed = json.loads(put["Body"])
        self.assertEqual(committed["tiles"], [f"https://snow.example.test/runs/{RUN_ID}/tiles/{{z}}/{{x}}/{{y}}.png"])
        self.assertEqual(latest, committed)
        self.assertEqual(client.deletes, [])


    def test_failed_upload_never_moves_pointer_or_prunes(self) -> None:
        client = FakeS3Client()
        env = {
            "R2_ACCOUNT_ID": "account", "R2_BUCKET": "snow",
            "R2_PUBLIC_BASE_URL": "https://snow.example.test/",
            "R2_ACCESS_KEY_ID": "key", "R2_SECRET_ACCESS_KEY": "secret",
        }
        with tempfile.TemporaryDirectory() as tmp:
            run_dir, metadata = make_run(Path(tmp))
            with patch.dict("os.environ", env, clear=True), patch(
                "nevaio_pipeline.publish.boto3.client", return_value=client
            ), patch.object(client, "upload_file", side_effect=IOError("upload failed")):
                with self.assertRaises(IOError):
                    publish_to_r2(run_dir, metadata, keep_runs=7)
        self.assertEqual(client.puts, [])
        self.assertEqual(client.deletes, [])


class PruneOldRunsTests(unittest.TestCase):
    def runs(self) -> dict[str, list[str]]:
        return {
            "20260820T000000Z": ["runs/20260820T000000Z/tiles/a.png"],
            "20260821T000000Z": ["runs/20260821T000000Z/tiles/b.png"],
            "20260822T000000Z": ["runs/20260822T000000Z/tiles/c.png"],
            "20260823T000000Z": ["runs/20260823T000000Z/tiles/d.png"],
        }

    def test_keeps_newest_runs_including_the_one_just_published(self) -> None:
        client = FakeS3Client(self.runs())

        doomed = _prune_old_runs(client, "snow", keep=2, current_run_id="20260823T000000Z")

        # Two kept: the just-published run plus the newest other one.
        self.assertEqual(doomed, ["20260821T000000Z", "20260820T000000Z"])
        self.assertEqual(
            [item["Key"] for call in client.deletes for item in call["Delete"]["Objects"]],
            ["runs/20260821T000000Z/tiles/b.png", "runs/20260820T000000Z/tiles/a.png"],
        )

    def test_never_deletes_the_published_run_even_if_it_sorts_oldest(self) -> None:
        client = FakeS3Client(self.runs())

        # A clock skew could stamp the new run behind the existing ones; keep=1
        # then means the published run is the only survivor.
        doomed = _prune_old_runs(client, "snow", keep=1, current_run_id="20260820T000000Z")

        self.assertNotIn("20260820T000000Z", doomed)
        self.assertEqual(
            doomed, ["20260823T000000Z", "20260822T000000Z", "20260821T000000Z"]
        )

    def test_rejects_a_retention_count_that_would_delete_everything(self) -> None:
        with self.assertRaisesRegex(ValueError, "at least 1"):
            _prune_old_runs(FakeS3Client(), "snow", keep=0, current_run_id="run-1")

    def test_prunes_only_after_the_pointer_has_moved(self) -> None:
        client = FakeS3Client(self.runs())
        env = {
            "R2_ACCOUNT_ID": "account",
            "R2_BUCKET": "snow",
            "R2_PUBLIC_BASE_URL": "https://snow.example.test/",
            "R2_ACCESS_KEY_ID": "key",
            "R2_SECRET_ACCESS_KEY": "secret",
        }
        with tempfile.TemporaryDirectory() as tmp:
            run_dir, metadata = make_run(Path(tmp), "20260824T000000Z")
            with patch.dict("os.environ", env, clear=True), patch(
                "nevaio_pipeline.publish.boto3.client", return_value=client
            ):
                publish_to_r2(run_dir, metadata, keep_runs=2)

        # Every delete must follow the latest.json put, so a failed prune can
        # never leave the app pointed at a run whose tiles are already gone.
        self.assertEqual(client.calls.index("put"), client.calls.index("delete") - 1)
        self.assertEqual(
            [item["Key"] for call in client.deletes for item in call["Delete"]["Objects"]],
            [
                "runs/20260822T000000Z/tiles/c.png",
                "runs/20260821T000000Z/tiles/b.png",
                "runs/20260820T000000Z/tiles/a.png",
            ],
        )


if __name__ == "__main__":
    unittest.main()
