"""Server-only Supabase RPC adapter. Never log credentials, tokens or payloads."""
import os
from urllib.parse import urlparse
import httpx

class RepositoryError(Exception):
    def __init__(self,code='unavailable',status=503):
        self.code,self.status=code,status;super().__init__(code)

class SupabaseRepository:
    def __init__(self,url,key,*,allow_local_http=False):
        parsed=urlparse(url)
        if parsed.scheme!='https' and not (allow_local_http and parsed.scheme=='http' and parsed.hostname in ['127.0.0.1','localhost']):
            raise ValueError('Backend Supabase URL must use HTTPS')
        self.client=httpx.Client(base_url=url.rstrip('/')+'/rest/v1/',timeout=20,
            headers={'apikey':key,'Authorization':'Bearer '+key,'Content-Type':'application/json'},
            limits=httpx.Limits(max_connections=8,max_keepalive_connections=4),follow_redirects=False)
    def rpc(self,name,body):
        try:
            response=self.client.post('rpc/'+name,json=body)
            if response.is_success:return response.json()
            data=response.json();code=data.get('code');msg=data.get('message','')
        except (httpx.HTTPError,ValueError):raise RepositoryError() from None
        if code=='42501':
            if 'permission denied for function' in msg:raise RepositoryError('configuration_required')
            raise RepositoryError('forbidden',403)
        if code=='23514':raise RepositoryError('conflict',409)
        if code in ['22023','22P02']:raise RepositoryError('invalid',422)
        raise RepositoryError('configuration_required' if code in ['PGRST202','42883','42P01'] else 'unavailable')
    def ingest(self,trip,token,fingerprint):return self.rpc('live_baseline_ingest',dict(p_trip=trip,p_feedback_token=token,p_input_fingerprint=fingerprint))
    def get(self,id,token,include_readings=False):return self.rpc('live_baseline_get',dict(p_trip_id=id,p_feedback_token=token,p_include_readings=include_readings))
    def claim(self,id,token,fingerprint,lease):return self.rpc('live_baseline_claim',dict(p_trip_id=id,p_feedback_token=token,p_input_fingerprint=fingerprint,p_lease_id=lease))['claimed']
    def finish(self,id,token,fingerprint,lease,result):return self.rpc('live_baseline_finish',dict(p_trip_id=id,p_feedback_token=token,p_input_fingerprint=fingerprint,p_lease_id=lease,p_result=result))
    def context_get(self,id,token):return self.rpc('live_contextual_get',dict(p_trip_id=id,p_feedback_token=token))
    def context_finish(self,id,token,feedback_id,fingerprint,result):return self.rpc('live_contextual_finish',dict(p_trip_id=id,p_feedback_token=token,p_feedback_id=feedback_id,p_source_fingerprint=fingerprint,p_result=result))
    def close(self):self.client.close()

def from_environment():
    url=os.getenv('SCORING_SUPABASE_URL');key=os.getenv('SCORING_SUPABASE_SERVICE_KEY')
    if not url or not key:return None
    return SupabaseRepository(url,key,allow_local_http=os.getenv('SCORING_ALLOW_LOCAL_HTTP')=='1')
