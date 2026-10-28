import { uploadTrip } from './upload.js'
import { submitTripFeedback, getTripFeedbackState } from './feedback.js'
import { validTripAccess } from './feedbackQuestions.js'
import { readEntries, putEntry, removeEntry, readResults, putResult } from './followUpStore.js'
import { getScoreStatus, retryScore, finalizeScore } from './scoring.js'

const listeners = new Set()
const running = new Map()
let initialization
let snapshot = { entries: [], results: [], busyIds: [], loading: true, storageWarning: '' }
const warning = 'This browser cannot keep drafts reliably. Keep this page open until your recording and answers are saved.'

function publish(changes) {
  snapshot = { ...snapshot, ...changes }
  for (const listener of listeners) listener()
}
export const getFollowUpSnapshot = () => snapshot
export const subscribeFollowUps = listener => { listeners.add(listener); return () => listeners.delete(listener) }
const find = id => snapshot.entries.find(entry => entry.id === id)

export function initializeFollowUps() {
  if (!initialization) initialization = Promise.all([readEntries(), readResults()]).then(([entries, results]) => {
    const valid = entries.filter(e => validTripAccess(e.id, e.feedbackToken)
      && ['upload_pending', 'feedback_pending'].includes(e.status))
    publish({ entries: valid.map(entry => entry.status === 'feedback_pending' && !Object.hasOwn(entry, 'score')
      ? { ...entry, score: { state: 'pending', retryable: true } } : entry), results, loading: false })
    for (const entry of valid.filter(e => e.status === 'feedback_pending')) void recoverAcceptedFeedback(entry.id)
  }).catch(() => publish({ loading: false, storageWarning: warning }))
  return initialization
}

async function persist(entry) {
  publish({ entries: [...snapshot.entries.filter(e => e.id !== entry.id), entry] })
  try { await putEntry(entry) } catch { publish({ storageWarning: warning }) }
}
async function remove(id) {
  publish({ entries: snapshot.entries.filter(entry => entry.id !== id) })
  try { await removeEntry(id) } catch { publish({ storageWarning: warning }) }
}

function once(kind, id, operation) {
  const key = `${kind}:${id}`
  if (running.has(key)) return running.get(key)
  const busyIds = () => [...new Set([...running.keys()].map(task => task.split(':')[1]))]
  // Install the promise before operation starts, including before any await.
  const promise = Promise.resolve().then(operation).finally(() => {
    running.delete(key)
    publish({ busyIds: busyIds() })
  })
  running.set(key, promise)
  publish({ busyIds: busyIds() })
  return promise
}

export async function saveRecordedTrip(trip) {
  await initializeFollowUps()
  if (!validTripAccess(trip.id, trip.feedbackToken)) return { success: false }
  if (!find(trip.id)) await persist({
    id: trip.id, feedbackToken: trip.feedbackToken, endedAt: trip.endedAt,
    createdAt: new Date().toISOString(), status: 'upload_pending', trip,
    answers: {}, comments: '', deferred: false, uploadAttempts: 0,
  })
  return retryTripUpload(trip.id)
}

export function retryTripUpload(id) {
  return once('upload', id, async () => {
    const entry = find(id)
    if (!entry?.trip || entry.status !== 'upload_pending') return { success: false }
    let result
    await persist({ ...entry, uploadAttempts: (entry.uploadAttempts ?? 0) + 1 })
    try { result = await uploadTrip(entry.trip, { recoverFirst: (entry.uploadAttempts ?? 0) > 0 }) } catch { result = { success: false } }
    if (result.success && result.tripId === id) {
      const { trip: _rawRecording, ...feedback } = entry
      await settle({ ...feedback, status: 'feedback_pending', deferred: false, feedbackComplete: Boolean(result.feedbackSubmitted),
        feedbackDisposition: result.feedbackSubmitted ? 'submitted' : undefined,
        score: result.score ?? null, scoreChecks: 0 })
      if (result.feedbackSubmitted) void finalizeRide(id)
      return result
    }
    return { success: false, error: { message: 'Could not confirm the trip was saved. Retry when connected; your recording is kept.' } }
  })
}

export async function updateFeedbackDraft(id, answers, comments) {
  const entry = find(id)
  if (entry?.status === 'feedback_pending' && !entry.feedbackComplete) await persist({ ...entry, answers, comments })
}
export async function deferFeedback(id, deferred) {
  const entry = find(id)
  if (entry?.status === 'feedback_pending') await persist({ ...entry, deferred })
}
export async function skipFeedback(id) {
  const entry = find(id)
  if (entry?.status === 'feedback_pending' && !entry.feedbackComplete && !running.has(`feedback:${id}`)) await settle({ ...entry,
    feedbackComplete: true, feedbackDisposition: 'skipped', feedbackIntent: undefined, answers: {}, comments: '' })
}

export function sendFeedback(id, answers, comments) {
  return once('feedback', id, async () => {
    const entry = find(id)
    if (entry?.status !== 'feedback_pending') return { success: false }
    if (entry.feedbackDisposition === 'submitted') { void finalizeRide(id); return { success: true } }
    await updateFeedbackDraft(id, answers, comments)
    await persist({ ...find(id), feedbackIntent: 'submitting' })
    let result
    try {
      const accepted = await getTripFeedbackState(id, entry.feedbackToken)
      result = accepted === 'submitted' ? { success: true, acceptedPreviously: true }
        : await submitTripFeedback(id, entry.feedbackToken, answers, comments)
      if (!result.success && await getTripFeedbackState(id, entry.feedbackToken) === 'submitted') result = { success: true, recovered: true }
    }
    catch { result = { success: false, error: { message: 'Could not save your answers. Please retry.' } } }
    if (result.success) await acceptFeedback(id)
    else if (find(id)) await persist({ ...find(id), feedbackIntent: 'checking' })
    return result
  })
}

const baselineTerminal = score => !score || ['ready', 'unavailable'].includes(score.state) || (score.state === 'failed' && score.retryable === false)
const terminal = entry => baselineTerminal(entry.score) && (entry.feedbackDisposition !== 'submitted' || !entry.score
  || ['final', 'unavailable'].includes(entry.score.contextual?.state))
async function settle(entry) {
  if (entry.feedbackDisposition === 'submitted' && entry.score?.status !== 'final' && entry.score
    && baselineTerminal(entry.score) && entry.score.state !== 'ready') {
    entry = { ...entry, score: { ...entry.score, contextual: { ...entry.score.contextual, state: 'unavailable', feedbackAccepted: true } } }
  }
  // Keep the recovery capability until the compact result has durably committed.
  // Publish the latest lifecycle first so concurrent Skip/Submit cannot be undone.
  await persist(entry)
  if (entry.score && terminal(entry)) {
    const existing = snapshot.results.find(r => r.id === entry.id)
    const result = { id: entry.id, endedAt: entry.endedAt, score: existing?.score.status === 'final' ? existing.score : entry.score,
      feedbackComplete: Boolean(entry.feedbackComplete || existing?.feedbackComplete), feedbackDisposition: entry.feedbackDisposition }
    publish({ results: [...snapshot.results.filter(r => r.id !== entry.id), result].slice(-20) })
    try { await putResult(result) } catch { publish({ storageWarning: warning }); return }
  }
  const current = find(entry.id)
  if (current?.feedbackComplete && terminal(current)) await remove(entry.id)
}

async function acceptFeedback(id) {
  const entry = find(id)
  if (!entry) return
  const context = entry.score ? { ...entry.score, contextual: { ...entry.score.contextual,
    state: entry.score.status === 'final' ? 'final' : baselineTerminal(entry.score) && entry.score.state !== 'ready' ? 'unavailable' : 'pending', feedbackAccepted: true } } : null
  await settle({ ...entry, feedbackComplete: true, feedbackDisposition: 'submitted', feedbackIntent: 'accepted', answers: {}, comments: '', score: context })
  if (find(id) && context?.contextual.state !== 'unavailable') void finalizeRide(id)
}

export function recoverAcceptedFeedback(id) {
  return once('feedback-state', id, async () => {
    const entry = find(id)
    if (!entry || entry.status !== 'feedback_pending') return { success: false }
    const state = await getTripFeedbackState(id, entry.feedbackToken)
    if (state === 'submitted') { await acceptFeedback(id); return { success: true } }
    if (state === 'trip_saved' && find(id)?.feedbackDisposition !== 'submitted' && !running.has(`feedback:${id}`)) {
      const current = find(id)
      if (current?.feedbackIntent) await persist({ ...current, feedbackIntent: undefined })
      if (current?.feedbackComplete) await settle({ ...find(id), feedbackDisposition: 'skipped' })
    }
    return { success: false }
  })
}

function mergeScore(current, incoming) {
  if (current.score?.status === 'final' && incoming.status !== 'final') return current.score
  if (incoming.status === 'final') return incoming
  return { ...current.score, ...incoming, ...(current.feedbackDisposition === 'submitted'
    ? { contextual: { ...current.score?.contextual, feedbackAccepted: true } } : {}) }
}
export function refreshScore(id) {
  return once('score', id, async () => {
    const entry = find(id)
    if (!entry || entry.status !== 'feedback_pending') return { success: false }
    let result = await getScoreStatus(id, entry.feedbackToken, entry.score?.inputFingerprint)
    if (result.success && result.score.state === 'pending' && result.score.retryable) result = await retryScore(id, entry.feedbackToken, entry.score?.inputFingerprint)
    const current = find(id)
    if (!current) return result
    await settle({ ...current, scoreChecks: (current.scoreChecks ?? 0) + 1,
      score: current.score?.status === 'final' ? current.score : result.success ? mergeScore(current, result.score) : { ...current.score, state: 'failed', retryable: true,
        reason: result.error?.message ?? 'Score unavailable. Retry analysis.' } })
    const latest = find(id)
    if (latest?.feedbackDisposition === 'submitted' && latest.score?.state === 'ready'
      && ['pending', 'waiting_for_baseline'].includes(latest.score.contextual?.state)) void finalizeRide(id)
    return result
  })
}
export function retryAnalysis(id) {
  return once('score', id, async () => {
    const entry = find(id)
    if (!entry || entry.status !== 'feedback_pending') return { success: false }
    const result = await retryScore(id, entry.feedbackToken, entry.score?.inputFingerprint)
    const current = find(id)
    if (current) await settle({ ...current, scoreChecks: 0,
      score: current.score?.status === 'final' ? current.score : result.success ? mergeScore(current, result.score) : { ...current.score, state: 'failed', retryable: true,
        reason: result.error?.message ?? 'Score unavailable. Retry analysis.' } })
    const latest = find(id)
    if (latest?.feedbackDisposition === 'submitted' && latest.score?.state === 'ready'
      && ['pending', 'waiting_for_baseline'].includes(latest.score.contextual?.state)) void finalizeRide(id)
    return result
  })
}

function finalizeRide(id, { recoverFirst = false } = {}) {
  return once('contextual', id, async () => {
    const entry = find(id)
    if (!entry || entry.feedbackDisposition !== 'submitted' || !entry.score) return { success: false }
    if (entry.score.status === 'final' && entry.score.contextual?.state === 'final') {
      await settle(entry)
      return { success: true, tripId: id, score: entry.score }
    }
    await persist({ ...entry, score: { ...entry.score, contextual: { ...entry.score.contextual, state: 'processing', feedbackAccepted: true } } })
    let result
    if (recoverFirst) {
      const stored = await getScoreStatus(id, entry.feedbackToken, entry.score.inputFingerprint)
      if (stored.success && stored.score.status === 'final') result = stored
    }
    result ??= await finalizeScore(id, entry.feedbackToken, entry.score.inputFingerprint)
    const current = find(id)
    if (!current) return result
    const incoming = result.success ? result.score : null
    const context = incoming?.contextual
    const confirmed = incoming?.status === 'final' && context?.state === 'final'
    const next = confirmed ? incoming : { ...current.score, ...(incoming ? { ...incoming } : {}),
      contextual: context && context.state !== 'not_requested' ? context : { ...current.score.contextual,
        state: 'failed', reason: result.error?.message ?? 'Your feedback is saved. The final score could not be confirmed.', feedbackAccepted: true } }
    await settle({ ...current, score: next })
    return result
  })
}
export const retryFinalization = id => finalizeRide(id, { recoverFirst: true })
