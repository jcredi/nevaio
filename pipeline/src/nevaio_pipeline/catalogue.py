"""The public AS-OF date catalogue and the retention plan that backs it.

Spec section 5.3 (amendment v1.12) lets the user select any *available* AS-OF
date in the latest 31-calendar-date window, loading that date's own archived
manifest and tiles. Two public objects implement it, both at the bucket root
beside ``latest.json``:

``dates.json``
    The catalogue. Authoritative about availability: a date absent from it is
    unavailable, full stop. Small (a few kilobytes) because it is fetched at
    startup.

``asof-<YYYY-MM-DD>-<runId>.json``
    One date's manifest, identical in shape to ``latest.json`` so the
    frontend's existing manifest validator accepts it unchanged. That
    validator resolves tiles as ``<manifest directory>/runs/<runId>/tiles/...``,
    which is why these live at the bucket root rather than under a ``dates/``
    prefix - a prefix would move the directory and break the rule.

The run ID is *in the key* on purpose. It makes the whole public layer
derivable from two bucket listings with no GETs at all, it makes each date
manifest immutable (a re-run writes a new key rather than mutating a live
one), and it removes any way for the catalogue and a manifest to disagree
about which run backs a date.

This module is pure: no boto3, no I/O, no clock. ``publish.py`` supplies the
listings and performs the writes and deletes in the order ``plan_retention``
documents.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
import re

from .config import ASOF_CATALOGUE_DATES, ROLLBACK_RUNS

CATALOGUE_KEY = "dates.json"
CATALOGUE_SCHEMA_VERSION = 1
CATALOGUE_KIND = "asof-date-catalogue"
MANIFEST_KEY_PREFIX = "asof-"

RUN_ID_PATTERN = re.compile(r"\d{8}T\d{6}Z")
MANIFEST_KEY_PATTERN = re.compile(r"asof-(\d{4}-\d{2}-\d{2})-(\d{8}T\d{6}Z)\.json")


def _iso_date(value: str) -> date:
    parsed = date.fromisoformat(value)
    if parsed.isoformat() != value:
        raise ValueError(f"date must use YYYY-MM-DD, got {value!r}")
    return parsed


def date_manifest_key(as_of_date: str, run_id: str) -> str:
    """The bucket key holding one AS-OF date's manifest."""
    key = f"{MANIFEST_KEY_PREFIX}{as_of_date}-{run_id}.json"
    if MANIFEST_KEY_PATTERN.fullmatch(key) is None:
        raise ValueError(f"invalid AS-OF manifest key {key!r}")
    return key


def parse_manifest_key(key: str) -> tuple[str, str] | None:
    """Split a listed key into ``(asOfDate, runId)``, or ``None`` if foreign.

    Anything unrecognised under the ``asof-`` prefix is ignored rather than
    treated as garbage to collect: this feeds a delete path, so it only ever
    acts on names it fully understands.
    """
    match = MANIFEST_KEY_PATTERN.fullmatch(key)
    if match is None:
        return None
    as_of, run_id = match.groups()
    try:
        _iso_date(as_of)
    except ValueError:
        return None
    return as_of, run_id


@dataclass(frozen=True)
class RetentionPlan:
    """What the catalogue will say, and what may be deleted once it says it."""

    entries: tuple[tuple[str, str], ...]
    """``(asOfDate, runId)`` newest date first - exactly the public catalogue."""

    doomed_manifest_keys: tuple[str, ...]
    """Listed date manifests the new catalogue no longer advertises."""

    doomed_run_ids: tuple[str, ...]
    """Runs no catalogue entry references and no rollback slot protects."""

    @property
    def dates(self) -> tuple[str, ...]:
        return tuple(as_of for as_of, _ in self.entries)

    @property
    def advertised_run_ids(self) -> frozenset[str]:
        return frozenset(run_id for _, run_id in self.entries)


def plan_retention(
    *,
    run_ids: object,
    manifest_keys: object,
    current_run_id: str,
    current_as_of_date: str,
    keep_dates: int = ASOF_CATALOGUE_DATES,
    keep_runs: int = ROLLBACK_RUNS,
) -> RetentionPlan:
    """Decide the catalogue contents and the deletions that may follow it.

    ``run_ids`` and ``manifest_keys`` are what the bucket currently lists; the
    run being published is folded in explicitly rather than trusted to appear
    in a listing, so an eventually-consistent LIST can never make the
    publisher delete the run it just uploaded.

    Dates are kept by *calendar window*, not by count: the newest available
    date anchors a ``keep_dates``-wide window and anything older falls out.
    A count would keep advertising dates further back than the selector may
    offer whenever a day failed. Within one date the newest run wins, so a
    re-run supersedes its predecessor in the catalogue.

    A run survives when it backs a catalogue entry, when it is one of the
    newest ``keep_runs`` runs (the rollback buffer, independent of dates), or
    when it is the run being published. Everything else is doomed. The
    rollback buffer is what keeps a superseded same-date run around long
    enough to point ``latest.json`` back at it.

    **Ordering the caller must honour.** The plan is only safe if every write
    happens before any delete:

    1. upload the new run's objects;
    2. put its date manifest;
    3. put the catalogue - the first moment the new date is advertised, and
       also the moment an evicted date stops being advertised;
    4. put ``latest.json``;
    5. delete ``doomed_manifest_keys``, then ``doomed_run_ids``.

    A date is therefore advertised only after its manifest and tiles are
    complete, and an object is deleted only after a durable catalogue that
    omits it exists. A crash anywhere leaves unreferenced objects behind,
    never a catalogue entry whose data is gone.
    """
    if keep_dates < 1:
        raise ValueError("keep_dates must be at least 1 so the published date survives")
    if keep_runs < 1:
        raise ValueError("keep_runs must be at least 1 so the published run survives")
    if RUN_ID_PATTERN.fullmatch(current_run_id) is None:
        raise ValueError(f"invalid run ID {current_run_id!r}")
    _iso_date(current_as_of_date)

    known_runs = {str(run_id) for run_id in run_ids} | {current_run_id}
    listed: dict[tuple[str, str], str] = {}
    for key in manifest_keys:
        parsed = parse_manifest_key(str(key))
        if parsed is not None:
            listed[parsed] = str(key)

    # A manifest whose run is gone is not a date we may advertise. This
    # algorithm never deletes an advertised run, so it should not arise - but
    # the catalogue is a public availability promise, so derive it from what
    # the bucket actually holds rather than from what a key name claims.
    candidates = {pair for pair in listed if pair[1] in known_runs}
    candidates.add((current_as_of_date, current_run_id))

    newest_run_for_date: dict[str, str] = {}
    for as_of, run_id in candidates:
        if run_id > newest_run_for_date.get(as_of, ""):
            newest_run_for_date[as_of] = run_id

    anchor = _iso_date(max(newest_run_for_date))
    window_start = anchor - timedelta(days=keep_dates - 1)
    entries = tuple(
        (as_of, newest_run_for_date[as_of])
        for as_of in sorted(newest_run_for_date, reverse=True)
        if _iso_date(as_of) >= window_start
    )

    rollback = set(sorted(known_runs, reverse=True)[:keep_runs])
    keep = {run_id for _, run_id in entries} | rollback | {current_run_id}

    advertised = set(entries)
    doomed_manifest_keys = tuple(
        listed[pair] for pair in sorted(listed, reverse=True) if pair not in advertised
    )
    doomed_run_ids = tuple(sorted(known_runs - keep, reverse=True))
    return RetentionPlan(entries, doomed_manifest_keys, doomed_run_ids)


def build_catalogue(
    entries: object, *, generated_at: str, keep_dates: int = ASOF_CATALOGUE_DATES
) -> dict:
    """Render a `RetentionPlan`'s entries as the public catalogue document.

    Deliberately four top-level fields and three per date. This is fetched on
    every page load and validated as a public contract, so each field has to
    earn its place: ``maxDates`` lets a reader tell a full window with a gap
    apart from a shrinking policy without hardcoding the number, and
    ``manifest`` is a *relative* key so the frontend resolves it against the
    catalogue's own URL and can never be sent to another host.
    """
    return {
        "schemaVersion": CATALOGUE_SCHEMA_VERSION,
        "kind": CATALOGUE_KIND,
        "generatedAt": generated_at,
        "maxDates": keep_dates,
        "dates": [
            {
                "asOfDate": str(as_of),
                "runId": str(run_id),
                "manifest": date_manifest_key(str(as_of), str(run_id)),
            }
            for as_of, run_id in entries
        ],
    }
