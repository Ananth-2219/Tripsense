"""Single-upload, capability-authorized baseline API. No public DB table access."""
from contextlib import asynccontextmanager
from datetime import datetime,timezone
import hashlib,re,threading,time
from uuid import UUID
from fastapi import FastAPI,Request,HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from scoring_service.repository import RepositoryError,from_environment
from scoring_service.schemas import TripPayload,EvaluationPayload,MAX_BYTES
from scoring_service.worker import Worker
from scoring_service.finalization import Finalizer
from trip_scoring.baseline import load_policy

class RequestBoundary:
    def __init__(self,app):self.app=app;self.capacity=threading.BoundedSemaphore(4)
    async def __call__(self,scope,receive,send):
        if scope['type']!='http':return await self.app(scope,receive,send)
        if not self.capacity.acquire(blocking=False):return await JSONResponse({'error':{'code':'busy','message':'Service busy. Retry shortly.'}},503)(scope,receive,send)
        try:
            chunks=[];total=0
            while True:
                message=await receive()
                if message['type']=='http.disconnect':return
                chunk=message.get('body',b'');total+=len(chunk)
                if total>MAX_BYTES:return await JSONResponse({'error':{'code':'too_large','message':'Ride payload is too large.'}},413)(scope,receive,send)
                chunks.append(chunk)
                if not message.get('more_body'):break
            body=b''.join(chunks);sent=False
            async def replay():
                nonlocal sent
                if not sent:sent=True;return {'type':'http.request','body':body,'more_body':False}
                return await receive()
            await self.app(scope,replay,send)
        finally:self.capacity.release()

def public_result(saved):
    row=saved.get('score') or {};quality=row.get('quality_details') or {};processing=quality.get('processing') or {}
    state='ready' if row.get('baseline_score') is not None else processing.get('state','pending')
    attempts=processing.get('attempts',0)
    lease=processing.get('lease_until');expired=False
    if lease:
        expired=(lease<time.time()) if isinstance(lease,(float,int)) else datetime.fromisoformat(lease.replace('Z','+00:00'))<datetime.now(timezone.utc)
    reason=processing.get('reason')
    if state=='processing' and expired and attempts>=3:
        state='failed'
        reason='Analysis could not be completed after three attempts. Your ride is saved.'
    retryable=attempts<3 and (state in ['pending','failed'] or (state=='processing' and expired)) and row.get('score_status')!='final'
    def score(k):return float(row[k]) if row.get(k) is not None else None
    context=(row.get('context_details') or {}).get('contextual_v3') or {}
    final=row.get('score_status')=='final' and context.get('policy_version')=='experimental-contextual-scoring/3.0.0'
    fields={'phone_placement':'Phone placement','phone_movement':'Phone movement','road_condition':'Road conditions',
        'traffic_condition':'Traffic','reported_maneuvers':'Reported movements','unusual_event':'Reported road events'}
    effects=[dict(field=a['field'],label=fields.get(a['field'],a['field']),answer=a.get('answer'))
        for a in context.get('sensor_audit',[]) if any(v!=1 for v in a.get('multipliers',{}).values())]
    if context.get('experience_audit',{}).get('source')=='perceived_smoothness_mapping':
        effects.append(dict(field='perceived_smoothness',label='Perceived smoothness',answer=context['experience_audit'].get('answer')))
    if (score('incident_penalty') or 0)>0:effects.append(dict(field='incident_penalty',label='Reported incident experience',answer='No driver fault is inferred'))
    return dict(tripId=saved['trip']['id'],tripSaved=True,policyVersion=load_policy()['version'],score=dict(
        state=state,status=row.get('score_status','provisional'),baselineScore=score('baseline_score'),
        components=dict(A=score('acceleration_score'),J=score('jerk_score'),R=score('rotation_score')),
        baselineWeights=row.get('baseline_weights',{'A':.35,'J':.4,'R':.25}),
        reason=reason,retryable=retryable,attempts=attempts,
        inputFingerprint=quality.get('input_fingerprint'),computedAt=row.get('computed_at'),
        quality={k:v for k,v in quality.items() if k not in ['processing','input_fingerprint','feature_summary']},
        features=quality.get('feature_summary'),contextual=dict(
            state='final' if final else 'not_requested',policyVersion=context.get('policy_version'),policyHash=context.get('policy_sha256'),
            feedbackAccepted=bool(row.get('feedback_id')),feedbackId=row.get('feedback_id'),
            sensorScore=score('contextual_sensor_score'),finalScore=score('final_score'),weights=row.get('contextual_weights'),
            experienceScore=score('experience_score'),experienceContribution=context.get('experience_contribution'),
            incidentPenalty=score('incident_penalty') if final else None,
            deltaFromBaseline=score('final_score')-score('baseline_score') if final else None,
            effects=effects,fallbackFields=context.get('fallback_fields',[]),experienceSource=context.get('experience_audit',{}).get('source'))))

def create_app(repository=None,*,workers=2):
    repo=repository if repository is not None else from_environment()
    worker=Worker(repo,workers) if repo is not None else None
    finalizer=Finalizer(repo) if repo is not None else None
    @asynccontextmanager
    async def lifespan(app):
        yield
        if worker:worker.close()
        if repo:repo.close()
    app=FastAPI(title='TripSense baseline scoring',lifespan=lifespan,docs_url=None,redoc_url=None)
    app.add_middleware(RequestBoundary)
    app.state.worker=worker
    app.state.finalizer=finalizer
    rate_lock=threading.Lock();rates={}
    def authorize(request):
        if repo is None:raise RepositoryError('configuration_required')
        header=request.headers.get('authorization','')
        if not re.fullmatch(r'Bearer [0-9a-f]{64}',header):raise HTTPException(401,'Trip access denied')
        # Bound storage and calls; no raw token is retained as a rate-limit key.
        key=request.client.host if request.client else 'unknown'
        now=time.monotonic()
        with rate_lock:
            if len(rates)>1000:rates.clear()
            entries=[t for t in rates.get(key,[]) if now-t<60]
            if len(entries)>=90:raise HTTPException(429,'Too many requests. Retry later.')
            rates[key]=entries+[now]
        return header[7:]
    def check_fingerprint(saved,request):
        expected=request.headers.get('x-trip-input-fingerprint')
        actual=(saved.get('score') or {}).get('quality_details',{}).get('input_fingerprint')
        if expected and actual and expected!=actual:raise RepositoryError('conflict',409)
    @app.exception_handler(RepositoryError)
    async def repository_error(request,error):
        messages={'forbidden':'Trip access denied.','conflict':'This trip identity does not match the saved input.',
            'configuration_required':'Scoring requires backend credentials and the reviewed database migration.'}
        return JSONResponse({'tripSaved':getattr(request.state,'trip_saved',False),'error':{'code':error.code,'message':messages.get(error.code,'Service unavailable. Saved rides and accepted feedback are preserved; retry when connected.')}},error.status,headers={'Cache-Control':'no-store'})
    @app.exception_handler(RequestValidationError)
    async def invalid_payload(request,error):
        return JSONResponse({'error':{'code':'invalid','message':'Invalid ride payload. Check sensor values, counts and timestamps.'}},422)
    @app.get('/api/health')
    def health():return {'service':'baseline','configured':repo is not None,'policyVersion':load_policy()['version']}
    @app.post('/api/trips')
    async def ingest(payload:TripPayload,request:Request):
        token=authorize(request);body=await request.body();fingerprint=hashlib.sha256(body).hexdigest()
        expected=request.headers.get('x-trip-input-fingerprint')
        if expected and expected!=fingerprint:raise RepositoryError('conflict',409)
        record=payload.record()
        # The sync network boundary runs outside the event loop.
        from starlette.concurrency import run_in_threadpool
        saved=await run_in_threadpool(repo.ingest,record,token,fingerprint)
        status=public_result(saved)
        if status['score']['retryable'] and worker.submit(str(payload.id),token,record=record,fingerprint=fingerprint):
            status['score'].update(state='pending',reason=None,retryable=False)
        return JSONResponse(status,headers={'Cache-Control':'no-store'})
    @app.get('/api/trips/{trip_id}/score')
    def status(trip_id:UUID,request:Request):
        token=authorize(request);saved=repo.get(str(trip_id),token);check_fingerprint(saved,request)
        return JSONResponse(public_result(saved),headers={'Cache-Control':'no-store'})
    @app.post('/api/trips/{trip_id}/score/retry')
    def retry(trip_id:UUID,request:Request):
        token=authorize(request);saved=repo.get(str(trip_id),token);check_fingerprint(saved,request)
        status=public_result(saved)
        if status['score']['retryable'] and worker.submit(str(trip_id),token):
            status['score'].update(state='pending',reason=None,retryable=False)
        return JSONResponse(status,headers={'Cache-Control':'no-store'})
    @app.post('/api/trips/{trip_id}/score/finalize')
    async def finalize(trip_id:UUID,request:Request):
        token=authorize(request)
        if await request.body():raise HTTPException(422,'Finalization accepts no browser questionnaire values')
        from starlette.concurrency import run_in_threadpool
        saved,state=await run_in_threadpool(finalizer.run,str(trip_id),token,request.headers.get('x-trip-input-fingerprint'))
        request.state.trip_saved=True
        check_fingerprint(saved,request)
        result=public_result(saved)
        if state=='waiting_for_baseline' and result['score']['state'] in ['unavailable','failed'] and not result['score']['retryable']:
            state='unavailable'
        result['score']['contextual'].update(state=state,feedbackAccepted=bool(saved.get('feedback')) or bool((saved.get('score') or {}).get('feedback_id')))
        return JSONResponse(result,headers={'Cache-Control':'no-store'})
    @app.get('/api/trips/{trip_id}/evaluation')
    def get_evaluation(trip_id:UUID,request:Request):
        token=authorize(request)
        saved=repo.evaluation_get(str(trip_id),token)
        return JSONResponse({'tripId':str(trip_id),'evaluation':saved},headers={'Cache-Control':'no-store'})
    @app.post('/api/trips/{trip_id}/evaluation')
    async def submit_evaluation(trip_id:UUID,payload:EvaluationPayload,request:Request):
        token=authorize(request)
        from starlette.concurrency import run_in_threadpool
        saved=await run_in_threadpool(repo.evaluation_submit,str(trip_id),token,
            comfort_rating=payload.comfortRating,comfort_skipped=payload.comfortSkipped,
            score_agreement=payload.scoreAgreement,score_agreement_skipped=payload.scoreAgreementSkipped)
        return JSONResponse({'tripId':str(trip_id),'evaluation':saved},headers={'Cache-Control':'no-store'})
    return app

app=create_app()
