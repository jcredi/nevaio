"""Retention-window and catalogue-shape rules, with no bucket in sight."""
from __future__ import annotations

from datetime import date, timedelta
import unittest

from nevaio_pipeline.catalogue import (
    build_catalogue,
    date_manifest_key,
    parse_manifest_key,
    plan_retention,
)
from nevaio_pipeline.config import ASOF_CATALOGUE_DATES, ROLLBACK_RUNS


def run_id_for(as_of: str, hour: int = 4) -> str:
    return f"{as_of.replace('-', '')}T{hour:02d}3500Z"


def daily(count: int, *, last: str = "2026-09-11") -> list[str]:
    """``count`` consecutive dates ending on ``last``, oldest first."""
    end = date.fromisoformat(last)
    return [(end - timedelta(days=n)).isoformat() for n in reversed(range(count))]


def bucket_state(dates: list[str]) -> tuple[list[str], list[str]]:
    """The two listings a bucket holding one run per date would return."""
    runs = [run_id_for(day) for day in dates]
    manifests = [date_manifest_key(day, run_id_for(day)) for day in dates]
    return runs, manifests


class ManifestKeyTests(unittest.TestCase):
    def test_key_round_trips_through_its_parser(self) -> None:
        key = date_manifest_key("2026-09-11", "20260911T043500Z")
        self.assertEqual(key, "asof-2026-09-11-20260911T043500Z.json")
        self.assertEqual(parse_manifest_key(key), ("2026-09-11", "20260911T043500Z"))

    def test_unrecognised_keys_are_ignored_not_guessed_at(self) -> None:
        for key in (
            "latest.json",
            "dates.json",
            "asof-2026-09-11.json",
            "asof-2026-9-11-20260911T043500Z.json",
            "asof-2026-13-11-20260911T043500Z.json",
            "asof-2026-09-11-20260911T043500Z.json.bak",
            "runs/20260911T043500Z/run.json",
        ):
            with self.subTest(key=key):
                self.assertIsNone(parse_manifest_key(key))

    def test_a_malformed_date_or_run_never_becomes_a_key(self) -> None:
        for as_of, run_id in (("2026-9-11", "20260911T043500Z"), ("2026-09-11", "nope")):
            with self.subTest(as_of=as_of):
                with self.assertRaisesRegex(ValueError, "invalid AS-OF manifest key"):
                    date_manifest_key(as_of, run_id)


class RetentionWindowTests(unittest.TestCase):
    def plan(self, dates: list[str], current: str, **kwargs):
        runs, manifests = bucket_state(dates)
        return plan_retention(
            run_ids=runs,
            manifest_keys=manifests,
            current_run_id=run_id_for(current),
            current_as_of_date=current,
            **kwargs,
        )

    def test_fewer_dates_than_the_window_keeps_every_one(self) -> None:
        dates = daily(5)
        plan = self.plan(dates, dates[-1])

        self.assertEqual(list(plan.dates), sorted(dates, reverse=True))
        self.assertEqual(plan.doomed_run_ids, ())
        self.assertEqual(plan.doomed_manifest_keys, ())

    def test_more_dates_than_the_window_evicts_the_oldest_by_calendar(self) -> None:
        dates = daily(40)
        plan = self.plan(dates, dates[-1])

        self.assertEqual(len(plan.dates), ASOF_CATALOGUE_DATES)
        self.assertEqual(plan.dates[0], "2026-09-11")
        # 31 dates wide means the newest date minus 30 days is the oldest.
        self.assertEqual(plan.dates[-1], "2026-08-12")
        evicted = sorted(set(dates) - set(plan.dates), reverse=True)
        self.assertEqual(len(evicted), 9)
        self.assertEqual(
            plan.doomed_run_ids, tuple(run_id_for(day) for day in evicted)
        )
        self.assertEqual(
            plan.doomed_manifest_keys,
            tuple(date_manifest_key(day, run_id_for(day)) for day in evicted),
        )

    def test_a_gap_shortens_the_catalogue_rather_than_reaching_further_back(self) -> None:
        # 35 consecutive dates, but the pipeline failed on five days inside
        # the window. A "newest 31 published dates" rule would backfill the
        # shortfall with 2026-08-08..2026-08-11, which are more than 30 days
        # before the anchor and outside what the picker may offer.
        failed = set(daily(5, last="2026-08-20"))
        dates = [day for day in daily(35) if day not in failed]
        plan = self.plan(dates, dates[-1])

        self.assertEqual(len(plan.dates), ASOF_CATALOGUE_DATES - 5)
        self.assertEqual(plan.dates[0], "2026-09-11")
        self.assertEqual(plan.dates[-1], "2026-08-12")
        self.assertFalse(failed & set(plan.dates))
        self.assertNotIn("2026-08-11", plan.dates)

    def test_the_window_never_advertises_a_date_it_has_no_data_for(self) -> None:
        dates = daily(3)
        plan = self.plan(dates, dates[-1])

        self.assertEqual(len(plan.dates), 3)
        self.assertLessEqual(len(plan.dates), ASOF_CATALOGUE_DATES)


class SameDateRerunTests(unittest.TestCase):
    def test_the_newest_run_of_a_date_wins_and_the_older_one_stays_for_rollback(self) -> None:
        dates = daily(3)
        runs, manifests = bucket_state(dates)
        rerun = run_id_for(dates[-1], hour=9)

        plan = plan_retention(
            run_ids=runs,
            manifest_keys=manifests,
            current_run_id=rerun,
            current_as_of_date=dates[-1],
        )

        self.assertEqual(len(plan.dates), 3)
        self.assertEqual(dict(plan.entries)[dates[-1]], rerun)
        # The superseded run is no longer advertised, but the rollback buffer
        # keeps its objects so latest.json can still be pointed back at it.
        superseded = run_id_for(dates[-1])
        self.assertNotIn(superseded, plan.advertised_run_ids)
        self.assertNotIn(superseded, plan.doomed_run_ids)
        # Its stale manifest is dropped, so exactly one manifest per date.
        self.assertEqual(
            plan.doomed_manifest_keys, (date_manifest_key(dates[-1], superseded),)
        )

    def test_a_superseded_run_past_the_rollback_buffer_is_collected(self) -> None:
        dates = daily(10)
        runs, manifests = bucket_state(dates)
        # Ten daily runs plus one extra run on the oldest date: that extra is
        # neither advertised nor within the newest seven runs.
        stale = run_id_for(dates[0], hour=9)
        runs = [*runs, stale]

        plan = plan_retention(
            run_ids=runs,
            manifest_keys=manifests,
            current_run_id=run_id_for("2026-09-12"),
            current_as_of_date="2026-09-12",
        )

        self.assertEqual(plan.doomed_run_ids, (stale,))
        self.assertNotIn(stale, plan.advertised_run_ids)


class RunSafetyTests(unittest.TestCase):
    def test_the_published_run_survives_even_when_a_listing_has_not_caught_up(self) -> None:
        dates = daily(40)
        runs, manifests = bucket_state(dates)
        fresh = run_id_for("2026-09-12")

        plan = plan_retention(
            run_ids=runs,  # deliberately does not contain the new run yet
            manifest_keys=manifests,
            current_run_id=fresh,
            current_as_of_date="2026-09-12",
        )

        self.assertEqual(plan.dates[0], "2026-09-12")
        self.assertNotIn(fresh, plan.doomed_run_ids)

    def test_a_clock_skewed_run_is_still_never_its_own_victim(self) -> None:
        dates = daily(40)
        runs, manifests = bucket_state(dates)
        # An AS-OF date far behind the anchor: the run cannot be advertised,
        # but it must not be deleted by the publication that created it.
        skewed = run_id_for("2026-01-01")

        plan = plan_retention(
            run_ids=runs,
            manifest_keys=manifests,
            current_run_id=skewed,
            current_as_of_date="2026-01-01",
        )

        self.assertNotIn("2026-01-01", plan.dates)
        self.assertNotIn(skewed, plan.doomed_run_ids)

    def test_the_rollback_buffer_protects_the_newest_runs_whatever_the_dates(self) -> None:
        dates = daily(40)
        plan = plan_retention(
            run_ids=bucket_state(dates)[0],
            manifest_keys=[],  # catalogue objects lost entirely
            current_run_id=run_id_for(dates[-1]),
            current_as_of_date=dates[-1],
        )

        # With no manifests to derive dates from, only today can be
        # advertised - but the rollback buffer still refuses to strand the
        # operator with a single run to fall back to.
        self.assertEqual(plan.dates, ("2026-09-11",))
        survivors = set(bucket_state(dates)[0]) - set(plan.doomed_run_ids)
        self.assertEqual(len(survivors), ROLLBACK_RUNS)

    def test_a_manifest_whose_run_is_missing_is_never_advertised(self) -> None:
        dates = daily(5)
        runs, manifests = bucket_state(dates)
        orphan_date = "2026-09-06"
        manifests.append(date_manifest_key(orphan_date, run_id_for(orphan_date)))

        plan = plan_retention(
            run_ids=runs,
            manifest_keys=manifests,
            current_run_id=run_id_for(dates[-1]),
            current_as_of_date=dates[-1],
        )

        self.assertNotIn(orphan_date, plan.dates)
        self.assertIn(
            date_manifest_key(orphan_date, run_id_for(orphan_date)),
            plan.doomed_manifest_keys,
        )

    def test_a_run_with_no_manifest_is_unavailable_and_collectable(self) -> None:
        # Step 2 of the publish order crashed: the run uploaded, its manifest
        # never landed. The date must stay unavailable rather than be
        # advertised against a 404, and the objects must eventually go.
        dates = daily(10)
        runs, manifests = bucket_state(dates)
        crashed = run_id_for("2026-08-20")
        runs.append(crashed)

        plan = plan_retention(
            run_ids=runs,
            manifest_keys=manifests,
            current_run_id=run_id_for(dates[-1]),
            current_as_of_date=dates[-1],
        )

        self.assertNotIn("2026-08-20", plan.dates)
        self.assertIn(crashed, plan.doomed_run_ids)

    def test_every_advertised_run_is_kept_and_every_doomed_run_unadvertised(self) -> None:
        dates = daily(40)
        runs, manifests = bucket_state(dates)
        plan = plan_retention(
            run_ids=runs,
            manifest_keys=manifests,
            current_run_id=run_id_for("2026-09-12"),
            current_as_of_date="2026-09-12",
        )

        self.assertFalse(plan.advertised_run_ids & set(plan.doomed_run_ids))
        advertised_keys = {date_manifest_key(d, r) for d, r in plan.entries}
        self.assertFalse(advertised_keys & set(plan.doomed_manifest_keys))

    def test_retention_counts_below_one_are_refused(self) -> None:
        for kwargs in ({"keep_dates": 0}, {"keep_runs": 0}):
            with self.subTest(**kwargs):
                with self.assertRaisesRegex(ValueError, "at least 1"):
                    plan_retention(
                        run_ids=[],
                        manifest_keys=[],
                        current_run_id=run_id_for("2026-09-11"),
                        current_as_of_date="2026-09-11",
                        **kwargs,
                    )

    def test_a_malformed_current_run_or_date_is_refused(self) -> None:
        with self.assertRaisesRegex(ValueError, "invalid run ID"):
            plan_retention(
                run_ids=[], manifest_keys=[],
                current_run_id="today", current_as_of_date="2026-09-11",
            )
        with self.assertRaises(ValueError):
            plan_retention(
                run_ids=[], manifest_keys=[],
                current_run_id=run_id_for("2026-09-11"), current_as_of_date="11/09/2026",
            )


class CatalogueDocumentTests(unittest.TestCase):
    def test_document_is_newest_first_and_self_describing(self) -> None:
        dates = daily(3)
        plan = plan_retention(
            run_ids=bucket_state(dates)[0],
            manifest_keys=bucket_state(dates)[1],
            current_run_id=run_id_for(dates[-1]),
            current_as_of_date=dates[-1],
        )
        document = build_catalogue(plan.entries, generated_at="2026-09-11T04:41:02+00:00")

        self.assertEqual(
            set(document), {"schemaVersion", "kind", "generatedAt", "maxDates", "dates"}
        )
        self.assertEqual(document["kind"], "asof-date-catalogue")
        self.assertEqual(document["maxDates"], ASOF_CATALOGUE_DATES)
        self.assertEqual(
            [entry["asOfDate"] for entry in document["dates"]],
            ["2026-09-11", "2026-09-10", "2026-09-09"],
        )
        self.assertEqual(
            document["dates"][0],
            {
                "asOfDate": "2026-09-11",
                "runId": "20260911T043500Z",
                "manifest": "asof-2026-09-11-20260911T043500Z.json",
            },
        )

    def test_a_full_window_stays_small_enough_to_fetch_at_startup(self) -> None:
        import json

        dates = daily(ASOF_CATALOGUE_DATES)
        entries = [(day, run_id_for(day)) for day in reversed(dates)]
        body = json.dumps(
            build_catalogue(entries, generated_at="2026-09-11T04:41:02+00:00"), indent=2
        )
        self.assertLess(len(body.encode()), 6 * 1024)


if __name__ == "__main__":
    unittest.main()
