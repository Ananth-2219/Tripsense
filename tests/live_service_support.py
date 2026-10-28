"""Atomic in-memory repository used only by isolated service tests."""
from copy import deepcopy
import hashlib,threading,time
from scoring_service.repository import RepositoryError
from trip_scoring.baseline import load_policy

TOKEN='a'*64
ID='31e14df0-1020-4d15-af90-003d48ef2631'
def payload():
 return dict(id=ID,startedAt='2026-10-27T00:00:00.000Z',endedAt='2026-10-27T00:00:01.000Z',durationSeconds=1,motionCount=3,locationCount=0,
  readings=[dict(type='motion',timestamp=1793059200000+i*100,x=1,y=0,z=0,rotationAlpha=1,rotationBeta=0,rotationGamma=0) for i in range(3)])

class MemoryRepository:
 def __init__(self):self.trips={};self.scores={};self.tokens={};self.lock=threading.RLock();self.reads=0;self.fail_ingest=False;self.fail_finish=False
 def authorize(self,id,token):
  if id not in self.tokens or self.tokens[id]!=hashlib.sha256(token.encode()).hexdigest():raise RepositoryError('forbidden',403)
 def get(self,id,token,include_readings=False):
  with self.lock:
   self.authorize(id,token);t=deepcopy(self.trips[id]);readings=t.pop('readings')
   if include_readings:self.reads+=1
   return dict(trip=t,readings=readings if include_readings else None,score=deepcopy(self.scores.get(id)))
 def ingest(self,trip,token,fingerprint):
  with self.lock:
   if self.fail_ingest:raise RepositoryError('unavailable',503)
   id=trip['id']
   if id in self.trips:
    self.authorize(id,token)
    if self.trips[id]!=trip or self.scores[id]['quality_details']['input_fingerprint']!=fingerprint:raise RepositoryError('conflict',409)
   else:
    self.tokens[id]=hashlib.sha256(token.encode()).hexdigest();self.trips[id]=deepcopy(trip)
    self.scores[id]=dict(trip_id=id,policy_version=load_policy()['version'],score_status='provisional',baseline_score=None,
     baseline_weights={'A':.35,'J':.4,'R':.25},quality_details=dict(input_fingerprint=fingerprint,processing=dict(state='pending',attempts=0)),context_details={},computed_at='2026-10-27T00:00:01Z')
   return self.get(id,token)
 def claim(self,id,token,fingerprint,lease):
  with self.lock:
   self.authorize(id,token);s=self.scores[id];p=s['quality_details']['processing']
   if s['score_status']=='final' or s['baseline_score'] is not None or p['state']=='unavailable':return False
   if fingerprint!=s['quality_details']['input_fingerprint']:raise RepositoryError('conflict',409)
   if p['attempts']>=3 or (p['state']=='processing' and p.get('lease_until',0)>time.time()):return False
   p.update(state='processing',attempts=p['attempts']+1,lease_id=lease,lease_until=time.time()+120);return True
 def finish(self,id,token,fingerprint,lease,result):
  with self.lock:
   self.authorize(id,token)
   if self.fail_finish:raise RepositoryError('unavailable',503)
   s=self.scores[id];p=s['quality_details']['processing']
   if s['score_status']=='final' or p.get('lease_id')!=lease or p['state']!='processing':return False
   for k in ['baseline_score','acceleration_score','jerk_score','rotation_score']:s[k]=result.get(k)
   s['quality_details']=dict(result.get('quality_details',{}),input_fingerprint=fingerprint,processing=dict(state=result['state'],attempts=p['attempts'],reason=result.get('reason')))
   s['context_details']=deepcopy(result.get('audit',{}));return True
 def close(self):pass
