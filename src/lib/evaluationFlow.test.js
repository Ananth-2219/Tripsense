import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, expect, test, vi } from 'vitest'

vi.mock('./upload.js', () => ({ uploadTrip: vi.fn() }))
vi.mock('./feedback.js', () => ({ submitTripFeedback: vi.fn(), getTripFeedbackState: vi.fn().mockResolvedValue('trip_saved') }))
vi.mock('./scoring.js', () => ({ getScoreStatus: vi.fn(), retryScore: vi.fn(), finalizeScore: vi.fn() }))
vi.mock('./evaluation.js', () => ({ submitTripEvaluation: vi.fn().mockResolvedValue({ success: true }), getTripEvaluation: vi.fn() }))

let flow, upload, evaluation, store

const trip = {
  id: '877f6a92-fa06-4b3a-a967-57b72f54cd59',
  feedbackToken: 'a'.repeat(64),
  endedAt: '2026-10-28T12:00:00Z',
  readings: [{ type: 'motion', x: 1 }],
}

const readyScore = {
  state: 'ready',
  status: 'provisional',
  baselineScore: 82,
  components: { A: 80, J: 85, R: 81 },
  retryable: false,
  contextual: { state: 'not_requested' },
}

beforeEach(async () => {
  vi.resetModules()
  vi.stubGlobal('indexedDB', new IDBFactory())
  upload = await import('./upload.js')
  evaluation = await import('./evaluation.js')
  upload.uploadTrip.mockReset()
  evaluation.submitTripEvaluation.mockReset()
  upload.uploadTrip.mockResolvedValue({ success: true, tripId: trip.id, score: readyScore })
  evaluation.submitTripEvaluation.mockResolvedValue({ success: true, tripId: trip.id })

  flow = await import('./followUps.js')
  store = await import('./followUpStore.js')
  await flow.initializeFollowUps()
})

test('saveRecordedTrip initializes evaluation state with comfort rating unrevealed', async () => {
  await flow.saveRecordedTrip(trip)
  const entry = flow.getFollowUpSnapshot().entries[0]
  expect(entry.evaluation).toEqual({
    comfortRating: null,
    comfortSubmitted: false,
    comfortSkipped: false,
    scoreAgreement: null,
    agreementSubmitted: false,
    agreementSkipped: false,
    pendingSync: false,
  })
})

test('submitComfortRating validates input, updates entry, and posts to evaluation API', async () => {
  await flow.saveRecordedTrip(trip)
  
  // Validation
  const invalid = await flow.submitComfortRating(trip.id, 105)
  expect(invalid.success).toBe(false)
  const negative = await flow.submitComfortRating(trip.id, -1)
  expect(negative.success).toBe(false)
  const nanVal = await flow.submitComfortRating(trip.id, 'great')
  expect(nanVal.success).toBe(false)

  // Valid rating
  const valid = await flow.submitComfortRating(trip.id, 88)
  expect(valid.success).toBe(true)

  const entry = flow.getFollowUpSnapshot().entries[0]
  expect(entry.evaluation.comfortRating).toBe(88)
  expect(entry.evaluation.comfortSubmitted).toBe(true)
  expect(entry.evaluation.comfortSkipped).toBe(false)
  expect(evaluation.submitTripEvaluation).toHaveBeenCalledWith(
    trip.id,
    trip.feedbackToken,
    { comfortRating: 88 }
  )
})

test('skipComfortRating marks skipped and submits skip to API', async () => {
  await flow.saveRecordedTrip(trip)
  const res = await flow.skipComfortRating(trip.id)
  expect(res.success).toBe(true)

  const entry = flow.getFollowUpSnapshot().entries[0]
  expect(entry.evaluation.comfortSkipped).toBe(true)
  expect(entry.evaluation.comfortSubmitted).toBe(false)
  expect(evaluation.submitTripEvaluation).toHaveBeenCalledWith(
    trip.id,
    trip.feedbackToken,
    { comfortSkipped: true }
  )
})

test('submitScoreAgreement and skipScoreAgreement validate and send agreement data', async () => {
  await flow.saveRecordedTrip(trip)

  // Validation
  const invalid = await flow.submitScoreAgreement(trip.id, 'maybe')
  expect(invalid.success).toBe(false)

  // Submit valid choice
  const valid = await flow.submitScoreAgreement(trip.id, 'partially')
  expect(valid.success).toBe(true)

  let entry = flow.getFollowUpSnapshot().entries[0]
  expect(entry.evaluation.scoreAgreement).toBe('partially')
  expect(entry.evaluation.agreementSubmitted).toBe(true)
  expect(entry.evaluation.agreementSkipped).toBe(false)
  expect(evaluation.submitTripEvaluation).toHaveBeenCalledWith(
    trip.id,
    trip.feedbackToken,
    { scoreAgreement: 'partially' }
  )

  // Skip agreement
  const skipped = await flow.skipScoreAgreement(trip.id)
  expect(skipped.success).toBe(true)
  entry = flow.getFollowUpSnapshot().entries[0]
  expect(entry.evaluation.scoreAgreementSkipped).toBe(true)
  expect(entry.evaluation.agreementSkipped).toBe(true)
  expect(evaluation.submitTripEvaluation).toHaveBeenCalledWith(
    trip.id,
    trip.feedbackToken,
    { scoreAgreementSkipped: true }
  )
})

test('offline comfort rating is preserved locally and synced automatically once trip upload succeeds', async () => {
  // 1. Initial upload fails -> status: upload_pending
  upload.uploadTrip.mockResolvedValueOnce({ success: false })
  await flow.saveRecordedTrip(trip)
  expect(flow.getFollowUpSnapshot().entries[0].status).toBe('upload_pending')

  // 2. Rider rates comfort while offline
  const rated = await flow.submitComfortRating(trip.id, 92)
  expect(rated.success).toBe(true)
  expect(evaluation.submitTripEvaluation).not.toHaveBeenCalled()

  const pendingEntry = flow.getFollowUpSnapshot().entries[0]
  expect(pendingEntry.evaluation.comfortRating).toBe(92)
  expect(pendingEntry.evaluation.pendingSync).toBe(true)

  // 3. Network recovers and trip is uploaded
  upload.uploadTrip.mockResolvedValueOnce({ success: true, tripId: trip.id, score: readyScore })
  await flow.retryTripUpload(trip.id)

  expect(flow.getFollowUpSnapshot().entries[0].status).toBe('feedback_pending')

  // Wait for syncEvaluation triggered in retryTripUpload
  await vi.waitFor(() => {
    expect(evaluation.submitTripEvaluation).toHaveBeenCalledWith(
      trip.id,
      trip.feedbackToken,
      { comfortRating: 92 }
    )
  })

  // pendingSync is cleared after successful sync
  await vi.waitFor(() => {
    expect(flow.getFollowUpSnapshot().entries[0].evaluation.pendingSync).toBe(false)
  })
})

test('evaluation data is preserved in stored results when trip follow-up settles', async () => {
  await flow.saveRecordedTrip(trip)
  await flow.submitComfortRating(trip.id, 75)
  await flow.submitScoreAgreement(trip.id, 'yes')

  // Skip questionnaire to trigger settlement of provisional result
  await flow.skipFeedback(trip.id)

  const results = await store.readResults()
  expect(results.length).toBe(1)
  expect(results[0].evaluation).toMatchObject({
    comfortRating: 75,
    comfortSubmitted: true,
    scoreAgreement: 'yes',
    agreementSubmitted: true,
  })
})
