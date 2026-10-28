# Experimental live ride scoring: baseline v1 and contextual v3

End Ride now saves one immutable recording through FastAPI, scores its received
readings in memory and persists a provisional baseline in `trip_scores`. Recording,
sensor sampling, the 1,800-second cap and the optional questionnaire are preserved.
This is a rule-based phone-motion descriptor, not a driver-skill or safety rating.
Phase 3 adds optional accepted-feedback finalization. Its complete setup and recovery
contract are in [live contextual scoring](live-contextual-scoring.md). No evaluations
or ML run in either phase.

## Current deployment state

Phase 2 is connected to live Supabase according to the user's successful test.
Phase 3 SELECT inspection confirms the baseline and feedback RPCs, original keys,
RLS and revoked browser score grants. No live writes, schema changes or deployment
were performed by this Phase 3 task. The contextual RPC migration is new and requires
manual review/application. Restart the existing backend afterward; retain its current
credentials. Missing configuration fails closed and preserves local recovery state.

## Start locally (PowerShell, Python 3.12 and Node 22.12+)

From `C:\Tripsense`:

```powershell
python -m venv .venv-scoring
.venv-scoring\Scripts\python.exe -m pip install -r requirements-scoring.lock.txt
npm ci
```

The runtime lock pins direct and transitive dependencies. Map/Streamlit dependencies
are not needed by the service; the separate test lock adds them for existing tests.

In backend terminal A, set values privately in your shell (placeholders below):

```powershell
$env:SCORING_SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co'
$env:SCORING_SUPABASE_SERVICE_KEY = 'BACKEND-ONLY-SERVICE-ROLE-KEY'
npm run dev:scoring
```

This runs one Uvicorn process on `127.0.0.1:8000`, without access logging. Environment
variables must exist before startup; restart after changing them. The API does not
load the frontend `.env`. Never use a `VITE_` variable for privileged credentials.
Do not set `SCORING_ALLOW_LOCAL_HTTP` for Supabase; that opt-in exists for local tests.
Without credentials, health is available with `configured: false`; writes fail closed.

In frontend terminal B, retain only the public configuration in ignored `.env`:

```dotenv
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=YOUR-PUBLIC-KEY
```

```powershell
npm run dev
Invoke-RestMethod http://127.0.0.1:8000/api/health
```

Vite proxies `/api` to `127.0.0.1:8000`. `SCORING_API_PROXY_TARGET` can change the
development target. No CORS wildcard or credential in browser code is needed.
On macOS/Linux invoke `.venv-scoring/bin/python -m uvicorn scoring_service.app:app
--host 127.0.0.1 --port 8000 --no-access-log` instead of the Windows npm shortcut.

## Reviewed migration: manual application only

For a fresh installation, review and run the **complete transaction** in
[`20261027162918_live_baseline_scoring.sql`](../supabase/migrations/20261027162918_live_baseline_scoring.sql)
once using the intended project's SQL Editor as owner, or your reviewed migration
process. It is already installed in the inspected project: do not reapply it. Inspect existing function names first. Do not blindly apply all pending
migrations to an already-configured project. The feedback migration is already live.

This migration requires the verified existing `trips` and `trip_scores` schema and
unique `(trip_id, policy_version)` constraint. It adds five functions, not tables or
public policies. `_live_score_authorize` has no client execution grant. Four RPCs
have EXECUTE only for `service_role`, with SECURITY DEFINER and empty search paths.
Existing tables, RLS, browser grants, historical data and scores are unchanged.
Keep function ownership with the trusted migration owner.

Verify with SELECT-only SQL (use `pg_proc`; `information_schema.routines` can hide
functions the inspection role cannot execute):

```sql
SELECT p.proname, pg_get_function_identity_arguments(p.oid), p.prosecdef,
       p.proconfig, has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
       has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
       has_function_privilege('service_role',p.oid,'EXECUTE') AS service_role
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND
 (p.proname LIKE 'live_baseline_%' OR p.proname='_live_score_authorize');

SELECT c.relname,c.relrowsecurity FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN
 ('trips','trip_feedback','trip_scores','score_evaluations');

SELECT grantee,privilege_type FROM information_schema.role_table_grants
WHERE table_schema='public' AND table_name='trip_scores'
AND grantee IN ('anon','authenticated');

SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid='public.trip_scores'::regclass;
```

Expected: five functions; four service-executable RPCs; no anon/authenticated
execution; all four RLS flags true; no browser score grants; original unique/FK/check
constraints retained. Perform a private test ride only after these checks. Verify
one trip and one baseline-policy score, provisional status, null contextual/final
scores, preserved readings, feature/input hashes and component scores. Refresh and
Retry must not add rows. Never use the read-only MCP to attempt writes.

## Service and authorization

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Configuration presence and canonical policy identifier |
| `POST /api/trips` | Validate, durably ingest once, schedule bounded analysis |
| `GET /api/trips/{id}/score` | Authorized compact result/status, no raw readings |
| `POST /api/trips/{id}/score/retry` | Authorized retry/recovery without browser raw re-upload |
| `POST /api/trips/{id}/score/finalize` | Accepted-feedback finalization, without browser answers/readings |

All trip endpoints require `Authorization: Bearer <64-lowercase-hex-trip-token>`.
The token is generated once with the UUID and verified against the stored SHA-256
hash. The UUID alone never authorizes lookup or retry. Responses use `no-store`.
The browser sends `X-Trip-Input-Fingerprint`: SHA-256 of its exact JSON upload body.
Returning an existing result requires token authorization and, when supplied,
matching input fingerprint. Repeated uploads also compare the immutable persisted
recording before returning success; altered input receives 409. JSON serialization
must remain stable on raw-upload retries. The backend hashes the body itself.

Trip insert and score placeholder share a short transaction; a durable transaction
must complete before `tripSaved: true`. A score failure cannot roll back a saved
ride. Unique trip IDs and `(trip_id, policy_version)` prevent duplicates. Database
row locks and 120-second processing leases allow one effective claim; attempts are
capped at three. Expired last attempts return terminal failure rather than endless
processing. Every finish checks token, fingerprint and lease, and refuses final
rows. There is no provisional overwrite of a finalized result.

The service limits each request to 8 MiB, 30,000 combined readings and 1,800 seconds;
metadata to 16 KiB; four in-flight HTTP requests; two active workers with no unbounded
job queue; and 90 trip requests per minute per IP. Samples require supported types,
finite numbers, valid timestamp ranges and matching counts; missing motion axes
remain missing, never zero-filled. Empty/insufficient data is saved with an unavailable
score, never a fabricated perfect result. Overload returns a retryable error.
Use one service process for local testing. Multiple processes would need reviewed
global resource limits; database leases already protect duplicate calculation.

The backend alone holds the service-role key. There is no public raw-reading API,
token in URLs/database or route logging. RPC errors are sanitized; payloads and raw
coordinates are not logged. Capability tokens are bearer secrets: browser storage
loss has no account recovery. Device/origin access and XSS remain relevant; no new
Auth/RLS model is introduced. Public deployment requires a separate operational
review including TLS, proxy trust, authentication threat model and global quotas.

## Reused mathematics and audit evidence

`trip_scoring/extraction.py` uses the validated NumPy/pandas magnitude, stable time
ordering, distribution metrics, jerk valid-step window (0.05–0.5 seconds) and
observed midpoint support. It never bridges missing/invalid motion. GPS diagnostics
screen unsupported edges without creating a route or interpolating coordinates.
`trip_scoring/baseline.py` packages the frozen pure scoring helpers and verifies the
byte-identical policy SHA-256. No JavaScript scoring implementation exists.

Baseline ID: `experimental-ride-smoothness/1.0.0`.
References A/J/R: 7.035623639735144 / 45.052178163487305 / 66.92398673121619.
Component = `100 / (1 + mean/reference)`; baseline = `0.35*A + 0.40*J + 0.25*R`.
The contextual ID is `experimental-contextual-scoring/3.0.0`, not the database's
`experimental_v3` default. Phase 3 records it in nested audit metadata on the existing
baseline-policy row, preserving the row's `policy_version` and baseline inputs.

Stored baseline rows include all requested component scores, frozen baseline weights,
`score_status=provisional`, quality/coverage/gap warnings, compact distributions,
input/feature fingerprint, extraction and policy hashes, attempts and `computed_at`.
No `score_evaluations` rows are written. Optional Phase 3 results occupy separate
contextual/final columns and never replace baseline measurements. Historical bus
regression retains its 117.872-second initial absence and GPS warnings.

Original research modules and policies are untouched. 604 preexisting artifact
hashes are checked in ignored `analysis/live_baseline_phase2/historical_hashes.json`.
Authorized application changes have original bytes archived under `before_application/`
and explicit reviewed new hashes in `tests/fixtures/phase2_application_hashes.json`;
legacy preservation tests still validate those originals and every unchanged path.
Historical manifests and policies were not rewritten or skipped.

## Frontend lifecycle and retention

End Ride writes its snapshot, UUID and token to IndexedDB before upload. Upload
success removes only raw readings. Actual pending/processing states show “Analyzing
ride”; ready results show the provisional score, components, coverage and expandable
quality breakdown. Invalid data shows the actual limitation. Failure keeps the ride
and a metadata-only Retry analysis action. Polling is bounded to 30 checks, pauses
during recording and offers a manual Check analysis afterward.

Skip finishes feedback and retains a provisional baseline. Submit finishes feedback
and requests contextual finalization; the capability remains until that result is
terminal. Finalization failure keeps accepted feedback, baseline and token for retry.
Ready/unavailable/exhausted-failure results are archived without token,
raw data or questionnaire comments, capped at 20. The remaining token/draft is removed
after a compact result is durably archived and the lifecycle completes. Reload restores pending work and compact results.
Storage failure retains an in-memory copy and warns to keep the page open. Clearing
storage or changing origin destroys this browser's recovery capability.

## Phone testing without public deployment

Run both services on the desktop. Use a private LAN DNS name resolving to the
desktop and a trusted HTTPS reverse proxy on that desktop. Install/trust its local
CA on the phone. Proxy `/api/*` to `127.0.0.1:8000` and all frontend/WebSocket traffic
to `127.0.0.1:5173` under the **same HTTPS origin**, forwarding a Host accepted by
Vite. Keep the Python port bound to loopback; firewall the LAN proxy to trusted
devices. A trusted private VPN HTTPS origin is another option; do not create a
public tunnel for this phase. Backend Supabase must remain reachable from desktop.

Visit that HTTPS origin on the phone. Its `localhost` refers to the phone, not the
desktop. Plain LAN HTTP does not provide the secure context required for mobile
sensor permissions. On iOS, allow motion from the Start gesture; allow location.
Test a short ride, End, upload, analyzing, results, Skip/Submit, refresh and offline
retry on the **same origin**. Browser emulation does not verify physical sensors,
permission prompts, OS background suspension or radio-network reliability.
`vite preview` has no configured scoring API proxy; use this documented dev setup.

## Verification commands and measured performance

```powershell
.venv-scoring\Scripts\python.exe -m pip install -r requirements-scoring-test.lock.txt
.venv-scoring\Scripts\python.exe -m pip check
.venv-scoring\Scripts\python.exe -m unittest discover -s tests -v
npm test
npm run lint
npm run build
npm run test:browser
npm run test:scoring:browser
npm run benchmark:contextual
.venv-scoring\Scripts\python.exe scripts/validate-contextual-phase3.py
```

Python historical tests and benchmarks require the already-verified local
`analysis/<trip-id>/<trip-id>.json` fixtures; raw private trips are not added to Git.
Browser tests use ephemeral PGlite with the real SQL migration, an isolated browser
profile, fake local credentials and no live database writes. The scoring browser
test starts real FastAPI (8001) and Vite (4175); feedback uses 4174 and a mocked scoring
boundary. Install Chromium with `npx playwright install chromium`, or use installed
Chrome/Edge on Windows / `TRIPSENSE_TEST_BROWSER`. Ports must be free.

Measured on this Windows/Python 3.12 desktop, median of three fresh local inserts:

| Fixture | Readings | Payload bytes | Upload acceptance | Extraction | Baseline | Score persistence |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 363.468 s | 3,725 | 544,900 | 69.11 ms | 25.95 ms | 0.44 ms | 5.30 ms |
| 1,800 s | 18,929 | 2,812,300 | 336.98 ms | 85.40 ms | 0.54 ms | 5.93 ms |

Upload uses FastAPI's in-process HTTP test client plus actual HTTP RPCs to local
PostgreSQL. It includes parsing, validation and durable trip/placeholder insert;
it excludes phone upload and live Supabase network latency. Extraction includes
quality diagnostics. Score persistence includes local HTTP/JSON/SQL. Small local
benchmarks are not production throughput claims. Full payload serialization, JSONB
ingest and real uplink latency are likely larger costs than frozen baseline math.
Raw metrics are in `analysis/live_baseline_phase2/benchmarks.json`; screenshots and
Phase 2 browser evidence remains in `.trip_maps/live-scoring/`; new Phase 3 evidence
uses `.trip_maps/live-contextual/`, preserving historical images.

## Remaining Phase 4 work

Contextual v3 integration is implemented separately after feedback, with distinct
baseline/contextual/final outputs and guarded finalization. Design and authorize
`score_evaluations` separately. Confirm physical-phone behavior and live authorized
finalization after manual setup. Review operational deployment, durable
scheduling beyond the current local worker/retry model, monitoring and private-data
retention. No machine-learning implementation is part of this plan.
