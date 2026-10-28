import { validTripAccess } from './feedbackQuestions.js'

export async function evaluationRequest(path, id, token, { method = 'GET', body } = {}) {
  if (!validTripAccess(id, token)) {
    return { success: false, error: { code: 'invalid', message: 'Trip access is missing.' } }
  }
  try {
    const response = await fetch(path, {
      method,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    })
    const data = await response.json()
    if (!response.ok) {
      return {
        success: false,
        error: {
          code: data.error?.code ?? 'unavailable',
          message: data.error?.message ?? 'Could not reach evaluation service. Please retry.',
        },
      }
    }
    return { success: true, tripId: id, evaluation: data.evaluation, error: null }
  } catch {
    return {
      success: false,
      error: {
        code: 'unavailable',
        message: 'Could not reach evaluation service. Your response is saved on device; retry when connected.',
      },
    }
  }
}

export const getTripEvaluation = (id, token) =>
  evaluationRequest(`/api/trips/${id}/evaluation`, id, token)

export const submitTripEvaluation = (id, token, payload) =>
  evaluationRequest(`/api/trips/${id}/evaluation`, id, token, { method: 'POST', body: payload })
