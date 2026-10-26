import { uploadTrip } from './upload.js'
import { submitTripFeedback } from './feedback.js'
import { validTripAccess } from './feedbackQuestions.js'
import { readEntries, putEntry, removeEntry } from './followUpStore.js'

const listeners = new Set()
const running = new Map()
let initialization
let snapshot = { entries: [], busyIds: [], loading: true, storageWarning: '' }
const warning = 'This browser cannot keep drafts reliably. Keep this page open until your recording and answers are saved.'

function publish(changes) {
  snapshot = { ...snapshot, ...changes }
  for (const listener of listeners) listener()
}
export const getFollowUpSnapshot = () => snapshot
export const subscribeFollowUps = listener => { listeners.add(listener); return () => listeners.delete(listener) }
const find = id => snapshot.entries.find(entry => entry.id === id)

export function initializeFollowUps() {
  if (!initialization) initialization = readEntries().then(entries => {
    const valid = entries.filter(e => validTripAccess(e.id, e.feedbackToken)
      && ['upload_pending', 'feedback_pending'].includes(e.status))
    publish({ entries: valid, loading: false })
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
    answers: {}, comments: '', deferred: false,
  })
  return retryTripUpload(trip.id)
}

export function retryTripUpload(id) {
  return once('upload', id, async () => {
    const entry = find(id)
    if (!entry?.trip || entry.status !== 'upload_pending') return { success: false }
    let result
    try { result = await uploadTrip(entry.trip) } catch { result = { success: false } }
    if (result.success && result.tripId === id) {
      if (result.feedbackSubmitted) await remove(id)
      else {
        const { trip: _rawRecording, ...feedback } = entry
        await persist({ ...feedback, status: 'feedback_pending', deferred: false })
      }
      return result
    }
    return { success: false, error: { message: 'Could not confirm the trip was saved. Retry when connected; your recording is kept.' } }
  })
}

export async function updateFeedbackDraft(id, answers, comments) {
  const entry = find(id)
  if (entry?.status === 'feedback_pending') await persist({ ...entry, answers, comments })
}
export async function deferFeedback(id, deferred) {
  const entry = find(id)
  if (entry?.status === 'feedback_pending') await persist({ ...entry, deferred })
}
export async function skipFeedback(id) {
  if (find(id)?.status === 'feedback_pending' && !running.has(`feedback:${id}`)) await remove(id)
}

export function sendFeedback(id, answers, comments) {
  return once('feedback', id, async () => {
    const entry = find(id)
    if (entry?.status !== 'feedback_pending') return { success: false }
    await updateFeedbackDraft(id, answers, comments)
    let result
    try { result = await submitTripFeedback(id, entry.feedbackToken, answers, comments) }
    catch { result = { success: false, error: { message: 'Could not save your answers. Please retry.' } } }
    if (result.success) await remove(id)
    return result
  })
}
