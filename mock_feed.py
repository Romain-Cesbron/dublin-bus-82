#!/usr/bin/env python3
"""Synthetic GTFS-Realtime feeds for testing the live code path without a key.

Shapes the payload exactly like the NTA GTFS-R v2 JSON output (camelCase keys,
`entity` list, `vehicle.position`, `tripUpdate.stopTimeUpdate`) so that
server.normalise_* and the browser's live rendering are exercised for real.

Enable with:  python3 server.py --mock-live
"""
import json
import os
import time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")

_cache = {}

try:
    from zoneinfo import ZoneInfo
    DUBLIN_TZ = ZoneInfo("Europe/Dublin")
except Exception:          # no tzdata available
    DUBLIN_TZ = None


def _load():
    if "route" not in _cache:
        with open(os.path.join(DATA_DIR, "route.json"), encoding="utf-8") as fh:
            _cache["route"] = json.load(fh)
        with open(os.path.join(DATA_DIR, "schedule.json"), encoding="utf-8") as fh:
            _cache["schedule"] = json.load(fh)
    return _cache["route"], _cache["schedule"]


def _dublin_now():
    if DUBLIN_TZ is not None:
        now = datetime.now(DUBLIN_TZ)
    else:
        # Fall back to the Irish DST rule: last Sunday in March to last Sunday
        # in October is UTC+1, otherwise UTC.
        utc = datetime.now(timezone.utc)
        last_sun = lambda y, m: max(
            d for d in range(25, 32)
            if datetime(y, m, d, tzinfo=timezone.utc).weekday() == 6)
        start = datetime(utc.year, 3, last_sun(utc.year, 3), 1, tzinfo=timezone.utc)
        end = datetime(utc.year, 10, last_sun(utc.year, 10), 1, tzinfo=timezone.utc)
        now = utc + timedelta(hours=1 if start <= utc < end else 0)
    return now, now.hour * 3600 + now.minute * 60 + now.second


def _active_trips(limit=12):
    """Trips that the timetable says are running right now."""
    route, schedule = _load()
    now, secs = _dublin_now()
    ymd = now.strftime("%Y%m%d")
    weekday = now.weekday()

    active_services = set()
    for sid, cal in route["calendar"].items():
        if cal["start_date"] <= ymd <= cal["end_date"] and cal["days"][weekday] == 1:
            active_services.add(sid)
    for sid, excs in (route.get("calendar_exceptions") or {}).items():
        for e in excs:
            if e["date"] == ymd:
                active_services.add(sid) if e["type"] == 1 else active_services.discard(sid)

    out = []
    for trip_id, (service_id, direction, shape_id, headsign, stops) in schedule.items():
        if service_id not in active_services or len(stops) < 2:
            continue
        if not (stops[0][1] <= secs <= stops[-1][1]):
            continue
        # index of the stop the bus is heading to
        i = 0
        while i < len(stops) - 2 and stops[i + 1][1] <= secs:
            i += 1
        out.append((trip_id, direction, headsign, stops, i, secs))
        if len(out) >= limit:
            break
    return out


def vehicles_feed():
    """A Vehicles feed with one entity per in-service trip."""
    route, _ = _load()
    stops_meta = route["stops"]
    route_id = route["route"]["route_ids"][0]
    now_unix = int(time.time())
    entities = []

    for n, (trip_id, direction, headsign, stops, i, secs) in enumerate(_active_trips()):
        prev_id, prev_t = stops[i]
        next_id, next_t = stops[i + 1]
        a, b = stops_meta.get(prev_id), stops_meta.get(next_id)
        if not a or not b:
            continue
        span = max(next_t - prev_t, 1)
        frac = min(max((secs - prev_t) / span, 0.0), 1.0)
        entities.append({
            "id": "mock-%d" % n,
            "vehicle": {
                "trip": {
                    "tripId": trip_id,
                    "routeId": route_id,
                    "directionId": direction,
                    "startTime": "%02d:%02d:00" % (stops[0][1] // 3600 % 24,
                                                   stops[0][1] // 60 % 60),
                    "startDate": datetime.now(timezone.utc).strftime("%Y%m%d"),
                    "scheduleRelationship": "SCHEDULED",
                },
                "position": {
                    "latitude": a["lat"] + (b["lat"] - a["lat"]) * frac,
                    "longitude": a["lon"] + (b["lon"] - a["lon"]) * frac,
                    "bearing": 90.0 if direction == 0 else 270.0,
                    "speed": 7.5,
                },
                "currentStopSequence": i + 2,
                "stopId": next_id,
                "currentStatus": "IN_TRANSIT_TO",
                "timestamp": now_unix - (n % 4) * 20,
                "vehicle": {"id": "mock-%d" % n, "label": "MOCK%03d" % n},
            },
        })

    # A couple of entities from other routes, to prove filtering works.
    entities.append({
        "id": "mock-other",
        "vehicle": {
            "trip": {"tripId": "other-trip", "routeId": "1 46A 1", "directionId": 0},
            "position": {"latitude": 53.34, "longitude": -6.26, "bearing": 10.0},
            "timestamp": now_unix,
        },
    })

    return {
        "header": {"gtfsRealtimeVersion": "2.0", "timestamp": now_unix,
                   "incrementality": "FULL_DATASET"},
        "entity": entities,
    }


def trip_updates_feed():
    """A TripUpdates feed carrying plausible delays for the same trips."""
    route, _ = _load()
    route_id = route["route"]["route_ids"][0]
    now_unix = int(time.time())
    entities = []

    for n, (trip_id, direction, headsign, stops, i, secs) in enumerate(_active_trips()):
        # spread delays from 3 min early to 9 min late across the fleet
        delay = (n % 5 - 1) * 180
        updates = []
        for seq, (stop_id, t) in enumerate(stops[i:], start=i + 1):
            updates.append({
                "stopSequence": seq,
                "stopId": stop_id,
                "arrival": {"delay": delay, "time": now_unix + (t - secs) + delay},
                "departure": {"delay": delay, "time": now_unix + (t - secs) + delay},
                "scheduleRelationship": "SCHEDULED",
            })
        entities.append({
            "id": "mock-tu-%d" % n,
            "tripUpdate": {
                "trip": {"tripId": trip_id, "routeId": route_id,
                         "directionId": direction, "scheduleRelationship": "SCHEDULED"},
                "stopTimeUpdate": updates,
                "timestamp": now_unix,
            },
        })

    return {
        "header": {"gtfsRealtimeVersion": "2.0", "timestamp": now_unix},
        "entity": entities,
    }


def feed(endpoint):
    return vehicles_feed() if endpoint == "Vehicles" else trip_updates_feed()
