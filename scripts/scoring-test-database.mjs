// Ephemeral PostgreSQL/PostgREST boundary for local tests only. Never contacts Supabase.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { PGlite } from '@electric-sql/pglite'

export async function startTestDatabase() {
  const db = new PGlite()
  await db.exec(await readFile('tests/fixtures/scoring_schema.sql', 'utf8'))
  await db.exec(await readFile('supabase/migrations/20261026000000_trip_feedback.sql', 'utf8'))
  await db.exec(await readFile('supabase/migrations/20261027162918_live_baseline_scoring.sql', 'utf8'))
  await db.exec(await readFile('supabase/migrations/20261027180012_live_contextual_scoring.sql', 'utf8'))
  const metrics = [], faults = { ingest: 0, analysis: 0, finalization: 0, loseFinalizationResponse: 0, baselineDelayMs: 0 }
  const calls = {
    live_baseline_ingest: ['p_trip', 'p_feedback_token', 'p_input_fingerprint'],
    live_baseline_get: ['p_trip_id', 'p_feedback_token', 'p_include_readings'],
    live_baseline_claim: ['p_trip_id', 'p_feedback_token', 'p_input_fingerprint', 'p_lease_id'],
    live_baseline_finish: ['p_trip_id', 'p_feedback_token', 'p_input_fingerprint', 'p_lease_id', 'p_result'],
    live_contextual_get: ['p_trip_id', 'p_feedback_token'],
    live_contextual_finish: ['p_trip_id', 'p_feedback_token', 'p_feedback_id', 'p_source_fingerprint', 'p_result'],
    trip_feedback_state: ['p_trip_id', 'p_feedback_token'],
    submit_trip_feedback: ['p_trip_id', 'p_feedback_token', 'p_answers', 'p_comments'],
  }
  let queue = Promise.resolve()
  function serialized(operation) { const current = queue.then(operation); queue = current.catch(() => {}); return current }
  const server = http.createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', 'http://127.0.0.1:4175')
    res.setHeader('access-control-allow-headers', 'apikey,authorization,content-type,x-client-info')
    res.setHeader('access-control-allow-methods', 'POST,OPTIONS')
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
    const name = req.url.split('/').at(-1), fields = calls[name]
    const service = req.headers.apikey === 'local-test-service-key'
    const role = service ? 'service_role' : 'anon'
    if (!fields || req.method !== 'POST') { res.writeHead(404); return res.end() }
    const chunks = []; let bytes = 0
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 8388608) { res.writeHead(413); return res.end() } chunks.push(chunk) }
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString())
      if (name === 'live_baseline_ingest' && faults.ingest > 0) { faults.ingest--; throw Object.assign(new Error(), { code: 'TEST_UNAVAILABLE' }) }
      if (name === 'live_contextual_finish' && faults.finalization > 0) { faults.finalization--; throw Object.assign(new Error(), { code: 'TEST_UNAVAILABLE' }) }
      if (name === 'live_baseline_finish' && faults.baselineDelayMs) await new Promise(resolve => setTimeout(resolve, faults.baselineDelayMs))
      if (name === 'live_baseline_finish' && faults.analysis > 0) {
        faults.analysis--; data.p_result = { state: 'failed', reason: 'Analysis interrupted. Your ride is saved.' }
      }
      const start = performance.now()
      const value = await serialized(async () => {
        await db.exec(`SET ROLE ${role}`)
        try {
          return (await db.query(`SELECT public.${name}(${fields.map((_, i) => '$' + (i + 1)).join(',')}) AS value`, fields.map(k => data[k]))).rows[0].value
        } finally { await db.exec('RESET ROLE') }
      })
      metrics.push({ rpc: name, ms: performance.now() - start, bytes })
      if (name === 'live_contextual_finish' && faults.loseFinalizationResponse > 0) { faults.loseFinalizationResponse--; res.destroy(); return }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value))
    } catch (error) {
      res.writeHead(error.code === '42501' ? 403 : 503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: error.code ?? 'TEST_ERROR', message: 'Local test RPC failed' }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { db, faults, metrics, url: `http://127.0.0.1:${server.address().port}`, query: (...args) => serialized(() => db.query(...args)),
    close: async () => { await new Promise(resolve => server.close(resolve)); await db.close() } }
}
