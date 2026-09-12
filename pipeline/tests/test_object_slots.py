from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from nevaio_pipeline.object_slots import (
    SLOT_DIRECTORY,
    SlotMap,
    build_slot_map,
    extend_slot_map,
    load_or_create_slot_map,
    load_slot_map,
    slot_map_from_document,
    validate_slot_map,
    write_slot_map,
)


class SlotMapCoreTests(unittest.TestCase):
    def test_build_assigns_slots_in_given_order(self) -> None:
        slot_map = build_slot_map("32TPS", ["node/1", "node/2", "node/3"])
        self.assertEqual(slot_map.slot_for("node/1"), 0)
        self.assertEqual(slot_map.slot_for("node/2"), 1)
        self.assertEqual(slot_map.slot_for("node/3"), 2)
        self.assertEqual(slot_map.slot_count, 3)

    def test_unknown_id_has_no_slot(self) -> None:
        slot_map = build_slot_map("32TPS", ["node/1"])
        self.assertIsNone(slot_map.slot_for("node/999"))

    def test_rejects_duplicate_ids(self) -> None:
        with self.assertRaises(ValueError):
            SlotMap(tile="32TPS", slot_ids=("node/1", "node/1"))


class ExtendSlotMapTests(unittest.TestCase):
    """The append-only rule this whole module exists to enforce."""

    def test_disappeared_object_leaves_a_permanent_hole(self) -> None:
        original = build_slot_map("32TPS", ["node/1", "node/2", "node/3"])
        # node/2 vanished from the new OSM extract; node/4 is new.
        refreshed = extend_slot_map(original, ["node/1", "node/3", "node/4"])

        # Every id the old map knew keeps its exact slot - extending never
        # reassigns or drops an entry, it only appends.
        self.assertEqual(refreshed.slot_for("node/1"), 0)
        self.assertEqual(refreshed.slot_for("node/2"), 1)
        self.assertEqual(refreshed.slot_for("node/3"), 2)
        # The new object gets the next free slot, not node/2's now-unused one.
        self.assertEqual(refreshed.slot_for("node/4"), 3)
        self.assertEqual(refreshed.slot_count, 4)
        # node/2's slot is a hole only in the sense that nothing currently
        # live will sample into it - callers drive that by only handing
        # `index_tile_objects` (object_series_sampling.py) the *current*
        # shard's entries, never the slot map's own id list.

    def test_new_object_after_a_refresh_gets_the_next_free_slot(self) -> None:
        original = build_slot_map("32TPS", ["node/1"])
        refreshed = extend_slot_map(original, ["node/1", "node/2"])
        self.assertEqual(refreshed.slot_for("node/1"), 0)
        self.assertEqual(refreshed.slot_for("node/2"), 1)

    def test_no_new_ids_returns_the_same_map_unchanged(self) -> None:
        original = build_slot_map("32TPS", ["node/1", "node/2"])
        refreshed = extend_slot_map(original, ["node/1"])
        self.assertEqual(refreshed.slot_ids, original.slot_ids)

    def test_duplicate_ids_in_the_current_index_only_get_one_slot(self) -> None:
        original = build_slot_map("32TPS", ["node/1"])
        refreshed = extend_slot_map(original, ["node/2", "node/2", "node/1"])
        self.assertEqual(refreshed.slot_ids, ("node/1", "node/2"))

    def test_repeated_refreshes_never_move_an_earlier_assignment(self) -> None:
        step1 = build_slot_map("32TPS", ["a", "b"])
        step2 = extend_slot_map(step1, ["b", "c"])  # a disappears from the current index, c is new
        step3 = extend_slot_map(step2, ["a", "b", "c", "d"])  # a comes back, d is new

        self.assertEqual(step2.slot_for("a"), 0)  # untouched even though "a" wasn't in this refresh
        self.assertEqual(step2.slot_for("b"), 1)
        self.assertEqual(step2.slot_for("c"), 2)
        # "a" reappearing gets its original slot back - it was never actually
        # forgotten, only absent from one refresh's current id list.
        self.assertEqual(step3.slot_for("a"), 0)
        self.assertEqual(step3.slot_for("b"), 1)
        self.assertEqual(step3.slot_for("c"), 2)
        self.assertEqual(step3.slot_for("d"), 3)
        self.assertEqual(step3.slot_count, 4)


class ValidateSlotMapTests(unittest.TestCase):
    def test_passes_when_every_current_id_has_a_slot(self) -> None:
        slot_map = build_slot_map("32TPS", ["node/1", "node/2"])
        validate_slot_map(slot_map, ["node/1", "node/2"])  # no raise

    def test_raises_when_the_current_index_outgrew_the_map(self) -> None:
        slot_map = build_slot_map("32TPS", ["node/1"])
        with self.assertRaisesRegex(ValueError, "node/2"):
            validate_slot_map(slot_map, ["node/1", "node/2"])

    def test_a_hole_does_not_fail_validation(self) -> None:
        slot_map = build_slot_map("32TPS", ["node/1", "node/2"])
        validate_slot_map(slot_map, ["node/1"])  # node/2 missing from current: fine


class SlotMapSerializationTests(unittest.TestCase):
    def test_document_round_trip(self) -> None:
        slot_map = build_slot_map("32TPS", ["node/1", "node/2"])
        restored = slot_map_from_document(slot_map.to_document())
        self.assertEqual(restored, slot_map)

    def test_rejects_unsupported_schema_version(self) -> None:
        with self.assertRaises(ValueError):
            slot_map_from_document({"schemaVersion": 2, "tile": "32TPS", "slotIds": []})

    def test_write_then_load_round_trip(self) -> None:
        slot_map = build_slot_map("32TPS", ["node/1", "node/2"])
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            written = write_slot_map(root, slot_map)
            self.assertEqual(written, root / SLOT_DIRECTORY / "32TPS.json")
            loaded = load_slot_map(written)
            self.assertEqual(loaded, slot_map)

    def test_load_missing_file_returns_none(self) -> None:
        with TemporaryDirectory() as tmp:
            self.assertIsNone(load_slot_map(Path(tmp) / "slots" / "32TPS.json"))


class LoadOrCreateSlotMapTests(unittest.TestCase):
    def test_first_run_creates_a_fresh_map(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            slot_map = load_or_create_slot_map(root, "32TPS", ["node/1", "node/2"])
            self.assertEqual(slot_map.slot_ids, ("node/1", "node/2"))

    def test_later_run_extends_a_persisted_map(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = load_or_create_slot_map(root, "32TPS", ["node/1", "node/2"])
            write_slot_map(root, first)

            second = load_or_create_slot_map(root, "32TPS", ["node/1", "node/3"])
            self.assertEqual(second.slot_for("node/1"), 0)
            self.assertEqual(second.slot_for("node/2"), 1)  # still assigned, just not "current"
            self.assertEqual(second.slot_for("node/3"), 2)  # next free slot, not node/2's


if __name__ == "__main__":
    unittest.main()
