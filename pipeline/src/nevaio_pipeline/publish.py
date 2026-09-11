"""Publish a complete preview tile set to Cloudflare R2 atomically."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
import argparse
import json
import mimetypes
import os
from pathlib import Path
from typing import Any

import boto3

from .artifact_validation import validate_artifact, validate_date_catalogue, validate_run
from .catalogue import (
    CATALOGUE_KEY, MANIFEST_KEY_PREFIX, build_catalogue, date_manifest_key, plan_retention,
)
from .config import ASOF_CATALOGUE_DATES, ROLLBACK_RUNS

# A listing this long means something is very wrong with the bucket layout;
# refuse to reason about it rather than plan deletions over it.
MAX_LISTED_KEYS = 20_000


def _required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is required for R2 publication")
    return value


def _list_run_ids(client: Any, bucket: str) -> set[str]:
    """Every immutable run currently in the bucket, from its prefixes alone."""
    run_ids: set[str] = set()
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix="runs/", Delimiter="/"):
        for common in page.get("CommonPrefixes", ()):
            run_ids.add(common["Prefix"].removeprefix("runs/").rstrip("/"))
        if len(run_ids) > MAX_LISTED_KEYS:
            raise RuntimeError("bucket lists more runs than this publisher will reason about")
    return run_ids


def _list_manifest_keys(client: Any, bucket: str) -> list[str]:
    """Every published AS-OF date manifest, by key.

    The key carries both the date and the run, so this listing is the entire
    input needed to rebuild the catalogue - no object bodies are read, which
    keeps the daily publication at two LIST calls rather than a GET per date.
    """
    keys: list[str] = []
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=MANIFEST_KEY_PREFIX):
        keys.extend(item["Key"] for item in page.get("Contents", ()))
        if len(keys) > MAX_LISTED_KEYS:
            raise RuntimeError("bucket lists more date manifests than expected")
    return keys


def _delete_keys(client: Any, bucket: str, keys: list[str]) -> None:
    for start in range(0, len(keys), 1000):
        client.delete_objects(
            Bucket=bucket,
            Delete={"Objects": [{"Key": key} for key in keys[start : start + 1000]]},
        )


def _delete_runs(client: Any, bucket: str, run_ids: object) -> None:
    paginator = client.get_paginator("list_objects_v2")
    for run_id in run_ids:
        keys: list[str] = []
        for page in paginator.paginate(Bucket=bucket, Prefix=f"runs/{run_id}/"):
            keys.extend(item["Key"] for item in page.get("Contents", ()))
        _delete_keys(client, bucket, keys)


def publish_to_r2(
    run_dir: Path,
    run_metadata: dict[str, Any],
    *,
    keep_runs: int | None = None,
    keep_dates: int = ASOF_CATALOGUE_DATES,
    upload_workers: int = 16,
) -> dict[str, Any]:
    """Upload an immutable run, publish its date, then commit ``latest.json``.

    Five ordered stages, and the order is the whole safety argument (see
    `catalogue.plan_retention`): upload the run, put its own AS-OF manifest,
    put the catalogue that first advertises it, move ``latest.json``, and only
    then delete what the new catalogue no longer names. A crash at any point
    leaves objects nothing refers to, never a catalogue entry whose tiles are
    gone.

    ``keep_dates`` is the width of the catalogue's calendar window - the
    latest available date plus the preceding ``keep_dates - 1`` calendar
    dates, per spec section 5.3.

    ``keep_runs`` is the rollback buffer: that many newest runs survive a
    prune whatever their date. Left as ``None`` nothing is ever deleted, which
    is the safe library default; a daily schedule must set it, because a
    mid-winter full-area run is roughly 130 MB and unbounded daily retention
    would pass R2's 10 GB free tier within one season. A 31-date archive is
    about 4 GB, which still fits.
    """

    validated_metadata, files = validate_run(Path(run_dir))
    if validated_metadata != run_metadata:
        raise ValueError("run metadata does not match validated run.json")
    if keep_runs is not None and keep_runs < 1:
        raise ValueError("keep_runs must be at least 1")
    if keep_dates < 1:
        raise ValueError("keep_dates must be at least 1")

    account_id = _required_env("R2_ACCOUNT_ID")
    bucket = _required_env("R2_BUCKET")
    public_base_url = _required_env("R2_PUBLIC_BASE_URL").rstrip("/")
    client = boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=_required_env("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=_required_env("R2_SECRET_ACCESS_KEY"),
        region_name="auto",
    )

    run_id = str(run_metadata["runId"])
    prefix = f"runs/{run_id}"

    def upload(path: Path) -> None:
        relative = path.relative_to(run_dir).as_posix()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        client.upload_file(
            str(path),
            bucket,
            f"{prefix}/{relative}",
            ExtraArgs={
                "ContentType": content_type,
                "CacheControl": "public, max-age=31536000, immutable",
            },
        )

    # A full-area run is ~3,500 objects; uploading them one at a time takes
    # about ten minutes, so this is concurrent. `ThreadPoolExecutor.map` is
    # still a barrier - every object is uploaded before `latest.json` moves
    # below - and it re-raises the first failure, so a partial run can never
    # be committed. boto3 clients are thread-safe for this use.
    with ThreadPoolExecutor(max_workers=upload_workers) as executor:
        for _ in executor.map(upload, files):
            pass

    as_of_date = str(run_metadata["asOfDate"])
    published_at = datetime.now(UTC).isoformat()

    def manifest(key: str) -> dict[str, Any]:
        """One publication, addressed by whichever key is serving it."""
        body = dict(run_metadata)
        body["manifestUrl"] = f"{public_base_url}/{key}"
        body["tiles"] = [f"{public_base_url}/{prefix}/tiles/{{z}}/{{x}}/{{y}}.png"]
        body["publishedAt"] = published_at
        return body

    def put_json(key: str, body: dict[str, Any], cache_control: str) -> None:
        client.put_object(
            Bucket=bucket,
            Key=key,
            Body=json.dumps(body, indent=2).encode(),
            ContentType="application/json",
            CacheControl=cache_control,
        )

    plan = plan_retention(
        run_ids=_list_run_ids(client, bucket),
        manifest_keys=_list_manifest_keys(client, bucket),
        current_run_id=run_id,
        current_as_of_date=as_of_date,
        keep_dates=keep_dates,
        keep_runs=ROLLBACK_RUNS if keep_runs is None else keep_runs,
    )

    # Only write this date's manifest if the catalogue will actually name it.
    # A backfill older than the window is published as an archived run but is
    # not advertised, rather than written and immediately deleted.
    date_key = date_manifest_key(as_of_date, run_id)
    if (as_of_date, run_id) in plan.entries:
        put_json(date_key, manifest(date_key), "public, max-age=31536000, immutable")

    catalogue = build_catalogue(plan.entries, generated_at=published_at, keep_dates=keep_dates)
    validate_date_catalogue(json.dumps(catalogue, indent=2), max_dates=keep_dates)
    put_json(CATALOGUE_KEY, catalogue, "no-cache, max-age=0")

    latest = manifest("latest.json")
    put_json("latest.json", latest, "no-cache, max-age=0")

    if keep_runs is not None:
        # Manifests first: a date manifest must never outlive the run whose
        # tiles it names, even though it is already unadvertised by now.
        _delete_keys(client, bucket, list(plan.doomed_manifest_keys))
        _delete_runs(client, bucket, plan.doomed_run_ids)
    return latest



def main() -> None:
    parser = argparse.ArgumentParser(description="Validate or publish a rendered artifact; never render here.")
    parser.add_argument("--runs-dir", type=Path, required=True)
    parser.add_argument("--tiles", nargs="+")
    parser.add_argument("--as-of")
    parser.add_argument("--max-missing-tiles", type=int, default=0)
    parser.add_argument("--keep-runs", type=int, default=ROLLBACK_RUNS)
    parser.add_argument("--keep-dates", type=int, default=ASOF_CATALOGUE_DATES)
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    run_dir, metadata = validate_artifact(
        args.runs_dir, tiles=args.tiles, max_missing_tiles=args.max_missing_tiles, as_of=args.as_of,
    )
    if args.check_only:
        print(f"Validated run {metadata['runId']}: {metadata['tileCount']} tiles")
        return
    latest = publish_to_r2(
        run_dir, metadata, keep_runs=args.keep_runs, keep_dates=args.keep_dates
    )
    if args.receipt:
        args.receipt.write_text(json.dumps(latest, indent=2) + "\n")
    print(
        f"Published run {latest['runId']}: {latest['tileCount']} tiles, "
        f"AS-OF {latest['asOfDate']}"
    )


if __name__ == "__main__":
    main()
