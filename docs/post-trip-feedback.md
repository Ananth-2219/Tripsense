# Post-trip rider questionnaire

The questionnaire appears on the Recorder after a manually stopped or automatically
stopped trip is confirmed saved. It has seven single-choice questions: phone
placement, phone movement/stability, road, traffic, perceived smoothness, sudden
braking/acceleration/turning, and unusual events. Every question includes **Not
sure**. Comments are optional (maximum 1,000 characters). Submitting requires all
seven choices; skipping does not. Unusual events requests the main event, with
comments available for additional context.

## Required database setup — not applied to live Supabase

The connected `supabase_trips_readonly` MCP was used only for SELECT inspection
and historical-data verification. It cannot apply this migration.

1. Open the intended project's Supabase SQL Editor as a database owner.
2. Inspect `public.trip_feedback` and the two function names below before applying.
   The final inspection found an existing nullable `public.trip_feedback` table
   with `phone_movement`, `road_condition`, `traffic_condition`,
   `perceived_smoothness`, `reported_maneuvers` and `unusual_event` columns,
   but no questionnaire RPCs or direct client policies. The migration reuses this
   table and its existing UUID association; it also supports a fresh installation.
   If the schema has since changed, reconcile the migration first.
3. Review and run the complete transaction in
   [`20261026000000_trip_feedback.sql`](../supabase/migrations/20261026000000_trip_feedback.sql)
   once. Alternatively, apply through your linked Supabase CLI migration workflow.
   This is a reviewed standalone additive migration; no CLI/project setup or
   database changes were performed by this task.
4. Ensure `public` is in the project's exposed Data API schemas so the two RPCs
   are discoverable. A schema-cache refresh may be necessary if the Data API
   reports a function-not-found error immediately after applying.
5. Keep the current `anon` INSERT grant/policy on `public.trips`. The app still
   does not need SELECT/UPDATE/DELETE permission on trips. Do not grant public
   access to `trip_feedback`, and do not introduce a service-role key in the app.
6. Deploy the frontend with the existing `SUPABASE_URL` and
   `SUPABASE_PUBLISHABLE_KEY` configuration. No Auth-provider, anonymous-sign-in,
   account or secret-key configuration is required.

The migration reuses `trip_feedback` (creating it only if absent), adds validation
constraints/access controls, and creates two narrowly granted functions.
It never alters the trips table, rewrites metadata, backfills feedback, changes
recordings, or updates analysis outputs. It never replaces an existing table.
If a named constraint or function already exists, reconcile it before applying.
The transaction
rolls back on failure. Removing it later should be a separate reviewed migration;
dropping the feedback table would discard collected answers.

Until the migration is applied, normal trip inserts still work with the existing
schema. A feedback save reports that questionnaire saving is unavailable and keeps
the draft. Token-verified recovery of an ambiguous trip-insert response also needs
the migration; do not interpret a duplicate UUID as proof of a successful save.

## Access control follows the existing account-free app

Inspection found no authentication UI or calls, zero Auth users, no trip-owner
column, and an insert-only `anon` trip policy. Adding an `auth.uid()` policy alone
would prevent this application from submitting feedback. Instead, each **new**
recording gets a client-generated UUID and a cryptographically random 256-bit
per-trip token. The token remains in this browser's IndexedDB. Only its SHA-256
hash is included in the new trip's existing JSONB `metadata.feedback_token_hash`.
The raw token is never placed in trip readings, URLs, logs or the feedback table.
This field is upload metadata, not user-editable Supabase Auth `user_metadata`.

- The existing `trip_feedback.id` UUID primary key is preserved. `trip_id` is a
  unique foreign key to `trips.id`, retaining the existing `ON DELETE CASCADE`.
  The app has no trip-deletion path. One trip can have at most one feedback row. Historical
  trips need no feedback row and no token; they remain valid and cannot be claimed
  retrospectively by supplying a UUID.
- All seven fields have non-null/allowed-value CHECK constraints, with comment
  length and non-null timestamp checks. They use `NOT VALID`, so old incomplete
  feedback remains unchanged while new inserts/updates are checked. No existing
  column is renamed and no historical answer is filled in. `submitted_at` is a
  server-generated `timestamptz`. RPC validation also rejects incomplete/extra/invalid
  answers before duplicate handling. Callers cannot supply a submission timestamp.
  No scoring or historical questionnaire version is fabricated.
- RLS is enabled with **no direct client policies** (default deny). All table
  privileges are revoked from `PUBLIC`, `anon` and `authenticated`. This is
  intentionally stricter than adding broad insert/select policies. There are no
  client UPDATE or DELETE paths.
- Only the existing `anon` role gets EXECUTE on
  `trip_feedback_state(uuid,text)` and
  `submit_trip_feedback(uuid,text,jsonb,text)`. Default PUBLIC execute permission
  is explicitly revoked. `authenticated` is not granted a new access path; future
  account-based authentication would need its own reviewed ownership design.
- The functions use `SECURITY DEFINER`, an empty `search_path`, fully qualified
  table references, fixed SQL and a token-hash check against the requested completed
  trip. Definer access is needed because the existing app cannot SELECT trip rows under RLS.
  Apply as a trusted database owner; do not grant an untrusted role function
  ownership or broad privileges. A UUID, public key, or another trip's token alone
  cannot read/write feedback.
- The state RPC returns only `missing`, `trip_saved` or `submitted`, and returns
  `missing` for wrong tokens and unclaimed historical trips. The submission RPC
  returns only the server timestamp. Neither exposes answers, raw trips or hashes.
- Submission uses `ON CONFLICT (trip_id) DO NOTHING`: the first accepted answers
  win. Repeated clicks, tabs and network retries cannot duplicate or overwrite the
  feedback. If an accepted response was lost, retry returns the original timestamp.

Anyone with the per-trip token can submit that trip's questionnaire, so treat
local device data as private. It grants no access to another trip. There is no
cross-device recovery, login or account recovery. Clearing browser storage,
changing origin, or using private browsing can remove deferred drafts and their
tokens. Shared-device users should submit or skip before clearing storage.

## Failure recovery and local retention

Completed recordings are saved to IndexedDB before attempting upload. The raw
snapshot, UUID and token stay together while upload is pending. Reload or return
to the Recorder to use **Retry saving trip**. There are no automatic background
uploads, and starting another trip does not overwrite a pending recording.
Recording before Stop still uses the existing in-memory sensor buffer.

The upload helper remains INSERT-only and supplies the same UUID on every retry.
It does not upsert or modify any existing trip. An uncertain network response or
unique-key conflict is considered saved only if the capability-checked state RPC
confirms that exact trip. Requests time out (30s for trip insert; 20s for RPCs).
Raw recordings are removed from the local queue after confirmed trip upload.

Questionnaire choices/comments persist as a local draft. **Submit later** hides
the form and leaves a **Finish questionnaire** entry on the Recorder. **Skip
questionnaire** removes only the local questionnaire/token. A successful feedback
submission removes the local questionnaire/token too. The saved trip remains in
Supabase for both actions. Network errors keep choices and comments, and submission
locks are separate from upload locks so an upload result cannot be confused with
a feedback result.

If IndexedDB is blocked or full, the current page keeps an in-memory retry copy
and shows **Keep this page open**. Persistence across refresh cannot be guaranteed
in that case; a best-effort unload warning is installed. Browser/OS termination
can still destroy in-memory data. Device storage is not a backup.

## Analysis and future score validation

Feedback is subjective rider metadata, not ground truth for a sensor event.
No score is implemented. The historical frozen magnitude/jerk/rotation thresholds,
event inventories, GPS screens and Folium workflow are untouched. Missing feedback
does not invalidate a trip or imply any answer. Future authorized offline analysis
may LEFT JOIN feedback by UUID, retaining every trip and explicitly reporting
missing answers. It must not silently remove spikes or relabel maneuvers based on
these responses. The current Python export/analysis pipeline is unchanged and
does not automatically fetch or consume this new table.

## Validation

Run from the repository root:

```sh
npm test
npm run lint
npm run build
npm run test:browser
```

The test command runs all Node sensor tests and all Vitest files (excluding the
same sensor file already run with Node). PGlite runs the SQL migration in a fresh
local PostgreSQL engine and tests role permissions, RLS, token/trip association,
validation, foreign keys, timestamps, immutable retries and historical-row
preservation. `fake-indexeddb` verifies durable state and reload recovery.

The browser test launches an isolated Chrome/Chromium profile and a temporary
Vite process with fake credentials, intercepts every remote request, and uses
the local PostgreSQL engine as its API fixture. It tests real Supabase client
serialization, form validation, upload failure/reload/retry, raw-snapshot identity,
deferred drafts, navigation, a lost feedback response, idempotent retry and Skip.
It checks no horizontal overflow and >=44px radio targets at 320, 390, 768, 1024
and 1440px. It never writes to live Supabase or uses a personal browser profile.

On Windows it locates installed Chrome/Edge; otherwise install test Chromium with
`npx playwright install chromium`, or set `TRIPSENSE_TEST_BROWSER` to a browser
executable. The script uses localhost port 4174 and fails if that port is occupied.
Screenshots and evidence go to ignored `.trip_maps/questionnaire/`.
This is browser emulation, not a physical Android sensor/permission test.

Existing Python/Folium checks remain:

```powershell
.venv-maps/Scripts/python.exe -m unittest discover -s tests
```

Production dependency audit reports zero vulnerabilities. The complete dependency
audit reports eight pre-existing development-tool advisories; unrelated dependency
upgrades were not applied. The production build succeeds with a >500kB chunk-size
advisory; no size limit was weakened.

Implementation references: [Postgres-backed Supabase functions](https://supabase.com/docs/guides/database/functions),
[Supabase RLS and grants](https://supabase.com/docs/guides/database/postgres/row-level-security),
and [PostgreSQL binary hash functions](https://www.postgresql.org/docs/current/functions-binarystring.html).
