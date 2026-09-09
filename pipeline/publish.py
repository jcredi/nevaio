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

from .artifact_validation import validate_artifact, validate_run


def _required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is required for R2 publication")
    return value


def _prune_old_runs(client: Any, bucket: str, keep: int, current_run_id: str) -> list[str]:
    """Delete all but the newest ``keep`` immutable runs.

    Called only after ``latest.json`` has been replaced, so a pruned run is
    never the one the app is being pointed at. Run IDs are UTC
    ``%Y%m%dT%H%M%SZ`` stamps, making lexicographic order chronological. The
    run just published is excluded explicitly rather than relying on it sorting
    newest, so a clock skew cannot delete the run being committed.
    """

    if keep < 1:
        raise ValueError("keep must be at least 1 so the published run survives")

    paginator = client.get_paginator("list_objects_v2")
    run_ids: set[str] = set()
    for page in paginator.paginate(Bucket=bucket, Prefix="runs/", Delimiter="/"):
        for common in page.get("CommonPrefixes", ()):
            run_ids.add(common["Prefix"].removeprefix("runs/").rstrip("/"))

    doomed = sorted(run_ids - {current_run_id}, reverse=True)[keep - 1 :]
    for run_id in doomed:
        keys: list[dict[str, str]] = []
        for page in paginator.paginate(Bucket=bucket, Prefix=f"runs/{run_id}/"):
            keys.extend({"Key": item["Key"]} for item in page.get("Contents", ()))
        for start in range(0, len(keys), 1000):
            client.delete_objects(
                Bucket=bucket, Delete={"Objects": keys[start : start + 1000]}
            )
    return doomed


def publish_to_r2(
    run_dir: Path,
    run_metadata: dict[str, Any],
    *,
    keep_runs: int | None = None,
    upload_workers: int = 16,
) -> dict[str, Any]:
    """Upload an immutable run, then replace ``latest.json`` as the commit.

    ``keep_runs`` retains only that many newest runs, pruning older ones after
    the pointer has moved. Left as ``None`` nothing is ever deleted; a daily
    schedule needs it, because a mid-winter full-area run is roughly 130 MB and
    unbounded daily retention would pass R2's 10 GB free tier within one season.
    """

    validated_metadata, files = validate_run(Path(run_dir))
    if validated_metadata != run_metadata:
        raise ValueError("run metadata does not match validated run.json")
    if keep_runs is not None and keep_runs < 1:
        raise ValueError("keep_runs must be at least 1")

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

    latest = dict(run_metadata)
    latest["manifestUrl"] = f"{public_base_url}/latest.json"
    latest["tiles"] = [f"{public_base_url}/{prefix}/tiles/{{z}}/{{x}}/{{y}}.png"]
    latest["publishedAt"] = datetime.now(UTC).isoformat()
    client.put_object(
        Bucket=bucket,
        Key="latest.json",
        Body=json.dumps(latest, indent=2).encode(),
        ContentType="application/json",
        CacheControl="no-cache, max-age=0",
    )
    if keep_runs is not None:
        _prune_old_runs(client, bucket, keep_runs, run_id)
    return latest



def main() -> None:
    parser = argparse.ArgumentParser(description="Validate or publish a rendered artifact; never render here.")
    parser.add_argument("--runs-dir", type=Path, required=True)
    parser.add_argument("--tiles", nargs="+")
    parser.add_argument("--as-of")
    parser.add_argument("--max-missing-tiles", type=int, default=0)
    parser.add_argument("--keep-runs", type=int, default=7)
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    run_dir, metadata = validate_artifact(
        args.runs_dir, tiles=args.tiles, max_missing_tiles=args.max_missing_tiles, as_of=args.as_of,
    )
    if args.check_only:
        print(f"Validated run {metadata['runId']}: {metadata['tileCount']} tiles")
        return
    latest = publish_to_r2(run_dir, metadata, keep_runs=args.keep_runs)
    if args.receipt:
        args.receipt.write_text(json.dumps(latest, indent=2) + "\n")
    print(f"Published run {latest['runId']}: {latest['tileCount']} tiles")


if __name__ == "__main__":
    main()
