import { spawn } from 'node:child_process'
import { writeFile, mkdir } from 'node:fs/promises'
import { startTestDatabase } from './scoring-test-database.mjs'
const database=await startTestDatabase()
try {
 const child=spawn('.venv-scoring/Scripts/python.exe',['scripts/benchmark-live-scoring.py'],{
  windowsHide:true,env:{...process.env,SCORING_SUPABASE_URL:database.url,SCORING_SUPABASE_SERVICE_KEY:'local-test-service-key',SCORING_ALLOW_LOCAL_HTTP:'1'},stdio:['ignore','pipe','pipe'],
 })
 let output='',errors=''
 child.stdout.on('data',x=>{output+=x});child.stderr.on('data',x=>{errors+=x})
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)})
 if(code!==0)throw new Error('Isolated benchmark failed: '+errors)
 const result=JSON.parse(output)
 result.database_rpc_measurements=database.metrics
 await mkdir('analysis/live_baseline_phase2',{recursive:true})
 await writeFile('analysis/live_baseline_phase2/benchmarks.json',JSON.stringify(result,null,2)+'\n')
 console.log(JSON.stringify(result.results.map(r=>({fixture:r.fixture,readings:r.readings,payload_bytes:r.payload_bytes,baseline_score:r.baseline_score,median_ms:r.median_ms})),null,2))
}finally{await database.close()}
