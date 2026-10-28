import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { uploadTrip } from './upload.js'
import { supabase } from './supabase.js'
vi.mock('./supabase.js',()=>({supabase:{from:vi.fn(),rpc:vi.fn()}}))
const trip={id:'877f6a92-fa06-4b3a-a967-57b72f54cd59',feedbackToken:'a'.repeat(64),startedAt:'2026-10-07T10:00:00.000Z',
 endedAt:'2026-10-07T10:00:01.250Z',durationSeconds:1.25,motionCount:1,locationCount:1,readings:[{type:'motion'},{type:'location'}]}
const saved={tripId:trip.id,tripSaved:true,policyVersion:'experimental-ride-smoothness/1.0.0',score:{state:'pending',retryable:true}}
const response=data=>({ok:true,json:async()=>data})
beforeEach(()=>{
 vi.resetAllMocks();vi.stubGlobal('fetch',vi.fn())
 supabase.rpc.mockReturnValue({abortSignal:()=>Promise.resolve({data:'missing',error:null})})
})
afterEach(()=>vi.unstubAllGlobals())
test('single upload preserves raw snapshot and identity; capability is header-only',async()=>{
 fetch.mockResolvedValue(response(saved))
 const result=await uploadTrip(trip)
 expect(result.success).toBe(true);expect(result.tripId).toBe(trip.id)
 expect(fetch).toHaveBeenCalledOnce();expect(fetch.mock.calls[0][0]).toBe('/api/trips')
 const options=fetch.mock.calls[0][1],body=JSON.parse(options.body)
 expect(body).toEqual({...trip,feedbackToken:undefined,metadata:null})
 expect(options.body).not.toContain(trip.feedbackToken)
 expect(options.headers.Authorization).toBe('Bearer '+trip.feedbackToken)
 expect(options.headers['X-Trip-Input-Fingerprint']).toMatch(/^[a-f0-9]{64}$/)
 expect(supabase.from).not.toHaveBeenCalled()
})
test('preserves supplied metadata without sending service credentials',async()=>{
 fetch.mockResolvedValue(response(saved));await uploadTrip({...trip,metadata:{app:'TripSense'}})
 expect(JSON.parse(fetch.mock.calls[0][1].body).metadata).toEqual({app:'TripSense'})
})
test('a lost upload response recovers by capability and fingerprint without raw re-upload',async()=>{
 fetch.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(response(saved))
 expect((await uploadTrip(trip)).success).toBe(true)
 expect(fetch.mock.calls.map(([url])=>url)).toEqual(['/api/trips',`/api/trips/${trip.id}/score`])
 expect(fetch.mock.calls[1][1].body).toBeUndefined()
})
test('retry checks persistence first and uses no duplicate upload when found',async()=>{
 fetch.mockResolvedValue(response(saved))
 expect((await uploadTrip(trip,{recoverFirst:true})).success).toBe(true)
 expect(fetch).toHaveBeenCalledOnce();expect(fetch.mock.calls[0][1].method).toBe('GET')
})
test('identity conflicts and access failures are not treated as a successful save',async()=>{
 for(const code of ['conflict','forbidden']){
  fetch.mockResolvedValue({ok:false,json:async()=>({error:{code,message:'Denied'}})})
  expect((await uploadTrip(trip)).success).toBe(false)
 }
 expect(supabase.rpc).not.toHaveBeenCalled()
})
test('unavailable service keeps upload failed when no capability confirms persistence',async()=>{
 fetch.mockRejectedValue(new Error('private connection details'))
 const result=await uploadTrip(trip)
 expect(result.success).toBe(false);expect(JSON.stringify(result)).not.toContain('private connection details')
})
test('capability-confirmed legacy save retains analysis recovery rather than raw data',async()=>{
 fetch.mockRejectedValue(new Error('offline'))
 supabase.rpc.mockReturnValue({abortSignal:()=>Promise.resolve({data:'trip_saved',error:null})})
 const result=await uploadTrip(trip)
 expect(result.success).toBe(true);expect(result.score.state).toBe('failed');expect(result.score.retryable).toBe(true)
 expect(supabase.rpc).toHaveBeenCalledWith('trip_feedback_state',{p_trip_id:trip.id,p_feedback_token:trip.feedbackToken})
})
test('missing identity cannot create an unassociated trip',async()=>{
 expect((await uploadTrip({...trip,id:undefined})).success).toBe(false);expect(fetch).not.toHaveBeenCalled()
})
