"""The permanent per-tile slot map for the per-object GFSC time series.

``docs/plan.md`` is explicit about why this exists: row order in
``series/<TILE>/<YYYY-MM>.bin`` (see :mod:`nevaio_pipeline.object_series`) must
be a permanent per-tile slot map published beside the object index, *not* the
index shard's own order. The shard is rebuilt from scratch every time the OSM
extracts refresh (:mod:`nevaio_pipeline.object_index`), and nothing promises
that a rebuild reproduces the same order - a new object inserted alphabetically
ahead of an old one would shift every later object's row, and every byte
offset ever handed to a client as an HTTP Range request would now point at the
wrong object's history.

A slot map fixes that by being append-only: once an object id is assigned a
slot, it keeps that slot forever, even across every later OSM refresh. An
object that disappears from the current index (renamed, deleted, or dropped by
a footprint change) is simply absent from the entries handed to the sampler,
so nothing is ever written to its slot again - it becomes a permanent hole in
the ``.bin`` files, and the objects on either side of it never move. The
permanent map itself does not forget the id, though: if the same id reappears
in a later refresh, it is recognized and gets its *original* slot back rather
than a new one, so a transient OSM edit never wastes a slot. An id the map has
truly never seen before gets the next free slot, in the order it is
presented. This module knows nothing about raster sampling, R2, or the
``.bin`` format itself - it is the ordering authority the sampler and the
format both build on.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Mapping, Sequence

SLOT_DIRECTORY = "slots"
_SCHEMA_VERSION = 1


@dataclass(frozen=True)
class SlotMap:
    """One tile's permanent object-id -> row-slot assignment.

    ``slot_ids[i]`` is the object id permanently occupying slot ``i``. The
    tuple only ever grows at the end; nothing in this module ever removes or
    reorders an existing entry.
    """

    tile: str
    slot_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        if len(set(self.slot_ids)) != len(self.slot_ids):
            raise ValueError(f"slot map for tile {self.tile} assigns one object id to two slots")

    @property
    def slot_count(self) -> int:
        return len(self.slot_ids)

    @property
    def path(self) -> str:
        return f"{SLOT_DIRECTORY}/{self.tile}.json"

    def slot_for(self, object_id: str) -> int | None:
        """Return the permanent slot for ``object_id``, or ``None`` if unassigned."""

        return self._index.get(object_id)

    @property
    def _index(self) -> Mapping[str, int]:
        cached = self.__dict__.get("_slot_index_cache")
        if cached is None:
            cached = {object_id: position for position, object_id in enumerate(self.slot_ids)}
            object.__setattr__(self, "_slot_index_cache", cached)
        return cached

    def to_document(self) -> dict[str, object]:
        return {
            "schemaVersion": _SCHEMA_VERSION,
            "tile": self.tile,
            "slotCount": self.slot_count,
            "slotIds": list(self.slot_ids),
        }


def build_slot_map(tile: str, object_ids: Sequence[str]) -> SlotMap:
    """Create a brand-new slot map, assigning slots in the given order.

    Only for a tile with no published slot map at all yet. Once written, this
    ordering is permanent: every later OSM refresh must go through
    :func:`extend_slot_map`, never through this function again, or every
    previously written ``.bin`` byte offset for this tile is invalidated.
    """

    return SlotMap(tile=tile, slot_ids=tuple(object_ids))


def extend_slot_map(existing: SlotMap, current_object_ids: Sequence[str]) -> SlotMap:
    """Append-only extension of ``existing`` for a new OSM refresh.

    Every id ``existing`` already knows keeps its slot, at the same index,
    forever - that is what keeps previously written ``.bin`` byte offsets
    valid. An id in ``current_object_ids`` that ``existing`` has never seen
    gets the next free slot, in the order it first appears here. An id
    ``existing`` knows about that is missing from ``current_object_ids`` stays
    in the returned map, at its existing slot, unchanged: this function only
    ever adds, so whether that id is "live" right now is a question for the
    caller's own entry list, not something this map tracks.
    """

    known = set(existing.slot_ids)
    additions: list[str] = []
    seen_additions: set[str] = set()
    for object_id in current_object_ids:
        if object_id in known or object_id in seen_additions:
            continue
        additions.append(object_id)
        seen_additions.add(object_id)
    if not additions:
        return existing
    return SlotMap(tile=existing.tile, slot_ids=existing.slot_ids + tuple(additions))


def validate_slot_map(slot_map: SlotMap, current_object_ids: Sequence[str]) -> None:
    """Raise if ``slot_map`` cannot be safely sampled against ``current_object_ids``.

    A slot map missing an id the current object index carries cannot be used
    for sampling: doing so would either skip that object silently or require
    inventing a slot for it here, which would make growth an invisible side
    effect of sampling rather than the explicit, auditable step
    :func:`extend_slot_map` is meant to be. Callers must extend first.
    """

    index = slot_map._index
    missing = sorted({object_id for object_id in current_object_ids if object_id not in index})
    if missing:
        preview = ", ".join(missing[:5])
        more = "" if len(missing) <= 5 else f" (+{len(missing) - 5} more)"
        raise ValueError(
            f"slot map for tile {slot_map.tile} is missing {len(missing)} object id(s) "
            f"present in the current index and must be extended first: {preview}{more}"
        )


def slot_map_from_document(document: Mapping[str, object]) -> SlotMap:
    if document.get("schemaVersion") != _SCHEMA_VERSION:
        raise ValueError("slot map document has an unsupported schemaVersion")
    tile = document.get("tile")
    if not isinstance(tile, str) or not tile:
        raise ValueError("slot map document is missing a tile id")
    slot_ids = document.get("slotIds")
    if not isinstance(slot_ids, list) or not all(isinstance(item, str) and item for item in slot_ids):
        raise ValueError("slot map document slotIds must be a list of non-empty strings")
    return SlotMap(tile=tile, slot_ids=tuple(slot_ids))


def load_slot_map(path: Path) -> SlotMap | None:
    """Load one tile's slot map file, or ``None`` if it has never been created."""

    if not path.is_file():
        return None
    return slot_map_from_document(json.loads(path.read_text(encoding="utf-8")))


def write_slot_map(directory: Path, slot_map: SlotMap) -> Path:
    """Write a slot map beside the object index, at ``directory/slots/<TILE>.json``."""

    destination = directory / slot_map.path
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(slot_map.to_document(), ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return destination


def load_or_create_slot_map(directory: Path, tile: str, current_object_ids: Sequence[str]) -> SlotMap:
    """Load a tile's slot map and extend it for the current index, or create it fresh.

    This is the one entry point production code should call: it never
    reorders or drops an existing assignment, so its result is always safe to
    sample ``.bin`` files written against an earlier version of the same
    file. The caller is responsible for persisting the result with
    :func:`write_slot_map` when it wants the extension to survive.
    """

    existing = load_slot_map(directory / SLOT_DIRECTORY / f"{tile}.json")
    if existing is None:
        return build_slot_map(tile, current_object_ids)
    return extend_slot_map(existing, current_object_ids)
