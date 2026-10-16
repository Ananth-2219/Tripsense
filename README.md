# TripSense

Vite + React starter with React Router, Tailwind CSS, and an installable PWA.

## Development

Use Node.js 22.12+ (Node.js 24 recommended).

```sh
npm install
npm run dev
```

## Checks and production preview

```sh
npm run lint
npm test
npm run build
npm run preview
```

Open the localhost preview URL to test installation and offline support. The
service worker is generated for production builds; it is disabled during normal
development. Production hosting needs HTTPS and an SPA fallback to `index.html`
so direct visits to `/dashboard` work.

## Structure

- `src/pages/Recorder.jsx` — `/` route, permissions, trip controls, and live reading counts.
- `src/pages/Dashboard.jsx` — `/dashboard` route, dashboard placeholder.
- `src/lib/sensors.js` — sensor permissions, motion/location recording, and screen wake lock.
- `src/lib/upload.js` — reserved for upload integration.
- `vite.config.js` — React, Tailwind, and PWA plugins and manifest.
- `public/` — app icons, including 192px, 512px, and maskable PNGs.

Tailwind uses its Vite plugin and the import in `src/index.css`.
The PWA uses `registerType: 'autoUpdate'` and explicit registration in
`src/main.jsx`. Its generated service worker precaches the application shell
and automatically activates updates.

The Recorder requests motion and location permission before starting. It buffers
readings in memory, shows live counts, and logs totals on Stop. After stopping,
use **Download as JSON** to save the readings array as a formatted local JSON file.
Each new trip
resets the buffer; leaving the page stops recording. No data is uploaded or
persisted in Phase 1. Screen wake lock is best effort on supported devices.

Tests cover sensor lifecycle and Recorder UI behavior with mocked browser APIs.
Actual permission prompts and sensors should also be checked on a phone over HTTPS.

## GPS trip visualization (Python / Folium)

The separate [Trip Explorer](trip_visualization/README.md) displays only trips with
completed, validated local analysis artifacts. It uses Streamlit, Folium and
OpenStreetMap, with speed coloring, timestamp replay, existing event labels and
data-quality reporting. It reads Supabase MCP exports and never writes the database.

```powershell
python -m venv .venv-maps
.venv-maps\Scripts\python.exe -m pip install -r requirements-maps.lock.txt
.venv-maps\Scripts\python.exe -m streamlit run trip_visualization/app.py --server.address 127.0.0.1 --browser.gatherUsageStats false
```

See the Trip Explorer documentation for an already-analyzed-trip example,
read-only MCP verification, speed estimation and event-location matching rules.

Command for trip visualization .venv-maps\Scripts\python.exe -m streamlit run trip_visualization/app.py --server.address 127.0.0.1


