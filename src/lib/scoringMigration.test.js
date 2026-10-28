import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, afterAll, expect, test } from 'vitest'
let db
const id='e5acdeab-e19a-49a7-abca-fbc2620baa01', token='a'.repeat(64), fingerprint='b'.repeat(64)
const lease='e5acdeab-e19a-49a7-abca-fbc2620baa02'
const trip={id,started_at:'2026-10-27T00:00:00Z',ended_at:'2026-10-27T00:00:01Z',duration_seconds:1,motion_count:2,location_count:0,
 readings:[{type:'motion',timestamp:1,x:1},{type:'motion',timestamp:101,x:2}],metadata:null}
beforeAll(async()=>{
 db=new PGlite()
 await db.exec(await readFile('tests/fixtures/scoring_schema.sql','utf8'))
 await db.exec(await readFile('supabase/migrations/20261027162918_live_baseline_scoring.sql','utf8'))
},30000)
afterAll(async()=>{await db?.close()})
async function call(name,args,role='service_role') {
 await db.exec(`SET ROLE ${role}`)
 try {const {rows}=await db.query(`SELECT public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS result`,args);return rows[0].result}
 finally {await db.exec('RESET ROLE')}
}
test('RPCs are service-only, and score table remains default-deny',async()=>{
 for(const role of ['anon','authenticated']){
  await expect(call('live_baseline_ingest',[trip,token,fingerprint],role)).rejects.toThrow(/permission denied/i)
  await db.exec(`SET ROLE ${role}`)
  try {await expect(db.query('SELECT * FROM public.trip_scores')).rejects.toThrow(/permission denied/i)}finally{await db.exec('RESET ROLE')}
 }
})
test('single ingest is idempotent and never persists the raw capability',async()=>{
 await call('live_baseline_ingest',[trip,token,fingerprint]);await call('live_baseline_ingest',[trip,token,fingerprint])
 expect((await db.query('SELECT count(*)::int AS n FROM public.trips')).rows[0].n).toBe(1)
 expect((await db.query('SELECT count(*)::int AS n FROM public.trip_scores')).rows[0].n).toBe(1)
 const row=(await db.query('SELECT * FROM public.trips')).rows[0]
 expect(JSON.stringify(row)).not.toContain(token)
 expect(row.readings).toEqual(trip.readings)
})
test('wrong token cannot inspect, retry, or collide with an existing trip',async()=>{
 await expect(call('live_baseline_get',[id,'c'.repeat(64),false])).rejects.toThrow(/access denied/i)
 await expect(call('live_baseline_ingest',[trip,'c'.repeat(64),fingerprint])).rejects.toThrow(/access denied/i)
 await expect(call('live_baseline_claim',[id,'c'.repeat(64),fingerprint,lease])).rejects.toThrow(/access denied/i)
})
test('same identity with different input cannot overwrite recordings or scores',async()=>{
 await expect(call('live_baseline_ingest',[{...trip,readings:[...trip.readings].reverse()},token,fingerprint])).rejects.toThrow(/identity/i)
 await expect(call('live_baseline_ingest',[trip,token,'d'.repeat(64)])).rejects.toThrow(/identity/i)
 expect((await db.query('SELECT readings FROM public.trips')).rows[0].readings).toEqual(trip.readings)
})
test('lease suppresses concurrent claims and stale writers; persistence is retrievable',async()=>{
 expect(await call('live_baseline_claim',[id,token,fingerprint,lease])).toEqual({claimed:true})
 expect(await call('live_baseline_claim',[id,token,fingerprint,'e5acdeab-e19a-49a7-abca-fbc2620baa03'])).toEqual({claimed:false})
 expect(await call('live_baseline_finish',[id,token,fingerprint,'e5acdeab-e19a-49a7-abca-fbc2620baa04',{state:'ready',baseline_score:100}])).toBe(false)
 const result={state:'ready',baseline_score:80,acceleration_score:75,jerk_score:81,rotation_score:86,quality_details:{feature_summary:{mean:1}},audit:{policy_sha256:'frozen'}}
 expect(await call('live_baseline_finish',[id,token,fingerprint,lease,result])).toBe(true)
 const saved=await call('live_baseline_get',[id,token,false])
 expect(Number(saved.score.baseline_score)).toBe(80)
 expect(saved.readings).toBeNull()
 expect(saved.score.final_score).toBeNull()
 expect(saved.score.quality_details.feature_summary).toEqual({mean:1})
})
test('late provisional completion never replaces finalized score',async()=>{
 await db.query("UPDATE public.trip_scores SET score_status='final',final_score=88 WHERE trip_id=$1",[id])
 const before=(await db.query('SELECT * FROM public.trip_scores')).rows
 expect(await call('live_baseline_claim',[id,token,fingerprint,lease])).toEqual({claimed:false})
 expect(await call('live_baseline_finish',[id,token,fingerprint,lease,{state:'failed'}])).toBe(false)
 await call('live_baseline_ingest',[trip,token,fingerprint])
 expect((await db.query('SELECT * FROM public.trip_scores')).rows).toEqual(before)
})

test('expired leases are reclaimable, attempts capped, and stale results rejected',async()=>{
 const retryId='e5acdeab-e19a-49a7-abca-fbc2620baa11'
 await call('live_baseline_ingest',[{...trip,id:retryId},token,fingerprint])
 for(let attempt=1;attempt<=3;attempt++){
  expect(await call('live_baseline_claim',[retryId,token,fingerprint,lease])).toEqual({claimed:true})
  const score=(await call('live_baseline_get',[retryId,token,false])).score
  expect(score.quality_details.processing.attempts).toBe(attempt)
  if(attempt===1){
   await expect(call('live_baseline_finish',[retryId,token,fingerprint,lease,{state:'ready',baseline_score:101,acceleration_score:1,jerk_score:1,rotation_score:1}])).rejects.toThrow(/score bounds/i)
   await db.query("UPDATE public.trip_scores SET quality_details=jsonb_set(quality_details,'{processing,lease_until}',to_jsonb((now()-interval '1 second')::text)) WHERE trip_id=$1",[retryId])
  }else{
   expect(await call('live_baseline_finish',[retryId,token,fingerprint,lease,{state:'failed',reason:'test interruption'}])).toBe(true)
  }
 }
 expect(await call('live_baseline_claim',[retryId,token,fingerprint,lease])).toEqual({claimed:false})
 expect(await call('live_baseline_finish',[retryId,token,fingerprint,lease,{state:'unavailable'}])).toBe(false)
})
