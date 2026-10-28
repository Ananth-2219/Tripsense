import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, afterAll, expect, test } from 'vitest'

let db
const id = '4bd29975-712a-41a4-a40a-c42f94d7c510'
const token = 'a'.repeat(64)
const fingerprint = 'b'.repeat(64)
const trip = {
  id,
  started_at: '2026-10-27T00:00:00Z',
  ended_at: '2026-10-27T00:00:01Z',
  duration_seconds: 1,
  motion_count: 0,
  location_count: 0,
  readings: [],
  metadata: null,
}

beforeAll(async () => {
  db = new PGlite()
  const files = [
    'tests/fixtures/scoring_schema.sql',
    'supabase/migrations/20261026000000_trip_feedback.sql',
    'supabase/migrations/20261027162918_live_baseline_scoring.sql',
    'supabase/migrations/20261027180012_live_contextual_scoring.sql',
    'supabase/migrations/20261028210000_independent_ride_evaluations.sql',
  ]
  for (const file of files) {
    await db.exec(await readFile(file, 'utf8'))
  }
  // Ingest test trip
  await call('live_baseline_ingest', [trip, token, fingerprint])
}, 30000)

afterAll(async () => {
  await db?.close()
})

async function call(name, args, role = 'service_role') {
  await db.exec(`SET ROLE ${role}`)
  try {
    return (await db.query(
      `SELECT public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) AS result`,
      args
    )).rows[0].result
  } finally {
    await db.exec('RESET ROLE')
  }
}

test('evaluation RPCs are denied for anon and authenticated roles', async () => {
  for (const role of ['anon', 'authenticated']) {
    await expect(call('live_evaluation_get', [id, token], role)).rejects.toThrow(/permission denied/i)
    await expect(call('live_evaluation_submit', [id, token, 80, false, null, false], role)).rejects.toThrow(/permission denied/i)
  }
  const rls = (await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.score_evaluations'::regclass")).rows[0].relrowsecurity
  expect(rls).toBe(true)
})

test('unauthorized token cannot get or submit evaluation', async () => {
  const badToken = 'c'.repeat(64)
  await expect(call('live_evaluation_get', [id, badToken])).rejects.toThrow(/access denied/i)
  await expect(call('live_evaluation_submit', [id, badToken, 75, false, null, false])).rejects.toThrow(/access denied/i)
})

test('independent comfort rating is saved and cannot be silently overwritten', async () => {
  // Initial submit of comfort rating
  const res1 = await call('live_evaluation_submit', [id, token, 85, false, null, false])
  expect(res1.trip_id).toBe(id)
  expect(res1.comfort_rating).toBe(85)
  expect(res1.comfort_rating_skipped).toBe(false)
  expect(res1.score_agreement).toBeNull()

  // Subsequent call attempting to change rating to 50 must NOT overwrite 85
  const res2 = await call('live_evaluation_submit', [id, token, 50, false, null, false])
  expect(res2.comfort_rating).toBe(85)

  // Submitting agreement later updates agreement without changing comfort rating
  const res3 = await call('live_evaluation_submit', [id, token, null, false, 'yes', false])
  expect(res3.comfort_rating).toBe(85)
  expect(res3.score_agreement).toBe('yes')
  expect(res3.score_agreement_skipped).toBe(false)

  // Duplicate submission is idempotent
  const res4 = await call('live_evaluation_submit', [id, token, 85, false, 'yes', false])
  expect(res4.comfort_rating).toBe(85)
  expect(res4.score_agreement).toBe('yes')
})

test('comfort rating bounds and agreement choices are enforced', async () => {
  await expect(call('live_evaluation_submit', [id, token, 101, false, null, false])).rejects.toThrow(/comfort rating/i)
  await expect(call('live_evaluation_submit', [id, token, -1, false, null, false])).rejects.toThrow(/comfort rating/i)
  await expect(call('live_evaluation_submit', [id, token, null, false, 'invalid_choice', false])).rejects.toThrow(/score agreement/i)
})
