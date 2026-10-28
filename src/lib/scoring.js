import { validTripAccess } from './feedbackQuestions.js'
export const BASELINE_POLICY = 'experimental-ride-smoothness/1.0.0'
export const CONTEXTUAL_POLICY = 'experimental-contextual-scoring/3.0.0'

export function tripPayload(trip) {
  return { id: trip.id, startedAt: trip.startedAt, endedAt: trip.endedAt, durationSeconds: trip.durationSeconds,
    motionCount: trip.motionCount, locationCount: trip.locationCount, readings: trip.readings, metadata: trip.metadata ?? null }
}
export async function inputFingerprint(body) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}
export async function scoreRequest(path, id, token, { method = 'GET', body, fingerprint } = {}) {
  if (!validTripAccess(id, token)) return { success: false, error: { code: 'invalid', message: 'Trip access is missing.' } }
  try {
    const response = await fetch(path, { method, body, cache: 'no-store', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(fingerprint ? { 'X-Trip-Input-Fingerprint': fingerprint } : {}) } })
    const data = await response.json()
    if (!response.ok) return { success: false, error: { code: data.error?.code ?? 'unavailable', message: data.error?.message ?? 'Could not reach ride analysis. Please retry.' } }
    const score = data.score
    const validNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    if (data.tripId !== id || data.tripSaved !== true || data.policyVersion !== BASELINE_POLICY
      || !['pending', 'processing', 'ready', 'unavailable', 'failed'].includes(score?.state)
      || (score.state === 'ready' && (!validNumber(score.baselineScore) || !['A', 'J', 'R'].every(k => validNumber(score.components?.[k]))))) {
      return { success: false, error: { code: 'invalid_response', message: 'Could not verify the analysis result. Retry analysis.' } }
    }
    if (score.status === 'final' && (score.contextual?.state !== 'final' || score.contextual.policyVersion !== CONTEXTUAL_POLICY
      || !validNumber(score.contextual.finalScore) || !validNumber(score.contextual.sensorScore))) {
      return { success: false, error: { code: 'invalid_response', message: 'Could not verify the final score. Retry safely.' } }
    }
    return { success: true, tripId: id, score, error: null }
  } catch {
    return { success: false, error: { code: 'unavailable', message: 'Could not reach ride analysis. Your ride is kept; retry when connected.' } }
  }
}
export const getScoreStatus = (id, token, fingerprint) => scoreRequest(`/api/trips/${id}/score`, id, token, { fingerprint })
export const retryScore = (id, token, fingerprint) => scoreRequest(`/api/trips/${id}/score/retry`, id, token, { method: 'POST', fingerprint })
export const finalizeScore = (id, token, fingerprint) => scoreRequest(`/api/trips/${id}/score/finalize`, id, token, { method: 'POST', fingerprint })
