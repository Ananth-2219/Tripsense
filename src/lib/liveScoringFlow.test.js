import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('./upload.js',()=>({uploadTrip:vi.fn()}))
vi.mock('./feedback.js',()=>({submitTripFeedback:vi.fn(),getTripFeedbackState:vi.fn().mockResolvedValue('trip_saved')}))
vi.mock('./scoring.js',()=>({getScoreStatus:vi.fn(),retryScore:vi.fn(),finalizeScore:vi.fn()}))
let flow,upload,scoring,feedback
const trip={id:'877f6a92-fa06-4b3a-a967-57b72f54cd59',feedbackToken:'a'.repeat(64),endedAt:'2026-10-27T00:00:01Z',readings:[{type:'motion',x:1}]}
const ready={state:'ready',status:'provisional',baselineScore:81,components:{A:80,J:82,R:81},retryable:false,quality:{motion_coverage_percent:99}}
beforeEach(async()=>{
 vi.resetModules();vi.stubGlobal('indexedDB',new IDBFactory())
 upload=await import('./upload.js');scoring=await import('./scoring.js');feedback=await import('./feedback.js')
 upload.uploadTrip.mockReset();scoring.getScoreStatus.mockReset();scoring.retryScore.mockReset();feedback.submitTripFeedback.mockReset()
 scoring.finalizeScore.mockResolvedValue({success:true,tripId:trip.id,score:{...ready,status:'final',contextual:{state:'final',policyVersion:'experimental-contextual-scoring/3.0.0',finalScore:79,sensorScore:80}}})
 flow=await import('./followUps.js');await flow.initializeFollowUps()
})
test('uploaded raw is removed but capability survives failed scoring and skipped feedback',async()=>{
 upload.uploadTrip.mockResolvedValue({success:true,tripId:trip.id,score:{state:'failed',retryable:true}})
 await flow.saveRecordedTrip(trip);await flow.skipFeedback(trip.id)
 const {readEntries}=await import('./followUpStore.js')
 expect((await readEntries())[0]).toMatchObject({feedbackComplete:true,feedbackToken:trip.feedbackToken})
 expect((await readEntries())[0].trip).toBeUndefined()
 scoring.retryScore.mockResolvedValue({success:true,tripId:trip.id,score:ready})
 await flow.retryAnalysis(trip.id)
 expect(await readEntries()).toEqual([])
 expect(flow.getFollowUpSnapshot().results[0].score.baselineScore).toBe(81)
 expect(JSON.stringify(flow.getFollowUpSnapshot().results)).not.toContain(trip.feedbackToken)
})
test('ready result survives reload and feedback success cleans the capability only when scoring is complete',async()=>{
 upload.uploadTrip.mockResolvedValue({success:true,tripId:trip.id,score:ready})
 await flow.saveRecordedTrip(trip)
 feedback.submitTripFeedback.mockResolvedValue({success:true})
 await flow.sendFeedback(trip.id,{},'')
 await vi.waitFor(()=>expect(flow.getFollowUpSnapshot().entries).toEqual([]))
 vi.resetModules();const restored=await import('./followUps.js');await restored.initializeFollowUps()
 expect(restored.getFollowUpSnapshot().entries).toEqual([])
 expect(restored.getFollowUpSnapshot().results[0].score.baselineScore).toBe(81)
})
test('score retry is separate from upload and duplicate actions share one request',async()=>{
 upload.uploadTrip.mockResolvedValue({success:true,tripId:trip.id,score:{state:'failed',retryable:true}})
 await flow.saveRecordedTrip(trip)
 scoring.retryScore.mockResolvedValue({success:true,tripId:trip.id,score:ready})
 await Promise.all([flow.retryAnalysis(trip.id),flow.retryAnalysis(trip.id)])
 expect(scoring.retryScore).toHaveBeenCalledOnce();expect(upload.uploadTrip).toHaveBeenCalledOnce()
})
test('skipping feedback during result archival cannot resurrect a draft or capability',async()=>{
 upload.uploadTrip.mockResolvedValue({success:true,tripId:trip.id,score:{state:'processing'}})
 await flow.saveRecordedTrip(trip)
 const store=await import('./followUpStore.js');const original=store.putResult
 let release, held=false
 vi.spyOn(store,'putResult').mockImplementation(async result=>{await original(result);if(!held){held=true;await new Promise(resolve=>{release=resolve})}})
 scoring.getScoreStatus.mockResolvedValue({success:true,tripId:trip.id,score:ready})
 const finishing=flow.refreshScore(trip.id)
 await vi.waitFor(()=>expect(release).toBeTypeOf('function'))
 const skipping=flow.skipFeedback(trip.id)
 release();await Promise.all([finishing,skipping])
 expect(flow.getFollowUpSnapshot().entries).toEqual([])
 expect(await store.readEntries()).toEqual([])
})
