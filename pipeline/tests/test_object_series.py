from __future__ import annotations

import itertools
import unittest
from datetime import date

import numpy as np

from nevaio_pipeline.asof import CLOUD, NODATA, WATER
from nevaio_pipeline.object_series import (
    CELL_SIZE,
    NO_DATA_CELL,
    SeriesMarkState,
    array_from_buffer,
    buffer_from_array,
    cell_offset,
    days_in_month,
    decode_cell,
    encode_cell,
    encode_cells_vectorized,
    grow_month_array,
    month_buffer_size,
    new_month_array,
    new_month_buffer,
    object_month_range,
    read_cell,
    unix_day,
    write_cell,
)


def epoch(day: date, hour: int = 10) -> int:
    from datetime import UTC, datetime

    return int(datetime(day.year, day.month, day.day, hour, tzinfo=UTC).timestamp())


class EncodeDecodeSentinelTests(unittest.TestCase):
    """The three gap categories, plus the one real mark, must round-trip and be distinguishable."""

    def test_valid_mark(self) -> None:
        product_day = unix_day(date(2026, 2, 10))
        at = epoch(date(2026, 2, 8))  # two days before the product date
        cell = encode_cell(gf=42, quality=1, acquisition_time=at, product_day_epoch=product_day)
        decoded = decode_cell(cell)
        self.assertEqual(decoded.state, SeriesMarkState.VALID)
        self.assertEqual(decoded.gf, 42)
        self.assertEqual(decoded.quality, 1)
        self.assertEqual(decoded.age_days, 2)

    def test_valid_mark_at_the_exact_14_day_ceiling(self) -> None:
        product_day = unix_day(date(2026, 2, 14))
        at = epoch(date(2026, 1, 31))  # exactly 14 days earlier
        decoded = decode_cell(encode_cell(10, 0, at, product_day))
        self.assertEqual(decoded.state, SeriesMarkState.VALID)
        self.assertEqual(decoded.age_days, 14)

    def test_stale_one_day_past_the_ceiling(self) -> None:
        product_day = unix_day(date(2026, 2, 15))
        at = epoch(date(2026, 1, 31))  # 15 days earlier
        decoded = decode_cell(encode_cell(10, 0, at, product_day))
        self.assertEqual(decoded.state, SeriesMarkState.STALE)
        # Raw GF/QA are preserved for detail views even though it's not a mark.
        self.assertEqual(decoded.gf, 10)
        self.assertEqual(decoded.age_days, None)

    def test_stale_when_gf_present_but_qa_out_of_range(self) -> None:
        product_day = unix_day(date(2026, 2, 10))
        at = epoch(date(2026, 2, 9))
        decoded = decode_cell(encode_cell(gf=10, quality=4, acquisition_time=at, product_day_epoch=product_day))
        self.assertEqual(decoded.state, SeriesMarkState.STALE)

    def test_stale_when_gf_present_but_at_unusable(self) -> None:
        product_day = unix_day(date(2026, 2, 10))
        decoded = decode_cell(encode_cell(gf=10, quality=0, acquisition_time=0, product_day_epoch=product_day))
        self.assertEqual(decoded.state, SeriesMarkState.STALE)

    def test_cloud(self) -> None:
        product_day = unix_day(date(2026, 2, 10))
        decoded = decode_cell(encode_cell(CLOUD, CLOUD, 0, product_day))
        self.assertEqual(decoded, (SeriesMarkState.CLOUD, None, None, None))

    def test_no_data_from_the_water_code(self) -> None:
        product_day = unix_day(date(2026, 2, 10))
        decoded = decode_cell(encode_cell(WATER, WATER, 0, product_day))
        self.assertEqual(decoded.state, SeriesMarkState.NO_DATA)

    def test_no_data_from_the_raw_nodata_code(self) -> None:
        product_day = unix_day(date(2026, 2, 10))
        decoded = decode_cell(encode_cell(NODATA, NODATA, 0, product_day))
        self.assertEqual(decoded.state, SeriesMarkState.NO_DATA)

    def test_missing_day_sentinel_decodes_as_no_data(self) -> None:
        self.assertEqual(decode_cell(NO_DATA_CELL).state, SeriesMarkState.NO_DATA)

    def test_the_four_states_use_distinguishable_byte_patterns(self) -> None:
        product_day = unix_day(date(2026, 2, 20))
        valid = encode_cell(30, 2, epoch(date(2026, 2, 19)), product_day)
        cloud = encode_cell(CLOUD, CLOUD, 0, product_day)
        no_data = encode_cell(NODATA, NODATA, 0, product_day)
        stale = encode_cell(30, 2, epoch(date(2026, 1, 1)), product_day)
        self.assertEqual(len({valid, cloud, no_data, stale}), 4)

    def test_decode_rejects_the_wrong_cell_size(self) -> None:
        with self.assertRaises(ValueError):
            decode_cell(b"\x00")


class ScalarVectorEquivalenceTests(unittest.TestCase):
    """The numpy fast path must never disagree with the scalar definition."""

    def test_matches_across_a_grid_of_edge_cases(self) -> None:
        product_day = unix_day(date(2026, 2, 20))
        gf_values = [0, 1, 50, 100, 101, CLOUD, WATER, NODATA, 200]
        quality_values = [0, 3, 4, 255]
        at_values = [0, -1, epoch(date(2026, 2, 20)), epoch(date(2026, 2, 6)), epoch(date(2026, 1, 1))]

        for gf, quality, at in itertools.product(gf_values, quality_values, at_values):
            with self.subTest(gf=gf, quality=quality, at=at):
                scalar = encode_cell(gf, quality, at, product_day)
                vector = encode_cells_vectorized(
                    np.array([gf]), np.array([quality]), np.array([at]), product_day
                )
                self.assertEqual(scalar, bytes((int(vector[0, 0]), int(vector[0, 1]))))

    def test_vectorized_handles_a_batch_in_one_call(self) -> None:
        product_day = unix_day(date(2026, 2, 20))
        gf = np.array([50, CLOUD, NODATA])
        quality = np.array([1, 0, 0])
        at = np.array([epoch(date(2026, 2, 19)), 0, 0])
        cells = encode_cells_vectorized(gf, quality, at, product_day)
        self.assertEqual(cells.shape, (3, 2))
        self.assertEqual(decode_cell(bytes(cells[0])).state, SeriesMarkState.VALID)
        self.assertEqual(decode_cell(bytes(cells[1])).state, SeriesMarkState.CLOUD)
        self.assertEqual(decode_cell(bytes(cells[2])).state, SeriesMarkState.NO_DATA)


class OffsetArithmeticTests(unittest.TestCase):
    def test_object_month_range_is_62_bytes_for_a_31_day_month(self) -> None:
        self.assertEqual(object_month_range(0, 31), (0, 62))
        self.assertEqual(object_month_range(1, 31), (62, 62))
        self.assertEqual(object_month_range(5, 31), (310, 62))

    def test_cell_offset_matches_object_month_range_start(self) -> None:
        days = 31
        for slot in (0, 1, 5, 100):
            start, _ = object_month_range(slot, days)
            self.assertEqual(cell_offset(slot, 0, days), start)
            self.assertEqual(cell_offset(slot, days - 1, days), start + (days - 1) * CELL_SIZE)

    def test_cell_offset_rejects_an_out_of_range_day(self) -> None:
        with self.assertRaises(ValueError):
            cell_offset(0, 31, 31)
        with self.assertRaises(ValueError):
            cell_offset(0, -1, 31)

    def test_month_buffer_size(self) -> None:
        self.assertEqual(month_buffer_size(100, 31), 100 * 31 * 2)

    def test_days_in_month_handles_february(self) -> None:
        self.assertEqual(days_in_month(2024, 2), 29)  # leap year
        self.assertEqual(days_in_month(2026, 2), 28)


class MonthByteBufferTests(unittest.TestCase):
    def test_new_buffer_is_all_no_data(self) -> None:
        buffer = new_month_buffer(3, 2026, 2)  # 28-day month
        self.assertEqual(len(buffer), month_buffer_size(3, 28))
        for slot in range(3):
            for day in range(28):
                self.assertEqual(read_cell(buffer, slot, day, 28).state, SeriesMarkState.NO_DATA)

    def test_write_then_read_a_62_byte_object_month_lands_at_the_right_offset(self) -> None:
        days = 31
        buffer = new_month_buffer(4, 2026, 1)
        product_day = unix_day(date(2026, 1, 10))
        cell = encode_cell(77, 2, epoch(date(2026, 1, 9)), product_day)
        write_cell(buffer, slot_index=2, day_index=9, days=days, cell=cell)

        start, length = object_month_range(2, days)
        self.assertEqual(length, 62)
        month_slice = bytes(buffer[start : start + length])
        self.assertEqual(len(month_slice), 62)
        # Every other day in this object's own 62-byte range is untouched.
        for day in range(days):
            decoded = decode_cell(month_slice[day * CELL_SIZE : day * CELL_SIZE + CELL_SIZE])
            if day == 9:
                self.assertEqual(decoded.state, SeriesMarkState.VALID)
                self.assertEqual(decoded.gf, 77)
            else:
                self.assertEqual(decoded.state, SeriesMarkState.NO_DATA)
        # And no other object's slot was touched.
        for other_slot in (0, 1, 3):
            for day in range(days):
                self.assertEqual(read_cell(buffer, other_slot, day, days).state, SeriesMarkState.NO_DATA)

    def test_a_missing_day_in_the_middle_of_a_month_is_still_a_gap(self) -> None:
        days = 31
        buffer = new_month_buffer(1, 2026, 1)
        product_day_5 = unix_day(date(2026, 1, 5))
        write_cell(buffer, 0, 4, days, encode_cell(20, 0, epoch(date(2026, 1, 5)), product_day_5))
        product_day_7 = unix_day(date(2026, 1, 7))
        write_cell(buffer, 0, 6, days, encode_cell(25, 0, epoch(date(2026, 1, 7)), product_day_7))
        # Day 6 (index 5, the 6th of the month) never had a product this run.
        self.assertEqual(read_cell(buffer, 0, 4, days).state, SeriesMarkState.VALID)
        self.assertEqual(read_cell(buffer, 0, 5, days).state, SeriesMarkState.NO_DATA)
        self.assertEqual(read_cell(buffer, 0, 6, days).state, SeriesMarkState.VALID)


class MonthArrayTests(unittest.TestCase):
    """The (slots, days, 2) numpy view used by the sampling hot path."""

    def test_new_array_matches_new_buffer_byte_for_byte(self) -> None:
        array = new_month_array(3, 2026, 2)
        buffer = new_month_buffer(3, 2026, 2)
        self.assertEqual(buffer_from_array(array), bytes(buffer))

    def test_array_from_buffer_round_trips(self) -> None:
        days = 30
        buffer = new_month_buffer(2, 2026, 4)
        write_cell(buffer, 1, 3, days, encode_cell(15, 1, epoch(date(2026, 4, 4)), unix_day(date(2026, 4, 4))))
        array = array_from_buffer(bytes(buffer), 2, days)
        self.assertEqual(buffer_from_array(array), bytes(buffer))
        cell = bytes(array[1, 3])
        self.assertEqual(decode_cell(cell).gf, 15)

    def test_array_from_buffer_rejects_a_size_mismatch(self) -> None:
        with self.assertRaises(ValueError):
            array_from_buffer(b"\x00" * 10, slot_count=2, days=31)

    def test_grow_month_array_appends_new_slots_without_disturbing_old_ones(self) -> None:
        days = 28
        array = new_month_array(2, 2026, 2)
        cell = np.array(list(encode_cell(60, 0, epoch(date(2026, 2, 1)), unix_day(date(2026, 2, 1)))), dtype=np.uint8)
        array[0, 0, :] = cell

        grown = grow_month_array(array, 4)
        self.assertEqual(grown.shape, (4, days, 2))
        # The original two slots are untouched, byte for byte.
        np.testing.assert_array_equal(grown[:2], array)
        # The two new slots start out as pure no-data.
        for slot in (2, 3):
            for day in range(days):
                self.assertEqual(decode_cell(bytes(grown[slot, day])).state, SeriesMarkState.NO_DATA)

    def test_grow_month_array_is_a_no_op_at_the_same_size(self) -> None:
        array = new_month_array(2, 2026, 2)
        self.assertIs(grow_month_array(array, 2), array)

    def test_grow_month_array_rejects_shrinking(self) -> None:
        array = new_month_array(3, 2026, 2)
        with self.assertRaises(ValueError):
            grow_month_array(array, 2)


if __name__ == "__main__":
    unittest.main()
