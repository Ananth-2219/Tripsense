import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('./upload.js',()=>({uploadTrip:vi.fn()}))
vi.mock('./feedback.js',()=>({submitTripFeedback:vi.fn(),getTripFeedbackState:vi.fn()}))
vi.mock('./scoring.js',()=>({getScoreStatus:vi.fn(),retryScore:vi.fn(),finalizeScore:vi.fn()}))
let flow,upload,feedback,scoring,store
const trip={id:'877f6a92-fa06-4b3a-a967-57b72f54cd59',feedbackToken:'a'.repeat(64),endedAt:'2026-10-27T00:00:01Z',readings:[{type:'motion',x:1}]}
const ready={state:'ready',status:'provisional',baselineScore:81,components:{A:80,J:82,R:81},retryable:false,contextual:{state:'not_requested'}}
const final={...ready,status:'final',contextual:{state:'final',policyVersion:'experimental-contextual-scoring/3.0.0',sensorScore:80,finalScore:77,feedbackAccepted:true,weights:{A:.4,J:.4,R:.2}}}
const reply=score=>({success:true,tripId:trip.id,score})
beforeEach(async()=>{
 vi.resetModules();vi.stubGlobal('indexedDB',new IDBFactory())
 upload=await import('./upload.js');feedback=await import('./feedback.js');scoring=await import('./scoring.js')
 upload.uploadTrip.mockReset();feedback.submitTripFeedback.mockReset();feedback.getTripFeedbackState.mockReset()
 scoring.getScoreStatus.mockReset();scoring.retryScore.mockReset();scoring.finalizeScore.mockReset()
 feedback.getTripFeedbackState.mockResolvedValue('trip_saved');feedback.submitTripFeedback.mockResolvedValue({success:true})
 upload.uploadTrip.mockResolvedValue(reply(ready));scoring.finalizeScore.mockResolvedValue(reply(final));scoring.getScoreStatus.mockResolvedValue(reply(ready))
 flow=await import('./followUps.js');store=await import('./followUpStore.js');await flow.initializeFollowUps()
})
test('accepted feedback automatically finalizes and archives final without raw/token retention',async()=>{
 await flow.saveRecordedTrip(trip);await flow.sendFeedback(trip.id,{},'')
 await vi.waitFor(()=>expect(flow.getFollowUpSnapshot().entries).toEqual([]))
 expect(scoring.finalizeScore).toHaveBeenCalledOnce();expect(feedback.submitTripFeedback).toHaveBeenCalledOnce()
 expect((await store.readResults())[0].score.status).toBe('final')
 expect(JSON.stringify(await store.readResults())).not.toContain(trip.feedbackToken)
})
test('Skip keeps provisional, never requests finalization and never invents answers',async()=>{
 await flow.saveRecordedTrip(trip);await flow.skipFeedback(trip.id)
 expect(scoring.finalizeScore).not.toHaveBeenCalled();expect(feedback.submitTripFeedback).not.toHaveBeenCalled()
 expect((await store.readResults())[0].score.status).toBe('provisional');expect(await store.readEntries()).toEqual([])
})
test('failed finalization keeps baseline, accepted feedback and capability; retry never resubmits',async()=>{
 scoring.finalizeScore.mockResolvedValueOnce({success:false,error:{message:'Offline'}})
 await flow.saveRecordedTrip(trip);await flow.sendFeedback(trip.id,{},'')
 await vi.waitFor(()=>expect(flow.getFollowUpSnapshot().entries[0].score.contextual.state).toBe('failed'))
 expect((await store.readEntries())[0]).toMatchObject({feedbackComplete:true,feedbackDisposition:'submitted',feedbackToken:trip.feedbackToken})
 expect((await store.readEntries())[0].score.baselineScore).toBe(81)
 await flow.retryFinalization(trip.id)
 expect(feedback.submitTripFeedback).toHaveBeenCalledOnce();expect(await store.readEntries()).toEqual([])
})
test('accepted feedback before baseline waits then finalizes after ready',async()=>{
 upload.uploadTrip.mockResolvedValue(reply({...ready,state:'processing',baselineScore:null}))
 scoring.finalizeScore.mockResolvedValueOnce(reply({...ready,state:'processing',baselineScore:null,contextual:{state:'waiting_for_baseline',feedbackAccepted:true}}))
 await flow.saveRecordedTrip(trip);await flow.sendFeedback(trip.id,{},'')
 await vi.waitFor(()=>expect(flow.getFollowUpSnapshot().entries[0].score.contextual.state).toBe('waiting_for_baseline'))
 await flow.refreshScore(trip.id)
 await vi.waitFor(()=>expect(flow.getFollowUpSnapshot().entries).toEqual([]))
 expect(scoring.finalizeScore).toHaveBeenCalledTimes(2)
})
test('duplicate Submit and finalization actions share requests independently',async()=>{
 await flow.saveRecordedTrip(trip)
 await Promise.all([flow.sendFeedback(trip.id,{},''),flow.sendFeedback(trip.id,{},'')])
 await vi.waitFor(()=>expect(flow.getFollowUpSnapshot().entries).toEqual([]))
 expect(feedback.submitTripFeedback).toHaveBeenCalledOnce();expect(scoring.finalizeScore).toHaveBeenCalledOnce()
})
test('refresh reconciles a submission accepted just before the browser closed',async()=>{
 await flow.saveRecordedTrip(trip)
 const entry=(await store.readEntries())[0]
 await store.putEntry({...entry,feedbackIntent:'submitting',answers:{phone_placement:'pocket'}})
 feedback.getTripFeedbackState.mockResolvedValue('submitted')
 vi.resetModules();flow=await import('./followUps.js');await flow.initializeFollowUps()
 await vi.waitFor(()=>expect(flow.getFollowUpSnapshot().results[0].score.status).toBe('final'))
 expect(feedback.submitTripFeedback).not.toHaveBeenCalled();expect(await store.readEntries()).toEqual([])
})
test('already accepted feedback is authoritative and never overwritten by a new draft',async()=>{
 await flow.saveRecordedTrip(trip);feedback.getTripFeedbackState.mockResolvedValue('submitted')
 await flow.sendFeedback(trip.id,{phone_placement:'hand'},'new draft')
 await vi.waitFor(()=>expect(flow.getFollowUpSnapshot().results[0].score.status).toBe('final'))
 expect(feedback.submitTripFeedback).not.toHaveBeenCalled();expect(scoring.finalizeScore).toHaveBeenCalledOnce()
})
test('stale provisional response cannot replace a final result',async()=>{
 await flow.saveRecordedTrip(trip)
 let release
 scoring.getScoreStatus.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}))
 const refreshing=flow.refreshScore(trip.id)
 await vi.waitFor(()=>expect(release).toBeTypeOf('function'))
 await flow.sendFeedback(trip.id,{},'')
 await vi.waitFor(()=>expect(flow.getFollowUpSnapshot().entries).toEqual([]))
 release(reply(ready));await refreshing
 expect(flow.getFollowUpSnapshot().results[0].score.status).toBe('final')
})
test('capability is retained until the compact result is durably archived',async()=>{
 await flow.saveRecordedTrip(trip)
 const original=store.putResult;let release
 vi.spyOn(store,'putResult').mockImplementation(async result=>{await new Promise(resolve=>{release=resolve});await original(result)})
 const skipping=flow.skipFeedback(trip.id)
 await vi.waitFor(()=>expect(release).toBeTypeOf('function'))
 expect((await store.readEntries())[0].feedbackToken).toBe(trip.feedbackToken)
 release();await skipping;expect(await store.readEntries()).toEqual([])
})
test('a verified final remains final during archive failure and offline recovery attempts',async()=>{
 vi.spyOn(store,'putResult').mockRejectedValue(new Error('Device quota exceeded'))
 await flow.saveRecordedTrip(trip);await flow.sendFeedback(trip.id,{},'')
 await vi.waitFor(()=>expect(flow.getFollowUpSnapshot().entries[0].score.status).toBe('final'))
 scoring.finalizeScore.mockResolvedValue({success:false,error:{message:'Offline'}})
 scoring.getScoreStatus.mockResolvedValue({success:false,error:{message:'Offline'}})
 await flow.retryFinalization(trip.id);await flow.refreshScore(trip.id)
 expect(flow.getFollowUpSnapshot().entries[0].score).toMatchObject({status:'final',state:'ready',contextual:{state:'final'}})
 expect((await store.readEntries())[0].feedbackToken).toBe(trip.feedbackToken)
})
test('an exhausted baseline makes the requested final unavailable without inventing a score',async()=>{
 upload.uploadTrip.mockResolvedValue(reply({...ready,state:'processing',baselineScore:null}))
 scoring.finalizeScore.mockResolvedValue(reply({...ready,state:'processing',baselineScore:null,contextual:{state:'waiting_for_baseline',feedbackAccepted:true}}))
 await flow.saveRecordedTrip(trip);await flow.sendFeedback(trip.id,{},'')
 await vi.waitFor(()=>expect(flow.getFollowUpSnapshot().entries[0].score.contextual.state).toBe('waiting_for_baseline'))
 scoring.getScoreStatus.mockResolvedValue(reply({...ready,state:'failed',baselineScore:null,retryable:false,attempts:3}))
 await flow.refreshScore(trip.id)
 expect(flow.getFollowUpSnapshot().entries).toEqual([])
 expect((await store.readResults())[0].score).toMatchObject({status:'provisional',baselineScore:null,contextual:{state:'unavailable'}})
})
