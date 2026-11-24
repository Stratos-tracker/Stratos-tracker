"""Tests for the simulator bridge logic. Run: python3 -m unittest discover -s tests -p "test_*.py" """

import importlib
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

TEMP = tempfile.mkdtemp(prefix="stratos-test-")
os.environ["STRATOS_DATA_DIR"] = TEMP

import bridge_logbook_addon as addon  # noqa: E402
importlib.reload(addon)

AIRPORTS = [
    ["KAAA", "Test Field", 37.0, -122.0, 30, [9, 27], [8000, 8000],
     [["09", "27", 37.0, -122.02, 37.0, -121.98, 8000, 150],
      ["27", "09", 37.0, -121.98, 37.0, -122.02, 8000, 150]],
     {"TWR": "118.0"}],
]


def telemetry(**overrides):
    data = {"lat": 37.0, "lon": -122.0, "alt": 30.0, "agl": 30.0, "gs": 0.0,
            "hdg": 90.0, "vs": 0.0, "src": "Test", "aircraft": "B738"}
    data.update(overrides)
    return data


def reset():
    addon.lb_save([])
    with addon._fs_lock:
        addon._flight_state.update(phase="PARKED", flight=None, parked_since=None, recent=[])
    for path in (addon.LOGBOOK_FILE, addon.INPROGRESS_FILE):
        try:
            os.remove(path)
        except OSError:
            pass


class LandingAnalysisTests(unittest.TestCase):
    def test_derived_vertical_speed(self):
        now = int(time.time() * 1000)
        samples = []
        for index in range(10):
            samples.append({"lat": 37.0, "lon": -122.01, "alt": 100 - index * 2,
                            "agl": 20, "gs": 130, "hdg": 90, "vs": -240,
                            "t": now - (9 - index) * 500})
        with addon._fs_lock:
            addon._flight_state["recent"] = samples
        result = addon._analyse_landing(telemetry(lat=37.0, lon=-122.01, alt=80, agl=0, gs=120, hdg=90), AIRPORTS)
        self.assertEqual(result["vsSource"], "derived from recorded altitude")
        self.assertLess(result["vsFpm"], 0)
        self.assertTrue(result["estimated"]["vs"] is False)

    def test_landing_rate_window_ends_at_first_wheel_contact(self):
        # 200 fpm descent until wheel contact at t=2000 ms, then a flat ground roll.
        # Using ground-roll samples flattens the slope (old bug: ~85 fpm instead of 200).
        base = 1_700_000_000_000
        samples = []
        for index in range(14):
            alt = 1000 - (200 / 60) * min(index, 8) * 0.25
            samples.append({"lat": 37.0, "lon": -122.01, "alt": alt, "agl": 0, "gs": 100,
                            "hdg": 90, "vs": -200, "t": base + index * 250})
        result = addon._analyse_landing(
            telemetry(lat=37.0, lon=-122.01, alt=1000, agl=0, gs=40, hdg=90), AIRPORTS,
            samples, touchdown_t=base + 2000)
        self.assertAlmostEqual(result["vsFpm"], -200, delta=1)

    def test_simulator_touchdown_rate_wins_over_the_altitude_slope(self):
        base = 1_700_000_000_000
        samples = [{"lat": 37.0, "lon": -122.01, "alt": 1000 - i * 5, "agl": 0, "gs": 130,
                    "hdg": 90, "vs": -1200, "t": base + i * 250} for i in range(12)]
        result = addon._analyse_landing(
            telemetry(lat=37.0, lon=-122.01, alt=1000, agl=0, gs=40, hdg=90, touchdownVs=-142.6), AIRPORTS,
            samples, touchdown_t=base + 3000)
        self.assertEqual(result["vsFpm"], -143)
        self.assertEqual(result["vsSource"], "measured by the simulator at touchdown")

    def test_touchdown_is_wheel_contact_when_the_sim_reports_it(self):
        clock = {"t": 1_700_000_000_000}
        patcher = unittest.mock.patch.object(addon, "_now_ms", side_effect=lambda: clock["t"])
        patcher.start()
        try:
            feed = lambda **kw: addon.process_telemetry_for_logbook(telemetry(lon=-122.01, **kw), AIRPORTS)
            feed(gs=0, onGround=True)
            feed(gs=15, onGround=True)
            feed(gs=150, agl=2000, alt=2030, onGround=False)
            # An airliner's reference point is still 15 ft up in the flare: not yet landed.
            clock["t"] += 250
            feed(gs=140, agl=15, alt=45, vs=-120, onGround=False)
            with addon._fs_lock:
                self.assertIsNone(addon._flight_state["touchdown_t"])
            clock["t"] += 250
            feed(gs=138, agl=12, alt=42, vs=-110, onGround=True)
            with addon._fs_lock:
                self.assertEqual(addon._flight_state["touchdown_t"], clock["t"])
        finally:
            patcher.stop()

    def test_runway_match_and_distance(self):
        result = addon._analyse_landing(
            telemetry(lat=37.0002, lon=-122.01, alt=10, agl=0, gs=120, hdg=90), AIRPORTS)
        runway = result["runway"]
        self.assertIsNotNone(runway)
        self.assertEqual(runway["id"], "09/27")
        self.assertEqual(runway["lengthFt"], 8000)
        self.assertTrue(1000 < runway["distanceFromThresholdFt"] < 3000)
        self.assertTrue(runway["estimated"])
        self.assertTrue(result["estimated"]["runway"])

    def test_runway_direction_follows_heading_late_in_the_rollout(self):
        # Landing on 27 (east end, heading 270), sampled near the 09 threshold at the end of the roll.
        runway = addon.match_runway(AIRPORTS, 37.0, -122.017, 270)
        self.assertEqual(runway["threshold"], "27")
        self.assertTrue(runway["headingAligned"])
        self.assertGreater(runway["distanceFromThresholdFt"], 6000)

    def test_touchdown_point_is_first_wheel_contact(self):
        base = 1_700_000_000_000
        samples = [{"lat": 37.0, "lon": -121.985 + i * 0.0002, "alt": 40 - i * 2, "agl": 10 - i * 2,
                    "gs": 135, "hdg": 270, "vs": -240, "t": base + i * 250} for i in range(6)]
        samples[-1]["lon"] = -121.99   # wheel contact, ~1,400 ft past the 27 threshold
        result = addon._analyse_landing(
            telemetry(lat=37.0, lon=-122.015, alt=30, agl=0, gs=55, hdg=270), AIRPORTS,
            samples, touchdown_t=samples[-1]["t"])
        self.assertEqual(result["runway"]["threshold"], "27")
        self.assertLess(result["runway"]["distanceFromThresholdFt"], 3000)
        self.assertEqual(result["lon"], -121.99)

    def test_no_runway_when_far_away(self):
        result = addon._analyse_landing(
            telemetry(lat=38.0, lon=-121.0, alt=10, agl=0, gs=110, hdg=90), AIRPORTS)
        self.assertIsNone(result["runway"])
        self.assertTrue(any("Runway" in warning for warning in result["warnings"]))

    def test_classification_is_class_based(self):
        self.assertEqual(addon.classify_landing(-170, "B738")["key"], "good")
        self.assertEqual(addon.classify_landing(-170, "C172")["key"], "firm")
        self.assertEqual(addon.classify_landing(-600, "C172")["key"], "severe")
        self.assertEqual(addon.classify_landing(None, "C172")["key"], "unclassified")
        self.assertEqual(addon.classify_landing(-150, "")["classKey"], "unknown")

    def test_representative_touchdown_rates_use_fpm(self):
        # 100, 200 and 500 fpm, against the published per-class thresholds.
        # jet: smooth <=100, good <=180, firm <=300, hard <=600
        self.assertEqual(addon.classify_landing(-100, "B738")["key"], "smooth")
        self.assertEqual(addon.classify_landing(-200, "B738")["key"], "firm")
        self.assertEqual(addon.classify_landing(-500, "B738")["key"], "hard")
        # piston: smooth <=80, good <=140, firm <=220, hard <=400
        self.assertEqual(addon.classify_landing(-100, "C172")["key"], "good")
        self.assertEqual(addon.classify_landing(-200, "C172")["key"], "firm")
        self.assertEqual(addon.classify_landing(-500, "C172")["key"], "severe")
        # The rating reads the magnitude, so a positive sample is not a smooth landing.
        self.assertEqual(addon.classify_landing(500, "B738")["key"], "hard")


class FlightLifecycleTests(unittest.TestCase):
    def setUp(self):
        reset()

    def test_full_flight_records_track_and_landing(self):
        base = 1700000000000
        patcher = unittest.mock.patch.object(addon, "_now_ms", return_value=base)
        patcher.start()
        try:
            addon.process_telemetry_for_logbook(telemetry(), AIRPORTS)          # parked
            addon.process_telemetry_for_logbook(telemetry(gs=15), AIRPORTS)     # taxi
            self.assertEqual(addon.get_flight_phase(), "TAXI")
            addon.process_telemetry_for_logbook(telemetry(gs=150, agl=2000, alt=2000), AIRPORTS)
            self.assertEqual(addon.get_flight_phase(), "AIRBORNE")
            addon.process_telemetry_for_logbook(telemetry(lat=37.2, lon=-121.5, agl=4000, alt=12000, gs=300), AIRPORTS)
            with addon._fs_lock:
                flight = addon._flight_state["flight"]
                flight["takeoffTime"] = base - 3600 * 1000  # one hour airborne
            addon.process_telemetry_for_logbook(telemetry(lat=37.0002, lon=-122.01, agl=0, alt=15, gs=50, hdg=90, vs=-700), AIRPORTS)
            self.assertEqual(addon.get_flight_phase(), "LANDED")
            with addon._fs_lock:
                landing = addon._flight_state["flight"]["landing"]
            self.assertIsNotNone(landing)
            self.assertIsNotNone(landing["runway"])
            self.assertIn("classification", landing)
            with addon._fs_lock:
                addon._flight_state["parked_since"] = time.time() - addon.PARKED_SECONDS - 1
            addon.process_telemetry_for_logbook(telemetry(lat=37.0002, lon=-122.01, agl=0, alt=15, gs=0, hdg=90), AIRPORTS)
            flights = addon.lb_load()
            self.assertEqual(len(flights), 1)
            record = flights[0]
            self.assertTrue(record["complete"])
            self.assertFalse(record["incomplete"])
            self.assertGreater(len(record["track"]), 2)
            self.assertEqual(record["depAirport"], "KAAA")
            self.assertEqual(record["arrAirport"], "KAAA")
            self.assertIsNotNone(record["landing"]["runway"])
        finally:
            patcher.stop()

    def test_landing_rate_survives_a_long_rollout_at_simulator_rates(self):
        # 10 Hz telemetry: 300 fpm final descent, wheel contact, then 16 s of rollout (160 samples)
        # before ground speed drops below LANDED_SPEED_KT. The 40-sample window used to lose every
        # approach sample by then and report no landing rate at all.
        clock = {"t": 1_700_000_000_000}
        patcher = unittest.mock.patch.object(addon, "_now_ms", side_effect=lambda: clock["t"])
        patcher.start()
        try:
            feed = lambda **kw: addon.process_telemetry_for_logbook(telemetry(lon=-122.01, **kw), AIRPORTS)
            feed(gs=0)
            feed(gs=15)
            feed(gs=150, agl=2000, alt=2030)
            alt = 130.0
            while alt > 30:                                   # agl from 100 ft down to wheel contact
                clock["t"] += 100
                alt = max(30.0, alt - 300 / 600)              # 300 fpm at 10 Hz
                feed(gs=135, agl=alt - 30, alt=alt, vs=-300)
            for step in range(160):                           # rollout from 135 kt to below 60 kt
                clock["t"] += 100
                feed(gs=135 - step * 0.5, agl=0, alt=30, vs=0)
            self.assertEqual(addon.get_flight_phase(), "LANDED")
            with addon._fs_lock:
                landing = addon._flight_state["flight"]["landing"]
            self.assertEqual(landing["vsSource"], "derived from recorded altitude")
            self.assertAlmostEqual(landing["vsFpm"], -300, delta=5)
        finally:
            patcher.stop()

    def test_duplicate_records_are_ignored(self):
        flight = {"id": "flt_1", "complete": True, "takeoffTime": 1700000000000,
                  "depAirport": "KAAA", "arrAirport": "KBBB", "startTime": 1700000000000}
        self.assertTrue(addon.lb_add(dict(flight)))
        self.assertFalse(addon.lb_add(dict(flight)))
        twin = dict(flight, id="flt_2")
        self.assertFalse(addon.lb_add(twin))
        # A completed record upgrades an incomplete one.
        partial = {"id": "flt_3", "complete": False, "takeoffTime": 1700000000000,
                   "depAirport": "KAAA", "arrAirport": "KBBB"}
        addon.lb_save([partial])
        self.assertTrue(addon.lb_add(dict(flight, id="flt_3")))
        self.assertEqual(len(addon.lb_load()), 1)
        self.assertTrue(addon.lb_load()[0]["complete"])

    def test_shutdown_finalises_without_data_loss(self):
        with addon._fs_lock:
            addon._flight_state["flight"] = addon._new_flight(telemetry())
            addon._flight_state["flight"]["track"] = [
                {"lat": 37.0, "lon": -122.0, "alt": 100, "t": 1},
                {"lat": 37.1, "lon": -121.9, "alt": 200, "t": 2},
            ]
            addon._flight_state["phase"] = "AIRBORNE"
        saved = addon.finalize_active_flight("test shutdown")
        self.assertIsNotNone(saved)
        self.assertTrue(saved["incomplete"])
        flights = addon.lb_load()
        self.assertEqual(len(flights), 1)
        self.assertFalse(flights[0].get("recovered", False))
        self.assertEqual(flights[0]["track"][-1]["lat"], 37.1)

    def test_inprogress_recovery(self):
        flight = addon._new_flight(telemetry())
        flight["track"] = [{"lat": 37.0, "lon": -122.0, "alt": 10, "t": 1},
                           {"lat": 37.2, "lon": -121.8, "alt": 5000, "t": 2}]
        flight["takeoffTime"] = 1
        with open(addon.INPROGRESS_FILE, "w", encoding="utf-8") as handle:
            json.dump(flight, handle)
        recovered = addon.recover_inprogress()
        self.assertIsNotNone(recovered)
        self.assertTrue(recovered["incomplete"])
        flights = addon.lb_load()
        self.assertEqual(len(flights), 1)
        self.assertTrue(flights[0]["recovered"])
        self.assertFalse(os.path.exists(addon.INPROGRESS_FILE))

    def test_descent_gradient_is_measured_from_the_track(self):
        # 20 nm level at 18,000 ft, then 18,000 ft down to 1,800 ft over 60 nm
        # of straight track: 270 ft/nm.
        step = 1.0 / 60.0  # one nautical mile of latitude
        track = []
        for index in range(20):
            track.append({"lat": 37.0 + index * step, "lon": -122.0, "alt": 18000,
                          "t": index * 60000})
        for index in range(61):
            track.append({"lat": 39.0 + index * step, "lon": -122.0,
                          "alt": 18000 - index * 270, "t": (20 + index) * 60000})
        result = addon._analyse_descent(track)
        self.assertIsNotNone(result)
        self.assertAlmostEqual(result["ftPerNm"], 270.0, delta=2.0)
        self.assertEqual(result["startAltFt"], 18000)
        self.assertEqual(result["source"], "measured from the recorded track")

    def test_descent_is_ignored_when_the_track_is_unusable(self):
        self.assertIsNone(addon._analyse_descent([]))
        # Pattern work: a 1,000 ft drop is not a descent profile.
        short = [{"lat": 37.0 + i * 0.05, "lon": -122.0, "alt": 2000 - i * 200, "t": i} for i in range(6)]
        self.assertIsNone(addon._analyse_descent(short))
        # A descent with no distance is not a gradient either.
        stacked = [{"lat": 37.0, "lon": -122.0, "alt": 18000 - i * 1000, "t": i} for i in range(12)]
        self.assertIsNone(addon._analyse_descent(stacked))

    def test_descent_profile_uses_the_newest_measured_flight(self):
        addon.lb_save([
            {"id": "a", "complete": True, "endTime": 1000, "aircraft": "B738",
             "descent": {"ftPerNm": 250.0}},
            {"id": "b", "complete": True, "endTime": 2000, "aircraft": "B738",
             "descent": {"ftPerNm": 200.0}},
            {"id": "c", "complete": True, "endTime": 3000, "aircraft": "A320",
             "descent": {"ftPerNm": 9999.0}},
        ])
        profile = addon.get_descent_profile()
        self.assertTrue(profile["available"])
        self.assertEqual(profile["ftPerNm"], 200.0)
        self.assertEqual(profile["medianFtPerNm"], 225.0)
        self.assertEqual(profile["flights"], 2)

    def test_descent_profile_is_unavailable_before_any_flight(self):
        addon.lb_save([])
        profile = addon.get_descent_profile()
        self.assertFalse(profile["available"])
        self.assertEqual(profile["flights"], 0)

    def test_current_flight_summary_carries_a_sampled_track(self):
        addon.process_telemetry_for_logbook(telemetry(gs=20), AIRPORTS)
        summary = addon.get_current_flight()
        self.assertIn("phase", summary)
        self.assertEqual(summary["phase"], "TAXI")
        # The live payload carries the recorded path, sampled, so a page opened
        # halfway through can draw the flight from its first point.
        self.assertIsInstance(summary["track"], list)
        self.assertLessEqual(len(summary["track"]), addon.TRACK_STREAM_POINTS + 1)

    def test_stats_counts_only_complete_flights(self):
        addon.lb_save([
            {"id": "a", "complete": True, "incomplete": False, "takeoffTime": 0, "landingTime": 3600000,
             "distanceNm": 100, "landing": {"vsFpm": -120}},
            {"id": "b", "complete": True, "incomplete": True, "takeoffTime": 0, "landingTime": 3600000},
            {"id": "c", "complete": False},
        ])
        stats = addon.get_stats()
        self.assertEqual(stats["flights"], 1)
        self.assertEqual(stats["incomplete"], 2)
        self.assertEqual(stats["hours"], 1.0)
        self.assertEqual(stats["landings"], 1)


import unittest.mock  # noqa: E402  (imported after env setup for clarity)
import stratos_bridge as bridge  # noqa: E402


class PairLandingTests(unittest.TestCase):
    """One-tap pairing lands on the page the phone asked for, and only on this bridge."""

    @staticmethod
    def handler(path):
        instance = bridge.Handler.__new__(bridge.Handler)
        instance.path = path
        return instance

    def test_a_phone_lands_on_the_live_dashboard_by_default(self):
        self.assertEqual(self.handler("/pair/connect").pair_landing(), "/live.html")

    def test_a_phone_can_ask_for_the_map_instead(self):
        self.assertEqual(self.handler("/pair/connect?next=%2Findex.html").pair_landing(), "/index.html")
        # The account hand-off lives in the fragment, which is never sent to
        # this server, and still lands on a page served by this bridge.
        self.assertEqual(
            self.handler("/pair/connect?next=%2Findex.html%23account%3Dabc123").pair_landing(),
            "/index.html#account=abc123",
        )

    def test_the_landing_page_cannot_be_sent_off_this_bridge(self):
        for bad in ("/pair/connect?next=https://example.com",
                    "/pair/connect?next=//example.com",
                    "/pair/connect?next=/../bridge_token.txt",
                    "/pair/connect?next=index.html"):
            self.assertEqual(self.handler(bad).pair_landing(), "/live.html", bad)


class PairingTests(unittest.TestCase):
    def setUp(self):
        bridge.revoke_pairs()
        with bridge.PAIR_LOCK:
            bridge.PAIR_ATTEMPTS.clear()
            bridge.PAIR_CLIENTS.clear()
        try:
            os.unlink(bridge.PHONE_PAIRS_FILE)
        except OSError:
            pass

    def test_a_new_pairing_is_short_lived_and_single_use(self):
        session = bridge.create_pair_session()
        self.assertIn("/pair?t=", session["url"])
        self.assertRegex(session["code"], r"^\d{6}$")
        self.assertEqual(session["ttlSeconds"], 120)
        self.assertGreater(session["expiresAt"], time.time() * 1000)
        self.assertTrue(bridge.claim_pair(session["token"]))
        self.assertFalse(bridge.claim_pair(session["token"]), "a pairing token must work once")

    def test_the_six_digit_code_pairs_once(self):
        session = bridge.create_pair_session()
        self.assertTrue(bridge.claim_pair(session["code"]))
        self.assertFalse(bridge.claim_pair(session["code"]))

    def test_unknown_or_empty_values_never_pair(self):
        bridge.create_pair_session()
        self.assertFalse(bridge.claim_pair(""))
        self.assertFalse(bridge.claim_pair("000000-not-a-code"))
        self.assertFalse(bridge.claim_pair(None))

    def test_an_expired_pairing_is_rejected_and_cleaned_up(self):
        session = bridge.create_pair_session()
        with bridge.PAIR_LOCK:
            for entry in bridge.PAIR_SESSIONS.values():
                entry["expires"] = time.time() - 1
        self.assertFalse(bridge.claim_pair(session["token"]))
        bridge.pair_clean()
        with bridge.PAIR_LOCK:
            self.assertEqual(bridge.PAIR_SESSIONS, {})

    def test_status_never_exposes_the_token(self):
        bridge.create_pair_session()
        status = bridge.pair_status()
        self.assertEqual(status["activeCodes"], 1)
        self.assertNotIn("token", json.dumps(status).lower())

    def test_a_paired_phone_gets_its_own_secret_and_only_a_hash_is_stored(self):
        secret, record = bridge.pair_client("10.0.0.9")
        self.assertTrue(bridge.verify_phone_secret(secret))
        self.assertFalse(bridge.verify_phone_secret("not-the-secret"))
        self.assertFalse(bridge.verify_phone_secret(""))
        self.assertTrue(record["id"])
        status = bridge.pair_status()
        self.assertEqual(status["clients"], 1)
        self.assertEqual(status["devices"][0]["label"], "10.0.0.9")
        serialized = json.dumps(status)
        self.assertNotIn(secret, serialized)
        with open(bridge.PHONE_PAIRS_FILE, "r", encoding="utf-8") as handle:
            stored = handle.read()
        self.assertNotIn(secret, stored)
        self.assertIn(bridge.phone_digest(secret), stored)

    def test_phone_pairing_survives_a_bridge_restart(self):
        secret, record = bridge.pair_client("10.0.0.10")
        with bridge.PAIR_LOCK:
            bridge.PAIR_CLIENTS.clear()
        self.assertFalse(bridge.verify_phone_secret(secret))
        bridge.load_phone_clients()
        self.assertTrue(bridge.verify_phone_secret(secret))
        self.assertEqual(bridge.pair_status()["devices"][0]["id"], record["id"])

    def test_forgetting_one_phone_keeps_the_other_paired(self):
        first, first_record = bridge.pair_client("10.0.0.11")
        second, _ = bridge.pair_client("10.0.0.12")
        self.assertTrue(bridge.revoke_phone_client(first_record["id"]))
        self.assertFalse(bridge.verify_phone_secret(first))
        self.assertTrue(bridge.verify_phone_secret(second))
        self.assertEqual(bridge.pair_status()["clients"], 1)
        self.assertFalse(bridge.revoke_phone_client(first_record["id"]), "revoking twice is harmless")

    def test_a_phone_can_forget_itself(self):
        secret, _ = bridge.pair_client("10.0.0.13")
        self.assertTrue(bridge.revoke_phone_client_for_secret(secret))
        self.assertFalse(bridge.verify_phone_secret(secret))
        self.assertFalse(bridge.revoke_phone_client_for_secret(secret))

    def test_forgetting_every_phone_invalidates_old_secrets_and_rotates_the_shared_token(self):
        secret, _ = bridge.pair_client("10.0.0.14")
        before = bridge.TOKEN
        bridge.revoke_pairs()
        self.assertFalse(bridge.verify_phone_secret(secret))
        self.assertEqual(bridge.pair_status()["clients"], 0)
        self.assertNotEqual(bridge.TOKEN, before)
        with open(bridge.TOKEN_FILE, "r", encoding="utf-8") as handle:
            self.assertEqual(handle.read().strip(), bridge.TOKEN)


class ChecklistSyncTests(unittest.TestCase):
    def setUp(self):
        with bridge.CHECKLIST_LOCK:
            bridge.CHECKLIST_STATE.clear()

    def test_state_is_sanitised_before_it_is_shared(self):
        saved = bridge.save_checklist({
            "profileKey": "a346-toliss",
            "flightKey": "flight:1",
            "activeSection": "beforeStart",
            "revision": 4,
            "checks": {"beforeStart.0": True, "beforeStart.1": False, "beforeStart.2": "yes",
                       "x" * 200: True},
        })
        self.assertEqual(saved["checks"], {"beforeStart.0": True})
        self.assertEqual(saved["flightKey"], "flight:1")
        self.assertEqual(saved["revision"], 4)

    def test_an_older_revision_cannot_overwrite_a_newer_one(self):
        bridge.save_checklist({"flightKey": "flight:1", "revision": 5, "checks": {"a.0": True}})
        result = bridge.save_checklist({"flightKey": "flight:1", "revision": 3, "checks": {"b.0": True}})
        self.assertEqual(result["revision"], 5)
        self.assertIn("a.0", result["checks"])
        self.assertNotIn("b.0", result["checks"])

    def test_a_new_flight_replaces_the_previous_state(self):
        bridge.save_checklist({"flightKey": "flight:1", "revision": 9, "checks": {"a.0": True}})
        bridge.save_checklist({"flightKey": "flight:2", "revision": 0, "checks": {}})
        snapshot = bridge.checklist_snapshot()
        self.assertEqual(snapshot["flightKey"], "flight:2")
        self.assertEqual(snapshot["checks"], {})

    def test_snapshots_are_copies(self):
        bridge.save_checklist({"flightKey": "flight:1", "revision": 1, "checks": {"a.0": True}})
        snapshot = bridge.checklist_snapshot()
        snapshot["checks"]["b.0"] = True
        self.assertEqual(bridge.checklist_snapshot()["checks"], {"a.0": True})

    def test_empty_or_malformed_payloads_are_ignored(self):
        self.assertIsNone(bridge.save_checklist("nope"))
        self.assertIsNone(bridge.save_checklist([1, 2, 3]))
        self.assertIsNone(bridge.checklist_snapshot())


class PhoneDiscoveryTests(unittest.TestCase):
    """The one-tap connection: mDNS name, LAN-only enrollment, RREF identity."""

    def test_a_query_for_our_name_is_answered_with_the_lan_address(self):
        query = (b"\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00"
                 + bridge.dns_encode_name("stratos.local") + b"\x00\x01\x00\x01")
        self.assertEqual(bridge.dns_questions(query), [("stratos.local", 1)])
        reply = bridge.mdns_response(query, "192.168.1.20")
        self.assertIsNotNone(reply)
        self.assertEqual(reply[2] & 0x80, 0x80, "the reply is a response")
        self.assertIn(b"\xc0\xa8\x01\x14", reply, "the A record carries the LAN address")

    def test_a_query_for_another_name_is_left_alone(self):
        query = (b"\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00"
                 + bridge.dns_encode_name("printer.local") + b"\x00\x01\x00\x01")
        self.assertIsNone(bridge.mdns_response(query, "192.168.1.20"))

    def test_the_service_is_advertised_without_a_secret(self):
        txt = bridge.mdns_txt()
        self.assertIn(b"path=/live", txt)
        self.assertNotIn(b"token", txt.lower())
        self.assertTrue(bridge.mdns_txt().startswith(bytes([len(b"path=/live")])))

    def test_auto_pairing_is_limited_to_the_local_network(self):
        self.assertTrue(bridge.is_lan_address("192.168.1.5"))
        self.assertTrue(bridge.is_lan_address("10.0.0.4"))
        self.assertFalse(bridge.is_lan_address("8.8.8.8"))
        self.assertFalse(bridge.is_lan_address("203.0.113.9"))

    def test_auto_pairing_says_why_it_cannot_run(self):
        original_host, original_enabled = bridge.HOST, bridge.AUTO_PAIR_ENABLED
        try:
            bridge.HOST = "127.0.0.1"
            self.assertIn("only on this PC", bridge.auto_pair_gate("192.168.1.5"))
            bridge.HOST = "0.0.0.0"
            self.assertIn("local network", bridge.auto_pair_gate("203.0.113.9"))
            bridge.AUTO_PAIR_ENABLED = False
            self.assertIn("turned off", bridge.auto_pair_gate("192.168.1.5"))
            bridge.AUTO_PAIR_ENABLED = True
            self.assertEqual(bridge.auto_pair_gate("192.168.1.5"), "")
        finally:
            bridge.HOST, bridge.AUTO_PAIR_ENABLED = original_host, original_enabled

    def test_auto_pairing_hands_out_its_own_secret(self):
        original_host = bridge.HOST
        try:
            bridge.HOST = "0.0.0.0"
            secret, record = bridge.auto_pair("192.168.1.5")
            self.assertTrue(secret)
            self.assertTrue(bridge.verify_phone_secret(secret))
            self.assertEqual(record["pairedAt"] > 0, True)
        finally:
            bridge.HOST = original_host


class XPlaneIdentityTests(unittest.TestCase):
    def test_a_request_is_the_standard_rref_packet(self):
        packet = bridge.rref_request(9003, "sim/aircraft/view/acf_tailnum[3]", 1)
        self.assertEqual(packet[:4], b"RREF")
        self.assertEqual(len(packet), 5 + 4 + 4 + 400)
        self.assertEqual(bridge.struct.unpack("<i", packet[5:9])[0], 1)
        self.assertEqual(bridge.struct.unpack("<i", packet[9:13])[0], 9003)
        self.assertEqual(packet[13:13 + 34].rstrip(b"\x00"),
                         b"sim/aircraft/view/acf_tailnum[3]")

    def test_several_values_may_share_one_packet(self):
        body = b"RREF\x00" + bridge.struct.pack("<if", 9000, 67.0) + bridge.struct.pack("<if", 9001, 45.0)
        self.assertEqual(bridge.rref_values(body), [(9000, 67.0), (9001, 45.0)])
        self.assertEqual(bridge.rref_values(b"DATA\x00"), [])

    def test_characters_assemble_into_the_reported_text(self):
        chars = {0: 78.0, 1: 56.0, 2: 51.0, 3: 49.0, 4: 50.0, 5: 67.0}
        self.assertEqual(bridge.rref_text(chars), "N8312C")
        self.assertEqual(bridge.rref_text({0: 78.0, 1: 0.0, 2: 56.0}), "N")
        self.assertEqual(bridge.rref_text({1: 56.0, 2: 51.0}), "")

    def test_placeholders_are_not_registrations(self):
        for value in ("", "NONE", "N/A", "B738", "---"):
            self.assertEqual(bridge.plausible_registration(value), "")
        self.assertEqual(bridge.plausible_registration("n8312c"), "N8312C")
        self.assertEqual(bridge.plausible_registration("G-TAWI"), "G-TAWI")
        self.assertEqual(bridge.plausible_registration("B-1234"), "B-1234", "a country mark is not a type")
        self.assertEqual(bridge.plausible_registration("MD-82"), "", "a type with a hyphen is still a type")

    def test_the_subscription_covers_every_character_and_numeric_row(self):
        self.assertEqual(len(bridge.RREF_REQUESTS), 10 + 8 + 48 + 3 + len(bridge.XPLANE_POSITION_DATAREFS))
        names = [request[1] for request in bridge.RREF_REQUESTS]
        self.assertIn("sim/aircraft/view/acf_tailnum[0]", names)
        self.assertIn("sim/aircraft/view/acf_tailnum[9]", names)
        self.assertIn("sim/weather/region/altimeter_setting_inhg", names)
        self.assertIn("sim/flightmodel/weight/m_total", names)
        self.assertIn("sim/cockpit2/controls/flap_ratio", names)

    def test_ground_track_is_derived_from_movement_not_heading(self):
        """A track that has not moved is unknown, and a moved one is its course."""
        bridge._GROUND_TRACK.update(lat=None, lon=None, at=0.0)
        start = time.time()
        self.assertIsNone(bridge.ground_track_from_motion(37.0, -122.0, start))
        course = bridge.ground_track_from_motion(37.01, -121.99, start + 1.0)
        self.assertIsNotNone(course)
        self.assertGreater(course, 0.0)
        self.assertLess(course, 90.0, "north-east movement is a north-east course")
        self.assertNotAlmostEqual(course, 270.0, msg="the track must not copy a heading")

    def test_position_datarefs_publish_bank_track_and_speeds(self):
        """Bank, both headings, track, IAS/TAS, wind and OAT reach the snapshot."""
        saved = dict(bridge._XPLANE_POSITION)
        keys = ("lat", "lon", "bank", "trk", "hdgMag", "ias", "tas",
                "windDir", "windSpd", "oat")
        with bridge.state_lock:
            keep = {key: bridge.state.get(key) for key in keys}
        try:
            bridge._XPLANE_POSITION.update(
                lat=37.0, lon=-122.0, bank=12.0, trk=263.0, hdgMag=270.0,
                ias=276.0, tas=451.0, windDir=300.0, windSpd=40.0, oat=-52.0)
            bridge.apply_xplane_position()
            with bridge.state_lock:
                self.assertEqual(bridge.state["bank"], 12.0)
                self.assertEqual(bridge.state["trk"], 263.0)
                self.assertEqual(bridge.state["hdgMag"], 270.0)
                self.assertEqual(bridge.state["ias"], 276.0)
                self.assertEqual(bridge.state["tas"], 451.0)
                self.assertEqual(bridge.state["windDir"], 300.0)
                self.assertEqual(bridge.state["windSpd"], 40.0)
                self.assertEqual(bridge.state["oat"], -52.0)
                self.assertNotEqual(bridge.state["hdgMag"], bridge.state["trk"])
        finally:
            bridge._XPLANE_POSITION.clear()
            bridge._XPLANE_POSITION.update(saved)
            with bridge.state_lock:
                for key, value in keep.items():
                    if value is None:
                        bridge.state.pop(key, None)
                    else:
                        bridge.state[key] = value

    def test_performance_datarefs_become_physical_values(self):
        saved = dict(bridge._XPLANE_NUMERIC)
        saved_status = dict(bridge.xplane_performance_status)
        try:
            bridge._XPLANE_NUMERIC.update(qnh=29.92, weight=70000.0, flap=0.5)
            bridge.apply_xplane_performance()
            status = bridge.xplane_performance_status
            self.assertTrue(status["available"])
            self.assertAlmostEqual(status["qnhHpa"], 1013.2, places=1)
            self.assertEqual(status["weightKg"], 70000.0)
            self.assertEqual(status["flapRatio"], 0.5)
            self.assertGreater(status["at"], 0)
        finally:
            bridge._XPLANE_NUMERIC.clear()
            bridge._XPLANE_NUMERIC.update(saved)
            bridge.xplane_performance_status.clear()
            bridge.xplane_performance_status.update(saved_status)

    def test_implausible_performance_values_are_not_published(self):
        saved = dict(bridge._XPLANE_NUMERIC)
        saved_status = dict(bridge.xplane_performance_status)
        try:
            bridge.xplane_performance_status.update(
                available=False, qnhHpa=None, weightKg=None, flapRatio=None, at=0)
            bridge._XPLANE_NUMERIC.update(qnh=0.0, weight=0.0, flap=1.5)
            bridge.apply_xplane_performance()
            self.assertFalse(bridge.xplane_performance_status["available"])
            self.assertIsNone(bridge.xplane_performance_status["qnhHpa"])
        finally:
            bridge._XPLANE_NUMERIC.clear()
            bridge._XPLANE_NUMERIC.update(saved)
            bridge.xplane_performance_status.clear()
            bridge.xplane_performance_status.update(saved_status)


class RelayTrafficTests(unittest.TestCase):
    """What a relayed phone gets: the list, and only the samples it lacks."""

    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix="stratos-relay-traffic-")
        self.file = bridge.TRAFFIC_FILE
        bridge.TRAFFIC_FILE = os.path.join(self.directory, "traffic_trails.json")
        with bridge.TRAFFIC_LOCK:
            bridge.TRAFFIC.clear()
        with bridge.state_lock:
            self.saved_tr = bridge.state.get("tr")
            self.saved_trt = bridge.state.get("trt")

    def tearDown(self):
        bridge.TRAFFIC_FILE = self.file
        with bridge.TRAFFIC_LOCK:
            bridge.TRAFFIC.clear()
        with bridge.state_lock:
            if self.saved_tr is None:
                bridge.state.pop("tr", None)
            else:
                bridge.state["tr"] = self.saved_tr
            if self.saved_trt is None:
                bridge.state.pop("trt", None)
            else:
                bridge.state["trt"] = self.saved_trt

    def test_the_batch_carries_the_list_and_every_new_sample(self):
        now = int(time.time() * 1000)
        with bridge.state_lock:
            bridge.state["tr"] = [
                {"id": "SWR219", "lat": 46.5, "lon": -122.9, "alt": 12000, "gs": 320, "hdg": 180},
                {"id": "", "lat": 46.0, "lon": -122.0},
                {"id": "BAD", "lat": None, "lon": None},
            ]
            bridge.state["trt"] = time.time()
        bridge.record_traffic([
            ["SWR219", 46.5, -122.9, 12000, now - 15000],
            ["SWR219", 46.4, -122.8, 16000, now],
            ["DLH400", 47.0, -121.0, 30000, now],
        ])
        batch = bridge.relay_traffic_batch({})
        self.assertEqual([entry["id"] for entry in batch["list"]], ["SWR219"],
                         "an entry without a usable position is not relayed")
        self.assertEqual(batch["list"][0]["alt"], 12000)
        keys = {point[0] for point in batch["points"]}
        self.assertEqual(keys, {"SWR219", "DLH400"})
        self.assertEqual([point[3] for point in batch["points"] if point[0] == "SWR219"], [12000, 16000],
                         "a trail keeps the altitudes it recorded")

    def test_only_samples_after_the_cursor_are_sent_again(self):
        now = int(time.time() * 1000)
        bridge.record_traffic([
            ["SWR219", 46.5, -122.9, 12000, now - 15000],
            ["SWR219", 46.4, -122.8, 16000, now],
        ])
        first = bridge.relay_traffic_batch({})
        cursor = {}
        for key, _lat, _lon, _alt, stamp in first["points"]:
            cursor[key] = max(cursor.get(key, 0), stamp)
        self.assertEqual(bridge.relay_traffic_batch(cursor)["points"], [],
                         "nothing new means nothing sent")
        # record_traffic never accepts a stamp in the future, so the sample has to
        # arrive after the one already stored or it would collapse onto its
        # millisecond and count as nothing new.
        time.sleep(0.02)
        bridge.record_traffic([["SWR219", 46.3, -122.7, 20000, now + 5000]])
        second = bridge.relay_traffic_batch(cursor)
        self.assertEqual([point[0] for point in second["points"]], ["SWR219"])
        self.assertEqual(second["points"][0][3], 20000)

    def test_the_batch_is_bounded(self):
        now = int(time.time() * 1000)
        with bridge.state_lock:
            bridge.state["tr"] = [{"id": "A%d" % index, "lat": 40.0 + index / 100, "lon": 8.0, "alt": 1000}
                                  for index in range(80)]
            bridge.state["trt"] = time.time()
        bridge.record_traffic([["A%d" % index, 40.0, 8.0, 1000, now] for index in range(40)])
        batch = bridge.relay_traffic_batch({})
        self.assertLessEqual(len(batch["list"]), 60)
        self.assertLessEqual(len(batch["points"]), bridge.TRAFFIC_RELAY_MAX_POINTS)


class StreamTrackTests(unittest.TestCase):
    def test_the_stream_carries_the_whole_flight_evenly_sampled(self):
        track = [{"lat": 37.0 + i * 0.001, "lon": -122.0, "alt": 1000 + i, "t": i}
                 for i in range(2000)]
        points = addon.stream_track(track)
        self.assertLessEqual(len(points), addon.TRACK_STREAM_POINTS + 1)
        self.assertEqual(points[0][0], 37.0, "the first point is kept")
        self.assertEqual(points[-1][0], track[-1]["lat"], "the last point is kept")
        # Chronological, and no invented positions.
        self.assertEqual(points, sorted(points, key=lambda point: point[3]))
        self.assertTrue(all(len(point) == 5 for point in points))
        self.assertTrue(all(point[4] is None for point in points), "a sample without AGL says so instead of inventing one")

    def test_a_short_track_is_passed_through_unchanged(self):
        track = [{"lat": 1.0, "lon": 2.0, "alt": 3.0, "t": 4}, {"lat": 5.0, "lon": 6.0, "alt": 7.0, "t": 8}]
        self.assertEqual(addon.stream_track(track), [[1.0, 2.0, 3.0, 4, None], [5.0, 6.0, 7.0, 8, None]])
        self.assertEqual(addon.stream_track([]), [])

    def test_the_stream_carries_the_height_above_ground_when_the_sim_gave_it(self):
        track = [
            {"lat": 1.0, "lon": 2.0, "alt": 5500.0, "t": 1004, "agl": 0.0},
            {"lat": 5.0, "lon": 6.0, "alt": 9500.0, "t": 1008, "agl": 4000.0},
        ]
        self.assertEqual(addon.stream_track(track), [[1.0, 2.0, 5500.0, 1004, 0.0], [5.0, 6.0, 9500.0, 1008, 4000.0]])


class TrafficTrailTests(unittest.TestCase):
    """The bridge remembers the traffic the page has seen, so a trail survives."""

    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix="stratos-trails-")
        self.file = bridge.TRAFFIC_FILE
        self.retention = bridge.TRAFFIC_RETENTION_S
        bridge.TRAFFIC_FILE = os.path.join(self.directory, "traffic_trails.json")
        with bridge.TRAFFIC_LOCK:
            bridge.TRAFFIC.clear()
        bridge.TRAFFIC_SAVE.update(at=0.0, dirty=False)

    def tearDown(self):
        bridge.TRAFFIC_FILE = self.file
        bridge.TRAFFIC_RETENTION_S = self.retention
        with bridge.TRAFFIC_LOCK:
            bridge.TRAFFIC.clear()
        bridge.TRAFFIC_SAVE.update(at=0.0, dirty=False)

    def test_positions_are_recorded_once_each_and_in_order(self):
        now = int(time.time() * 1000)
        added = bridge.record_traffic([
            ["4ca1b2", 47.1, -122.3, 12000, now - 2000],
            ["4CA1B2", 47.1, -122.3, 12000, now - 2000],  # the same sample again
            ["4CA1B2", 47.2, -122.2, 18000, now],
        ])
        self.assertEqual(added, 2, "a repeated position is not a second sample")
        points = bridge.traffic_trail("4CA1B2")
        self.assertEqual([point[0] for point in points], [47.1, 47.2])
        self.assertEqual(points, sorted(points, key=lambda point: point[3]), "chronological")
        self.assertEqual(bridge.traffic_trail("4ca1b2")[0][2], 12000, "the key is normalised")

    def test_a_sample_that_arrives_late_does_not_rewind_the_path(self):
        now = int(time.time() * 1000)
        bridge.record_traffic([["ABC123", 47.0, -122.0, 10000, now]])
        bridge.record_traffic([["ABC123", 46.0, -121.0, 9000, now - 60000]])
        points = bridge.traffic_trail("ABC123")
        self.assertEqual(len(points), 1, "a stale sample is dropped, not appended at the end")
        self.assertEqual(points[0][0], 47.0)

    def test_a_position_of_zero_zero_is_not_a_position(self):
        added = bridge.record_traffic([["ABC123", 0, 0, 0, int(time.time() * 1000)],
                                       ["ABC123", 200, 10, 0, int(time.time() * 1000)],
                                       ["", 47.0, -122.0, 0, int(time.time() * 1000)]])
        self.assertEqual(added, 0)
        self.assertEqual(bridge.traffic_trail("ABC123"), [])

    def test_the_trail_is_on_disk_and_survives_a_restart(self):
        bridge.record_traffic([["DEF456", 45.0, 9.0, 30000, int(time.time() * 1000)]])
        self.assertTrue(os.path.isfile(bridge.TRAFFIC_FILE), "the trail is written to the data folder")
        with bridge.TRAFFIC_LOCK:
            bridge.TRAFFIC.clear()
        bridge.load_traffic_trails()
        points = bridge.traffic_trail("DEF456")
        self.assertEqual(len(points), 1)
        self.assertEqual(points[0][2], 30000)

    def test_the_retention_window_drops_an_old_trail(self):
        bridge.TRAFFIC_RETENTION_S = 60
        now = int(time.time() * 1000)
        bridge.record_traffic([["OLD999", 40.0, 8.0, 20000, now - 120000]])
        self.assertEqual(bridge.traffic_trail("OLD999"), [], "a sample past the window is not served")

    def test_the_per_aircraft_cap_keeps_the_newest_samples(self):
        now = int(time.time() * 1000)
        points = [["CAP123", 40.0 + index * 0.01, 8.0, 30000, now + index] for index in range(bridge.TRAFFIC_MAX_POINTS + 40)]
        bridge.record_traffic(points)
        trail = bridge.traffic_trail("CAP123")
        self.assertEqual(len(trail), bridge.TRAFFIC_MAX_POINTS)
        self.assertEqual(trail[-1][0], points[-1][1], "the newest sample is kept")


class AircraftPhotoTests(unittest.TestCase):
    """The bridge serves photos for the pages it hosts, so the card works there."""

    def test_only_a_registration_reaches_the_photo_service(self):
        self.assertEqual(bridge.photo_registration(" n8312c "), "N8312C")
        self.assertEqual(bridge.photo_registration("9V-SKA"), "9V-SKA")
        self.assertEqual(bridge.photo_registration("B-1234"), "B-1234")
        self.assertEqual(bridge.photo_registration("12345"), "", "a number is not a registration")
        self.assertEqual(bridge.photo_registration("ASA123"), "", "a callsign is not a registration")
        self.assertEqual(bridge.photo_registration("B738"), "", "a type code is not a registration")
        self.assertEqual(bridge.photo_registration(""), "")
        self.assertEqual(bridge.photo_registration(None), "")
        self.assertEqual(bridge.photo_registration("N<script>"), "")

    def test_an_n_number_that_looks_like_a_type_is_still_a_tail(self):
        for reg in ("N123", "N1234", "N737SW", "N8312C"):
            self.assertEqual(bridge.photo_registration(reg), reg)

    def test_a_mode_s_address_is_six_hex_digits(self):
        self.assertEqual(bridge.photo_hex(" ab5eb2 "), "AB5EB2")
        for value in ("", None, "4066D", "4066D0A", "ZZZZZZ", "BAW2620"):
            self.assertEqual(bridge.photo_hex(value), "", str(value))

    def test_a_found_photo_is_kept_longer_than_a_miss(self):
        self.assertGreater(bridge.PHOTO_TTL, bridge.PHOTO_MISS_TTL)
        self.assertGreaterEqual(bridge.PHOTO_MISS_TTL, 60, "a miss is cached too, so the card does not spam")


if __name__ == "__main__":
    unittest.main(verbosity=2)


class OsmHoldingPointTests(unittest.TestCase):
    def test_holding_nodes_become_single_point_entries_beside_ways(self):
        payload = {"elements": [
            {"type": "way", "tags": {"aeroway": "taxiway", "ref": "A"},
             "geometry": [{"lat": 51.0, "lon": 0.0}, {"lat": 51.001, "lon": 0.0}]},
            {"type": "node", "lat": 51.0005, "lon": 0.0, "tags": {"aeroway": "holding_position", "ref": "A1"}},
            {"type": "node", "lat": 51.0, "lon": 0.0},                       # untagged vertex
            {"type": "way", "tags": {"aeroway": "taxiway"}},                # no geometry
        ]}
        self.assertEqual(bridge.osm_elements(payload), [
            ["taxiway", "A", [[51.0, 0.0], [51.001, 0.0]]],
            ["holding_position", "A1", [[51.0005, 0.0]]],
        ])


class OverpassMirrorTests(unittest.TestCase):
    WAY = {"type": "way", "tags": {"aeroway": "taxiway", "ref": "A"},
           "geometry": [{"lat": 51.0, "lon": 0.0}, {"lat": 51.001, "lon": 0.0}]}

    def run_with(self, answers):
        """answers: one per mirror tried; an Exception is raised, a dict is the JSON body."""
        import io
        from unittest import mock
        asked = []

        def fake(request, timeout=None):
            asked.append(request.full_url)
            answer = answers[len(asked) - 1]
            if isinstance(answer, Exception):
                raise answer
            return io.BytesIO(json.dumps(answer).encode())
        with mock.patch.object(bridge.urllib.request, "urlopen", fake), mock.patch.object(bridge, "log"):
            try:
                return bridge.overpass_query("q", mirrors=("https://a/i", "https://b/i", "https://c/i")), asked
            except Exception as exc:
                return exc, asked

    def test_a_failing_mirror_falls_through_to_the_next(self):
        result, asked = self.run_with([OSError("502 Bad Gateway"), {"elements": [self.WAY]}])
        self.assertEqual(asked, ["https://a/i", "https://b/i"])
        self.assertEqual(result, [["taxiway", "A", [[51.0, 0.0], [51.001, 0.0]]]])

    def test_a_timed_out_query_remark_is_a_failure_not_an_empty_airfield(self):
        result, asked = self.run_with([{"elements": [], "remark": "runtime error: timeout"}, {"elements": [self.WAY]}])
        self.assertEqual(len(asked), 2)
        self.assertEqual(len(result), 1)

    def test_when_every_mirror_fails_the_last_error_is_raised(self):
        result, asked = self.run_with([OSError("a"), OSError("b"), OSError("c")])
        self.assertEqual(len(asked), 3)
        self.assertIsInstance(result, OSError)
        self.assertEqual(str(result), "c")

    def test_an_empty_answer_is_returned_but_not_cached(self):
        from unittest import mock
        with mock.patch.object(bridge, "overpass_query", return_value=[]):
            self.assertEqual(bridge.osm_airfield("ZZZZ", 1.0, 2.0), "[]")
        self.assertFalse(os.path.exists(os.path.join(bridge.OSMDIR, "ZZZZ.v2.json")))
        with mock.patch.object(bridge, "overpass_query", return_value=[["taxiway", "A", [[1, 2], [1, 3]]]]):
            bridge.osm_airfield("ZZZZ", 1.0, 2.0)
        self.assertTrue(os.path.exists(os.path.join(bridge.OSMDIR, "ZZZZ.v2.json")))


class SigmetFeedTests(unittest.TestCase):
    def setUp(self):
        bridge.SIGMET_CACHE.update(at=0, payload=None)

    def test_feeds_are_passed_through_and_a_failed_one_is_named(self):
        def fetch(url):
            if "isigmet" in url:
                raise OSError("504 Gateway Timeout")
            return [{"hazard": "TURB"}]
        payload = bridge.sigmet_feeds(fetch)
        self.assertEqual(payload["airsigmet"], [{"hazard": "TURB"}])
        self.assertIsNone(payload["isigmet"])
        self.assertIn("isigmet", payload["errors"])
        self.assertNotIn("error", payload)
        # cached: a second call does not fetch
        self.assertIs(bridge.sigmet_feeds(lambda url: self.fail("fetched again")), payload)

    def test_all_failing_is_an_error_and_is_not_cached(self):
        def fetch(url):
            raise OSError("down")
        payload = bridge.sigmet_feeds(fetch)
        self.assertIn("error", payload)
        self.assertIsNone(bridge.SIGMET_CACHE["payload"])

    def test_a_non_list_answer_counts_as_a_failure(self):
        payload = bridge.sigmet_feeds(lambda url: {"error": "bad request"})
        self.assertIn("error", payload)


class SimConnectSourceTests(unittest.TestCase):
    def test_the_reported_application_name_picks_the_source(self):
        self.assertEqual(bridge.simconnect_label("Lockheed Martin® Prepar3D® v5"), "P3D")
        self.assertEqual(bridge.simconnect_label("Microsoft Flight Simulator X"), "FSX")
        self.assertEqual(bridge.simconnect_label("KittyHawk"), "MSFS")
        self.assertEqual(bridge.simconnect_label(""), "MSFS")

    def test_libraries_are_tried_override_first_then_bundled_then_prepar3d(self):
        root = tempfile.mkdtemp()
        p3d = os.path.join(root, "Lockheed Martin", "Prepar3D v5", "redist", "Interface", "SimConnect.dll")
        os.makedirs(os.path.dirname(p3d))
        open(p3d, "wb").close()
        saved = {k: os.environ.get(k) for k in ("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)", "STRATOS_SIMCONNECT_DLL")}
        try:
            for key in saved:
                os.environ.pop(key, None)
            os.environ["ProgramFiles"] = root
            os.environ["STRATOS_SIMCONNECT_DLL"] = r"D:\custom\SimConnect.dll"
            libs = bridge.simconnect_libraries("bundled.dll")
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        self.assertEqual(libs, [r"D:\custom\SimConnect.dll", "bundled.dll", p3d])


class AircraftIdentityTests(unittest.TestCase):
    def test_msfs_atc_model_gives_the_icao_type(self):
        self.assertEqual(bridge.atc_model_type("TT:ATCCOM.AC_MODEL_A320.0.text"), "A320")
        self.assertEqual(bridge.atc_model_type(b"A20N\x00"), "A20N")
        self.assertEqual(bridge.atc_model_type("Airbus A320neo"), "", "a description is not a type code")
        self.assertEqual(bridge.atc_model_type(None), "")
        self.assertEqual(bridge.sim_text(b"C-FABC\x00 "), "C-FABC")

    def _xplane(self, tail, icao, desc):
        bridge._XPLANE_CHARS["tail"] = {i: ord(c) for i, c in enumerate(tail)}
        bridge._XPLANE_CHARS["icao"] = {i: ord(c) for i, c in enumerate(icao)}
        bridge._XPLANE_CHARS["desc"] = {i: ord(c) for i, c in enumerate(desc)}
        bridge.apply_xplane_identity()

    def test_xplane_follows_a_switch_to_another_aircraft(self):
        saved_identity = bridge.load_aircraft_identity
        saved_state = dict(bridge.state)
        try:
            bridge.load_aircraft_identity = lambda: {}
            self._xplane("N123AB", "B738", "Boeing 737-800")
            self.assertEqual((bridge.state["registration"], bridge.state["aircraftType"]), ("N123AB", "B738"))
            self._xplane("D-AIZA", "A320", "Airbus A320")
            self.assertEqual((bridge.state["registration"], bridge.state["aircraftType"]), ("D-AIZA", "A320"),
                             "the new aircraft replaces the previous one")
            bridge.load_aircraft_identity = lambda: {"registration": "HB-JHK"}
            bridge.state["registration"] = "HB-JHK"
            self._xplane("G-EUPT", "A319", "Airbus A319")
            self.assertEqual(bridge.state["registration"], "HB-JHK", "a registration set by hand still wins")
        finally:
            bridge.load_aircraft_identity = saved_identity
            bridge.state.clear()
            bridge.state.update(saved_state)


class IlsNavDataTests(unittest.TestCase):
    # Real X-Plane 12 earth_nav.dat (1200) lines, cycle 2610.
    LINES = [
        " 4  47.465077778 -122.307738889      355    11030    18 123840.343 ISEA KSEA K1 34R ILS-cat-II",
        " 6  47.434277778 -122.306394444      355    11030    18 275000.343 ISEA KSEA K1 34R GS",
        "12  47.434333333 -122.306300000      369    11030    25      0.000 ISEA KSEA K1 SEATTLE-TACOMA INTL DME-ILS",
        " 4  51.477697222   -0.426961111       79    11030    18  31769.709  IAA EGLL EG 09L ILS-cat-III",
        " 6  51.478750000   -0.480675000       79    11030    18 300089.709  IAA EGLL EG 09L GS",
        " 4  51.477697222   -0.426961111       79    11090    18  31769.709  IAA EGLL EG 09L ILS-cat-III",  # older duplicate
        " 5  47.26 11.30 1900 10970 18 23469.000 OEJ LOWI LO 08 LOC",
        " 4  1 2 3 bad 18 0 X Y Z 01 ILS",                                                                     # malformed
    ]

    def setUp(self):
        import stratos_navdata
        self.nav = stratos_navdata

    def test_localizer_glide_slope_and_dme_are_decoded_and_joined(self):
        table = self.nav.ils_from_rows([line.split() for line in self.LINES])
        sea = table["KSEA"][0]
        self.assertEqual((sea["runway"], sea["ident"], sea["freqMHz"]), ("34R", "ISEA", 110.3))
        self.assertEqual(sea["courseMag"], 344)
        self.assertAlmostEqual(sea["courseTrue"], 0.34, places=2)
        self.assertEqual(sea["glideSlopeDeg"], 2.75)
        self.assertTrue(sea["dme"])
        self.assertEqual(sea["type"], "ILS CAT II")

    def test_xplane_11_localizer_keeps_true_course_and_has_no_magnetic(self):
        # X-Plane 11 earth_nav.dat (1150): the localizer field is the true course only.
        rows = [(line.split(), False) for line in (
            " 4  47.463533 -122.308041      354    11030    18     179.950 ISZI KSEA K1 16L ILS-cat-I",
            " 6  47.442900 -122.311200      354    11030    10  300179.950 ISZI KSEA K1 16L GS",
        )]
        sea = self.nav.ils_from_rows(rows)["KSEA"][0]
        self.assertIsNone(sea["courseMag"])
        self.assertAlmostEqual(sea["courseTrue"], 179.95, places=2)
        self.assertEqual(sea["glideSlopeDeg"], 3.0)

    def test_first_copy_wins_and_a_lone_localizer_has_no_glide_slope(self):
        table = self.nav.ils_from_rows([line.split() for line in self.LINES])
        lhr = table["EGLL"]
        self.assertEqual(len(lhr), 1)
        self.assertEqual((lhr[0]["freqMHz"], lhr[0]["courseMag"], lhr[0]["glideSlopeDeg"]), (110.3, 88, 3.0))
        self.assertFalse(lhr[0]["dme"])
        lowi = table["LOWI"][0]
        self.assertEqual((lowi["type"], lowi["glideSlopeDeg"], lowi["courseMag"]), ("LOC", None, 65))
        self.assertNotIn("Y", table)


class EnrouteNavDataTests(unittest.TestCase):
    def setUp(self):
        import stratos_navdata
        self.nav = stratos_navdata

    def test_airway_legs_resolve_both_ends_by_ident_region_and_type(self):
        lookup = {("AALIX", "K1", "fix"): (48.504414, -121.756347), ("BAALE", "K1", "fix"): (48.445161, -121.415667),
                  ("SEA", "K1", "nav"): (47.435, -122.31)}
        lines = [
            "AALIX K1 11 BAALE K1 11 N 1  85 175 T332",          # real line, both fixes known
            "SEA K1 3 AALIX K1 11 N 2 180 450 J5-J12",            # VHF navaid to fix, high, two names
            "AALIX K1 11 NOWHR K1 11 N 1  85 175 V1",             # unknown end: skipped, never guessed
            "garbage",
        ]
        legs = self.nav.parse_airways(lines, lookup)
        self.assertEqual(len(legs), 2)
        self.assertEqual((legs[0]["names"], legs[0]["level"], legs[0]["baseFl"]), (["T332"], "low", 85))
        self.assertEqual(legs[0]["a"], ["AALIX", 48.504414, -121.756347])
        self.assertEqual((legs[1]["names"], legs[1]["level"]), (["J5", "J12"], "high"))

    def test_openair_polygons_keep_chart_classes_only(self):
        lines = ["AC D", "AN WILLIAM P GWINN", "AL GND", "AH 2500 MSL",
                 "DP 26:50:47 N 080:16:49 W", "DP 26:50:24 N 080:21:49 W", "DP 26:58:58 N 080:20:08 W", "",
                 "AC A", "AN AUCKLAND OCA/A", "AL 24500 MSL", "AH 60000 MSL",
                 "DP 59:59:59 S 163:00:00 E", "DP 59:59:59 S 174:00:00 E", "DP 63:44:18 S 179:59:59 W"]
        areas = self.nav.parse_airspace(lines)
        self.assertEqual(len(areas), 1)
        area = areas[0]
        self.assertEqual((area["class"], area["name"], area["upper"]), ("D", "WILLIAM P GWINN", "2500 MSL"))
        self.assertAlmostEqual(area["points"][0][0], 26.84639, places=4)
        self.assertAlmostEqual(area["points"][0][1], -80.28028, places=4)
        self.assertEqual(self.nav._openair_coord("59:59:59 S 163:00:00 E")[1], 163.0)

    def test_mora_rows_fill_thirty_cells_eastward_and_skip_unpublished(self):
        mora = self.nav.parse_mora(["I", "1150 Version", "+27 +060 " + " ".join(["000"] * 26) + " 311 310 050 UNK"])
        self.assertEqual(mora[(27, 86)], 311)   # Everest's cell: 31,100 ft, above the 29,032 ft summit
        self.assertEqual(mora[(27, 87)], 310)
        self.assertNotIn((27, 60), mora)        # 000 is not published
        self.assertNotIn((27, 89), mora)        # nor is a non-number
