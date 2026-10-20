#!/usr/bin/env python3
"""Split route82.json into a small map payload + a compact schedule payload.

route.json     - stops, shapes, patterns, calendar  (loads instantly)
schedule.json  - per-trip stop times as seconds-since-midnight (loaded lazily)
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "web", "data")


def to_secs(hhmmss):
    h, m, s = (int(x) for x in hhmmss.split(":"))
    return h * 3600 + m * 60 + s


def main():
    with open(os.path.join(HERE, "build", "route82.json"), encoding="utf-8") as fh:
        src = json.load(fh)

    route_payload = {
        "generated_at_utc": src["generated_at_utc"],
        "route": src["route"],
        "stops": src["stops"],
        "shapes": src["shapes"],
        "patterns": src["patterns"],
        "calendar": src["calendar"],
        "calendar_exceptions": src["calendar_exceptions"],
    }

    # Compact schedule: trip_id -> [service_id, direction_id, shape_id, headsign,
    #                              [[stop_id, dep_secs], ...]]
    schedule = {}
    for trip_id, trip in src["trips"].items():
        times = src["stop_times"].get(trip_id, [])
        if not times:
            continue
        schedule[trip_id] = [
            trip["service_id"],
            trip["direction_id"],
            trip["shape_id"],
            trip["headsign"],
            [[st["stop_id"], to_secs(st["dep"] or st["arr"])] for st in times],
        ]

    for name, payload in (("route.json", route_payload), ("schedule.json", schedule)):
        path = os.path.join(DATA, name)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, separators=(",", ":"))
        print(f"{name}: {os.path.getsize(path)/1e6:.2f} MB")

    print(f"trips in schedule: {len(schedule)}")


if __name__ == "__main__":
    main()
