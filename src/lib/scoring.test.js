import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { getScoreStatus, retryScore, finalizeScore } from './scoring.js'
const id='877f6a92-fa06-4b3a-a967-57b72f54cd59',token='a'.repeat(64)
const ready={tripId:id,tripSaved:true,policyVersion:'experimental-ride-smoothness/1.0.0',score:{state:'ready',baselineScore:80,components:{A:75,J:81,R:86},status:'provisional',quality:{},retryable:false}}
beforeEach(()=>vi.stubGlobal('fetch',vi.fn()))
afterEach(()=>vi.unstubAllGlobals())
test('status is capability-authorized and never puts the token in a URL',async()=>{
 fetch.mockResolvedValue({ok:true,json:async()=>ready})
 const r=await getScoreStatus(id,token,'b'.repeat(64))
 expect(r.success).toBe(true)
 expect(fetch.mock.calls[0][0]).toBe(`/api/trips/${id}/score`)
 expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${token}`)
 expect(fetch.mock.calls[0][1].headers['X-Trip-Input-Fingerprint']).toBe('b'.repeat(64))
})
test('retry sends no raw readings and validates returned identity',async()=>{
 fetch.mockResolvedValue({ok:true,json:async()=>({...ready,tripId:'wrong'})})
 expect((await retryScore(id,token)).success).toBe(false)
 expect(fetch.mock.calls[0][1].method).toBe('POST')
 expect(fetch.mock.calls[0][1].body).toBeUndefined()
})
test('no invented ready score for invalid server values or unavailable data',async()=>{
 fetch.mockResolvedValue({ok:true,json:async()=>({...ready,score:{...ready.score,baselineScore:null}})})
 expect((await getScoreStatus(id,token)).success).toBe(false)
 fetch.mockResolvedValue({ok:true,json:async()=>({...ready,score:{state:'unavailable',baselineScore:null,components:{A:null,J:null,R:null},reason:'No motion',retryable:false}})})
 expect((await getScoreStatus(id,token)).score.baselineScore).toBeNull()
})
test('finalization sends no answers or readings and validates final policy and numbers',async()=>{
 const final={...ready,score:{...ready.score,status:'final',contextual:{state:'final',policyVersion:'experimental-contextual-scoring/3.0.0',finalScore:77,sensorScore:79}}}
 fetch.mockResolvedValue({ok:true,json:async()=>final})
 expect((await finalizeScore(id,token)).score.contextual.finalScore).toBe(77)
 expect(fetch.mock.calls[0][0]).toBe(`/api/trips/${id}/score/finalize`)
 expect(fetch.mock.calls[0][1].body).toBeUndefined()
 fetch.mockResolvedValue({ok:true,json:async()=>({...final,score:{...final.score,contextual:{...final.score.contextual,finalScore:101}}})})
 expect((await getScoreStatus(id,token)).success).toBe(false)
})
