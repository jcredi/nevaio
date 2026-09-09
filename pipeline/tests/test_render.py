from __future__ import annotations

import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from affine import Affine

from nevaio_pipeline.render import _downloaded_triplets, _local_window, _parse_date, build_preview
from nevaio_pipeline.fetch import CatalogProduct
from nevaio_pipeline.raster_io import ProductTriplet, RasterGrid


def triplet(tile: str, day: date, version: str) -> ProductTriplet:
    product = f"CLMS_WSI_GFSC_060m_T{tile}_{day:%Y%m%d}P7D_COMB_{version}"
    base = Path(product)
    return ProductTriplet(product, tile, day, version, base / "gf", base / "qa", base / "at")


class PreviewHelpersTests(unittest.TestCase):
    def test_parse_date_accepts_iso_and_rejects_other_formats(self) -> None:
        self.assertEqual(_parse_date("2026-02-10"), date(2026, 2, 10))
        with self.assertRaisesRegex(Exception, "YYYY-MM-DD"):
            _parse_date("10/02/2026")

    def test_local_window_bounds_the_window_and_resolves_versions(self) -> None:
        as_of = date(2026, 2, 10)
        discovered = [
            triplet("32TPS", date(2026, 2, 9), "V100"),
            triplet("32TPS", as_of, "V101"),
            triplet("32TPS", as_of, "V102"),
            triplet("32TPS", date(2026, 2, 11), "V999"),
            triplet("32TPS", date(2026, 1, 26), "V100"),
        ]
        with patch("nevaio_pipeline.render.discover_product_triplets", return_value=discovered):
            selected = _local_window(Path("raw"), ["32TPS"], as_of, 15)

        # 2026-02-11 is after the AS-OF date and 2026-01-26 is before the
        # 15-day window opens on 2026-01-27; the AS-OF date keeps V102.
        self.assertEqual(
            [(item.product_date, item.version) for item in selected["32TPS"]],
            [(date(2026, 2, 9), "V100"), (as_of, "V102")],
        )

    def test_local_window_reports_all_missing_tiles(self) -> None:
        with patch("nevaio_pipeline.render.discover_product_triplets", return_value=[]):
            with self.assertRaisesRegex(ValueError, "32TPS, 33TUM"):
                _local_window(Path("raw"), ["33TUM", "32TPS"], date(2026, 2, 10), 15)

    def test_downloaded_triplets_maps_whole_windows_and_reports_missing(self) -> None:
        older = triplet("32TPS", date(2026, 2, 9), "V100")
        newer = triplet("32TPS", date(2026, 2, 10), "V100")

        def catalog(item) -> CatalogProduct:
            return CatalogProduct("32TPS", item.product_date, item.version, item.product, {})

        with patch(
            "nevaio_pipeline.render.discover_product_triplets", return_value=[older, newer]
        ):
            selected = _downloaded_triplets(
                Path("raw"), {"32TPS": (catalog(older), catalog(newer))}
            )
        self.assertEqual(selected["32TPS"], (older, newer))

        missing = CatalogProduct("33TUM", newer.product_date, "V100", "missing-product", {})
        with patch("nevaio_pipeline.render.discover_product_triplets", return_value=[newer]):
            with self.assertRaisesRegex(ValueError, "missing-product"):
                _downloaded_triplets(Path("raw"), {"33TUM": (missing,)})

    def test_build_preview_writes_latest_manifest_and_hands_off_completed_run(self) -> None:
        first = (
            triplet("32TPS", date(2026, 2, 8), "V100"),
            triplet("32TPS", date(2026, 2, 9), "V100"),
        )
        second = (triplet("33TUM", date(2026, 2, 10), "V100"),)
        grid = RasterGrid("EPSG:3857", Affine(1, 0, 0, 0, -1, 1), 1, 1)

        def persist(path, _tile) -> None:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output = root / "output"
            with (
                patch("nevaio_pipeline.render._local_window", return_value={"32TPS": first, "33TUM": second}) as local,
                patch("nevaio_pipeline.render.load_tile_products", return_value=SimpleNamespace(grid=grid, products=(object(),))) as load,
                patch("nevaio_pipeline.render.compose_as_of", return_value=object()),
                patch("nevaio_pipeline.render.save_snapshot", side_effect=persist),
                patch("nevaio_pipeline.render.render_snapshots", return_value=[Path("one.png"), Path("two.png")]),
                patch("nevaio_pipeline.render._bounds_wgs84", return_value=[5.0, 40.0, 16.0, 48.0]),
                patch("nevaio_pipeline.render.publish_to_r2") as publish,
            ):
                metadata = build_preview(
                    as_of_date=date(2026, 2, 10),
                    tiles=["33tum", "32TPS", "32TPS"],
                    raw_dir=root / "raw",
                    work_dir=root / "work",
                    output_dir=output,
                    fetch=False,
                    publish=True,
                )

            local.assert_called_once_with(
                root / "raw", ("32TPS", "33TUM"), date(2026, 2, 10), 31
            )
            # The whole window reaches the loader, not just its newest member.
            self.assertEqual([call.args[0] for call in load.call_args_list], [first, second])
            self.assertEqual(metadata["sourceTiles"], ["32TPS", "33TUM"])
            self.assertEqual(metadata["mode"], "asof-window")
            self.assertEqual(metadata["asOfWindowDays"], 31)
            self.assertEqual(metadata["sourceProductCounts"], {"32TPS": 2, "33TUM": 1})
            self.assertEqual(metadata["sourceProductTotal"], 3)
            # productDates reports each tile's newest contributing product.
            self.assertEqual(
                metadata["productDates"], {"32TPS": "2026-02-09", "33TUM": "2026-02-10"}
            )
            self.assertEqual(metadata["tileCount"], 2)
            self.assertEqual(metadata["bounds"], [5.0, 40.0, 16.0, 48.0])
            run_dir = output / "runs" / str(metadata["runId"])
            self.assertEqual(json.loads((run_dir / "run.json").read_text()), metadata)
            latest = json.loads((output / "latest.json").read_text())
            self.assertEqual(latest["tiles"], [f"runs/{metadata['runId']}/tiles/{{z}}/{{x}}/{{y}}.png"])
            publish.assert_called_once_with(run_dir, metadata, keep_runs=None)

    def test_build_preview_refuses_to_publish_a_partial_area_by_default(self) -> None:
        found = (triplet("32TPS", date(2026, 2, 10), "V100"),)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with (
                patch("nevaio_pipeline.render._local_window", return_value={"32TPS": found}),
                patch("nevaio_pipeline.render.publish_to_r2") as publish,
            ):
                with self.assertRaisesRegex(ValueError, "33TUM"):
                    build_preview(
                        as_of_date=date(2026, 2, 10),
                        tiles=["32TPS", "33TUM"],
                        raw_dir=root / "raw",
                        work_dir=root / "work",
                        output_dir=root / "output",
                        fetch=False,
                        publish=True,
                    )
            # Nothing is rendered or published, so the previously published
            # latest.json keeps pointing at the last complete run.
            publish.assert_not_called()
            self.assertFalse((root / "output" / "latest.json").exists())


if __name__ == "__main__":
    unittest.main()
