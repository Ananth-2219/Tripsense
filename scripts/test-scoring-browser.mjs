// Real React + FastAPI + service-only RPCs in local PostgreSQL. No live writes.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { chromium } from 'playwright'
import { startTestDatabase } from './scoring-test-database.mjs'

const root = process.cwd(), origin = 'http://127.0.0.1:4175', output = path.join(root, '.trip_maps/live-contextual')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let database, backend, vite, browser
let logs = ''
function launch(exe, args, env) {
  const child = spawn(exe, args, { cwd: root, windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', x => { logs += x }); child.stderr.on('data', x => { logs += x }); return child
}
async function ready(url, child) {
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null) throw new Error('Test service exited: ' + logs)
    try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return } catch { /* startup */ }
    await delay(100)
  }
  throw new Error('Local test service did not start')
}
try {
  database = await startTestDatabase()
  backend = launch(path.join(root, '.venv-scoring/Scripts/python.exe'), ['-m', 'uvicorn', 'scoring_service.app:app', '--host', '127.0.0.1', '--port', '8001', '--no-access-log'], {
    SCORING_SUPABASE_URL: database.url, SCORING_SUPABASE_SERVICE_KEY: 'local-test-service-key', SCORING_ALLOW_LOCAL_HTTP: '1',
  })
  await ready('http://127.0.0.1:8001/api/health', backend)
  vite = launch(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4175', '--strictPort'], {
    SCORING_API_PROXY_TARGET: 'http://127.0.0.1:8001', SUPABASE_URL: database.url, SUPABASE_PUBLISHABLE_KEY: 'local-test-public-key',
  })
  await ready(origin, vite)
  browser = await chromium.launch({ headless: true, executablePath: process.env.TRIPSENSE_TEST_BROWSER ?? [
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(existsSync) })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await context.addInitScript(() => {
    window.DeviceMotionEvent = class extends Event {
      constructor(type) { super(type); this.acceleration = { x: 1, y: 2, z: .5 }; this.rotationRate = { alpha: 3, beta: 2, gamma: 1 } }
      static async requestPermission() { return 'granted' }
    }
    const fix = () => ({ timestamp: Date.now(), coords: { latitude: 12, longitude: 77 } })
    Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition: f => f(fix()), watchPosition: f => { f(fix()); return 1 }, clearWatch: () => {} } })
    if (navigator.permissions) navigator.permissions.query = async () => ({ state: 'granted' })
  })
  const blocked = [], errors = []
  await context.route('**/*', route => {
    const host = new URL(route.request().url()).origin
    if ([origin, database.url].includes(host)) return route.continue()
    blocked.push(host); return route.abort()
  })
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message))
  async function ride() {
    await page.getByRole('button', { name: 'Start trip', exact: true }).click()
    await page.getByText('Recording active', { exact: true }).waitFor()
    for (let i = 0; i < 4; i++) { await page.evaluate(() => window.dispatchEvent(new DeviceMotionEvent('devicemotion'))); await delay(120) }
    await page.getByRole('button', { name: 'Stop trip', exact: true }).click()
  }
  database.faults.ingest = 1; database.faults.analysis = 1
  await page.goto(origin); await ride()
  await page.getByRole('button', { name: 'Retry saving trip', exact: true }).waitFor()
  await page.reload()
  await page.getByRole('button', { name: 'Retry saving trip', exact: true }).click()
  await page.getByText('Analyzing ride', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Retry analysis', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Skip questionnaire', exact: true }).click()
  await page.getByText('Questionnaire skipped. Your trip is still saved.', { exact: true }).waitFor()
  await page.reload()
  await page.getByRole('button', { name: 'Retry analysis', exact: true }).click()
  await page.getByText('Provisional ride-smoothness score', { exact: true }).waitFor()
  let stored = (await database.query('SELECT * FROM public.trip_scores ORDER BY computed_at')).rows
  assert.equal(stored.length, 1); assert.ok(Number(stored[0].baseline_score) > 0 && Number(stored[0].baseline_score) <= 100)
  assert.equal(stored[0].policy_version, 'experimental-ride-smoothness/1.0.0')
  assert.equal(stored[0].contextual_sensor_score, null); assert.equal(stored[0].final_score, null)
  assert.equal((await database.query('SELECT count(*)::int AS n FROM public.trips')).rows[0].n, 1)
  const tripId = stored[0].trip_id
  assert.equal((await fetch(`${origin}/api/trips/${tripId}/score`)).status, 401)
  assert.equal((await fetch(`${origin}/api/trips/${tripId}/score`, { headers: { Authorization: 'Bearer ' + 'b'.repeat(64) } })).status, 403)
  const initialRaw = (await database.query('SELECT readings FROM public.trips WHERE id=$1', [tripId])).rows[0].readings
  assert.equal(initialRaw.filter(r => r.type === 'motion').length, 4)
  assert.equal(database.metrics.filter(r => r.rpc === 'live_baseline_ingest').length, 1, 'Recovery/analysis retries must not re-upload the persisted trip')
  await mkdir(output, { recursive: true })
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Overflow ${width}`)
    const card = page.getByRole('region', { name: 'Provisional ride-smoothness score' })
    await card.getByText('Score breakdown', { exact: true }).click()
    assert.ok(await card.getByText('Baseline weights:', { exact: false }).count())
    if ([320, 1440].includes(width)) await page.screenshot({ path: path.join(output, `result-${width}.png`), fullPage: true })
    await card.getByText('Score breakdown', { exact: true }).click()
  }
  await page.reload(); await page.getByText('Provisional ride-smoothness score', { exact: true }).waitFor()
  assert.equal(await page.getByText('How was your ride?', { exact: true }).count(), 0)
  await ride()
  await page.getByRole('heading', { name: 'How was your ride?', exact: true }).waitFor()
  const selections=['pocket','slight_movement','mixed','moderate','mixed','braking','near_miss']
  const groups=await page.getByRole('region', { name: 'How was your ride?', exact: true }).getByRole('group').all()
  for(let i=0;i<groups.length;i++)await groups[i].locator(`input[value="${selections[i]}"]`).check()
  database.faults.finalization=2
  await page.getByRole('button', { name: 'Submit answers', exact: true }).evaluate(button=>{button.click();button.click()})
  await page.getByText('Thank you. Your answers are saved.', { exact: true }).waitFor()
  await page.getByRole('button',{name:'Retry final score',exact:true}).waitFor()
  assert.equal((await database.query('SELECT count(*)::int n FROM public.trip_feedback')).rows[0].n,1)
  const accepted=(await database.query('SELECT * FROM public.trip_feedback')).rows[0]
  const baselineBefore=(await database.query('SELECT * FROM public.trip_scores WHERE trip_id=$1',[accepted.trip_id])).rows[0]
  await page.reload()
  await page.getByRole('button',{name:'Retry final score',exact:true}).waitFor()
  await page.getByRole('button',{name:'Retry final score',exact:true}).click()
  await page.getByRole('heading',{name:'Final ride-smoothness score',exact:true}).waitFor()
  const finalAfter=(await database.query('SELECT * FROM public.trip_scores WHERE trip_id=$1',[accepted.trip_id])).rows[0]
  for(const key of ['baseline_score','acceleration_score','jerk_score','rotation_score','baseline_weights','quality_details'])assert.deepEqual(finalAfter[key],baselineBefore[key])
  assert.equal(finalAfter.feedback_id,accepted.id)
  assert.equal(finalAfter.context_details.contextual_v3.policy_version,'experimental-contextual-scoring/3.0.0')
  assert.notEqual(Number(finalAfter.final_score),Number(finalAfter.baseline_score))
  for(const width of [320,390,768,1024,1440]){
    await page.setViewportSize({width,height:844})
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Final overflow ${width}`)
    const card=page.getByRole('region',{name:'Final ride-smoothness score',exact:true})
    await card.getByText('Score breakdown',{exact:true}).click()
    assert.ok(await card.getByText('Adjusted weights:',{exact:false}).count())
    if([320,1440].includes(width))await page.screenshot({path:path.join(output,`final-${width}.png`),fullPage:true})
    await card.getByText('Score breakdown',{exact:true}).click()
  }
  await page.reload();await page.getByRole('heading',{name:'Final ride-smoothness score',exact:true}).waitFor()
  assert.equal(await page.getByRole('heading',{name:'How was your ride?',exact:true}).count(),0)
  // Feedback accepted while the baseline is still processing must finalize later.
  database.faults.baselineDelayMs=1800
  await ride();await page.getByRole('heading',{name:'How was your ride?',exact:true}).waitFor()
  for(const group of await page.getByRole('region',{name:'How was your ride?',exact:true}).getByRole('group').all())await group.getByRole('radio',{name:'Not sure',exact:true}).check()
  await page.getByRole('button',{name:'Submit answers',exact:true}).click()
  await page.getByRole('heading',{name:'Final ride-smoothness score',exact:true}).nth(1).waitFor()
  stored = (await database.query('SELECT * FROM public.trip_scores')).rows
  assert.equal(stored.length, 3);assert.equal(stored.filter(s=>s.score_status==='final').length,2)
  assert.equal(stored.find(s=>s.trip_id===tripId).score_status,'provisional')
  assert.equal((await database.query('SELECT * FROM public.trip_feedback')).rows.length, 2)
  assert.equal(database.metrics.filter(m=>m.rpc==='submit_trip_feedback').length,2,'Accepted feedback is never resubmitted during finalization recovery')
  assert.deepEqual((await database.query('SELECT readings FROM public.trips WHERE id=$1', [tripId])).rows[0].readings, initialRaw)
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  const result = { passed: true, engine: 'React + real FastAPI + local PGlite RPCs', widths: [320, 390, 768, 1024, 1440],
    uploadFailureReloadRecovery: true, analysisFailureAfterSaveRecovered: true, initialProcessingStateObserved: true,
    noDuplicateRawUploadAfterSave: true, scoreSurvivesReload: true, skipDoesNotPreventScore: true,
    existingQuestionnairePreserved: true, baselineUnchangedByFinalization: true, wrongCapabilityDenied: true,
    finalizationFailureRefreshRetry: true, finalSurvivesReload: true, feedbackBeforeBaselineFinalizes: true,
    duplicateSubmitPrevented: true, skipRemainsProvisional: true, acceptedFeedbackNeverResubmitted: true,
    pageErrors: errors.length, unmockedRemoteRequests: blocked.length }
  await writeFile(path.join(output, 'browser-verification.json'), JSON.stringify(result, null, 2))
  await writeFile(path.join(output, 'rpc-timings.json'), JSON.stringify(database.metrics, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser?.close(); vite?.kill(); backend?.kill(); await database?.close()
}
