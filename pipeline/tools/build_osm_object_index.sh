#!/usr/bin/env bash
# Build a local, deterministic Nevaio object index from one or more regional
# OSM PBF extracts. The PBF inputs and all intermediate files stay local; this
# script does not download data or publish to R2.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: pipeline/tools/build_osm_object_index.sh --output OUTPUT.json SOURCE.osm.pbf [SOURCE.osm.pbf ...]

Requires: osmium on PATH and a Python environment able to import
nevaio_pipeline from pipeline/src. SOURCE extracts can overlap: identical OSM
objects are deduplicated, but differing snapshots fail instead of silently
choosing one.
EOF
}

if ! command -v osmium >/dev/null; then
  echo "error: osmium is required; install osmium-tool first" >&2
  exit 2
fi

output=""
if [[ "${1:-}" == "--output" ]]; then
  output="${2:-}"
  shift 2
fi
if [[ -z "$output" || "$#" -eq 0 ]]; then
  usage >&2
  exit 2
fi

for source in "$@"; do
  if [[ ! -f "$source" ]]; then
    echo "error: OSM extract does not exist: $source" >&2
    exit 2
  fi
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export_config="$repo_root/pipeline/tools/osmium-export-config.json"
python_bin="${PYTHON_BIN:-$repo_root/pipeline/.venv/bin/python}"
if [[ ! -x "$python_bin" ]]; then
  echo "error: Python executable is not available: $python_bin" >&2
  exit 2
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/nevaio-osm.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

normalized_args=()
counter=0
for source in "$@"; do
  filtered="$work_dir/filtered-$counter.osm.pbf"
  exported="$work_dir/exported-$counter.geojson"
  osmium tags-filter --remove-tags --output "$filtered" "$source" \
    nwr/natural=peak \
    nwr/tourism=alpine_hut,wilderness_hut \
    nwr/natural=saddle \
    nwr/mountain_pass=yes \
    nwr/amenity=shelter \
    nwr/amenity=parking \
    nwr/place=city,town,village,hamlet
  # A regional boundary can leave a multipolygon relation incomplete even when
  # every valid selectable object is present. Emit that diagnostic, but let
  # Osmium omit only the malformed geometry rather than failing the whole
  # static index; the normalized records that remain still go through strict
  # ID/name/point validation below.
  osmium export --show-errors --config "$export_config" --output "$exported" "$filtered"
  normalized_args+=(--input "$exported")
  counter=$((counter + 1))
done

normalized="$work_dir/normalized.geojson"
PYTHONPATH="$repo_root/pipeline/src" "$python_bin" -m nevaio_pipeline.osmium_export \
  "${normalized_args[@]}" --output "$normalized"
PYTHONPATH="$repo_root/pipeline/src" "$python_bin" -m nevaio_pipeline.object_index \
  --input "$normalized" --output "$output"
