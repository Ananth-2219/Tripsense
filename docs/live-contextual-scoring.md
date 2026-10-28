# Phase 3: experimental live contextual scoring

After the existing questionnaire is accepted, the browser requests a final score
from FastAPI. The service retrieves accepted feedback and full-precision saved
baseline components, runs frozen experimental v3 and atomically finalizes the same
`trip_scores` row. It never downloads raw readings or reruns extraction. Skip leaves
the baseline provisional. No ML, evaluations or public deployment are implemented.

## Versioning and preserved mathematics

- Row policy stays `experimental-ride-smoothness/1.0.0`; baseline scores, A/J/R,
  weights, feature summaries, extraction/input hashes and quality details stay intact.
- Contextual policy is `experimental-contextual-scoring/3.0.0` in
  `context_details.contextual_v3`, including exact policy SHA-256, implementation hash,
  accepted feedback ID, source fingerprint, answer/fallback audits and calculations.
- Frozen v3 JSON is byte-identical to `analysis/contextual_scoring_v3/policy.json`.
  Mathematical functions were copied verbatim. Only historical two-trip execution
  admission became live UUID admission, documented separately in
  `trip_scoring/policies/contextual_v3_provenance.json`. The original offline entry
  point, historical allowlist, policy, reports and coefficients remain unchanged.
- Applicable factors multiply component-wise, then clip once to [0.70,1.30], apply
  frozen 0.35/0.40/0.25 weights and normalize. Unchanged A/J/R determine the contextual
  sensor score. Final is clamp(0.90 × sensor + 0.10 × experience − incident penalty,
  0,100). No intermediate rounding or new weights/aliases are introduced.
- The current form's `mostly_smooth`, `frequent_movement`, `picked_up`, `multiple`,
  `stop_go`, and other unsupported policy values keep their **neutral, audited
  fallback**. They are not guessed to mean `smooth`, `significant_movement`, specific
  maneuvers or `heavy`. Field-name mapping remains in the existing feedback RPC;
  stored answer values are unchanged. Missing/unsure experience uses the contextual
  sensor score. This limitation follows the frozen policy deliberately.

Baseline describes observed phone motion. Contextual sensor changes relative
component weighting. Final additionally incorporates subjective experience and the
frozen incident-experience penalty. These are distinct outputs, not validated safety
or skill measures. Coefficients are user-specified experimental choices, not derived
from validated research. Incident reports do not establish driver fault or a timed
sensor event. Phone placement, orientation, gravity fallback, road/vehicle conditions,
GPS uncertainty and missing motion intervals remain limitations; quality warnings
are preserved without applying new numerical confidence adjustments.

## Manual migration and unchanged environment

Phase 2 baseline/feedback functions were verified live using SELECT only. Do not
reapply their migrations or change existing RLS/grants. This task applies no live SQL.

1. Review the full transaction in
   [`20261027180012_live_contextual_scoring.sql`](../supabase/migrations/20261027180012_live_contextual_scoring.sql).
2. Inspect the intended project's existing schema/function names, then apply that
   migration once as the trusted database owner using the SQL Editor or your reviewed
   migration process. It adds two service-only RPCs and an internal fingerprint
   helper; it adds no table/column, broad grant or browser policy.
3. Verify the permissions/functions below, then restart the existing Python service.
   Existing running desktop services were left untouched by this task.

```sql
SELECT p.proname,pg_get_function_identity_arguments(p.oid),p.prosecdef,p.proconfig,
 has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
 has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND (p.proname LIKE 'live_contextual_%'
 OR p.proname='_live_contextual_fingerprint');

SELECT c.relname,c.relrowsecurity FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN ('trips','trip_feedback','trip_scores');

SELECT grantee,privilege_type FROM information_schema.role_table_grants
WHERE table_schema='public' AND table_name='trip_scores'
 AND grantee IN ('anon','authenticated');
```

Expected: two contextual SECURITY DEFINER RPCs with empty search paths and service
EXECUTE only; the internal fingerprint helper has no browser/service EXECUTE grant.
RLS remains true and browser score grants remain absent. Trusted function ownership
is required; no Auth or RLS model changes are made.

Keep backend-only `SCORING_SUPABASE_URL` and `SCORING_SUPABASE_SERVICE_KEY` in the
backend environment. Frontend `.env` still contains only `SUPABASE_URL` and
`SUPABASE_PUBLISHABLE_KEY`. No new environment variables, Python dependencies or
frontend secret credentials are required. Never prefix a backend key with `VITE_`.

## Endpoint and database contract

`POST /api/trips/{id}/score/finalize` requires the existing 64-hex capability in the
Authorization Bearer header, with optional expected `X-Trip-Input-Fingerprint`.
It accepts **no request body**, questionnaire answers or raw readings. UUID alone
never grants access. Existing upload, score GET and baseline retry endpoints remain.

`live_contextual_get` authorizes and retrieves the saved baseline plus the single
accepted feedback record for that trip, without readings or comments. The source
fingerprint binds baseline values, weights, quality/features, original audit and
the exact accepted feedback record. Timestamp serialization uses fixed UTC across
database sessions. It is not a browser-supplied claim.

`live_contextual_finish` reauthorizes, locks the score and accepted feedback rows,
rechecks the source fingerprint and feedback-to-trip association, validates output
bounds/weights/policy hash, and updates only contextual fields, feedback ID, final
status, nested contextual audit and `computed_at`. The previous baseline computation
time is retained as `contextual_v3.baseline_computed_at`. No long calculation or
network operation runs inside the transaction. All baseline fields and quality JSON
remain unchanged. A changed source returns a conflict without writing.

Duplicates/concurrent calculations converge on one immutable final row. A finalized
result is returned only for the same accepted source and policy. Existing Phase 2
lease/finish guards prevent a late provisional write. Unique `(trip_id,policy_version)`
is retained; no extra contextual-policy score row or evaluation row is created.

Calculation runs in the existing HTTP threadpool path, bounded to two contextual
operations and four total in-flight HTTP requests, with the existing per-IP limit.
It is small enough to finish within the request; no second background queue or raw
processing worker is needed. Network timeout/ambiguous responses are safe to retry.
If the migration is missing, baseline remains usable and finalization fails closed.

## Lifecycle and results

Submission intent is saved locally before the feedback RPC. Before another submit,
the accepted state is checked; the first accepted record remains authoritative.
An ambiguous accepted response is reconciled without overwriting/resubmitting it.
If the browser closes at that point, startup checks accepted state and continues.

Accepted feedback hides the questionnaire and requests finalization. If baseline
is processing, the service reports waiting; bounded baseline polling triggers the
finalization when ready. Failure keeps feedback, baseline and token, with **Retry
final score**. Retry first checks for an already-final result, then uses the metadata-
only endpoint. A refresh retries accepted unfinished work once; it does not loop
failed requests indefinitely. Duplicate submission and finalization locks are separate.
An unavailable/exhausted baseline makes the final unavailable too; feedback stays
saved, status stays provisional and no contextual/final numbers are fabricated.

Skip never requests finalization. Its acknowledgement waits for persistence. Raw
snapshots still leave IndexedDB only after durable upload. Capabilities leave only
after the scoring/feedback lifecycle finishes **and** a compact result is durably
archived. Storage failure warns to keep the page open. Archives contain no raw data,
token or questionnaire comments; at most 20 results remain, and an old provisional
archive cannot replace a final one. Clearing device storage still has no recovery.
Historical Phase2 archives whose capability was already removed cannot be silently
finalized by UUID. They remain historical provisional results; retained pending
capabilities can recover, and new rides use the complete Phase3 lifecycle.

The final card shows final /100, original baseline, contextual sensor score, delta
and the answer categories used. The expandable breakdown shows components, baseline/
adjusted weights, experience component/contribution, incident penalty and quality
warnings. Form fields, values, optional comments, Skip and mobile styling are retained.

## Run and verify locally

Reuse the existing environment and start in separate terminals after the migration:

```powershell
npm run dev:scoring
npm run dev
```

For a fresh Python environment use the unchanged pinned runtime lock from
[baseline setup](live-baseline-scoring.md). Tests use the dedicated test lock:

```powershell
.venv-scoring\Scripts\python.exe -m pip install -r requirements-scoring-test.lock.txt
.venv-scoring\Scripts\python.exe -m unittest discover -s tests -v
npm test
npm run lint
npm run build
npm run test:browser
npm run test:contextual:browser
npm run benchmark:contextual
.venv-scoring\Scripts\python.exe scripts/validate-contextual-phase3.py
```

The contextual browser alias runs the extended existing scoring browser suite, not
a second duplicate suite. It starts isolated Vite4175/FastAPI8001/local PGlite with
fake credentials. Feedback tests use4174. All test writes are local. Test Chromium
must be installed or use Windows Chrome/Edge / `TRIPSENSE_TEST_BROWSER`. Historical
Python fixtures/benchmarks require the already-verified private local `analysis/`
files; they are not committed. New evidence goes under `.trip_maps/live-contextual/`
and `analysis/live_contextual_phase3/`; historical/Phase2 outputs remain untouched.
PGlite tests exercise SQL and logical interleavings; they do not simulate multi-host
production load. Physical-phone and authorized live-finalization checks remain manual.

On desktop, test End→baseline→feedback→final, refresh, Skip and offline retry. For
mobile, use the private same-origin HTTPS proxy/DNS and trusted certificate setup
in the baseline guide; phone localhost is not the desktop. Proxy `/api` to the desktop
backend and frontend/WebSockets to Vite. Retain the same origin/storage, permit
motion/location, record a short real ride and check its unchanged baseline plus final.
Do not expose the backend publicly. Browser emulation does not verify OS sensor
permissions, background suspension or real radio latency.

## Historical parity and local timings

Full precision is verified before display rounding:

| Fixture | Baseline | Contextual sensor | Final |
| --- | ---: | ---: | ---: |
| Learner | 80.30795859668785 | 79.86773526348567 | 76.8809617371371 |
| Third | 89.45285168835801 | 89.5104274804276 | 90.05938473238484 |
| Bus | 91.43690819817843 | 91.35615979176754 | 91.35615979176754 |

Median of three fresh local finalizations per fixture, Windows/Python3.12, actual
FastAPI test client and HTTP RPCs to ephemeral PGlite:

| Fixture | Feedback/source retrieval | Context calculation | Database update | Service end-to-end |
| --- | ---: | ---: | ---: | ---: |
| Learner | 3.40 ms | 1.25 ms | 5.65 ms | 9.31 ms |
| Third | 3.52 ms | 1.47 ms | 3.74 ms | 8.94 ms |
| Bus | 2.23 ms | 1.18 ms | 3.28 ms | 6.67 ms |

Stage medians need not add to the median total. These exclude live Supabase and
phone/network latency. HTTP dispatch medians were12.39/11.68/9.27ms. No raw download,
extraction, maps or reports run during finalization. Detailed measurements are in
`analysis/live_contextual_phase3/benchmarks.json`.

Preservation checks cover664 preexisting artifacts, original application archives,
unchanged Phase2 seal and frozen mathematical code/policies. A Windows launcher
adjustment already present at Phase3 start was retained separately: reversing only
that launcher string reproduces the exact Phase2-sealed package bytes, verified by
SHA-256. No historical seal is rewritten to hide that prior change.

Phase4 remains a separate evaluation workflow and authorization/design task for
`score_evaluations`, plus any validated study, physical-device validation and
operational deployment work. No evaluations or machine learning were added here.

Implementation references: [Supabase database functions](https://supabase.com/docs/guides/database/functions)
and [PostgreSQL row locking](https://www.postgresql.org/docs/current/explicit-locking.html).
