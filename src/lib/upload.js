import { getTripFeedbackState } from './feedback.js'
import { validTripAccess } from './feedbackQuestions.js'
import { getScoreStatus, inputFingerprint, scoreRequest, tripPayload } from './scoring.js'

export function createTripIdentity() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return { id: crypto.randomUUID(), feedbackToken: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('') }
}

export async function uploadTrip(trip, { recoverFirst = false } = {}) {
  const { id, feedbackToken } = trip
  if (!validTripAccess(id, feedbackToken)) return { success: false, error: { message: 'Trip identity is missing.', code: null } }
  try {
    const body = JSON.stringify(tripPayload(trip))
    const fingerprint = await inputFingerprint(body)
    if (recoverFirst) {
      const existing = await getScoreStatus(id, feedbackToken, fingerprint)
      if (existing.success) return existing
      if (existing.error?.code === 'conflict') return existing
    }
    const result = await scoreRequest('/api/trips', id, feedbackToken, { method: 'POST', body, fingerprint })
    if (result.success || ['conflict', 'forbidden', 'invalid'].includes(result.error?.code)) return result
    const recovered = await getScoreStatus(id, feedbackToken, fingerprint)
    if (recovered.success) return recovered
    // Existing capability RPC can confirm persistence even while the scoring API
    // is temporarily unavailable. UUID alone is never sufficient.
    const state = await getTripFeedbackState(id, feedbackToken)
    if (state === 'trip_saved' || state === 'submitted') return {
      success: true, tripId: id, error: null, feedbackSubmitted: state === 'submitted',
      score: { state: 'failed', retryable: true, inputFingerprint: fingerprint,
        reason: 'Your ride is saved. Analysis could not be confirmed; retry analysis.' },
    }
    return result
  } catch {
    return { success: false, error: { message: 'Could not upload trip. Check your connection.', code: null } }
  }
}

