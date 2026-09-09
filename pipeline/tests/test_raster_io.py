from __future__ import annotations

import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from affine import Affine
import numpy as np
import rasterio
from rasterio.crs import CRS

from nevaio_pipeline.config import GFSC_TILE_PIXELS
from nevaio_pipeline.raster_io import discover_product_triplets, load_tile_products


# Pixel value written only into a file outside the input directory, so a test
# can tell "the loader refused" from "the loader read the wrong file".
_OUTSIDE_MARKER = 7


class RasterIoTests(unittest.TestCase):
    tile = "32TPS"
    product_date = date(2026, 2, 6)

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_discovers_and_loads_a_valid_triplet(self) -> None:
        product_dir = self._write_product()

        triplets = discover_product_triplets(self.root)
        loaded = load_tile_products(triplets, expected_pixels=2)

        self.assertEqual(product_dir.name, triplets[0].product)
        self.assertEqual(loaded.tile, self.tile)
        self.assertEqual(loaded.grid.crs, "EPSG:32632")
        self.assertEqual(loaded.grid.width, 2)
        self.assertEqual(loaded.grid.height, 2)
        self.assertEqual(len(loaded.products), 1)
        np.testing.assert_array_equal(loaded.products[0].gf, [[0, 50], [100, 255]])
        np.testing.assert_array_equal(loaded.products[0].quality, [[0, 1], [3, 255]])
        np.testing.assert_array_equal(
            loaded.products[0].acquisition_time,
            [[1_770_000_000, 1_770_000_001], [1_770_000_002, 0]],
        )

    def test_rejects_an_incomplete_product(self) -> None:
        product_dir = self._write_product()
        (product_dir / f"{product_dir.name}_AT.tif").unlink()

        with self.assertRaisesRegex(ValueError, "incomplete GFSC product.*AT"):
            discover_product_triplets(self.root)

    def test_rejects_grid_mismatch_between_layers(self) -> None:
        self._write_product(at_transform=Affine.translation(600_060, 5_100_000) * Affine.scale(60, -60))

        with self.assertRaisesRegex(ValueError, "grid mismatch"):
            load_tile_products(discover_product_triplets(self.root), expected_pixels=2)

    def test_rejects_unexpected_layer_metadata(self) -> None:
        self._write_product(gf_nodata=0)

        with self.assertRaisesRegex(ValueError, "GF raster has nodata 0.0, expected 255"):
            load_tile_products(discover_product_triplets(self.root), expected_pixels=2)

    def test_rejects_duplicate_dates_and_mixed_tiles(self) -> None:
        self._write_product(version="V101")
        self._write_product(version="V102")

        with self.assertRaisesRegex(ValueError, "multiple GFSC product versions"):
            discover_product_triplets(self.root)

        other_root = self.root / "other"
        self._write_product(root=other_root, tile="33TUM")
        first = discover_product_triplets(self.root / "CLMS_WSI_GFSC_060m_T32TPS_20260206P7D_COMB_V101")
        second = discover_product_triplets(other_root)
        with self.assertRaisesRegex(ValueError, "exactly one MGRS tile"):
            load_tile_products([*first, *second], expected_pixels=2)

    # --- Input boundary tests (security audit F2) -------------------------

    def test_rejects_a_vrt_disguised_as_a_geotiff(self) -> None:
        """A `.tif` suffix is not evidence of GeoTIFF content.

        The audit demonstrated that a VRT using SimpleSource could make the
        loader read a raster outside its input directory. This asserts both
        halves of the fix: an unrestricted open really does follow the
        reference (so the probe is a genuine one), and the pipeline's
        driver-restricted open refuses it.
        """

        product_dir = self._write_product()
        outside = self.root / "outside.tif"
        with rasterio.open(
            outside, "w", driver="GTiff", width=2, height=2, count=1,
            dtype="uint8", crs=CRS.from_epsg(32632), nodata=255,
            transform=Affine.translation(600_000, 5_100_000) * Affine.scale(60, -60),
        ) as dataset:
            dataset.write(np.full((2, 2), _OUTSIDE_MARKER, dtype=np.uint8), 1)

        gf_path = product_dir / f"{product_dir.name}_GF.tif"
        gf_path.write_text(
            f"""<VRTDataset rasterXSize="2" rasterYSize="2">
  <SRS>EPSG:32632</SRS>
  <GeoTransform>600000, 60, 0, 5100000, 0, -60</GeoTransform>
  <VRTRasterBand dataType="Byte" band="1">
    <NoDataValue>255</NoDataValue>
    <SimpleSource>
      <SourceFilename relativeToVRT="0">{outside}</SourceFilename>
      <SourceBand>1</SourceBand>
    </SimpleSource>
  </VRTRasterBand>
</VRTDataset>
"""
        )

        # Without the restriction GDAL follows the reference and hands back the
        # outside file's pixels - the primitive the audit found.
        with rasterio.open(gf_path) as unrestricted:
            self.assertEqual(unrestricted.driver, "VRT")
            self.assertTrue((unrestricted.read(1) == _OUTSIDE_MARKER).all())

        with self.assertRaises(rasterio.errors.RasterioIOError):
            load_tile_products(discover_product_triplets(self.root), expected_pixels=2)

    def test_rejects_a_layer_over_the_size_limit(self) -> None:
        product_dir = self._write_product()
        gf_path = product_dir / f"{product_dir.name}_GF.tif"
        with patch("nevaio_pipeline.raster_io.MAX_LAYER_BYTES", 16):
            with self.assertRaisesRegex(ValueError, "over the 16-byte limit"):
                load_tile_products(discover_product_triplets(self.root), expected_pixels=2)
        self.assertTrue(gf_path.is_file())

    def test_rejects_a_symlinked_layer(self) -> None:
        product_dir = self._write_product()
        gf_path = product_dir / f"{product_dir.name}_GF.tif"
        real = self.root / "elsewhere.tif"
        gf_path.replace(real)
        gf_path.symlink_to(real)

        with self.assertRaisesRegex(ValueError, "is a symlink"):
            load_tile_products(discover_product_triplets(self.root), expected_pixels=2)

    def test_rejects_a_raster_in_the_wrong_utm_zone(self) -> None:
        self._write_product(crs_epsg=32633)

        with self.assertRaisesRegex(ValueError, "expected EPSG:32632 for tile 32TPS"):
            load_tile_products(discover_product_triplets(self.root), expected_pixels=2)

    def test_rejects_an_unexpected_pixel_size(self) -> None:
        self._write_product(
            transform=Affine.translation(600_000, 5_100_000) * Affine.scale(10, -10)
        )

        with self.assertRaisesRegex(ValueError, "pixel size is 10.0x-10.0"):
            load_tile_products(discover_product_triplets(self.root), expected_pixels=2)

    def test_rejects_a_rotated_grid(self) -> None:
        self._write_product(
            transform=Affine(60.0, 5.0, 600_000.0, 5.0, -60.0, 5_100_000.0)
        )

        with self.assertRaisesRegex(ValueError, "rotated or sheared"):
            load_tile_products(discover_product_triplets(self.root), expected_pixels=2)

    def test_rejects_an_implausible_origin(self) -> None:
        self._write_product(
            transform=Affine.translation(-600_000, 5_100_000) * Affine.scale(60, -60)
        )

        with self.assertRaisesRegex(ValueError, "outside the plausible northern-UTM range"):
            load_tile_products(discover_product_triplets(self.root), expected_pixels=2)

    def test_accepts_the_real_gfsc_shape_by_default(self) -> None:
        """The production default is the measured GFSC shape, not a test value."""

        self.assertEqual(GFSC_TILE_PIXELS, 1830)
        self._write_product()
        with self.assertRaisesRegex(ValueError, r"is 2x2, expected 1830x1830"):
            load_tile_products(discover_product_triplets(self.root))

    def _write_product(
        self,
        *,
        root: Path | None = None,
        tile: str | None = None,
        version: str = "V102",
        gf_nodata: int = 255,
        at_transform: Affine | None = None,
        crs_epsg: int = 32632,
        transform: Affine | None = None,
    ) -> Path:
        destination = root or self.root
        use_tile = tile or self.tile
        stem = f"CLMS_WSI_GFSC_060m_T{use_tile}_20260206P7D_COMB_{version}"
        product_dir = destination / stem
        product_dir.mkdir(parents=True, exist_ok=True)
        transform = transform or (
            Affine.translation(600_000, 5_100_000) * Affine.scale(60, -60)
        )
        arrays = {
            "GF": (np.array([[0, 50], [100, 255]], dtype=np.uint8), "uint8", gf_nodata, transform),
            "GF-QA": (np.array([[0, 1], [3, 255]], dtype=np.uint8), "uint8", 255, transform),
            "AT": (
                np.array([[1_770_000_000, 1_770_000_001], [1_770_000_002, 0]], dtype=np.uint32),
                "uint32",
                0,
                at_transform or transform,
            ),
        }
        for layer, (array, dtype, nodata, layer_transform) in arrays.items():
            with rasterio.open(
                product_dir / f"{stem}_{layer}.tif",
                "w",
                driver="GTiff",
                width=2,
                height=2,
                count=1,
                dtype=dtype,
                crs=CRS.from_epsg(crs_epsg),
                transform=layer_transform,
                nodata=nodata,
            ) as dataset:
                dataset.write(array, 1)
        return product_dir
