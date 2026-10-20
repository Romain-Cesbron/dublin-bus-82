#!/usr/bin/env python3
"""Extract route 82 (Irishtown - Kiltipper) from the TFI Dublin Bus GTFS feed.

Produces data/route82.json: stops per direction, route shapes, and the
scheduled stop times needed to place buses on the map from the timetable.

Usage: python3 build_route_data.py /path/to/extracted/gtfs
"""
import csv
import json
import os
import sys
from collections import defaultdict

ROUTE_SHORT_NAME = "82"


def read_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as fh:
        yield from csv.DictReader(fh)


def main(gtfs_dir, out_path):
    # --- route -------------------------------------------------------------
    routes = [r for r in read_csv(os.path.join(gtfs_dir, "routes.txt"))
              if r["route_short_name"] == ROUTE_SHORT_NAME]
    if not routes:
        sys.exit(f"route {ROUTE_SHORT_NAME} not found in feed")
    route_ids = {r["route_id"] for r in routes}
    route = routes[0]
    print(f"route_ids={sorted(route_ids)} long_name={route['route_long_name']}")

    # --- trips -------------------------------------------------------------
    trips = {}
    shape_ids = set()
    for t in read_csv(os.path.join(gtfs_dir, "trips.txt")):
        if t["route_id"] in route_ids:
            trips[t["trip_id"]] = {
                "trip_id": t["trip_id"],
                "service_id": t["service_id"],
                "headsign": t["trip_headsign"],
                "direction_id": int(t["direction_id"]),
                "shape_id": t["shape_id"],
            }
            shape_ids.add(t["shape_id"])
    print(f"trips={len(trips)} shapes={len(shape_ids)}")

    # --- calendar (which service_ids run on which weekdays) ------------------
    calendar = {}
    for c in read_csv(os.path.join(gtfs_dir, "calendar.txt")):
        calendar[c["service_id"]] = {
            "days": [int(c[d]) for d in ("monday", "tuesday", "wednesday",
                                         "thursday", "friday", "saturday", "sunday")],
            "start_date": c["start_date"],
            "end_date": c["end_date"],
        }
    exceptions = defaultdict(list)
    cal_dates = os.path.join(gtfs_dir, "calendar_dates.txt")
    if os.path.exists(cal_dates):
        for e in read_csv(cal_dates):
            exceptions[e["service_id"]].append(
                {"date": e["date"], "type": int(e["exception_type"])})

    # --- shapes (stream the big file, keep only ours) -----------------------
    shape_pts = defaultdict(list)
    with open(os.path.join(gtfs_dir, "shapes.txt"), newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            if row["shape_id"] in shape_ids:
                shape_pts[row["shape_id"]].append(
                    (int(row["shape_pt_sequence"]),
                     round(float(row["shape_pt_lat"]), 6),
                     round(float(row["shape_pt_lon"]), 6)))
    shapes = {sid: [[lat, lon] for _, lat, lon in sorted(pts)]
              for sid, pts in shape_pts.items()}
    print(f"shape points: {sum(len(v) for v in shapes.values())}")

    # --- stop_times (stream the 273MB file, keep only our trips) ------------
    trip_stop_times = defaultdict(list)
    stop_ids = set()
    with open(os.path.join(gtfs_dir, "stop_times.txt"), newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            tid = row["trip_id"]
            if tid in trips:
                trip_stop_times[tid].append({
                    "seq": int(row["stop_sequence"]),
                    "stop_id": row["stop_id"],
                    "arr": row["arrival_time"],
                    "dep": row["departure_time"],
                })
                stop_ids.add(row["stop_id"])
    for tid in trip_stop_times:
        trip_stop_times[tid].sort(key=lambda s: s["seq"])
    print(f"stop_times rows kept={sum(len(v) for v in trip_stop_times.values())} "
          f"distinct stops={len(stop_ids)}")

    # --- stops -------------------------------------------------------------
    stops = {}
    for s in read_csv(os.path.join(gtfs_dir, "stops.txt")):
        if s["stop_id"] in stop_ids:
            stops[s["stop_id"]] = {
                "id": s["stop_id"],
                "code": s.get("stop_code", "") or "",
                "name": s["stop_name"],
                "lat": round(float(s["stop_lat"]), 6),
                "lon": round(float(s["stop_lon"]), 6),
            }
    print(f"stops resolved={len(stops)}")

    # --- canonical stop order per direction ---------------------------------
    # Use the trip with the most stops for each direction as the "full" pattern,
    # then fold in any stops from other patterns that aren't in it.
    patterns = {}
    for direction in (0, 1):
        dir_trips = [t for t in trips.values() if t["direction_id"] == direction]
        if not dir_trips:
            continue
        longest = max(dir_trips, key=lambda t: len(trip_stop_times.get(t["trip_id"], [])))
        seq = [s["stop_id"] for s in trip_stop_times[longest["trip_id"]]]
        seen = set(seq)
        extra = []
        for t in dir_trips:
            for s in trip_stop_times.get(t["trip_id"], []):
                if s["stop_id"] not in seen:
                    seen.add(s["stop_id"])
                    extra.append(s["stop_id"])
        # headsign: most common for this direction
        heads = defaultdict(int)
        for t in dir_trips:
            heads[t["headsign"]] += 1
        patterns[str(direction)] = {
            "direction_id": direction,
            "headsign": max(heads.items(), key=lambda kv: kv[1])[0],
            "stop_ids": seq,
            "variant_stop_ids": extra,
            "shape_id": longest["shape_id"],
            "trip_count": len(dir_trips),
        }
        print(f"direction {direction}: {patterns[str(direction)]['headsign']} "
              f"{len(seq)} stops (+{len(extra)} variant), {len(dir_trips)} trips")

    out = {
        "generated_at_utc": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "route": {
            "short_name": route["route_short_name"],
            "long_name": route["route_long_name"],
            "route_ids": sorted(route_ids),
            "color": route.get("route_color") or "FFB500",
        },
        "stops": stops,
        "shapes": shapes,
        "patterns": patterns,
        "trips": trips,
        "stop_times": trip_stop_times,
        "calendar": calendar,
        "calendar_exceptions": dict(exceptions),
    }
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"wrote {out_path} ({os.path.getsize(out_path)/1e6:.1f} MB)")


if __name__ == "__main__":
    gtfs = sys.argv[1]
    os.makedirs(os.path.join(os.path.dirname(os.path.abspath(__file__)), "build"),
                exist_ok=True)
    here = os.path.dirname(os.path.abspath(__file__))
    main(gtfs, os.path.join(here, "build", "route82.json"))
