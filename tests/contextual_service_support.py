from copy import deepcopy
import hashlib,json
from scoring_service.repository import RepositoryError
from live_service_support import MemoryRepository,ID

class ContextMemoryRepository(MemoryRepository):
 def __init__(self):
  super().__init__();self.feedback={};self.context_writes=0;self.fail_context=False;self.lose_context_response=False
 def accept(self,id=ID,**answers):
  self.feedback.setdefault(id,dict(id='140121c7-00e8-447b-92b0-5bdc96cf5733',trip_id=id,perceived_smoothness='mixed',**answers))
 def context_get(self,id,token):
  with self.lock:
   source=self.get(id,token);source.pop('readings',None);source['feedback']=deepcopy(self.feedback.get(id))
   s=deepcopy(source.get('score') or {});s.pop('computed_at',None);s.pop('score_status',None)
   for k in ['feedback_id','contextual_sensor_score','contextual_weights','experience_score','incident_penalty','final_score']:s.pop(k,None)
   s.get('context_details',{}).pop('contextual_v3',None)
   source['source_fingerprint']=hashlib.sha256(json.dumps([s,source['feedback']],sort_keys=True).encode()).hexdigest()
   return source
 def context_finish(self,id,token,feedback_id,fingerprint,result):
  with self.lock:
   source=self.context_get(id,token);s=self.scores[id]
   if not source['feedback'] or source['feedback']['id']!=feedback_id or source['feedback']['trip_id']!=id:raise RepositoryError('conflict',409)
   if fingerprint!=source['source_fingerprint']:raise RepositoryError('conflict',409)
   if s['score_status']=='final':return self.get(id,token)
   if self.fail_context:raise RepositoryError()
   s.update(feedback_id=feedback_id,contextual_sensor_score=result['contextual_sensor_score'],contextual_weights=deepcopy(result['contextual_weights']),experience_score=result['experience_score'],incident_penalty=result['incident_penalty'],final_score=result['final_feedback_inclusive_score'],score_status='final')
   s['context_details']['contextual_v3']=dict(deepcopy(result),source_fingerprint=fingerprint,feedback_id=feedback_id)
   self.context_writes+=1
   if self.lose_context_response:self.lose_context_response=False;raise RepositoryError()
   return self.get(id,token)
