from __future__ import annotations

import unittest
from datetime import UTC, date, datetime

import numpy as np

from nevaio_pipeline.asof import (
    CLOUD,
    NODATA,
    WATER,
    DailyProduct,
    PixelState,
    compose_as_of,
    freshness_tier,
)


def at(day: date, hour: int = 12) -> int:
    return int(datetime(day.year, day.month, day.day, hour, tzinfo=UTC).timestamp())


def product(
    product_date: date,
    gf: list[list[int]],
    quality: list[list[int]],
    acquisition_time: list[list[int]],
) -> DailyProduct:
    return DailyProduct(
        product_date=product_date,
        gf=np.array(gf, dtype=np.uint8),
        quality=np.array(quality, dtype=np.uint8),
        acquisition_time=np.array(acquisition_time, dtype=np.uint32),
    )


class ComposeAsOfTests(unittest.TestCase):
    def test_keeps_minimal_quality_when_it_has_the_newest_acquisition(self) -> None:
        as_of = date(2026, 2, 10)
        older_high = product(date(2026, 2, 8), [[20]], [[0]], [[at(date(2026, 2, 8))]])
        newer_minimal = product(date(2026, 2, 10), [[80]], [[3]], [[at(as_of)]])

        result = compose_as_of([older_high, newer_minimal], as_of)

        self.assertEqual(int(result.state[0, 0]), PixelState.VALID)
        self.assertEqual(int(result.fsc[0, 0]), 80)
        self.assertEqual(int(result.quality[0, 0]), 3)
        self.assertEqual(int(result.age_days[0, 0]), 0)

    def test_uses_quality_then_product_date_as_deterministic_tie_breakers(self) -> None:
        as_of = date(2026, 2, 10)
        same_at = at(date(2026, 2, 9))
        latest_product = product(date(2026, 2, 10), [[30, 60]], [[2, 1]], [[same_at, same_at]])
        better_quality = product(date(2026, 2, 8), [[90, 10]], [[1, 1]], [[same_at, same_at]])

        forward = compose_as_of([latest_product, better_quality], as_of)
        reverse = compose_as_of([better_quality, latest_product], as_of)

        np.testing.assert_array_equal(forward.fsc, [[90, 60]])
        np.testing.assert_array_equal(forward.fsc, reverse.fsc)
        np.testing.assert_array_equal(forward.quality, reverse.quality)
        np.testing.assert_array_equal(forward.source_product_day, reverse.source_product_day)

    def test_falls_back_through_cloud_and_nodata_for_up_to_fourteen_days(self) -> None:
        observed = date(2026, 2, 7)
        as_of = date(2026, 2, 21)
        old = product(observed, [[33, 100]], [[3, 3]], [[at(observed), at(observed)]])
        gap = product(as_of, [[CLOUD, NODATA]], [[CLOUD, NODATA]], [[0, 0]])

        result = compose_as_of([gap, old], as_of)

        np.testing.assert_array_equal(result.fsc, [[33, 100]])
        np.testing.assert_array_equal(result.age_days, [[14, 14]])
        np.testing.assert_array_equal(freshness_tier(result.age_days), [[2, 2]])

    def test_day_thirty_is_still_valid_at_the_oldest_freshness_tier(self) -> None:
        as_of = date(2026, 3, 10)
        acquisition = date(2026, 2, 8)
        old_product = product(as_of, [[100]], [[3]], [[at(acquisition)]])

        result = compose_as_of([old_product], as_of)

        self.assertEqual(int(result.state[0, 0]), PixelState.VALID)
        self.assertEqual(int(result.fsc[0, 0]), 100)
        self.assertEqual(int(result.age_days[0, 0]), 30)
        self.assertEqual(int(freshness_tier(result.age_days)[0, 0]), 3)

    def test_day_thirty_one_is_hidden_and_reported_stale(self) -> None:
        as_of = date(2026, 3, 10)
        acquisition = date(2026, 2, 7)
        stale_product = product(as_of, [[100]], [[3]], [[at(acquisition)]])

        result = compose_as_of([stale_product], as_of)

        self.assertEqual(int(result.state[0, 0]), PixelState.STALE)
        self.assertEqual(int(result.fsc[0, 0]), NODATA)
        self.assertEqual(int(result.age_days[0, 0]), 31)

    def test_keeps_cloud_nodata_and_water_distinct(self) -> None:
        as_of = date(2026, 2, 10)
        categories = product(
            as_of,
            [[CLOUD, NODATA, WATER]],
            [[CLOUD, NODATA, WATER]],
            [[0, 0, 0]],
        )

        result = compose_as_of([categories], as_of)

        np.testing.assert_array_equal(
            result.state,
            [[PixelState.CLOUD, PixelState.NODATA, PixelState.WATER]],
        )

    def test_water_in_newest_product_overrides_an_older_value(self) -> None:
        as_of = date(2026, 2, 10)
        older = product(date(2026, 2, 9), [[100]], [[0]], [[at(date(2026, 2, 9))]])
        newest = product(as_of, [[WATER]], [[WATER]], [[0]])

        result = compose_as_of([older, newest], as_of)

        self.assertEqual(int(result.state[0, 0]), PixelState.WATER)
        self.assertEqual(int(result.fsc[0, 0]), NODATA)
        self.assertEqual(int(result.age_days[0, 0]), -1)

    def test_inconsistent_category_codes_and_future_at_are_nodata(self) -> None:
        as_of = date(2026, 2, 10)
        invalid = product(
            as_of,
            [[CLOUD, 50]],
            [[NODATA, 1]],
            [[0, at(date(2026, 2, 11))]],
        )

        result = compose_as_of([invalid], as_of)

        np.testing.assert_array_equal(result.state, [[PixelState.NODATA, PixelState.NODATA]])

    def test_rejects_duplicate_product_dates_and_misaligned_arrays(self) -> None:
        day = date(2026, 2, 10)
        first = product(day, [[0]], [[0]], [[at(day)]])
        duplicate = product(day, [[100]], [[0]], [[at(day)]])

        with self.assertRaisesRegex(ValueError, "duplicate product date"):
            compose_as_of([first, duplicate], day)

        misaligned = DailyProduct(
            day,
            np.zeros((1, 2), dtype=np.uint8),
            np.zeros((1, 1), dtype=np.uint8),
            np.zeros((1, 2), dtype=np.uint32),
        )
        with self.assertRaisesRegex(ValueError, "does not match"):
            compose_as_of([misaligned], day)


class FreshnessTierTests(unittest.TestCase):
    def test_exact_thresholds(self) -> None:
        ages = np.array([-1, 0, 3, 4, 7, 8, 14, 15, 30, 31], dtype=np.int32)
        np.testing.assert_array_equal(
            freshness_tier(ages),
            [0, 0, 0, 1, 1, 2, 2, 3, 3, 3],
        )


if __name__ == "__main__":
    unittest.main()
