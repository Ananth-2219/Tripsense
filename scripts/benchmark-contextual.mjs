import { spawn } from 'node:child_process'
import { readFile,writeFile,mkdir } from 'node:fs/promises'
import { createHash,randomUUID } from 'node:crypto'
import { startTestDatabase } from './scoring-test-database.mjs'
const database=await startTestDatabase(),cases=[],token='a'.repeat(64)
try{
 const paths=[['learner','analysis/two_trip_scoring/v3/17b5188c-8d2f-4911-a4cd-4f5903c41027.json'],['third','analysis/two_trip_scoring/v3/785e2229-ead3-44ca-ba0a-3fe24194d7a9.json'],['bus','analysis/bus_scoring/v3/bus_result.json']]
 for(const [fixture,path] of paths){
  const golden=JSON.parse(await readFile(path,'utf8'))
  for(let repetition=0;repetition<3;repetition++){
   const id=randomUUID(),fingerprint=createHash('sha256').update(id).digest('hex'),hash=createHash('sha256').update(token).digest('hex')
   await database.query("INSERT INTO public.trips(id,started_at,ended_at,duration_seconds,motion_count,location_count,readings,metadata) VALUES($1,now()-interval '1 second',now(),1,0,0,'[]',$2)",[id,{feedback_token_hash:hash}])
   const feedback=golden.feedback
   await database.query('INSERT INTO public.trip_feedback(trip_id,phone_placement,phone_movement,road_condition,traffic_condition,perceived_smoothness,reported_maneuvers,unusual_event,comments,submitted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,\'\',now())',
    [id,feedback.phone_placement,feedback.phone_movement,feedback.road_condition,feedback.traffic_condition,feedback.perceived_smoothness,feedback.reported_maneuvers,feedback.unusual_event])
   await database.query("INSERT INTO public.trip_scores(trip_id,policy_version,baseline_score,acceleration_score,jerk_score,rotation_score,baseline_weights,quality_details,context_details) VALUES($1,'experimental-ride-smoothness/1.0.0',$2,$3,$4,$5,$6,$7,$8)",
    [id,golden.baseline_score,golden.components.A,golden.components.J,golden.components.R,golden.baseline_weights,{input_fingerprint:fingerprint,processing:{state:'ready',attempts:1},feature_summary:{source:'Validated historical baseline; benchmark never extracts raw'}},{policy_sha256:'preserved-baseline-audit'}])
   cases.push({id,fingerprint,fixture,source_trip_id:golden.trip_id,expected_final:golden.final_feedback_inclusive_score})
  }
 }
 const child=spawn('.venv-scoring/Scripts/python.exe',['scripts/benchmark-contextual.py'],{windowsHide:true,
  env:{...process.env,SCORING_SUPABASE_URL:database.url,SCORING_SUPABASE_SERVICE_KEY:'local-test-service-key',SCORING_ALLOW_LOCAL_HTTP:'1'},stdio:['pipe','pipe','pipe']})
 let output='',errors='';child.stdout.on('data',x=>{output+=x});child.stderr.on('data',x=>{errors+=x});child.stdin.end(JSON.stringify(cases))
 const code=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject)})
 if(code!==0)throw new Error('Local contextual benchmark failed: '+errors)
 const result=JSON.parse(output);result.database_rpc_measurements=database.metrics
 await mkdir('analysis/live_contextual_phase3',{recursive:true})
 await writeFile('analysis/live_contextual_phase3/benchmarks.json',JSON.stringify(result,null,2)+'\n')
 console.log(JSON.stringify(result.results.map(({samples: _samples,...summary})=>summary),null,2))
}finally{await database.close()}
