"""Tiny real renderer output for publication boundary tests."""
from datetime import date
import json
from pathlib import Path

from pipeline.artifact_validation import snapshot_notice

RUN_ID = "20260210T120000Z"


def make_run(root: Path, run_id: str = RUN_ID) -> tuple[Path, dict]:
    from PIL import Image

    run = root / run_id
    tile = run / "tiles/8/1/2.png"
    tile.parent.mkdir(parents=True)
    Image.new("RGBA", (256, 256), (56, 189, 248, 128)).save(tile, optimize=True)
    day = date(int(run_id[:4]), int(run_id[4:6]), int(run_id[6:8])).isoformat()
    metadata = {
        "schemaVersion": 1, "runId": run_id, "mode": "asof-window", "asOfDate": day,
        "asOfWindowDays": 31, "generatedAt": f"{day}T{run_id[9:11]}:{run_id[11:13]}:{run_id[13:15]}+00:00",
        "minzoom": 8, "maxzoom": 11, "bounds": [5, 40, 16, 48], "tileCount": 1,
        "requestedSourceTileCount": 1, "sourceTileCount": 1, "sourceTiles": ["32TPS"],
        "missingSourceTiles": [], "productDates": {"32TPS": day},
        "sourceProductCounts": {"32TPS": 1}, "sourceProductTotal": 1,
        "notice": snapshot_notice(day),
    }
    (run / "run.json").write_text(json.dumps(metadata))
    return run, metadata
