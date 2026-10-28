import hashlib,json,threading,time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from fastapi.testclient import TestClient
from scoring_service.app import create_app
from live_service_support import MemoryRepository,payload,TOKEN,ID

class ServiceTests(unittest.TestCase):
 def setUp(self):
  self.repo=MemoryRepository();self.context=TestClient(create_app(self.repo,workers=1));self.client=self.context.__enter__()
  self.headers={'Authorization':'Bearer '+TOKEN}
 def tearDown(self):self.context.__exit__(None,None,None)
 def upload(self,data=None):return self.client.post('/api/trips',json=data or payload(),headers=self.headers)
 def wait(self):
  for _ in range(100):
   r=self.client.get(f'/api/trips/{ID}/score',headers=self.headers)
   if r.json()['score']['state'] not in ['pending','processing']:return r.json()
   time.sleep(.01)
  self.fail('Score did not complete')
 def test_upload_persist_calculate_and_authorized_retrieve(self):
  r=self.upload();self.assertEqual(r.status_code,200);self.assertTrue(r.json()['tripSaved'])
  result=self.wait();self.assertEqual(result['score']['state'],'ready');self.assertGreater(result['score']['baselineScore'],0)
  self.assertEqual(self.repo.reads,0,'Initial processing must reuse the received readings')
  self.assertNotIn('readings',result);self.assertNotIn('"lat":',json.dumps(result));self.assertNotIn(TOKEN,json.dumps(self.repo.trips))
 def test_idempotent_upload_and_input_conflict(self):
  self.upload();first=self.wait();self.upload()
  self.assertEqual(first['score']['baselineScore'],self.wait()['score']['baselineScore'])
  changed=payload();changed['readings'][0]['x']=2
  self.assertEqual(self.upload(changed).status_code,409)
  self.assertEqual(len(self.repo.trips),1);self.assertEqual(len(self.repo.scores),1)
 def test_wrong_missing_token_and_unknown_uuid_denied(self):
  self.upload()
  for headers in [{},{'Authorization':'Bearer '+'b'*64}]:
   self.assertIn(self.client.get(f'/api/trips/{ID}/score',headers=headers).status_code,[401,403])
   self.assertIn(self.client.post(f'/api/trips/{ID}/score/retry',headers=headers).status_code,[401,403])
  self.assertEqual(self.client.get('/api/trips/00000000-0000-4000-8000-000000000000/score',headers=self.headers).status_code,403)
 def test_invalid_types_counts_timestamps_finite_numbers_and_size_rejected(self):
  cases=[]
  d=payload();d['motionCount']=1;cases.append(d)
  d=payload();d['readings'][0]['timestamp']='bad';cases.append(d)
  d=payload();d['readings'][0]['type']='invented';cases.append(d)
  d=payload();d['readings'][0]['x']=True;cases.append(d)
  d=payload();d['endedAt']='2020-01-01T00:00:00Z';cases.append(d)
  for d in cases:self.assertEqual(self.upload(d).status_code,422)
  self.assertEqual(self.client.post('/api/trips',content='{"x":NaN}',headers=self.headers).status_code,422)
  self.assertEqual(self.client.post('/api/trips',content=b'x'*(8*1024*1024+1),headers=self.headers).status_code,413)
  self.assertEqual(self.repo.trips,{})
 def test_empty_recording_persisted_with_unavailable_not_perfect_score(self):
  d=payload();d.update(readings=[],motionCount=0)
  self.upload(d);r=self.wait()['score'];self.assertEqual(r['state'],'unavailable');self.assertIsNone(r['baselineScore'])
 def test_upload_failure_not_acknowledged(self):
  self.repo.fail_ingest=True;r=self.upload();self.assertEqual(r.status_code,503);self.assertEqual(self.repo.trips,{})
 def test_scoring_failure_keeps_trip_and_retry_reuses_persisted_raw_once(self):
  with patch('scoring_service.worker.extract_features',side_effect=RuntimeError('secret should not escape')):
   self.upload();self.assertEqual(self.wait()['score']['state'],'failed')
  self.assertEqual(len(self.repo.trips),1)
  retry=self.client.post(f'/api/trips/{ID}/score/retry',headers=self.headers)
  self.assertEqual(retry.status_code,200)
  self.assertIn(retry.json()['score']['state'],['pending','processing','ready'])
  self.assertEqual(self.wait()['score']['state'],'ready');self.assertEqual(self.repo.reads,1)
 def test_concurrent_retries_have_one_effective_claim(self):
  gate=threading.Event()
  from trip_scoring.extraction import extract_features
  def slow(raw):gate.wait(2);return extract_features(raw)
  with patch('scoring_service.worker.extract_features',side_effect=slow):
   self.upload()
   with ThreadPoolExecutor(3) as pool:
    replies=list(pool.map(lambda _:self.client.post(f'/api/trips/{ID}/score/retry',headers=self.headers),range(3)))
   self.assertTrue(all(r.status_code in [200,429,503] for r in replies));gate.set()
   self.wait()
  self.assertEqual(self.repo.scores[ID]['quality_details']['processing']['attempts'],1)
 def test_final_record_cannot_be_overwritten(self):
  self.upload();self.wait();self.repo.scores[ID].update(score_status='final',baseline_score=55,final_score=66)
  self.upload();self.client.post(f'/api/trips/{ID}/score/retry',headers=self.headers)
  self.assertEqual(self.repo.scores[ID]['baseline_score'],55);self.assertEqual(self.repo.scores[ID]['final_score'],66)
 def test_expected_fingerprint_required_to_match_on_recovery(self):
  self.upload();r=self.wait()
  bad=dict(self.headers,**{'X-Trip-Input-Fingerprint':'b'*64})
  self.assertEqual(self.client.get(f'/api/trips/{ID}/score',headers=bad).status_code,409)
 def test_failure_attempts_bounded(self):
  with patch('scoring_service.worker.extract_features',side_effect=RuntimeError('bad')):
   self.upload();self.wait()
   for _ in range(5):self.client.post(f'/api/trips/{ID}/score/retry',headers=self.headers);self.wait()
  self.assertEqual(self.repo.scores[ID]['quality_details']['processing']['attempts'],3)
 def test_expired_final_attempt_is_terminal_instead_of_analyzing_forever(self):
  self.upload();self.wait()
  s=self.repo.scores[ID];s['baseline_score']=None
  s['quality_details']['processing'].update(state='processing',attempts=3,lease_until=time.time()-1)
  result=self.client.get(f'/api/trips/{ID}/score',headers=self.headers).json()['score']
  self.assertEqual(result['state'],'failed');self.assertFalse(result['retryable'])
  self.assertIn('three attempts',result['reason'])
if __name__=='__main__':unittest.main()
