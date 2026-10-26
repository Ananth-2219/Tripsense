import { beforeEach, expect, test, vi } from 'vitest'
import { uploadTrip } from './upload.js'
import { supabase } from './supabase.js'

vi.mock('./supabase.js', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }))

const insert = vi.fn()
const trip = {
  id: '877f6a92-fa06-4b3a-a967-57b72f54cd59', feedbackToken: 'a'.repeat(64),
  startedAt: '2026-10-07T10:00:00.000Z', endedAt: '2026-10-07T10:00:01.250Z',
  durationSeconds: 1.25, motionCount: 1, locationCount: 1,
  readings: [{ type: 'motion' }, { type: 'location' }],
}

beforeEach(() => {
  vi.resetAllMocks()
  supabase.from.mockReturnValue({ insert })
  supabase.rpc.mockReturnValue({ abortSignal: () => Promise.resolve({data:'missing',error:null}) })
})

function insertResult(result, rejected=false) {
  insert.mockReturnValue({abortSignal: () => rejected ? Promise.reject(result) : Promise.resolve(result)})
}

test('inserts exactly one row with schema names and defaults, without selecting it', async () => {
  insertResult({ error: null })
  expect(await uploadTrip(trip)).toEqual({ success: true, tripId:trip.id, error: null })
  expect(supabase.from).toHaveBeenCalledExactlyOnceWith('trips')
  expect(insert).toHaveBeenCalledExactlyOnceWith({
    id:trip.id, started_at: trip.startedAt, ended_at: trip.endedAt, duration_seconds: 1.25,
    motion_count: 1, location_count: 1, readings: trip.readings, metadata: {feedback_token_hash:expect.stringMatching(/^[0-9a-f]{64}$/)},
  })
  expect(JSON.stringify(insert.mock.calls)).not.toContain(trip.feedbackToken)
})

test('preserves supplied metadata', async () => {
  insertResult({ error: null })
  await uploadTrip({ ...trip, metadata: { app: 'TripSense' } })
  expect(insert.mock.calls[0][0].metadata).toEqual({ app:'TripSense',feedback_token_hash:expect.any(String) })
})

test('returns a safe Supabase error result without retrying', async () => {
  insertResult({ error: { code: '42501', message: 'private connection details' } })
  expect(await uploadTrip(trip)).toEqual({
    success: false, error: { message: 'Could not upload trip.', code: '42501' },
  })
  expect(insert).toHaveBeenCalledOnce()
})

test('returns a safe result for network exceptions without retrying', async () => {
  insertResult(new Error('private connection details'),true)
  expect(await uploadTrip(trip)).toEqual({
    success: false, error: { message: 'Could not upload trip. Check your connection.', code: null },
  })
  expect(insert).toHaveBeenCalledOnce()
})

test('a lost insert response is recovered only with the matching trip capability', async () => {
  insertResult(new Error('Connection interrupted'),true)
  supabase.rpc.mockReturnValue({abortSignal:()=>Promise.resolve({data:'trip_saved',error:null})})
  expect((await uploadTrip(trip)).success).toBe(true)
  expect(supabase.rpc).toHaveBeenCalledWith('trip_feedback_state',{p_trip_id:trip.id,p_feedback_token:trip.feedbackToken})
})

test('duplicate UUID alone is never treated as a successful upload', async () => {
  insertResult({error:{code:'23505'}})
  expect((await uploadTrip(trip)).success).toBe(false)
  supabase.rpc.mockReturnValue({abortSignal:()=>Promise.resolve({data:'trip_saved',error:null})})
  expect((await uploadTrip(trip)).success).toBe(true)
  expect(insert.mock.calls[0][0].id).toBe(insert.mock.calls[1][0].id)
})

test('missing identity cannot silently create an unassociated trip', async () => {
  expect((await uploadTrip({...trip,id:undefined})).success).toBe(false)
  expect(insert).not.toHaveBeenCalled()
})
