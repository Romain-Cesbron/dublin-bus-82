#!/usr/bin/env bash
# Re-download the TFI Dublin Bus GTFS feed and rebuild data/route.json +
# data/schedule.json. The feed is republished roughly weekly, so run this
# whenever the timetable looks out of date.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FEED_URL="https://www.transportforireland.ie/transitData/Data/GTFS_Dublin_Bus.zip"

echo "==> downloading $FEED_URL (~59 MB)"
curl -fsSL -o "$WORK/gtfs.zip" "$FEED_URL"

echo "==> extracting"
unzip -oq "$WORK/gtfs.zip" -d "$WORK/gtfs"

echo "==> extracting route 82"
python3 "$HERE/build_route_data.py" "$WORK/gtfs"

echo "==> splitting payloads"
python3 "$HERE/split_data.py"

echo "==> done. Restart server.py to pick up the new data."
