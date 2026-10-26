import { supabase } from './supabase.js'
import { getTripFeedbackState } from './feedback.js'
import { validTripAccess } from './feedbackQuestions.js'

export function createTripIdentity() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return { id: crypto.randomUUID(), feedbackToken: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('') }
}

export async function uploadTrip({
  id, feedbackToken, startedAt, endedAt, durationSeconds, motionCount, locationCount, readings, metadata = null,
}) {
  if (!validTripAccess(id, feedbackToken)) return { success: false, error: { message: 'Trip identity is missing.', code: null } }
  try {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(feedbackToken)))
    const feedbackTokenHash = Array.from(hash, b => b.toString(16).padStart(2, '0')).join('')
    // Do not select the inserted row: uploading only needs INSERT permission.
    const { error } = await supabase.from('trips').insert({
      id,
      started_at: startedAt,
      ended_at: endedAt,
      duration_seconds: durationSeconds,
      motion_count: motionCount,
      location_count: locationCount,
      readings,
      metadata: { ...metadata, feedback_token_hash: feedbackTokenHash },
    }).abortSignal(AbortSignal.timeout(30000))
    if (error) {
      if (error.code === '23505' || !error.code) {
        const state = await getTripFeedbackState(id, feedbackToken)
        if (state === 'trip_saved' || state === 'submitted') return {
          success: true, tripId: id, error: null, ...(state === 'submitted' ? { feedbackSubmitted: true } : {}),
        }
      }
      return { success: false, error: { message: 'Could not upload trip.', code: error.code ?? null } }
    }
    return { success: true, tripId: id, error: null }
  } catch {
    const state = await getTripFeedbackState(id, feedbackToken)
    if (state === 'trip_saved' || state === 'submitted') return {
      success: true, tripId: id, error: null, ...(state === 'submitted' ? { feedbackSubmitted: true } : {}),
    }
    // Network exception text can contain connection details; return a safe message.
    return { success: false, error: { message: 'Could not upload trip. Check your connection.', code: null } }
  }
}

