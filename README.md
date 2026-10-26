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
- `src/lib/upload.js` — insert-only trip upload, stable UUIDs and verified retry recovery.
- `src/components/TripQuestionnaire.jsx` — accessible post-trip rider questionnaire.
- `src/lib/followUps.js` — pending-upload and questionnaire lifecycle with IndexedDB persistence.
- `supabase/migrations/` — SQL to apply separately; see [questionnaire setup](docs/post-trip-feedback.md).
- `vite.config.js` — React, Tailwind, and PWA plugins and manifest.
- `public/` — app icons, including 192px, 512px, and maskable PNGs.

Tailwind uses its Vite plugin and the import in `src/index.css`.
The PWA uses `registerType: 'autoUpdate'` and explicit registration in
`src/main.jsx`. Its generated service worker precaches the application shell
and automatically activates updates.

The Recorder requests motion and location permission before starting, buffers
readings in memory, and stops automatically at 30 minutes. On Stop it retains
the completed recording locally and uploads it to Supabase. Failed saves can be
retried from the Recorder, including after reloading on the same browser when
device storage is available. Screen wake lock is best effort on supported devices.

After a confirmed save, an optional seven-question rider questionnaire opens.
Choose **Submit later** to retain a draft on this browser, or **Skip questionnaire**
to remove the local draft while keeping the saved trip. Feedback remains separate
subjective metadata; no driving score, sensor thresholds or map labels change.

**Database setup is required before feedback can be saved.** The migration was
not applied through the read-only MCP connection. Follow
[post-trip feedback setup and permissions](docs/post-trip-feedback.md).
Configure `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in `.env` for the existing
project. Only the public/publishable key belongs in this frontend.

Tests cover sensor lifecycle and Recorder UI behavior with mocked browser APIs.
Actual permission prompts and sensors should also be checked on a phone over HTTPS.

`npm test` also runs questionnaire, IndexedDB recovery, upload association and
local PostgreSQL migration/access-control tests. `npm run test:browser` runs
isolated Chrome/Chromium against a local PostgreSQL engine with all remote APIs
intercepted; it never writes to live Supabase. See the questionnaire guide for
browser prerequisites, limits and test coverage.

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


