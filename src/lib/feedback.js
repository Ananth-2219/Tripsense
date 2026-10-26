import { supabase } from './supabase.js'
import { validTripAccess, validateFeedback } from './feedbackQuestions.js'

export async function getTripFeedbackState(tripId, feedbackToken) {
  if (!validTripAccess(tripId, feedbackToken)) return null
  try {
    const { data, error } = await supabase.rpc('trip_feedback_state', {
      p_trip_id: tripId, p_feedback_token: feedbackToken,
    }).abortSignal(AbortSignal.timeout(20000))
    return !error && ['missing', 'trip_saved', 'submitted'].includes(data) ? data : null
  } catch { return null }
}

export async function submitTripFeedback(tripId, feedbackToken, answers, comments = '') {
  const errors = validateFeedback(answers, comments)
  if (!validTripAccess(tripId, feedbackToken) || Object.keys(errors).length) {
    return { success: false, errors, error: { message: 'Check the questionnaire and try again.' } }
  }
  try {
    const { data, error } = await supabase.rpc('submit_trip_feedback', {
      p_trip_id: tripId, p_feedback_token: feedbackToken, p_answers: answers, p_comments: comments.trim(),
    }).abortSignal(AbortSignal.timeout(20000))
    if (!error && typeof data === 'string' && Number.isFinite(Date.parse(data))) {
      return { success: true, submittedAt: data }
    }
    const message = ['PGRST202', 'PGRST205', '42883', '42P01'].includes(error?.code)
      ? 'Questionnaire saving is not available yet. Your trip is saved; keep this draft and try later.'
      : error?.code === '42501'
        ? 'This browser could not verify access to this trip. Keep your draft and try again.'
        : 'Could not save your answers. Your draft is kept; check your connection and retry.'
    return { success: false, error: { message } }
  } catch {
    return { success: false, error: { message: 'Could not confirm your answers were saved. Check your connection and retry safely.' } }
  }
}
