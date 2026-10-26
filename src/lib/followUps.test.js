import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, expect, test, vi } from 'vitest'

vi.mock('./upload.js', () => ({ uploadTrip: vi.fn() }))
vi.mock('./feedback.js', () => ({ submitTripFeedback: vi.fn() }))
let followUps, uploadTrip, submitTripFeedback
const trip = { id:'877f6a92-fa06-4b3a-a967-57b72f54cd59', feedbackToken:'a'.repeat(64),
  endedAt:'2026-10-26T10:00:00Z', readings:[{type:'motion',x:1}] }
beforeEach(async () => {
  vi.resetModules()
  vi.stubGlobal('indexedDB', new IDBFactory())
  ;({uploadTrip} = await import('./upload.js'))
  ;({submitTripFeedback} = await import('./feedback.js'))
  uploadTrip.mockReset()
  submitTripFeedback.mockReset()
  followUps = await import('./followUps.js')
  await followUps.initializeFollowUps()
})

test('failed uploads persist the unchanged snapshot; retry keeps the original trip identity', async () => {
  uploadTrip.mockResolvedValueOnce({success:false}).mockResolvedValueOnce({success:true,tripId:trip.id})
  await followUps.saveRecordedTrip(trip)
  const {readEntries} = await import('./followUpStore.js')
  expect((await readEntries())[0].trip).toEqual(trip)
  expect(followUps.getFollowUpSnapshot().entries[0].status).toBe('upload_pending')
  await followUps.retryTripUpload(trip.id)
  expect(uploadTrip.mock.calls.map(([value]) => value)).toEqual([trip,trip])
  expect((await readEntries())[0].status).toBe('feedback_pending')
  expect((await readEntries())[0].trip).toBeUndefined()
})

test('deferred drafts survive reloading the module and retain UUID association', async () => {
  uploadTrip.mockResolvedValue({success:true,tripId:trip.id})
  await followUps.saveRecordedTrip(trip)
  await followUps.updateFeedbackDraft(trip.id,{phone_placement:'mount'},'A note')
  await followUps.deferFeedback(trip.id,true)
  vi.resetModules()
  const restored = await import('./followUps.js')
  await restored.initializeFollowUps()
  expect(restored.getFollowUpSnapshot().entries).toEqual([expect.objectContaining({
    id:trip.id,feedbackToken:trip.feedbackToken,deferred:true,answers:{phone_placement:'mount'},comments:'A note',
  })])
})

test('submission failures keep the draft; duplicate clicks share one request and success removes the token', async () => {
  uploadTrip.mockResolvedValue({success:true,tripId:trip.id})
  await followUps.saveRecordedTrip(trip)
  submitTripFeedback.mockResolvedValueOnce({success:false,error:{message:'Offline'}})
  await followUps.sendFeedback(trip.id,{phone_placement:'mount'},'Kept')
  expect(followUps.getFollowUpSnapshot().entries[0].comments).toBe('Kept')
  let finish
  submitTripFeedback.mockImplementation(() => new Promise(resolve => {finish=resolve}))
  const a = followUps.sendFeedback(trip.id,{},'Same trip')
  const b = followUps.sendFeedback(trip.id,{},'Same trip')
  await vi.waitFor(() => expect(submitTripFeedback).toHaveBeenCalledTimes(2))
  finish({success:true,submittedAt:'2026-10-26T10:05:00Z'})
  await Promise.all([a,b])
  expect(followUps.getFollowUpSnapshot().entries).toEqual([])
  const {readEntries} = await import('./followUpStore.js')
  expect(await readEntries()).toEqual([])
})

test('skip removes only this local questionnaire and never calls Supabase', async () => {
  uploadTrip.mockResolvedValue({success:true,tripId:trip.id})
  await followUps.saveRecordedTrip(trip)
  await followUps.skipFeedback(trip.id)
  expect(followUps.getFollowUpSnapshot().entries).toEqual([])
  expect(submitTripFeedback).not.toHaveBeenCalled()
  expect(uploadTrip).toHaveBeenCalledOnce()
})

test('answer submission during final upload bookkeeping must reach the feedback API', async () => {
  const store = await import('./followUpStore.js')
  const originalPut = store.putEntry
  let releaseUploadBookkeeping
  let held = false
  vi.spyOn(store,'putEntry').mockImplementation(entry => {
    const write = originalPut(entry)
    if (entry.status === 'feedback_pending' && !held) {
      held = true
      return write.then(() => new Promise(resolve => {releaseUploadBookkeeping=resolve}))
    }
    return write
  })
  uploadTrip.mockResolvedValue({success:true,tripId:trip.id})
  submitTripFeedback.mockResolvedValue({success:true,submittedAt:'2026-10-26T10:05:00Z'})
  const saving = followUps.saveRecordedTrip(trip)
  await vi.waitFor(() => expect(releaseUploadBookkeeping).toBeTypeOf('function'))
  const submitting = followUps.sendFeedback(trip.id,{phone_placement:'mount'},'Answers')
  try {
    await vi.waitFor(() => expect(submitTripFeedback).toHaveBeenCalledOnce(),{timeout:200})
  } finally {
    releaseUploadBookkeeping()
    await Promise.all([saving,submitting])
    vi.restoreAllMocks()
  }
})

test('unavailable persistent storage keeps a retryable in-memory recording and warns clearly', async () => {
  vi.resetModules()
  vi.stubGlobal('indexedDB',undefined)
  const service = await import('./followUps.js')
  uploadTrip.mockResolvedValue({success:false})
  await service.saveRecordedTrip(trip)
  expect(service.getFollowUpSnapshot().entries[0].trip).toEqual(trip)
  expect(service.getFollowUpSnapshot().storageWarning).toContain('Keep this page open')
})
