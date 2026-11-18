# Stratos

**Every flight, properly recorded.** Stratos is a free flight tracker and logbook for X-Plane 12 and Microsoft Flight Simulator 2020/2024.

Fly as usual. Stratos follows you on a live map and saves each flight to a career logbook, with replay and landing analysis. It also includes a route planner, charts, weather and a phone dashboard.

**Website:** https://www.stratos-tracker.com · **Download:** [latest release](../../releases/latest)

## What you get

- **Live map:** your aircraft, the flight plan, real-world traffic, airports and navaids.
- **Logbook:** every flight recorded automatically, with hours, routes, records and milestones.
- **Replay and landings:** scrub through any flight and see your touchdown rate and where you landed.
- **Planning:** a route planner with SimBrief import, SID/STAR procedures and route weather.
- **Stratos EFB:** a tablet-style flight bag with briefing, charts (US), weather, performance and fuel.
- **Phone mode:** on the same Wi-Fi, open `stratos.local` on your phone and the live flight is there, no app store needed.

Everything is free. There is no paid tier.

## Simulator support

| Simulator | Status |
| --- | --- |
| MSFS 2020/2024 | Tested in a real flight |
| X-Plane 12 | Implemented, not yet flown live. Reports welcome |

## Run it

- **Windows:** install `Stratos-Setup.exe` from the latest release. The desktop app starts the simulator bridge for you.
- **From source:** `npm ci`, then `npm run dev` (web app on http://127.0.0.1:8123) or `npm start` (desktop app). Bridge only: `python3 stratos_bridge.py`.
- **Tests:** `npm test`, `npm run test:py`, `npm run test:integration`.

## More

- [FEATURES.md](FEATURES.md): the full feature reference and known limitations
- [README-DEPLOY.md](README-DEPLOY.md): building and deploying
- [TEST_REPORT.md](TEST_REPORT.md): what has and hasn't been tested
- [SOURCES_AND_LICENSING.md](SOURCES_AND_LICENSING.md): data sources

Not for real-world navigation. MIT licensed; see [LICENSE](LICENSE).
