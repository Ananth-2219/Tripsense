import { beforeEach, expect, test, vi } from 'vitest'
import { uploadTrip } from './upload.js'
import { supabase } from './supabase.js'

vi.mock('./supabase.js', () => ({ supabase: { from: vi.fn() } }))

const insert = vi.fn()
const trip = {
  startedAt: '2026-10-07T10:00:00.000Z', endedAt: '2026-10-07T10:00:01.250Z',
  durationSeconds: 1.25, motionCount: 1, locationCount: 1,
  readings: [{ type: 'motion' }, { type: 'location' }],
}

beforeEach(() => {
  vi.resetAllMocks()
  supabase.from.mockReturnValue({ insert })
})

test('inserts exactly one row with schema names and defaults, without selecting it', async () => {
  insert.mockResolvedValue({ error: null })
  expect(await uploadTrip(trip)).toEqual({ success: true, error: null })
  expect(supabase.from).toHaveBeenCalledExactlyOnceWith('trips')
  expect(insert).toHaveBeenCalledExactlyOnceWith({
    started_at: trip.startedAt, ended_at: trip.endedAt, duration_seconds: 1.25,
    motion_count: 1, location_count: 1, readings: trip.readings, metadata: null,
  })
})

test('preserves supplied metadata', async () => {
  insert.mockResolvedValue({ error: null })
  await uploadTrip({ ...trip, metadata: { app: 'TripSense' } })
  expect(insert.mock.calls[0][0].metadata).toEqual({ app: 'TripSense' })
})

test('returns a safe Supabase error result without retrying', async () => {
  insert.mockResolvedValue({ error: { code: '42501', message: 'private connection details' } })
  expect(await uploadTrip(trip)).toEqual({
    success: false, error: { message: 'Could not upload trip.', code: '42501' },
  })
  expect(insert).toHaveBeenCalledOnce()
})

test('returns a safe result for network exceptions without retrying', async () => {
  insert.mockRejectedValue(new Error('private connection details'))
  expect(await uploadTrip(trip)).toEqual({
    success: false, error: { message: 'Could not upload trip. Check your connection.', code: null },
  })
  expect(insert).toHaveBeenCalledOnce()
})
