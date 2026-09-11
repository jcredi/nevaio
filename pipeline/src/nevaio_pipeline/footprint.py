"""The one definition of Nevaio's geographic snow footprint.

The product only ever shows snow where a GFSC product exists, and that set is
exactly the MGRS squares in :data:`nevaio_pipeline.config.MVP_MGRS_TILES`. Any
other component that needs to ask "is this place inside Nevaio?" - today the
static OSM object index - must ask this module, so there is never a second,
divergent outline of the same area.

Pure standard library on purpose. ``config.MVP_MGRS_TILES`` was resolved once
against Copernicus's own MGRS reference precisely so production does not carry
a spatial-library stack, and a footprint test that needed one would give that
saving straight back. What is needed instead is small and fully specified: the
MGRS 100 km square lettering scheme, and the transverse Mercator projection
that UTM is - implemented here as the Krüger series, which is accurate to well
under a metre over a UTM zone and its overlap. That is four orders of
magnitude finer than the 60 m pixels the footprint is made of.

Geometry, stated once so callers do not re-derive it: a tile id like ``32TPS``
names a UTM zone (32), a latitude band (T) and a 100 km MGRS square (PS). The
Sentinel-2 / HR-WSI granule filed under that name is 109.8 km square with its
north-west corner on the square's north-west corner, so it reaches 9.8 km east
and 9.8 km south beyond the lettered square. Granule corners carry a further
20 m alignment offset that is deliberately ignored: a third of a pixel does not
change whether a mountain is in the product.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from math import asin, atan2, atanh, cos, cosh, degrees, radians, sin, sinh, sqrt
from typing import Iterable, Sequence

# WGS84 / UTM, all fixed properties of the projection rather than tunables.
_SEMI_MAJOR_AXIS = 6_378_137.0
_FLATTENING = 1 / 298.257223563
_SCALE_FACTOR = 0.9996
_FALSE_EASTING = 500_000.0

# GFSC is published in northern UTM zones, whose EPSG codes are 32600 + zone.
UTM_NORTH_EPSG_BASE = 32600

# One MGRS 100 km square, and the granule that overhangs it (see module docs).
MGRS_SQUARE_METRES = 100_000.0
GRANULE_METRES = 109_800.0

_COLUMN_LETTERS = ("STUVWXYZ", "ABCDEFGH", "JKLMNPQR")
_ROW_LETTERS = "ABCDEFGHJKLMNPQRSTUV"
_ROW_CYCLE_METRES = len(_ROW_LETTERS) * MGRS_SQUARE_METRES
# Even zones start their row lettering five letters further on, so the same
# letter means a different 100 km band north/south of it than in an odd zone.
_EVEN_ZONE_ROW_SHIFT = 5
_BAND_LETTERS = "CDEFGHJKLMNPQRSTUVWX"
_BAND_DEGREES = 8.0

# How far a 100 km square may sit outside its band's own northing range before
# the row-letter cycle is considered unresolved. A band is ~890 km tall and the
# row cycle is 2000 km, so any slack in this range picks the same square; the
# check exists to catch a mis-decoded tile id, not to tune a result.
_BAND_NORTHING_SLACK = 300_000.0

# UTM zones are 6 degrees wide; granules overhang, and points are tested
# against neighbouring zones' squares too, so allow a generous margin either
# side of the central meridian before the series is out of its useful range.
_ZONE_HALF_WIDTH_DEGREES = 3.0
_MAX_OFFSET_DEGREES = 12.0


def _krueger_coefficients() -> tuple[float, tuple[float, ...], tuple[float, ...], tuple[float, ...]]:
    n = _FLATTENING / (2 - _FLATTENING)
    n2, n3, n4, n5, n6 = n**2, n**3, n**4, n**5, n**6
    rectifying = _SEMI_MAJOR_AXIS / (1 + n) * (1 + n2 / 4 + n4 / 64 + n6 / 256)
    alpha = (
        n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180 - 127 * n5 / 288 + 7891 * n6 / 37800,
        13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440 + 281 * n5 / 630 - 1983433 * n6 / 1935360,
        61 * n3 / 240 - 103 * n4 / 140 + 15061 * n5 / 26880 + 167603 * n6 / 181440,
        49561 * n4 / 161280 - 179 * n5 / 168 + 6601661 * n6 / 7257600,
        34729 * n5 / 80640 - 3418889 * n6 / 1995840,
        212378941 * n6 / 319334400,
    )
    beta = (
        n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360 - 81 * n5 / 512 + 96199 * n6 / 604800,
        n2 / 48 + n3 / 15 - 437 * n4 / 1440 + 46 * n5 / 105 - 1118711 * n6 / 3870720,
        17 * n3 / 480 - 37 * n4 / 840 - 209 * n5 / 4480 + 5569 * n6 / 90720,
        4397 * n4 / 161280 - 11 * n5 / 504 - 830251 * n6 / 7257600,
        4583 * n5 / 161280 - 108847 * n6 / 3991680,
        20648693 * n6 / 638668800,
    )
    delta = (
        2 * n - 2 * n2 / 3 - 2 * n3 + 116 * n4 / 45 + 26 * n5 / 45 - 2854 * n6 / 675,
        7 * n2 / 3 - 8 * n3 / 5 - 227 * n4 / 45 + 2704 * n5 / 315 + 2323 * n6 / 945,
        56 * n3 / 15 - 136 * n4 / 35 - 1262 * n5 / 105 + 73814 * n6 / 2835,
        4279 * n4 / 630 - 332 * n5 / 35 - 399572 * n6 / 14175,
        4174 * n5 / 315 - 144838 * n6 / 6237,
        601676 * n6 / 22275,
    )
    return rectifying, alpha, beta, delta


_RECTIFYING_RADIUS, _ALPHA, _BETA, _DELTA = _krueger_coefficients()
_CONFORMAL_FACTOR = 2 * sqrt(_FLATTENING / (2 - _FLATTENING)) / (1 + _FLATTENING / (2 - _FLATTENING))


def utm_zone(tile: str) -> int:
    """Return the northern UTM zone number an MGRS tile id is filed under."""

    return parse_mgrs_tile(tile).zone


def utm_epsg(tile: str) -> int:
    """Return the EPSG code of the northern UTM CRS an MGRS tile must be in."""

    return UTM_NORTH_EPSG_BASE + parse_mgrs_tile(tile).zone


def zone_central_meridian(zone: int) -> float:
    """Return the central meridian, in degrees, of a UTM zone."""

    if not 1 <= zone <= 60:
        raise ValueError(f"UTM zone must be 1-60, got {zone}")
    return -180.0 + 6.0 * zone - 3.0


def project_utm(longitude: float, latitude: float, zone: int) -> tuple[float, float]:
    """Project WGS84 degrees into a northern UTM zone's metres.

    The zone is given explicitly rather than derived from the longitude: a
    granule overhangs its zone, so a point is routinely tested against a zone
    that is not the one it would nominally be filed under.
    """

    if not -90.0 <= latitude <= 90.0:
        raise ValueError(f"latitude must be within -90..90, got {latitude}")
    offset = longitude - zone_central_meridian(zone)
    # Longitudes wrap, so a zone-1/zone-60 comparison must cross the
    # antimeridian rather than measure the long way round the planet.
    offset = (offset + 180.0) % 360.0 - 180.0
    if abs(offset) > _MAX_OFFSET_DEGREES:
        raise ValueError(f"longitude {longitude} is too far from UTM zone {zone} to project accurately")

    lat = radians(latitude)
    lam = radians(offset)
    sin_lat = sin(lat)
    t = sinh(atanh(sin_lat) - _CONFORMAL_FACTOR * atanh(_CONFORMAL_FACTOR * sin_lat))
    xi = atan2(t, cos(lam))
    eta = atanh(sin(lam) / sqrt(1 + t * t))
    easting = eta
    northing = xi
    for index, coefficient in enumerate(_ALPHA, start=1):
        easting += coefficient * cos(2 * index * xi) * sinh(2 * index * eta)
        northing += coefficient * sin(2 * index * xi) * cosh(2 * index * eta)
    scale = _SCALE_FACTOR * _RECTIFYING_RADIUS
    return _FALSE_EASTING + scale * easting, scale * northing


def unproject_utm(easting: float, northing: float, zone: int) -> tuple[float, float]:
    """Return the WGS84 degrees of a northern UTM coordinate (inverse of :func:`project_utm`)."""

    scale = _SCALE_FACTOR * _RECTIFYING_RADIUS
    xi = northing / scale
    eta = (easting - _FALSE_EASTING) / scale
    xi_prime = xi
    eta_prime = eta
    for index, coefficient in enumerate(_BETA, start=1):
        xi_prime -= coefficient * sin(2 * index * xi) * cosh(2 * index * eta)
        eta_prime -= coefficient * cos(2 * index * xi) * sinh(2 * index * eta)
    chi = asin(max(-1.0, min(1.0, sin(xi_prime) / cosh(eta_prime))))
    latitude = chi
    for index, coefficient in enumerate(_DELTA, start=1):
        latitude += coefficient * sin(2 * index * chi)
    longitude = zone_central_meridian(zone) + degrees(atan2(sinh(eta_prime), cos(xi_prime)))
    return (longitude + 180.0) % 360.0 - 180.0, degrees(latitude)


@dataclass(frozen=True)
class MgrsSquare:
    """One MVP tile: the GFSC granule filed under an MGRS 100 km square id."""

    tile: str
    zone: int
    min_easting: float
    min_northing: float
    """West/south corner of the 109.8 km granule, not of the lettered square."""

    @property
    def epsg(self) -> int:
        return UTM_NORTH_EPSG_BASE + self.zone

    @property
    def max_easting(self) -> float:
        return self.min_easting + GRANULE_METRES

    @property
    def max_northing(self) -> float:
        return self.min_northing + GRANULE_METRES

    def contains_utm(self, easting: float, northing: float) -> bool:
        """Return whether a coordinate in this square's own zone is inside it."""

        return (
            self.min_easting <= easting <= self.max_easting
            and self.min_northing <= northing <= self.max_northing
        )

    def corners_wgs84(self) -> tuple[tuple[float, float], ...]:
        """Return the granule's four corners as (longitude, latitude) degrees."""

        return tuple(
            unproject_utm(easting, northing, self.zone)
            for easting in (self.min_easting, self.max_easting)
            for northing in (self.min_northing, self.max_northing)
        )


def _band_northing_range(band: str, zone: int) -> tuple[float, float]:
    index = _BAND_LETTERS.index(band)
    latitude_min = -80.0 + _BAND_DEGREES * index
    # X is the one 12-degree band; every other band is 8 degrees tall.
    latitude_max = 84.0 if band == "X" else latitude_min + _BAND_DEGREES
    if latitude_max <= 0.0:
        raise ValueError(f"latitude band {band} is in the southern hemisphere, which this pipeline never uses")
    latitude_min = max(latitude_min, 0.0)
    # Northing grows with distance from the central meridian at a fixed
    # latitude, so the band's extremes sit at its corners.
    northings = [
        project_utm(zone_central_meridian(zone) + offset, latitude, zone)[1]
        for latitude in (latitude_min, latitude_max)
        for offset in (0.0, _ZONE_HALF_WIDTH_DEGREES)
    ]
    return min(northings), max(northings)


@lru_cache(maxsize=None)
def parse_mgrs_tile(tile: str) -> MgrsSquare:
    """Decode an MGRS tile id into the granule footprint it names.

    Only northern-hemisphere tiles are accepted; GFSC as Nevaio consumes it is
    northern UTM throughout, and admitting a southern band would mean carrying
    a false-northing rule that nothing here can exercise.
    """

    if not isinstance(tile, str) or len(tile) != 5 or tile != tile.upper():
        raise ValueError(f"MGRS tile id must be five upper-case characters, got {tile!r}")
    zone_text, band, column, row = tile[:2], tile[2], tile[3], tile[4]
    if not zone_text.isdigit() or not 1 <= (zone := int(zone_text)) <= 60:
        raise ValueError(f"MGRS tile id must start with a UTM zone 01-60, got {tile!r}")
    if band not in _BAND_LETTERS:
        raise ValueError(f"MGRS tile id has an invalid latitude band letter: {tile!r}")
    columns = _COLUMN_LETTERS[zone % 3]
    if column not in columns:
        raise ValueError(f"MGRS column letter {column!r} does not occur in zone {zone}: {tile!r}")
    if row not in _ROW_LETTERS:
        raise ValueError(f"MGRS tile id has an invalid row letter: {tile!r}")

    min_easting = (columns.index(column) + 1) * MGRS_SQUARE_METRES
    # Row letters repeat every 2000 km and are shifted half an alphabet in even
    # zones, so the latitude band is what says which repetition is meant.
    offset = 0 if zone % 2 else _EVEN_ZONE_ROW_SHIFT
    base_northing = ((_ROW_LETTERS.index(row) - offset) % len(_ROW_LETTERS)) * MGRS_SQUARE_METRES
    band_min, band_max = _band_northing_range(band, zone)
    candidates = [
        base_northing + cycle * _ROW_CYCLE_METRES
        for cycle in range(int((band_max + _ROW_CYCLE_METRES) // _ROW_CYCLE_METRES) + 1)
        if band_min - _BAND_NORTHING_SLACK <= base_northing + cycle * _ROW_CYCLE_METRES <= band_max + _BAND_NORTHING_SLACK
    ]
    if len(candidates) != 1:
        raise ValueError(f"MGRS row letter {row!r} does not resolve to one square in band {band}: {tile!r}")
    # The granule's north-west corner is the lettered square's north-west
    # corner, so the granule's south edge sits 9.8 km below the square's.
    granule_min_northing = candidates[0] + MGRS_SQUARE_METRES - GRANULE_METRES
    return MgrsSquare(tile=tile, zone=zone, min_easting=min_easting, min_northing=granule_min_northing)


@dataclass(frozen=True)
class Footprint:
    """The union of the GFSC granules Nevaio publishes snow for.

    Containment is answered in each granule's own UTM zone, which is where the
    granule is actually square, rather than against a longitude/latitude box
    that would be wrong by kilometres at the corners. The cheap
    longitude/latitude bounding box is only a pre-filter.
    """

    squares: tuple[MgrsSquare, ...]

    @classmethod
    def from_tiles(cls, tiles: Iterable[str]) -> "Footprint":
        squares = tuple(sorted((parse_mgrs_tile(tile) for tile in tiles), key=lambda square: square.tile))
        if not squares:
            raise ValueError("a footprint needs at least one MGRS tile")
        if len({square.tile for square in squares}) != len(squares):
            raise ValueError("footprint tiles must be unique")
        return cls(squares=squares)

    @property
    def zones(self) -> tuple[int, ...]:
        return tuple(sorted({square.zone for square in self.squares}))

    def _zone_boxes(self) -> tuple[tuple[int, float, float, float, float, tuple[MgrsSquare, ...]], ...]:
        boxes = []
        for zone in self.zones:
            squares = tuple(square for square in self.squares if square.zone == zone)
            longitudes = [corner[0] for square in squares for corner in square.corners_wgs84()]
            latitudes = [corner[1] for square in squares for corner in square.corners_wgs84()]
            boxes.append((zone, min(longitudes), min(latitudes), max(longitudes), max(latitudes), squares))
        return tuple(boxes)

    def bounding_box(self) -> tuple[float, float, float, float]:
        """Return the (west, south, east, north) WGS84 box enclosing the footprint."""

        boxes = self._cached_zone_boxes
        return (
            min(box[1] for box in boxes),
            min(box[2] for box in boxes),
            max(box[3] for box in boxes),
            max(box[4] for box in boxes),
        )

    @property
    def _cached_zone_boxes(self):
        cached = self.__dict__.get("_zone_box_cache")
        if cached is None:
            cached = self._zone_boxes()
            object.__setattr__(self, "_zone_box_cache", cached)
        return cached

    def contains(self, longitude: float, latitude: float) -> bool:
        """Return whether a WGS84 point lies inside any granule of the footprint."""

        for zone, west, south, east, north, squares in self._cached_zone_boxes:
            if not (west <= longitude <= east and south <= latitude <= north):
                continue
            easting, northing = project_utm(longitude, latitude, zone)
            if any(square.contains_utm(easting, northing) for square in squares):
                return True
        return False

    def containing_tiles(self, longitude: float, latitude: float) -> tuple[str, ...]:
        """Return the tile ids covering a point, in sorted order (granules overlap)."""

        found: list[str] = []
        for zone, west, south, east, north, squares in self._cached_zone_boxes:
            if not (west <= longitude <= east and south <= latitude <= north):
                continue
            easting, northing = project_utm(longitude, latitude, zone)
            found.extend(square.tile for square in squares if square.contains_utm(easting, northing))
        return tuple(sorted(found))


@lru_cache(maxsize=1)
def mvp_footprint() -> Footprint:
    """Return the MVP snow footprint - the only outline the product ships."""

    from .config import MVP_MGRS_TILES

    return Footprint.from_tiles(MVP_MGRS_TILES)


def parse_footprint_tiles(tiles: Sequence[str] | None) -> Footprint:
    """Return the MVP footprint, or one restricted to the named tiles."""

    if not tiles:
        return mvp_footprint()
    return Footprint.from_tiles(tiles)
