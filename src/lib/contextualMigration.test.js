import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, afterAll, expect, test } from 'vitest'
let db
const id='4bd29975-712a-41a4-a40a-c42f94d7c510',token='a'.repeat(64),fingerprint='b'.repeat(64)
const policyHash='e4d40140853da4b7731b3d8ee1e6ce89469ae4a9c2fd4613a9cfb3a9801d2483'
const answers={phone_placement:'pocket',phone_stability:'slight_movement',road_conditions:'mixed',traffic_conditions:'moderate',driving_smoothness:'mixed',sudden_maneuvers:'braking',unusual_events:'near_miss'}
const trip={id,started_at:'2026-10-27T00:00:00Z',ended_at:'2026-10-27T00:00:01Z',duration_seconds:1,motion_count:0,location_count:0,readings:[],metadata:null}
beforeAll(async()=>{
 db=new PGlite()
 for(const file of ['tests/fixtures/scoring_schema.sql','supabase/migrations/20261026000000_trip_feedback.sql','supabase/migrations/20261027162918_live_baseline_scoring.sql','supabase/migrations/20261027180012_live_contextual_scoring.sql'])await db.exec(await readFile(file,'utf8'))
 await db.exec('ALTER TABLE public.trip_scores ADD CONSTRAINT trip_scores_feedback_id_fkey FOREIGN KEY(feedback_id) REFERENCES public.trip_feedback(id) ON DELETE SET NULL')
},30000)
afterAll(async()=>{await db?.close()})
async function call(name,args,role='service_role'){
 await db.exec(`SET ROLE ${role}`)
 try{return (await db.query(`SELECT public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS result`,args)).rows[0].result}
 finally{await db.exec('RESET ROLE')}
}
async function setup(tripId=id){
 await call('live_baseline_ingest',[{...trip,id:tripId},token,fingerprint])
 await db.query(`UPDATE public.trip_scores SET baseline_score=80,acceleration_score=75,jerk_score=81,rotation_score=85,
 quality_details=quality_details||'{"feature_summary":{"acceleration":{"mean":1}},"processing":{"state":"ready","attempts":1}}',
 context_details='{"policy_sha256":"baseline-original"}' WHERE trip_id=$1`,[tripId])
 await call('submit_trip_feedback',[tripId,token,answers,'accepted first'],'anon')
 return call('live_contextual_get',[tripId,token])
}
const result={policy_version:'experimental-contextual-scoring/3.0.0',policy_sha256:policyHash,contextual_sensor_score:79.8,contextual_weights:{A:.4,J:.4,R:.2},experience_score:65,incident_penalty:1.5,final_feedback_inclusive_score:76.82,sensor_audit:[],experience_audit:{},fallback_fields:[]}
const finish=(source,value=result)=>call('live_contextual_finish',[source.trip.id,token,source.feedback.id,source.source_fingerprint,value])

test('new RPCs and fingerprint helper never grant browser score access',async()=>{
 for(const role of ['anon','authenticated']){
  await expect(call('live_contextual_get',[id,token],role)).rejects.toThrow(/permission denied/i)
  await expect(call('live_contextual_finish',[id,token,id,fingerprint,result],role)).rejects.toThrow(/permission denied/i)
 }
 expect((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.trip_scores'::regclass")).rows[0].relrowsecurity).toBe(true)
})
test('trusted accepted feedback is retrieved without raw readings or comments',async()=>{
 const source=await setup()
 expect(source.feedback.trip_id).toBe(id);expect(source.feedback.perceived_smoothness).toBe('mixed')
 expect(source.feedback.comments).toBeUndefined();expect(source.readings).toBeUndefined()
 expect(source.source_fingerprint).toMatch(/^[a-f0-9]{64}$/)
 await call('submit_trip_feedback',[id,token,{...answers,driving_smoothness:'rough'},'replacement'],'anon')
 expect((await call('live_contextual_get',[id,token])).feedback.perceived_smoothness).toBe('mixed')
})
test('invalid capabilities and feedback from another trip are denied',async()=>{
 const source=await call('live_contextual_get',[id,token])
 await expect(call('live_contextual_get',[id,'c'.repeat(64)])).rejects.toThrow(/access denied/i)
 await expect(call('live_contextual_finish',[id,'c'.repeat(64),source.feedback.id,source.source_fingerprint,result])).rejects.toThrow(/access denied/i)
 await expect(call('live_contextual_finish',[id,token,id,source.source_fingerprint,result])).rejects.toThrow(/feedback/i)
})
test('accepted-source fingerprints are deterministic across database session timezones',async()=>{
 const utc=(await call('live_contextual_get',[id,token])).source_fingerprint
 await db.exec("SET TIME ZONE 'Asia/Kolkata'")
 try{expect((await call('live_contextual_get',[id,token])).source_fingerprint).toBe(utc)}
 finally{await db.exec("SET TIME ZONE 'UTC'")}
})
test('changed source snapshot or policy and invalid outputs cannot finalize',async()=>{
 const source=await call('live_contextual_get',[id,token])
 await expect(call('live_contextual_finish',[id,token,source.feedback.id,'d'.repeat(64),result])).rejects.toThrow(/identity/i)
 for(const value of [{...result,policy_sha256:'d'.repeat(64)},{...result,final_feedback_inclusive_score:101},{...result,contextual_weights:{A:1,J:1,R:1}}])await expect(finish(source,value)).rejects.toThrow(/invalid/i)
 expect((await call('live_contextual_get',[id,token])).score.score_status).toBe('provisional')
})
test('one atomic final row preserves baseline features and audit; repeated finishes are immutable',async()=>{
 const source=await call('live_contextual_get',[id,token]);const before=source.score
 const saved=await finish(source),again=await finish(source,{...result,final_feedback_inclusive_score:10})
 expect(saved.score).toEqual(again.score)
 expect(saved.score.score_status).toBe('final');expect(saved.score.feedback_id).toBe(source.feedback.id)
 expect(saved.score.policy_version).toBe('experimental-ride-smoothness/1.0.0')
 for(const key of ['baseline_score','acceleration_score','jerk_score','rotation_score','baseline_weights','quality_details'])expect(saved.score[key]).toEqual(before[key])
 expect(saved.score.context_details.policy_sha256).toBe('baseline-original')
 expect(saved.score.context_details.contextual_v3.policy_version).toBe(result.policy_version)
 expect((await db.query('SELECT count(*)::int n FROM public.trip_scores WHERE trip_id=$1',[id])).rows[0].n).toBe(1)
})
test('baseline late finish and retries cannot replace contextual finalization',async()=>{
 const before=(await call('live_baseline_get',[id,token,false])).score
 expect(await call('live_baseline_finish',[id,token,fingerprint,id,{state:'failed'}])).toBe(false)
 expect(await call('live_baseline_claim',[id,token,fingerprint,id])).toEqual({claimed:false})
 expect((await call('live_baseline_get',[id,token,false])).score).toEqual(before)
})
test('two requests holding the same source snapshot converge on one unchanged final row',async()=>{
 const other='4bd29975-712a-41a4-a40a-c42f94d7c511',first=await setup(other),second=await call('live_contextual_get',[other,token])
 const a=await finish(first),b=await finish(second)
 expect(a.score).toEqual(b.score)
})
test('a finalized row cannot be silently reused after its accepted feedback changes',async()=>{
 const source=await call('live_contextual_get',[id,token])
 await db.query('UPDATE public.trip_feedback SET comments=$1 WHERE trip_id=$2',['administrative change',id])
 await expect(finish(source)).rejects.toThrow(/identity/i)
})
