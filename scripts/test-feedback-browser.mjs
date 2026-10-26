// Isolated Chrome/Chromium smoke test. Every remote request is intercepted;
// simulated trips and feedback go only to an ephemeral local PostgreSQL engine.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { chromium } from 'playwright'
import { PGlite } from '@electric-sql/pglite'

const root = process.cwd()
const origin = 'http://127.0.0.1:4174'
const database = new PGlite()
let browser
let server
let serverLog = ''
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  await database.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE public.trips(id uuid PRIMARY KEY,started_at timestamptz NOT NULL,ended_at timestamptz,
      duration_seconds double precision,motion_count integer,location_count integer,readings jsonb,metadata jsonb,created_at timestamptz DEFAULT now());
    ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA public TO anon;
    GRANT INSERT, SELECT ON public.trips TO anon;
    CREATE POLICY "Allow trip uploads" ON public.trips FOR INSERT TO anon WITH CHECK(true);`)
  await database.exec(await readFile(path.join(root,'supabase/migrations/20261026000000_trip_feedback.sql'),'utf8'))
  server = spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','4174','--strictPort'], {
    cwd:root,windowsHide:true,env:{...process.env,SUPABASE_URL:'https://tripsense-feedback.invalid',SUPABASE_PUBLISHABLE_KEY:'test-public-key'},stdio:['ignore','pipe','pipe'],
  })
  server.stdout.on('data',value=>{serverLog+=value})
  server.stderr.on('data',value=>{serverLog+=value})
  let ready=false
  for (let attempt=0;attempt<60;attempt++) {
    if (server.exitCode !== null) throw new Error(serverLog)
    try { ready=(await fetch(origin,{signal:AbortSignal.timeout(500)})).ok } catch { /* server starting */ }
    if (ready) break
    await delay(250)
  }
  assert.ok(ready,'Isolated Vite server did not start')
  const executablePath = process.env.TRIPSENSE_TEST_BROWSER ?? [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(candidate=>existsSync(candidate))
  browser = await chromium.launch({headless:true,...(executablePath?{executablePath}:{})})
  const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1})
  await context.addInitScript(()=>{
    window.DeviceMotionEvent = class extends Event {
      constructor(type) { super(type); this.acceleration={x:1,y:2,z:3}; this.rotationRate={alpha:1,beta:2,gamma:3} }
      static async requestPermission() { return 'granted' }
    }
    const fix=()=>({timestamp:Date.now(),coords:{latitude:12,longitude:77}})
    Object.defineProperty(navigator,'geolocation',{value:{
      getCurrentPosition:success=>success(fix()),watchPosition:success=>{success(fix());return 1},clearWatch:()=>{},
    }})
    if (navigator.permissions) navigator.permissions.query=async()=>({state:'granted'})
  })
  const attempts=[]
  const feedbackAttempts=[]
  let failUpload=true
  let loseFeedbackResponse=true
  const blocked=[]
  const headers={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'POST,OPTIONS'}
  await context.route('**/*',async route=>{
    const request=route.request()
    const url=new URL(request.url())
    if (url.origin===origin) return route.continue()
    if (url.hostname!=='tripsense-feedback.invalid') { blocked.push(url.hostname); return route.abort() }
    if (request.method()==='OPTIONS') return route.fulfill({status:204,headers})
    try {
      const body=request.postDataJSON()
      await database.exec('SET ROLE anon')
      if (url.pathname==='/rest/v1/trips') {
        attempts.push(body)
        if (failUpload) { failUpload=false;return route.abort('connectionreset') }
        await database.query(`INSERT INTO public.trips(id,started_at,ended_at,duration_seconds,motion_count,location_count,readings,metadata)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[body.id,body.started_at,body.ended_at,body.duration_seconds,body.motion_count,body.location_count,body.readings,body.metadata])
        return route.fulfill({status:201,headers,body:''})
      }
      if (url.pathname==='/rest/v1/rpc/trip_feedback_state') {
        const {rows}=await database.query('SELECT public.trip_feedback_state($1,$2) AS state',[body.p_trip_id,body.p_feedback_token])
        return route.fulfill({status:200,headers,contentType:'application/json',body:JSON.stringify(rows[0].state)})
      }
      if (url.pathname==='/rest/v1/rpc/submit_trip_feedback') {
        feedbackAttempts.push(body.p_trip_id)
        const {rows}=await database.query('SELECT public.submit_trip_feedback($1,$2,$3,$4) AS saved_at',[body.p_trip_id,body.p_feedback_token,body.p_answers,body.p_comments])
        if (loseFeedbackResponse) {loseFeedbackResponse=false;return route.abort('connectionreset')}
        return route.fulfill({status:200,headers,contentType:'application/json',body:JSON.stringify(rows[0].saved_at)})
      }
      throw new Error('Unexpected test API endpoint')
    } catch(error) {
      return route.fulfill({status:error.code==='23505'?409:400,headers,contentType:'application/json',body:JSON.stringify({code:error.code??'TEST_ERROR',message:'Test request failed'})})
    } finally { await database.exec('RESET ROLE') }
  })
  const page=await context.newPage()
  const errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.goto(origin)
  await page.getByRole('button',{name:'Start trip',exact:true}).click()
  await page.getByText('Recording active',{exact:true}).waitFor()
  await page.evaluate(()=>window.dispatchEvent(new DeviceMotionEvent('devicemotion')))
  await page.getByRole('button',{name:'Stop trip',exact:true}).click()
  await page.getByRole('button',{name:'Retry saving trip',exact:true}).waitFor()
  assert.equal(await page.getByText('How was your ride?',{exact:true}).count(),0)
  await page.reload()
  await page.getByRole('button',{name:'Retry saving trip',exact:true}).click()
  await page.getByRole('heading',{name:'How was your ride?',exact:true}).waitFor()
  assert.equal(attempts.length,2)
  assert.deepEqual(attempts[0],attempts[1],'Retry must preserve every raw value and UUID')
  assert.match(attempts[0].metadata.feedback_token_hash,/^[0-9a-f]{64}$/)
  assert.equal(attempts[0].readings.filter(r=>r.type==='motion').length,1)
  await page.getByRole('button',{name:'Submit answers',exact:true}).click()
  await page.getByRole('alert').filter({hasText:'Please answer all seven'}).waitFor()
  for (const group of await page.getByRole('group').all()) await group.getByRole('radio',{name:'Not sure',exact:true}).check()
  await page.getByLabel('Comments (optional)',{exact:true}).fill('Road works during this test ride.')
  await page.getByRole('button',{name:'Submit later',exact:true}).click()
  await page.reload()
  await page.getByRole('button',{name:'Finish questionnaire',exact:true}).waitFor()
  await page.getByRole('link',{name:'Dashboard',exact:true}).click()
  await page.getByRole('link',{name:'Recorder',exact:true}).click()
  await page.getByRole('button',{name:'Finish questionnaire',exact:true}).click()
  assert.equal(await page.getByLabel('Comments (optional)',{exact:true}).inputValue(),'Road works during this test ride.')
  assert.equal(await page.locator('input[type=radio]:checked').count(),7)
  await mkdir(path.join(root,'.trip_maps/questionnaire'),{recursive:true})
  for (const width of [320,390,768,1024,1440]) {
    await page.setViewportSize({width,height:844})
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),`Horizontal overflow at ${width}px`)
    assert.ok(await page.locator('label:has(input[type=radio])').evaluateAll(labels=>labels.every(label=>label.getBoundingClientRect().height>=44)))
    if ([320,1440].includes(width)) await page.screenshot({path:path.join(root,`.trip_maps/questionnaire/form-${width}.png`),fullPage:true})
  }
  await page.getByRole('button',{name:'Submit answers',exact:true}).click()
  await page.getByRole('alert').filter({hasText:/Could not confirm|Could not save/}).waitFor()
  assert.equal(await page.getByLabel('Comments (optional)',{exact:true}).inputValue(),'Road works during this test ride.')
  await page.getByRole('button',{name:'Submit answers',exact:true}).click()
  await page.getByText('Thank you. Your answers are saved.',{exact:true}).waitFor()
  assert.deepEqual(feedbackAttempts,[attempts[0].id,attempts[0].id])
  const {rows}=await database.query('SELECT * FROM public.trip_feedback')
  assert.equal(rows.length,1)
  assert.equal(rows[0].trip_id,attempts[0].id)
  assert.equal(rows[0].comments,'Road works during this test ride.')
  assert.ok(rows[0].submitted_at)
  await page.reload()
  assert.equal(await page.getByRole('button',{name:'Finish questionnaire',exact:true}).count(),0)
  await page.getByRole('button',{name:'Start trip',exact:true}).click()
  await page.getByText('Recording active',{exact:true}).waitFor()
  await page.getByRole('button',{name:'Stop trip',exact:true}).click()
  await page.getByRole('heading',{name:'How was your ride?',exact:true}).waitFor()
  await page.getByRole('button',{name:'Skip questionnaire',exact:true}).click()
  await page.getByText('Questionnaire skipped. Your trip is still saved.',{exact:true}).waitFor()
  assert.equal((await database.query('SELECT * FROM public.trip_feedback')).rows.length,1)
  assert.equal((await database.query('SELECT * FROM public.trips')).rows.length,2)
  assert.deepEqual(errors,[])
  assert.deepEqual(blocked,[])
  const result={passed:true,engine:'Isolated Chrome/Chromium + local PGlite PostgreSQL',widths:[320,390,768,1024,1440],
    failedUploadRecoveredAfterReload:true,rawSnapshotAndTripIdPreserved:true,deferredDraftRestored:true,
    lostFeedbackResponseRetriedWithoutDuplicate:true,skipCreatesNoFeedback:true,unmockedRemoteRequests:0,pageErrors:0}
  await writeFile(path.join(root,'.trip_maps/questionnaire/browser-verification.json'),JSON.stringify(result,null,2))
  console.log(JSON.stringify(result,null,2))
} finally {
  await browser?.close()
  server?.kill()
  await database.close()
}
