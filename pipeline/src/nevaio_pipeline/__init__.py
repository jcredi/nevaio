"""Production GFSC processing code.

Keep package import lightweight: the publisher must run without the native
raster stack. Preserve the public convenience exports with lazy imports.
"""
from importlib import import_module

_EXPORTS = {
    "AsOfComposite": "asof", "DailyProduct": "asof", "PixelState": "asof",
    "compose_as_of": "asof", "freshness_tier": "asof",
    "LoadedTile": "raster_io", "ProductTriplet": "raster_io", "RasterGrid": "raster_io",
    "discover_product_triplets": "raster_io", "load_tile_products": "raster_io",
    "Mosaic": "mosaic", "TileComposite": "mosaic", "mosaic_to_grid": "mosaic",
    "render_rgba": "tiles", "write_xyz_tiles": "tiles",
}
__all__ = list(_EXPORTS)


def __getattr__(name: str):
    if name not in _EXPORTS:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(f".{_EXPORTS[name]}", __name__), name)
    globals()[name] = value
    return value
