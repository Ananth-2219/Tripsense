# TripSense Folium Trip Explorer

A separate Python dashboard for the existing TripSense React recorder and offline analysis workflow. It uses **Folium + OpenStreetMap**, embedded in **Streamlit with streamlit-folium**. No direct Leaflet.js or React-Leaflet application is introduced.

## Run on Windows / PowerShell

From the repository root, with Python 3.12+:

```powershell
python -m venv .venv-maps
.venv-maps\Scripts\python.exe -m pip install -r requirements-maps.lock.txt
.venv-maps\Scripts\python.exe -m streamlit run trip_visualization/app.py --server.address 127.0.0.1 --server.port 8501 --browser.gatherUsageStats false
```

Open **http://127.0.0.1:8501**. The local environment has already been installed for this implementation. The dashboard runs separately from `npm run dev`; the recorder and Supabase upload path are unchanged. `requirements-maps.txt` lists the three direct dependencies, and `requirements-maps.lock.txt` pins the tested complete environment.

Choose a validated analysis in the sidebar. Toggle speed estimation, replay, accuracy, and a stricter event matching tolerance. Use the map's layer control to switch route, speed, fixes, endpoints and event layers. Gray sensor episodes are initially hidden so they cannot be mistaken for maneuver labels. Download the selected map as HTML. Standalone maps require internet for OSM tiles and Folium's JavaScript/CSS dependencies.

The following existing analyzed trips are available in this workspace:

| Analysis | UUID | Current maneuver labels | Existing combined sensor episodes |
|---|---|---:|---:|
| Target | `24c3661c-2311-4063-93e0-75dd1fc9030c` | 0 | 61 |
| Harsh (supplied trip condition) | `130d7a06-939f-4fef-8000-141389113923` | 0 | 18 |
| Normal (supplied trip condition) | `d566e369-1f03-4fff-910a-b0671819f4d2` | 0 | 59 |

The fourth database trip is not included: GPS presence alone is never considered analysis completion.

## Eligibility and source data

`data.discover_trips()` scans `analysis/*/results.json` and requires:

- A trip summary with a valid UUID, matching raw-export SHA256 and matching reading-type counts.
- `verification.json` proving success, supporting the two existing formats: a `passed: true` verification with complete ordinal validation, or the historical verified row/count inventory.
- `validation_and_sensitivity.json` with no invalid records and passing database numeric-field checksum differences.
- The matching raw JSON export in that analysis directory.

Missing, failed, stale, malformed or duplicate analysis candidates are excluded and reported. Analysis directories are already ignored by the repository; a fresh checkout must have the actual prior analysis artifacts copied into `analysis/` before any trip can be selected. Set `TRIPSENSE_ANALYSIS_DIR` to use another local analysis root.

The existing `supabase_trips_readonly` MCP connection was used during implementation to inspect `public.trips` and recheck all three exports against current row metadata, counts and every numeric-field sum. `public.trips` currently stores raw JSON readings and nullable metadata, with no separate feature/label/status columns. Local exports matched. No database data or schema was modified.

The dashboard reads **verified local Supabase exports**, not a live database subscription. It does not obtain database credentials, use the app's upload connection, or claim that the MCP server is connected to the Streamlit Python process. Its source caption shows the last imported MCP verification time. Missing freshness metadata does not manufacture a fresh verification.

### Refresh read-only MCP verification

1. Print a query scoped to artifact-verified trip IDs:

   ```powershell
   python -m trip_visualization.mcp
   ```

2. Run that SELECT using the existing `supabase_trips_readonly.execute_sql` tool in the agent environment. Save its returned JSON (MCP response envelope or row array) to a local file, e.g. `.trip_maps/mcp_verification_response.json`.
3. Validate the analyzed exports and record source freshness:

   ```powershell
   python -m trip_visualization.mcp --response .trip_maps/mcp_verification_response.json
   ```

This validates all currently eligible exports before replacing the visualization's own `.trip_maps/source_manifest.json`. A database mismatch fails the import: re-export and re-analyze separately rather than displaying old analysis as current. The helper treats MCP results only as JSON data and issues no database writes; it prints a SELECT for the existing tool rather than opening another database connection. Prior analysis files are never rewritten.

## Speed, route and data quality

Valid, finite latitude/longitude and Unix-millisecond timestamps are sorted chronologically. Exact equivalent fixes are deduplicated for display. Conflicting fixes at the same timestamp are excluded and prevent connecting across that time. Raw exports remain unchanged. Start/end markers identify the **first/last observed fix**, which may differ from the stored session boundary.

Recorded `speed`, when present, follows the browser Geolocation API's **m/s** units and is converted to **km/h**. The existing three trips contain no recorded speed or GPS accuracy, so their displayed speeds are explicitly **GPS estimates**. With estimation disabled these trips show gray speed-unavailable segments and unavailable speed summaries; the route remains visible.

Estimates use the existing analysis' haversine geometry: observed endpoint chord distance / actual elapsed time. Edges are rejected if:

- Elapsed time is below **0.5s** or above **5s**.
- A recorded accuracy radius exceeds **50m**.
- Implied chord speed exceeds **160 km/h**.
- They cross a conflicting-timestamp fix.

These configurable `MapOptions` defaults are visualization-quality screens, not calibrated safety limits, speed limits, or a new harsh-event detector. Unknown accuracy remains unknown. If recorded accuracy exists but displacement is no larger than the sum of endpoint accuracy radii, a speed estimate is withheld. Valid recorded speed is preferred; a rejected recorded speed can only fall back to a separately screened, explicitly marked GPS estimate.

Speed bands: **blue 0–20**, **teal 20–40**, **green 40–60**, **amber 60–80**, **magenta 80–160 km/h**; **gray unavailable**. The map includes a visible legend and segment tooltips/popups with times and source. No route or replay line crosses a rejected edge or a long gap. The optional observed-fix layer retains valid coordinate observations, including isolated fixes without a reliable speed.

Distance is the sum of accepted observed chords, **not full trip travel distance**. Average speed is time-weighted over accepted segments with available speed; maximum is the largest screened recorded/estimated value. Both exclude gaps. They remain diagnostics, not validated vehicle speeds.

For example, the target's estimated observed-chord distance is approximately **7.902 km**, average **37.97 km/h**, and maximum **130.33 km/h** under these screens. This differs deliberately from the prior unscreened 15.550km polyline sum, which included long unobserved chords. The maximum remains an unvalidated GPS estimate. Motion coverage is only **45.137%**; missing intervals cannot establish safe riding or an absence of events. The original 1ms/13ms apparent-speed artifacts and long gaps appear in the rejected-edge quality table rather than influencing the speed coloring/statistics.

Recorded `accuracy` in meters can be shown as an optional circle layer, available through LayerControl when accuracy values exist. No accuracy radii are fabricated for current trips.

## Event sources, labels and alignment

The prior analysis pipeline is inspected and reused as an artifact source: magnitudes, scalar-magnitude jerk, fixed empirical P95 cutoffs, contiguous midpoint-supported episodes and contextual GPS. It is descriptive and does **not** contain a validated maneuver classifier.

- Prefer `event_labels.csv` with `definition=contiguous`. Include combined sensor episodes and any explicitly named maneuver labels. Do not double-count alternate merged definitions.
- For older analyses without that CSV, read only existing `events_p95.combined.episodes` from `results.json`. Do not run event detection again.
- Exact supplied maneuver labels `harsh_braking`, `harsh_acceleration`, and `sharp_turn` receive red, orange, and purple markers respectively. A trip named Harsh does not create a maneuver. High unsigned acceleration is not harsh acceleration; gyro magnitude is not a sharp turn; scalar magnitude jerk is not braking.
- Existing sensor episodes receive a separate gray layer and keep the physical cause **uncertain**. All three current maps correctly have **zero named maneuver markers**. They show actual sensor episodes on demand.
- Severity and confidence are taken from existing artifacts. If unavailable, popups say “Not assigned”/“Not supplied”; no severity or numerical probability is invented. Popups contain UTC event/fix timestamps, speed and its source, alignment error, GPS accuracy if present, and available peak acceleration/jerk/gyro and evidence fields.
- A GPS-only analyzed trip can display the route and speeds. Sensor episodes and explicit motion-sensor-confirmed labels require valid relevant motion axes within **0.5s** of the supplied event time; samples elsewhere in a trip do not establish local evidence. Labels without that support are flagged rather than mapped as confirmed. This check also covers partial motion gaps. No new behavior labels are ever derived from GPS speed changes.

An event's supplied absolute timestamp is used first. Otherwise, the artifact's supplied `peak_elapsed`, or `start` elapsed seconds, is added to the stored trip start. A midpoint-supported episode start is a reported analytical boundary, not the precise physical maneuver onset. There is no inferred event time or peak-time invention.

The event is assigned to the **nearest observed fix that touches a screened GPS edge**, within **1.0 second maximum** by default (sidebar can reduce it). Ties choose the earlier fix. No coordinate interpolation/extrapolation is used. An event without a supported fix inside tolerance is listed under **Events without a reliable location**, with a reason and no marker. When accuracy is absent, the temporal match does not imply meter-level spatial certainty.

## Replay

Folium's `TimestampedGeoJson` plugin receives **observed point features only**, with their actual UTC timestamps, a one-second slider step and one-second display duration. Auto-play is off. It does not interpolate a moving vehicle or draw gap-spanning paths; no stale marker is carried through a long recording gap. Playback can be disabled in the sidebar. At least two supported timestamped observations are required.

## Reusable generator and example

Generate the target map from its already completed analysis:

```powershell
.venv-maps\Scripts\python.exe -m trip_visualization.maps --trip 24c3661c-2311-4063-93e0-75dd1fc9030c
```

This prints the generated `.trip_maps/html/<uuid>-<content-hash>.html` path. All three example maps have been generated in this workspace. The cache key includes the prepared data, labels/summary, map options, and generator/data-module source. Identical maps are reused without overwriting them; changed inputs/options produce another file. Generated maps contain location data and remain in the existing local workspace; they are ignored by Git.

Python callers can use:

```python
from pathlib import Path
from trip_visualization.data import discover_trips, read_json, load_events, prepare_trip
from trip_visualization.maps import build_map, save_map

trips, excluded = discover_trips(Path('analysis'))
record = next(t for t in trips if t.id == '24c3661c-2311-4063-93e0-75dd1fc9030c')
trip = prepare_trip(read_json(record.raw_path), record.summary, load_events(record))
map_object = build_map(trip, include_replay=True, show_accuracy=False)
html_path = save_map(trip, Path('.trip_maps/html'))
```

## Tests

```powershell
.venv-maps\Scripts\python.exe -m unittest discover -s tests
npm test
npm run lint
npm run build
```

Tests cover artifact eligibility, source hash changes/failure, GPS order/deduplication/conflicts/gaps, accuracy/jump screening, speed units and missing speed, event tolerance/timezones, missing motion, no relabeling of sensor peaks, popup escaping, Folium layers/replay/cache, and Streamlit selection/options/empty state. Synthetic observations exist only in tests and are never demonstration data.

References: [Folium TimestampedGeoJson](https://python-visualization.github.io/folium/latest/user_guide/plugins/timestamped_geojson.html), [streamlit-folium](https://github.com/randyzwitch/streamlit-folium), [Streamlit AppTest](https://docs.streamlit.io/develop/api-reference/app-testing/st.testing.v1.apptest).
