import { beforeEach, expect, test, vi } from 'vitest'
import { validateFeedback, QUESTIONS } from './feedbackQuestions.js'
import { submitTripFeedback } from './feedback.js'
import { supabase } from './supabase.js'

vi.mock('./supabase.js', () => ({ supabase: { rpc: vi.fn() } }))
const id = '877f6a92-fa06-4b3a-a967-57b72f54cd59'
const token = 'a'.repeat(64)
const answers = {
  phone_placement: 'mount', phone_stability: 'still', road_conditions: 'smooth',
  traffic_conditions: 'stop_go', driving_smoothness: 'mostly_smooth',
  sudden_maneuvers: 'braking', unusual_events: 'none',
}
beforeEach(() => vi.resetAllMocks())
function respond(value) { supabase.rpc.mockReturnValue({ abortSignal: () => Promise.resolve(value) }) }

test('seven explicit choices are required; unknown choices and long comments are rejected', () => {
  expect(QUESTIONS).toHaveLength(7)
  expect(validateFeedback(answers, '')).toEqual({})
  expect(Object.keys(validateFeedback({}, ''))).toHaveLength(7)
  expect(validateFeedback({ ...answers, traffic_conditions: 'invented' }, '').traffic_conditions).toBeTruthy()
  expect(validateFeedback(answers, 'x'.repeat(1001)).comments).toBeTruthy()
  expect(validateFeedback({ ...answers, extra: 'field' }, '').form).toBeTruthy()
})

test('submits answers to exactly the saved trip, without client-supplied timestamp', async () => {
  respond({ data: '2026-10-26T10:00:00+00:00', error: null })
  const result = await submitTripFeedback(id, token, answers, '  Rough patch  ')
  expect(result.success).toBe(true)
  expect(supabase.rpc).toHaveBeenCalledWith('submit_trip_feedback', {
    p_trip_id: id, p_feedback_token: token, p_answers: answers, p_comments: 'Rough patch',
  })
})

test('incomplete feedback or invalid association never reaches Supabase', async () => {
  expect((await submitTripFeedback(id, token, {}, '')).success).toBe(false)
  expect((await submitTripFeedback('not-a-uuid', token, answers, '')).success).toBe(false)
  expect((await submitTripFeedback(id, '', answers, '')).success).toBe(false)
  expect(supabase.rpc).not.toHaveBeenCalled()
})

test('missing migration and network failures return safe retryable errors', async () => {
  respond({ data: null, error: { code: 'PGRST202', message: 'internal detail' } })
  expect((await submitTripFeedback(id, token, answers, '')).error.message).toContain('not available yet')
  supabase.rpc.mockReturnValue({ abortSignal: () => Promise.reject(new Error('private endpoint')) })
  const result = await submitTripFeedback(id, token, answers, '')
  expect(result.success).toBe(false)
  expect(result.error.message).not.toContain('private endpoint')
})
