from __future__ import annotations

import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from pipeline.config import (
    ASOF_WINDOW_DAYS,
    MVP_MGRS_TILES,
    PREVIEW_MAX_ZOOM,
    PREVIEW_MIN_ZOOM,
)
from pipeline.fetch import (
    BUCKET,
    CatalogObject,
    CatalogProduct,
    _month_prefixes,
    discover_latest_products,
    discover_window_products,
    download_products,
    select_latest_products,
    select_window_products,
)


def objects(tile: str, day: date, version: str, *, missing: str | None = None) -> list[CatalogObject]:
    product = f"CLMS_WSI_GFSC_060m_T{tile}_{day:%Y%m%d}P7D_COMB_{version}"
    prefix = f"GFSC/{tile}/{day:%Y/%m/%d}/{product}/{product}"
    return [
        CatalogObject(f"{prefix}_{layer}.tif", len(layer))
        for layer in ("GF", "GF-QA", "AT")
        if layer != missing
    ]


class ConfigTests(unittest.TestCase):
    def test_preview_configuration_is_stable_and_valid(self) -> None:
        self.assertEqual(len(MVP_MGRS_TILES), len(set(MVP_MGRS_TILES)))
        self.assertTrue(all(len(tile) == 5 and tile == tile.upper() for tile in MVP_MGRS_TILES))
        self.assertLessEqual(PREVIEW_MIN_ZOOM, PREVIEW_MAX_ZOOM)

    def test_mvp_tiles_exclude_squares_hrwsi_does_not_publish(self) -> None:
        # Confirmed absent from HR-WSI's own 983-tile GFSC grid on 2026-08-27,
        # for every year 2016-2026 - all four are open-sea squares. See
        # pipeline/config.py and docs/worklog.md (2026-08-28).
        self.assertEqual(
            set(MVP_MGRS_TILES) & {"33SVD", "33SXB", "33TTF", "33TUE"}, set()
        )

    def test_asof_window_covers_the_full_30_day_age_ceiling(self) -> None:
        # Spec section 9.2 accepts an acquisition up to 30 days old, and a
        # product's AT never postdates its product date, so product dates
        # D-30..D - 31 days inclusive - are exactly the contributing set.
        self.assertEqual(ASOF_WINDOW_DAYS, 31)


class SelectLatestProductsTests(unittest.TestCase):
    def test_selects_newest_complete_product_and_highest_version(self) -> None:
        tile = "32TPS"
        start = date(2026, 2, 1)
        end = date(2026, 2, 10)
        catalog = [
            *objects(tile, date(2026, 2, 8), "V200"),
            *objects(tile, end, "V100"),
            *objects(tile, end, "V101"),
            *objects(tile, end, "V999", missing="AT"),
            CatalogObject("not/a/GFSC/object.txt", 1),
        ]

        selected = select_latest_products(catalog, [tile.lower()], start, end)

        self.assertEqual(selected[tile].product_date, end)
        self.assertEqual(selected[tile].version, "V101")
        self.assertEqual(set(selected[tile].layers), {"GF", "GF-QA", "AT"})

    def test_rejects_missing_complete_product_and_duplicate_layer(self) -> None:
        tile = "32TPS"
        day = date(2026, 2, 10)
        with self.assertRaisesRegex(ValueError, "no complete GFSC product"):
            select_latest_products(objects(tile, day, "V100", missing="AT"), [tile], day, day)

        duplicated = objects(tile, day, "V100")
        with self.assertRaisesRegex(ValueError, "duplicate GF"):
            select_latest_products([*duplicated, duplicated[0]], [tile], day, day)

class SelectWindowProductsTests(unittest.TestCase):
    def test_keeps_whole_window_ordered_and_one_version_per_date(self) -> None:
        tile = "32TPS"
        start, end = date(2026, 2, 1), date(2026, 2, 10)
        catalog = [
            *objects(tile, date(2026, 2, 4), "V100"),
            *objects(tile, date(2026, 2, 2), "V100"),
            *objects(tile, date(2026, 2, 4), "V101"),
            *objects(tile, end, "V100"),
            *objects(tile, date(2026, 2, 6), "V100", missing="GF-QA"),
            *objects(tile, date(2026, 1, 20), "V100"),
        ]

        window = select_window_products(catalog, [tile.lower()], start, end)[tile]

        # Oldest to newest, one entry per date, incomplete and out-of-window
        # products dropped, and the greater version chosen for 2026-02-04.
        self.assertEqual(
            [(item.product_date, item.version) for item in window],
            [
                (date(2026, 2, 2), "V100"),
                (date(2026, 2, 4), "V101"),
                (date(2026, 2, 10), "V100"),
            ],
        )

    def test_omits_or_reports_tiles_with_no_product_per_require_all(self) -> None:
        day = date(2026, 2, 10)
        catalog = objects("32TPS", day, "V100")

        selected = select_window_products(catalog, ["32TPS", "33TUM"], day, day)
        self.assertEqual(sorted(selected), ["32TPS"])

        with self.assertRaisesRegex(ValueError, "no complete GFSC product found for 33TUM"):
            select_window_products(catalog, ["33TUM"], day, day, require_all=True)

    def test_discovery_lists_the_same_prefixes_as_newest_only_discovery(self) -> None:
        day = date(2026, 2, 10)
        catalog = objects("32TPS", day, "V100") + objects("32TPS", date(2026, 2, 3), "V100")

        class Paginator:
            """Return only the objects actually under each requested prefix."""

            def __init__(self) -> None:
                self.calls: list[dict[str, object]] = []

            def paginate(self, **kwargs):
                self.calls.append(kwargs)
                prefix = kwargs["Prefix"]
                return [
                    {
                        "Contents": [
                            {"Key": item.key, "Size": item.size}
                            for item in catalog
                            if item.key.startswith(prefix)
                        ]
                    }
                ]

        paginator = Paginator()
        client = type("Client", (), {"get_paginator": lambda self, name: paginator})()
        with patch("pipeline.fetch._client", return_value=client):
            selected = discover_window_products(["32TPS"], day, window_days=15)

        self.assertEqual(
            [item.product_date for item in selected["32TPS"]],
            [date(2026, 2, 3), day],
        )
        self.assertEqual(
            paginator.calls,
            [
                {"Bucket": BUCKET, "Prefix": "GFSC/32TPS/2026/01/"},
                {"Bucket": BUCKET, "Prefix": "GFSC/32TPS/2026/02/"},
            ],
        )


class MonthPrefixTests(unittest.TestCase):
    def test_month_prefixes_span_year_boundary_once_per_month(self) -> None:
        self.assertEqual(
            _month_prefixes("32TPS", date(2025, 12, 31), date(2026, 2, 1)),
            ["GFSC/32TPS/2025/12/", "GFSC/32TPS/2026/01/", "GFSC/32TPS/2026/02/"],
        )


class FetchAdapterTests(unittest.TestCase):
    def test_discovery_paginates_expected_prefixes(self) -> None:
        day = date(2026, 2, 10)
        catalog = objects("32TPS", day, "V100")

        class Paginator:
            def __init__(self) -> None:
                self.calls: list[dict[str, object]] = []

            def paginate(self, **kwargs):
                self.calls.append(kwargs)
                return [{"Contents": [{"Key": item.key, "Size": item.size} for item in catalog]}]

        paginator = Paginator()
        client = type("Client", (), {"get_paginator": lambda self, name: paginator})()
        with patch("pipeline.fetch._client", return_value=client):
            selected = discover_latest_products(["32TPS"], day, lookback_days=1)

        self.assertEqual(selected["32TPS"].version, "V100")
        self.assertEqual(paginator.calls, [{"Bucket": BUCKET, "Prefix": "GFSC/32TPS/2026/02/"}])

    def test_download_skips_exact_cache_and_atomically_replaces_partial_file(self) -> None:
        day = date(2026, 2, 10)
        source = objects("32TPS", day, "V100")
        layers = {"GF": source[0], "GF-QA": source[1], "AT": source[2]}
        product_name = source[0].key.split("/")[-2]
        product = CatalogProduct("32TPS", day, "V100", product_name, layers)

        class Client:
            def __init__(self) -> None:
                self.keys: list[str] = []

            def download_file(self, bucket, key, target):
                self.keys.append(key)
                Path(target).write_bytes(b"x" * next(item.size for item in source if item.key == key))

        client = Client()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cached = root / product_name / Path(layers["GF"].key).name
            cached.parent.mkdir(parents=True)
            cached.write_bytes(b"x" * layers["GF"].size)
            with patch("pipeline.fetch._client", return_value=client):
                written = download_products([product], root, workers=1)

            self.assertEqual(len(written), 2)
            self.assertNotIn(layers["GF"].key, client.keys)
            self.assertFalse(any(root.rglob("*.part")))


if __name__ == "__main__":
    unittest.main()
