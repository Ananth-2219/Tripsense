import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, expect, test } from 'vitest'

const id = '877f6a92-fa06-4b3a-a967-57b72f54cd59'
const otherId = '4d2856e9-bfd7-4b74-8e42-839431666242'
const legacyId = '130d7a06-939f-4fef-8000-141389113923'
const token = 'a'.repeat(64)
const hash = createHash('sha256').update(token).digest('hex')
const otherToken = 'c'.repeat(64)
const otherHash = createHash('sha256').update(otherToken).digest('hex')
const answers = { phone_placement:'mount', phone_stability:'still', road_conditions:'smooth',
  traffic_conditions:'light', driving_smoothness:'mostly_smooth', sudden_maneuvers:'none', unusual_events:'none' }
let db
let originalTrips
let originalFeedback
let migration
beforeAll(async () => {
  db = new PGlite()
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE public.trips(id uuid PRIMARY KEY, ended_at timestamptz, metadata jsonb, readings jsonb);
    ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA public TO anon, authenticated;
    GRANT INSERT, SELECT ON public.trips TO anon;
    CREATE POLICY "Allow trip uploads" ON public.trips FOR INSERT TO anon WITH CHECK(true);`)
  await db.query('INSERT INTO public.trips VALUES ($1,now(),$2,$3),($4,now(),$6,$3),($5,now(),NULL,$3)',
    [id, {feedback_token_hash:hash}, [{type:'motion',x:1}],otherId,legacyId,{feedback_token_hash:otherHash}])
  originalTrips = (await db.query('SELECT * FROM public.trips ORDER BY id')).rows
  // Exact existing nullable table layout observed during final schema review.
  await db.exec(`CREATE TABLE public.trip_feedback(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id uuid NOT NULL UNIQUE REFERENCES public.trips(id) ON DELETE CASCADE,
    phone_placement text,phone_movement text,road_condition text,traffic_condition text,
    perceived_smoothness text,reported_maneuvers text,unusual_event text,comments text,submitted_at timestamptz DEFAULT now());
    ALTER TABLE public.trip_feedback ENABLE ROW LEVEL SECURITY;`)
  await db.query('INSERT INTO public.trip_feedback(trip_id,comments) VALUES($1,$2)',[legacyId,'Existing incomplete feedback'])
  originalFeedback=(await db.query('SELECT * FROM public.trip_feedback')).rows
  migration=await readFile(new URL('../../supabase/migrations/20261026000000_trip_feedback.sql', import.meta.url),'utf8')
  await db.exec(migration)
}, 30000)
afterAll(async () => { await db?.close() })

async function anon(query, parameters=[]) {
  await db.exec('SET ROLE anon')
  try { return await db.query(query, parameters) } finally { await db.exec('RESET ROLE') }
}
const submit = (tripId, capability, data=answers, comments='') => anon(
  'SELECT public.submit_trip_feedback($1,$2,$3,$4) AS submitted_at',[tripId,capability,data,comments])

test('anonymous clients cannot read trips, read feedback or write feedback directly', async () => {
  expect((await anon('SELECT * FROM public.trips')).rows).toEqual([])
  await expect(anon('SELECT * FROM public.trip_feedback')).rejects.toThrow(/permission denied/)
  await expect(anon('INSERT INTO public.trip_feedback(trip_id) VALUES ($1)',[id])).rejects.toThrow(/permission denied/)
  await expect(anon('UPDATE public.trip_feedback SET comments=$1',['tampered'])).rejects.toThrow(/permission denied/)
  const {rows} = await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.trip_feedback'::regclass")
  expect(rows[0].relrowsecurity).toBe(true)
})

test('UUID alone, a wrong token, a missing trip and historical unclaimed trips cannot submit', async () => {
  for (const [tripId,capability] of [[id,null],[id,'b'.repeat(64)],[otherId,token],[legacyId,token],['00000000-0000-4000-8000-000000000000',token]]) {
    await expect(submit(tripId,capability)).rejects.toThrow(/not authorized/i)
  }
})

test('database rejects missing, invented, extra or null answers and oversized comments', async () => {
  for (const data of [{},null,[],{...answers,road_conditions:'invented'},{...answers,phone_stability:null},{...answers,extra:'x'}]) {
    await expect(submit(otherId,otherToken,data)).rejects.toThrow()
  }
  await expect(submit(otherId,otherToken,answers,'x'.repeat(1001))).rejects.toThrow()
  expect((await db.query('SELECT * FROM public.trip_feedback WHERE trip_id<>$1',[legacyId])).rows).toHaveLength(0)
})

test('first valid submission wins; retries return the same timestamp and never overwrite', async () => {
  const first = await submit(id,token,answers,'Original')
  const retry = await submit(id,token,{...answers,road_conditions:'rough'},'Changed')
  expect(retry.rows[0].submitted_at).toEqual(first.rows[0].submitted_at)
  expect((await anon('SELECT public.trip_feedback_state($1,$2) AS state',[id,token])).rows[0].state).toBe('submitted')
  const {rows} = await db.query('SELECT * FROM public.trip_feedback WHERE trip_id=$1',[id])
  expect(rows).toHaveLength(1)
  expect(rows[0].comments).toBe('Original')
  expect(rows[0].road_condition).toBe('smooth')
  expect(rows[0].submitted_at).toBeTruthy()
})

test('save-state recovery is token-bound and does not expose old trips', async () => {
  expect((await anon('SELECT public.trip_feedback_state($1,$2) AS state',[otherId,otherToken])).rows[0].state).toBe('trip_saved')
  expect((await anon('SELECT public.trip_feedback_state($1,$2) AS state',[id,'b'.repeat(64)])).rows[0].state).toBe('missing')
  expect((await anon('SELECT public.trip_feedback_state($1,$2) AS state',[legacyId,token])).rows[0].state).toBe('missing')
})

test('foreign key exists and the migration and questionnaire never change trip rows', async () => {
  const {rows} = await db.query("SELECT confrelid::regclass::text AS parent FROM pg_constraint WHERE conrelid='public.trip_feedback'::regclass AND contype='f'")
  expect(rows).toEqual([{parent:'trips'}])
  expect((await db.query('SELECT * FROM public.trips ORDER BY id')).rows).toEqual(originalTrips)
  expect((await db.query('SELECT * FROM public.trip_feedback WHERE trip_id=$1',[legacyId])).rows).toEqual(originalFeedback)
})

test('the same migration also supports a fresh installation without a feedback table',async()=>{
  const fresh=new PGlite()
  try {
    await fresh.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE TABLE public.trips(id uuid PRIMARY KEY,ended_at timestamptz,metadata jsonb)')
    await fresh.exec(migration)
    const {rows}=await fresh.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='trip_feedback'")
    expect(rows.map(row=>row.column_name)).toContain('phone_movement')
    expect(rows).toHaveLength(11)
  } finally { await fresh.close() }
},30000)
