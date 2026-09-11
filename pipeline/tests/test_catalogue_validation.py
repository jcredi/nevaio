"""The date catalogue is a public contract, so validate it like one."""
from __future__ import annotations

import json
import unittest

from nevaio_pipeline.artifact_validation import MAX_CATALOGUE_BYTES, validate_date_catalogue
from nevaio_pipeline.catalogue import build_catalogue
from nevaio_pipeline.config import ASOF_CATALOGUE_DATES

GENERATED = "2026-09-11T04:41:02+00:00"
ENTRIES = (
    ("2026-09-11", "20260911T043500Z"),
    ("2026-09-10", "20260910T043500Z"),
    ("2026-09-08", "20260908T043500Z"),
)


def document(**overrides) -> dict:
    base = build_catalogue(ENTRIES, generated_at=GENERATED)
    base.update(overrides)
    return base


class DateCatalogueValidationTests(unittest.TestCase):
    def accepts(self, candidate: dict) -> dict:
        return validate_date_catalogue(json.dumps(candidate))

    def rejects(self, candidate, expected: str) -> None:
        body = candidate if isinstance(candidate, (str, bytes)) else json.dumps(candidate)
        with self.assertRaisesRegex(ValueError, expected):
            validate_date_catalogue(body)

    def test_accepts_what_the_builder_produces(self) -> None:
        self.assertEqual(self.accepts(document()), document())

    def test_accepts_an_empty_catalogue_because_nothing_available_is_a_real_answer(self) -> None:
        empty = self.accepts(build_catalogue((), generated_at=GENERATED))
        self.assertEqual(empty["dates"], [])

    def test_accepts_a_full_window_and_rejects_one_date_more(self) -> None:
        full = [(f"2026-08-{day:02d}", f"202608{day:02d}T043500Z") for day in range(12, 32)]
        full += [(f"2026-09-{day:02d}", f"202609{day:02d}T043500Z") for day in range(1, 12)]
        full.reverse()
        self.assertEqual(len(full), ASOF_CATALOGUE_DATES)
        self.accepts(build_catalogue(full, generated_at=GENERATED))

        over = [("2026-08-11", "20260811T043500Z"), *full]
        over.sort(reverse=True)
        self.rejects(build_catalogue(over, generated_at=GENERATED),
                     "advertises more dates than its window")

    def test_rejects_a_window_wider_than_the_policy_even_with_few_dates(self) -> None:
        self.rejects(
            build_catalogue(
                (("2026-09-11", "20260911T043500Z"), ("2026-08-11", "20260811T043500Z")),
                generated_at=GENERATED,
            ),
            "spans more than its retention window",
        )

    def test_rejects_unknown_missing_and_duplicate_fields(self) -> None:
        self.rejects({**document(), "extra": 1}, "unexpected catalogue fields")
        missing = document()
        del missing["maxDates"]
        self.rejects(missing, "unexpected catalogue fields")
        body = json.dumps(document())
        self.rejects(body.replace('"kind"', '"maxDates"', 1), "duplicate metadata key")

    def test_rejects_a_wrong_schema_version_kind_or_window(self) -> None:
        self.rejects(document(schemaVersion=2), "invalid catalogue schemaVersion")
        self.rejects(document(schemaVersion=True), "invalid catalogue schemaVersion")
        self.rejects(document(kind="latest"), "unexpected catalogue kind")
        self.rejects(document(maxDates=ASOF_CATALOGUE_DATES + 1), "invalid catalogue maxDates")

    def test_a_narrowed_window_validates_against_itself_only(self) -> None:
        narrow = build_catalogue(ENTRIES[:2], generated_at=GENERATED, keep_dates=7)
        self.assertEqual(validate_date_catalogue(json.dumps(narrow), max_dates=7), narrow)
        self.rejects(narrow, "invalid catalogue maxDates")

    def test_rejects_a_generation_stamp_that_is_not_utc(self) -> None:
        self.rejects(document(generatedAt="2026-09-11T04:41:02+02:00"), "must be UTC")
        self.rejects(document(generatedAt="2026-09-11T04:41:02"), "must be UTC")
        self.rejects(document(generatedAt=17), "must be a string")

    def test_rejects_a_manifest_key_that_does_not_match_its_own_entry(self) -> None:
        # The whole point of the key naming: a poisoned catalogue cannot point
        # a date at another run's manifest, or at any other object.
        for manifest in (
            "asof-2026-09-10-20260911T043500Z.json",
            "asof-2026-09-11-20260910T043500Z.json",
            "latest.json",
            "https://elsewhere.test/asof-2026-09-11-20260911T043500Z.json",
            "../asof-2026-09-11-20260911T043500Z.json",
        ):
            with self.subTest(manifest=manifest):
                candidate = document()
                candidate["dates"][0]["manifest"] = manifest
                self.rejects(candidate, "manifest key does not match")

    def test_rejects_malformed_entries(self) -> None:
        for mutate, expected in (
            (lambda e: e.update(asOfDate="2026-9-11"), "[Ii]nvalid isoformat"),
            (lambda e: e.update(asOfDate="20260911"), "date must use YYYY-MM-DD"),
            (lambda e: e.update(asOfDate=20260911), "date must be an ISO string"),
            (lambda e: e.update(runId="latest"), "invalid catalogue run ID"),
            (lambda e: e.pop("runId"), "unexpected catalogue entry fields"),
            (lambda e: e.update(extra=1), "unexpected catalogue entry fields"),
        ):
            with self.subTest(expected=expected):
                candidate = document()
                mutate(candidate["dates"][0])
                self.rejects(candidate, expected)
        self.rejects(document(dates={}), "dates must be a list")
        self.rejects(document(dates=["2026-09-11"]), "unexpected catalogue entry fields")

    def test_rejects_dates_out_of_order_or_repeated(self) -> None:
        self.rejects(document(dates=list(reversed(document()["dates"]))),
                     "unique and newest first")
        repeated = document()
        repeated["dates"][1] = dict(repeated["dates"][0])
        self.rejects(repeated, "unique and newest first")

    def test_rejects_one_run_backing_two_dates(self) -> None:
        candidate = document()
        candidate["dates"][1]["runId"] = candidate["dates"][0]["runId"]
        candidate["dates"][1]["manifest"] = (
            f"asof-{candidate['dates'][1]['asOfDate']}-{candidate['dates'][0]['runId']}.json"
        )
        self.rejects(candidate, "only one catalogue date")

    def test_rejects_an_empty_or_oversized_document(self) -> None:
        self.rejects(b"", "catalogue size outside limits")
        padded = document()
        padded["generatedAt"] = GENERATED
        blob = json.dumps(padded) + " " * MAX_CATALOGUE_BYTES
        self.rejects(blob, "catalogue size outside limits")


if __name__ == "__main__":
    unittest.main()
