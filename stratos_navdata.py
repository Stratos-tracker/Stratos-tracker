"""Navigation points near a position, from the simulator's own nav database.

The Flight Planner needs to show the real fixes, VORs, NDBs and airports around
whatever the pilot is looking at, and to name the point they click. Stratos
already reads the simulator's ``earth_fix.dat``, ``earth_nav.dat`` and
``earth_aptmeta.dat`` to resolve procedure legs; this module reads the same
three files once, indexes them on a one-degree grid, and answers "what is near
this place" with a true great-circle distance filter.

Nothing here is bundled or redistributed. The files are read from the pilot's
own X-Plane installation (Navigraph/Jeppesen data licensed to that pilot) or, for
airports, from the OurAirports public-domain set the bridge already downloads.
If no simulator nav data is installed, the answer says so and the page falls back
to the OurAirports airports and navaids it can fetch on its own.

Every record carries the source it came from so the interface can say where a
point was published rather than implying one worldwide database.
"""

import json
import math
import os
import threading
import time

import stratos_cifp

EARTH_R_NM = 3440.065

# X-Plane's earth_nav.dat type codes, as its own documentation lists them. The
# descriptive text at the end of the line is used when a code is one this map
# does not name, so an unknown facility is still described, never guessed at.
NAV_TYPES = {
    2: ("ndb", "NDB"),
    3: ("vor", "VOR"),
    4: ("loc", "Localizer"),
    5: ("loc", "Localizer"),
    6: ("gs", "Glide slope"),
    7: ("om", "Outer marker"),
    8: ("mm", "Middle marker"),
    9: ("im", "Inner marker"),
    12: ("dme", "DME"),
    13: ("tacan", "TACAN"),
}

# Kinds a route may hold. A fix is a published intersection; a nav is a radio
# facility; an apt is an airport. The map draws each differently.
WANTED_KINDS = ("fix", "nav", "apt")

_LOCK = threading.Lock()
_INDEX = None
_PROBE = None
_PROBE_AT = 0.0
PROBE_SECONDS = 20.0


def _dirs():
    """Nav-data directories to read, newest first, or empty when none exist."""
    xplane = stratos_cifp.find_xplane_dir()
    return stratos_cifp.data_dirs(xplane), xplane


def _cycle(xplane_dir):
    return stratos_cifp.read_cycle(xplane_dir) if xplane_dir else {}


def _bucket(lat, lon):
    """One-degree cell, with longitude wrapped so the antimeridian is one row."""
    return (int(math.floor(lat)), int(math.floor(((lon + 180.0) % 360.0) - 180.0)))


def _haversine_nm(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R_NM * math.asin(min(1.0, math.sqrt(a)))


def _describe(parts):
    """The facility description X-Plane writes after the region fields."""
    tail = " ".join(parts[10:]).strip()
    return tail[:40]


def _nav_kind(code, text):
    mapped = NAV_TYPES.get(code)
    if mapped:
        return mapped
    # An unnamed code keeps the publisher's own words rather than a guess.
    label = text.split()[0] if text else "Navaid"
    return ("nav", label[:14] or "Navaid")


def _build():
    """Parse the three files once into flat point records plus a grid index."""
    dirs, xplane = _dirs()
    points = []
    seen = set()
    counts = {"fix": 0, "nav": 0, "apt": 0}

    def add(ident, name, kind, lat, lon, elev, freq, region, source):
        ident = str(ident or "").strip().upper()
        if not ident or not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
            return
        # The same facility appears in both the Custom Data copy and the shipped
        # copy; a VOR and its co-located DME are one station within a few metres.
        key = (ident, kind, round(lat, 4), round(lon, 4))
        if key in seen:
            return
        seen.add(key)
        counts[kind] = counts.get(kind, 0) + 1
        points.append({
            "id": ident, "name": name or ident, "kind": kind, "lat": round(lat, 6),
            "lon": round(lon, 6), "elev": elev, "freq": freq, "region": region,
            "source": source,
        })

    def files(name):
        return [os.path.join(d, name) for d in dirs if os.path.isfile(os.path.join(d, name))]

    for path in files("earth_fix.dat"):
        label = "X-Plane 12 CIFP" if "Custom Data" not in path else "X-Plane 12 CIFP (Custom Data)"
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    parts = line.split()
                    # lat lon IDENT TERMINAL-AREA REGION type name (1200): the
                    # terminal area is ENRT or an airport; the region (K1, EG)
                    # is what airways and procedures name a fix by.
                    if len(parts) < 5 or not parts[0][0] in "-0123456789":
                        continue
                    try:
                        lat, lon = float(parts[0]), float(parts[1])
                    except ValueError:
                        continue
                    ident = parts[2]
                    # The grid-name fixes (05S015W) are Navigraph's own coordinate
                    # marks, not published intersections; they are kept as fixes
                    # because that is what the data calls them.
                    add(ident, ident, "fix", lat, lon, None, None, parts[4], label)
        except OSError:
            continue

    for path in files("earth_aptmeta.dat"):
        label = "Simulator airport data"
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    parts = line.split()
                    if len(parts) < 5:
                        continue
                    ident = parts[0].upper()
                    if len(ident) != 4 or not ident.isalnum():
                        continue
                    try:
                        lat, lon = float(parts[2]), float(parts[3])
                        elev = float(parts[4])
                    except ValueError:
                        continue
                    add(ident, ident, "apt", lat, lon, int(elev) if abs(elev) < 20000 else None,
                        None, parts[1], label)
        except OSError:
            continue

    ils_rows = []
    for path in files("earth_nav.dat"):
        label = "X-Plane 12 nav data"
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    parts = line.split()
                    if parts[:1] in (["4"], ["5"], ["6"], ["12"]):
                        ils_rows.append(parts)
                    # type lat lon elev freq range bearing ident airport region name...
                    if len(parts) < 10:
                        continue
                    try:
                        code = int(parts[0])
                        lat, lon = float(parts[1]), float(parts[2])
                        elev = float(parts[3])
                        freq = float(parts[4])
                    except ValueError:
                        continue
                    text = _describe(parts)
                    kind, type_label = _nav_kind(code, text)
                    # Localizers, glide slopes and marker beacons belong to one
                    # runway, not to a route; they are not offered as waypoints.
                    if kind in ("loc", "gs", "om", "mm", "im", "nav"):
                        continue
                    # A DME paired with an ILS carries the internal ident the
                    # installer assigned it (IBEJ at KSEA), not the ident a pilot
                    # flies. Its localizer is already excluded above, so it goes
                    # with it rather than appearing as a waypoint nobody can file.
                    upper = text.upper()
                    if any(word in upper for word in ("ILS", "LOCALIZER", "GLIDESLOPE", "MARKER")):
                        continue
                    name = text or parts[7]
                    add(parts[7], name, "nav", lat, lon,
                        int(elev) if abs(elev) < 20000 else None,
                        _freq_text(code, freq), parts[9] if len(parts) > 9 else "",
                        label)
                    _ = type_label
        except OSError:
            continue

    grid = {}
    for index, point in enumerate(points):
        grid.setdefault(_bucket(point["lat"], point["lon"]), []).append(index)

    return {"points": points, "grid": grid, "counts": counts, "ils": ils_from_rows(ils_rows),
            "dirs": dirs, "xplane": xplane, "cycle": _cycle(xplane),
            "builtAt": int(time.time() * 1000)}


def ils_from_rows(rows):
    """earth_nav.dat localizer (4/5), glide slope (6) and DME-ILS (12) rows -> {airport: [ILS]}.

    The 1200 format packs two numbers into one field: a localizer's bearing is
    magnetic course * 360 + true course, a glide slope's is angle in
    hundredths of a degree * 1000 + true course (300180.3 = 3.00 deg). Frequencies are in 10 kHz units. The first copy of a facility
    wins, so Custom Data (read first) overrides the shipped default data.
    """
    locs, slopes, dmes = {}, {}, set()
    for parts in rows:
        try:
            code = int(parts[0])
            lat, lon, elev = float(parts[1]), float(parts[2]), float(parts[3])
            freq, packed = int(parts[4]), float(parts[6])
            ident, airport = parts[7].upper(), parts[8].upper()
        except (ValueError, IndexError):
            continue
        key = (airport, ident)
        if code in (4, 5) and len(parts) > 10 and key not in locs:
            mag = int(packed // 360)
            name = " ".join(parts[11:])
            kind = name.replace("-", " ").upper() if name else ("ILS" if code == 4 else "LOC")
            locs[key] = {
                "airport": airport, "runway": parts[10].upper(), "ident": ident,
                "freqMHz": round(freq / 100.0, 2), "courseMag": mag % 360 or 360,
                "courseTrue": round(packed - mag * 360, 2), "type": kind,
                "lat": round(lat, 6), "lon": round(lon, 6), "elevFt": int(elev),
            }
        elif code == 6 and key not in slopes:
            slopes[key] = round(int(packed // 1000) / 100.0, 2)
        elif code == 12 and "ILS" in " ".join(parts[10:]).upper():
            dmes.add(key)
    out = {}
    for key, loc in locs.items():
        loc["glideSlopeDeg"] = slopes.get(key)
        loc["dme"] = key in dmes
        out.setdefault(key[0], []).append(loc)
    for airport in out:
        out[airport].sort(key=lambda item: (item["runway"], item["ident"]))
    return out


# ── En-route chart data ─────────────────────────────────────────────
# Airways (earth_awy.dat), terminal and special-use airspace (airspaces/
# airspace.txt, OpenAir) and the grid minimum off-route altitude
# (earth_mora.dat), all from the simulator's own data. Built on first use,
# separately from the point index so a point query never waits on it.

ENROUTE_CLASSES = {"B", "C", "D", "CTR", "R", "P"}
_ENROUTE = None
_ENROUTE_LOCK = threading.Lock()


def parse_airways(lines, lookup):
    """earth_awy.dat (1100) -> segments with both ends resolved to coordinates.

    A line is: fix region type fix region type direction low/high base top names.
    Type 11 is a fix, 2 an NDB, 3 a VHF navaid; base and top are hundreds of
    feet; several airway names sharing a leg are joined with '-'. A leg whose
    end the nav data cannot place is skipped, never drawn to a guessed point.
    """
    out = []
    for line in lines:
        parts = line.split()
        if len(parts) < 11:
            continue
        try:
            t1, t2, level = int(parts[2]), int(parts[5]), int(parts[7])
            base, top = int(parts[8]), int(parts[9])
        except ValueError:
            continue
        k1 = "fix" if t1 == 11 else "nav"
        k2 = "fix" if t2 == 11 else "nav"
        a = lookup.get((parts[0].upper(), parts[1].upper(), k1))
        b = lookup.get((parts[3].upper(), parts[4].upper(), k2))
        if not a or not b:
            continue
        out.append({
            "names": parts[10].split("-"), "level": "high" if level == 2 else "low",
            "baseFl": base, "topFl": top, "oneWay": parts[6].upper() in ("F", "B"),
            "a": [parts[0].upper(), a[0], a[1]], "b": [parts[3].upper(), b[0], b[1]],
        })
    return out


def _openair_coord(text):
    """'26:50:47 N 080:16:49 W' -> (lat, lon), or None."""
    parts = text.replace(":", " ").split()
    try:
        lat = float(parts[0]) + float(parts[1]) / 60 + float(parts[2]) / 3600
        lon = float(parts[4]) + float(parts[5]) / 60 + float(parts[6]) / 3600
    except (ValueError, IndexError):
        return None
    if parts[3].upper() == "S":
        lat = -lat
    if len(parts) > 7 and parts[7].upper() == "W":
        lon = -lon
    return (round(lat, 5), round(lon, 5))


def parse_airspace(lines, classes=ENROUTE_CLASSES):
    """OpenAir polygons (AC/AN/AL/AH/DP) for the classes an en-route chart shows."""
    out, current = [], None

    def close():
        if current and current["class"] in classes and len(current["points"]) >= 3:
            lats = [p[0] for p in current["points"]]
            lons = [p[1] for p in current["points"]]
            current["bbox"] = [min(lats), min(lons), max(lats), max(lons)]
            out.append(current)

    for raw in lines:
        line = raw.strip()
        if line.startswith("AC "):
            close()
            current = {"class": line[3:].strip().upper(), "name": "", "lower": "", "upper": "", "points": []}
        elif current is None:
            continue
        elif line.startswith("AN "):
            current["name"] = line[3:].strip()
        elif line.startswith("AL "):
            current["lower"] = line[3:].strip()
        elif line.startswith("AH "):
            current["upper"] = line[3:].strip()
        elif line.startswith("DP "):
            point = _openair_coord(line[3:])
            if point:
                current["points"].append(point)
    close()
    return out


def parse_mora(lines):
    """earth_mora.dat: '+LAT +LON v1 .. v30' -> {(lat, lon): hundreds of feet}.

    Each row covers 30 one-degree cells eastward from its longitude. The row's
    latitude names the cell's south edge here; a value of 0 or a non-number is
    not published and is left out.
    """
    out = {}
    for line in lines:
        parts = line.split()
        if len(parts) < 3 or parts[0][:1] not in "+-":
            continue
        try:
            lat, lon = int(parts[0]), int(parts[1])
        except ValueError:
            continue
        for i, value in enumerate(parts[2:32]):
            try:
                hundreds = int(value)
            except ValueError:
                continue
            if hundreds > 0:
                out[(lat, ((lon + i + 180) % 360) - 180)] = hundreds
    return out


def _build_enroute():
    data = index()
    lookup = {}
    for p in data["points"]:
        key = (p["id"], str(p.get("region") or "").upper(), p["kind"])
        if key not in lookup:
            lookup[key] = (p["lat"], p["lon"])
    dirs = data["dirs"]

    def first(name):
        for directory in dirs:
            path = os.path.join(directory, name)
            if os.path.isfile(path):
                return path
        return None

    def read(path):
        if not path:
            return []
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.readlines()

    started = time.time()
    airways = parse_airways(read(first("earth_awy.dat")), lookup)
    airspace = parse_airspace(read(first(os.path.join("airspaces", "airspace.txt"))))
    mora = parse_mora(read(first("earth_mora.dat")))
    stratos_log("En-route data: %d airway legs, %d airspaces, %d MORA cells in %.1fs" % (
        len(airways), len(airspace), len(mora), time.time() - started))
    return {"airways": airways, "airspace": airspace, "mora": mora,
            "cycle": data["cycle"].get("cycle", ""), "available": bool(dirs)}


def enroute(lat, lon, nm=80.0, level="low", limit=3000):
    """Airways, airspace and MORA inside a box around a position, for one chart level."""
    try:
        lat, lon, nm = float(lat), float(lon), float(nm)
    except (TypeError, ValueError):
        return {"ok": False, "error": "A latitude, a longitude and a radius are required."}
    if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0) or not (0.0 < nm <= 600.0):
        return {"ok": False, "error": "That position or radius is outside the range this map covers."}
    level = "high" if str(level).lower() == "high" else "low"
    global _ENROUTE
    with _ENROUTE_LOCK:
        if _ENROUTE is None:
            _ENROUTE = _build_enroute()
        data = _ENROUTE
    dlat = nm / 60.0
    dlon = nm / (60.0 * max(0.15, math.cos(math.radians(lat))))
    south, north, west, east = lat - dlat, lat + dlat, lon - dlon, lon + dlon

    def inside(la, lo):
        lo = lon + ((lo - lon + 540.0) % 360.0) - 180.0
        return south <= la <= north and west <= lo <= east

    airways = []
    for leg in data["airways"]:
        if leg["level"] != level:
            continue
        if inside(leg["a"][1], leg["a"][2]) or inside(leg["b"][1], leg["b"][2]):
            airways.append(leg)
            if len(airways) >= limit:
                break
    airspace = []
    if level == "low":
        for area in data["airspace"]:
            b = area["bbox"]
            if b[2] < south or b[0] > north:
                continue
            mid = (b[1] + b[3]) / 2.0
            if not inside(min(max(lat, b[0]), b[2]), min(max(lon, b[1]), b[3])) and not inside((b[0] + b[2]) / 2.0, mid):
                continue
            airspace.append({k: area[k] for k in ("class", "name", "lower", "upper", "points")})
            if len(airspace) >= 600:
                break
    mora = []
    for cell_lat in range(int(math.floor(south)), int(math.floor(north)) + 1):
        for step in range(int(math.floor(west)), int(math.floor(east)) + 1):
            cell_lon = ((step + 180) % 360) - 180
            value = data["mora"].get((cell_lat, cell_lon))
            if value:
                mora.append([cell_lat, cell_lon, value])
    return {"ok": True, "level": level, "airways": airways, "airspace": airspace, "mora": mora,
            "available": data["available"], "source": "X-Plane 12 nav data" if data["available"] else "",
            "cycle": data["cycle"]}


def ils(airport):
    """ILS/localizer records for one airport from the simulator's nav data."""
    data = index()
    code = str(airport or "").strip().upper()
    return {
        "ok": True, "airport": code, "ils": data.get("ils", {}).get(code, []),
        "simulatorNavData": bool(data["dirs"]),
        "source": "X-Plane 12 nav data" if data["dirs"] else "",
        "cycle": data["cycle"].get("cycle", ""),
    }


def _freq_text(code, raw):
    """A frequency as the facility publishes it: kHz for an NDB, MHz otherwise."""
    if not raw:
        return ""
    if code == 2:
        return "%d kHz" % int(round(raw))
    return "%.2f MHz" % (raw / 100.0 if raw > 1000 else raw)


def index():
    """The parsed index, built on first use and kept for the process lifetime."""
    global _INDEX
    with _LOCK:
        if _INDEX is None:
            started = time.time()
            _INDEX = _build()
            stratos_log("Navigation index: %d fixes, %d navaids, %d airports in %.1fs" % (
                _INDEX["counts"].get("fix", 0), _INDEX["counts"].get("nav", 0),
                _INDEX["counts"].get("apt", 0), time.time() - started))
        return _INDEX


_LOGGER = None


def set_logger(logger):
    global _LOGGER
    _LOGGER = logger


def stratos_log(message):
    if _LOGGER:
        _LOGGER(message)


def near(lat, lon, nm=40.0, kinds=WANTED_KINDS, limit=400):
    """Real navigation points within ``nm`` great-circle of a position.

    The one-degree grid narrows the candidate list; every candidate is then
    measured with the haversine formula, so the radius is a real distance and
    not a number of cells or pixels. Points are returned nearest first.
    """
    try:
        lat = float(lat)
        lon = float(lon)
        nm = float(nm)
    except (TypeError, ValueError):
        return {"ok": False, "reason": "bad-request", "error": "A latitude, a longitude and a radius are required."}
    if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0) or not (0.0 < nm <= 600.0):
        return {"ok": False, "reason": "bad-request",
                "error": "That position or radius is outside the range this map covers."}

    data = index()
    wanted = tuple(kinds) if kinds else WANTED_KINDS
    # A degree of latitude is 60 nm, so this many cells covers the radius at any
    # longitude; the true distance filter below removes the corners.
    span = int(math.ceil(nm / 60.0)) + 1
    rows = []
    points = data["points"]
    for dlat in range(-span, span + 1):
        cell_lat = int(math.floor(lat)) + dlat
        if cell_lat < -90 or cell_lat > 90:
            continue
        for dlon in range(-span, span + 1):
            cell_lon = ((int(math.floor(lon)) + dlon + 180) % 360) - 180
            for position in data["grid"].get((cell_lat, cell_lon), ()):
                point = points[position]
                if point["kind"] not in wanted:
                    continue
                distance = _haversine_nm(lat, lon, point["lat"], point["lon"])
                if distance <= nm:
                    rows.append((distance, point))
    rows.sort(key=lambda row: row[0])
    total = len(rows)
    shown = rows[:limit]
    return {
        "ok": True,
        "center": {"lat": round(lat, 6), "lon": round(lon, 6)},
        "radiusNm": nm,
        "count": total,
        "truncated": total > len(shown),
        "points": [dict(point, distanceNm=round(distance, 3)) for distance, point in shown],
        "coverage": coverage(data),
    }


def nearest(lat, lon, nm=10.0):
    """The single closest real point, for naming a click on the chart."""
    answer = near(lat, lon, nm=nm, limit=1)
    if not answer.get("ok"):
        return answer
    point = answer["points"][0] if answer["points"] else None
    answer["point"] = point
    answer.pop("points", None)
    return answer


def coverage(data=None):
    """What this index actually holds, so the page can state its coverage."""
    data = data or index()
    installed = bool(data["dirs"])
    cycle = data.get("cycle") or {}
    return {
        "simulatorNavData": installed,
        "source": "X-Plane 12 CIFP" if installed else "",
        "cycle": cycle.get("cycle", ""),
        "cycleSource": cycle.get("source", ""),
        "fixes": data["counts"].get("fix", 0),
        "navaids": data["counts"].get("nav", 0),
        # earth_aptmeta.dat is the simulator's own airport list; OurAirports is
        # the worldwide one the map draws, so this is reported separately.
        "simulatorAirports": data["counts"].get("apt", 0),
        "note": ("Fixes and radio navaids come from the simulator's own nav data "
                 "(Navigraph/Jeppesen, licensed to the pilot, read in place and never "
                 "bundled). Airports and the worldwide navaid fallback come from "
                 "OurAirports (CC0).") if installed else
                ("No simulator nav data is installed, so only published airports and "
                 "the OurAirports navaid set can be shown."),
    }


def status():
    """A cheap readiness probe, so the page can ask without building the index."""
    global _PROBE, _PROBE_AT
    now = time.time()
    if _PROBE is not None and now - _PROBE_AT < PROBE_SECONDS:
        return _PROBE
    if _INDEX is not None:
        _PROBE = coverage()
    else:
        dirs, xplane = _dirs()
        _PROBE = {
            "simulatorNavData": bool(dirs),
            "source": "X-Plane 12 CIFP" if dirs else "",
            "cycle": _cycle(xplane).get("cycle", ""),
            "cycleSource": _cycle(xplane).get("source", ""),
            "fixes": None, "navaids": None, "simulatorAirports": None,
            "note": ("The simulator's nav data is installed and is indexed on first use."
                     if dirs else
                     "No simulator nav data is installed, so only published airports and "
                     "the OurAirports navaid set can be shown."),
        }
    _PROBE_AT = now
    return _PROBE


def reset():
    """Drop the cached index. Used by the tests."""
    global _INDEX, _PROBE
    with _LOCK:
        _INDEX = None
        _PROBE = None


if __name__ == "__main__":  # a quick look without running the bridge
    import sys
    lat = float(sys.argv[1]) if len(sys.argv) > 1 else 47.449
    lon = float(sys.argv[2]) if len(sys.argv) > 2 else -122.309
    radius = float(sys.argv[3]) if len(sys.argv) > 3 else 40.0
    answer = near(lat, lon, radius, limit=25)
    print(json.dumps(answer, indent=1)[:4000])
