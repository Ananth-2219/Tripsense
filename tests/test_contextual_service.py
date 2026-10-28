from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import threading,time,unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
from scoring_service.app import create_app
from contextual_service_support import ContextMemoryRepository
from live_service_support import ID,TOKEN,payload

class ContextualServiceTests(unittest.TestCase):
 def setUp(self):
  self.repo=ContextMemoryRepository();self.app=create_app(self.repo,workers=1);self.context=TestClient(self.app);self.client=self.context.__enter__()
  self.headers={'Authorization':'Bearer '+TOKEN};self.path=f'/api/trips/{ID}/score/finalize'
 def tearDown(self):self.context.__exit__(None,None,None)
 def upload(self):return self.client.post('/api/trips',json=payload(),headers=self.headers)
 def ready(self):
  self.upload()
  for _ in range(100):
   if self.repo.scores[ID].get('baseline_score') is not None:return
   time.sleep(.01)
  self.fail('Baseline did not finish')
 def finish(self):return self.client.post(self.path,headers=self.headers)
 def test_accepted_feedback_finalizes_same_row_and_preserves_all_baseline_inputs(self):
  self.ready();self.repo.accept(phone_placement='pocket',unusual_event='near_miss');before=deepcopy(self.repo.scores[ID])
  with patch('scoring_service.worker.extract_features',side_effect=AssertionError('Do not extract again')):
   r=self.finish();self.assertEqual(r.status_code,200)
  score=r.json()['score'];self.assertEqual(score['status'],'final');self.assertEqual(score['contextual']['state'],'final')
  self.assertLess(score['contextual']['finalScore'],score['baselineScore']);self.assertEqual(self.repo.context_writes,1)
  for key in ['baseline_score','acceleration_score','jerk_score','rotation_score','baseline_weights','quality_details']:
   self.assertEqual(self.repo.scores[ID][key],before[key])
  self.assertEqual(self.repo.reads,0)
 def test_no_feedback_is_provisional_with_no_fabricated_contextual_result(self):
  self.ready();score=self.finish().json()['score'];self.assertEqual(score['status'],'provisional')
  self.assertEqual(score['contextual']['state'],'not_requested');self.assertIsNone(score['contextual']['finalScore']);self.assertEqual(self.repo.context_writes,0)
 def test_capability_and_arbitrary_browser_answers_rejected(self):
  self.ready();self.repo.accept()
  self.assertEqual(self.client.post(self.path).status_code,401)
  self.assertEqual(self.client.post(self.path,headers={'Authorization':'Bearer '+'b'*64}).status_code,403)
  self.assertEqual(self.client.post(self.path,json={'perceived_smoothness':'very_smooth'},headers=self.headers).status_code,422)
  self.assertEqual(self.repo.context_writes,0)
 def test_input_fingerprint_conflict_is_checked_before_finalization_write(self):
  self.ready();self.repo.accept()
  result=self.client.post(self.path,headers={**self.headers,'X-Trip-Input-Fingerprint':'c'*64})
  self.assertEqual(result.status_code,409);self.assertEqual(self.repo.context_writes,0)
 def test_feedback_association_and_unusable_components_rejected_without_baseline_alteration(self):
  self.ready();self.repo.accept();self.repo.feedback[ID]['trip_id']='00000000-0000-4000-8000-000000000000'
  before=deepcopy(self.repo.scores[ID]);self.assertEqual(self.finish().status_code,409);self.assertEqual(self.repo.scores[ID],before)
 def test_feedback_before_baseline_waits_then_finalizes(self):
  gate=threading.Event()
  from trip_scoring.extraction import extract_features
  with patch('scoring_service.worker.extract_features',side_effect=lambda raw:(gate.wait(2),extract_features(raw))[1]):
   self.upload();self.repo.accept();result=self.finish().json()['score']
   self.assertEqual(result['contextual']['state'],'waiting_for_baseline');self.assertEqual(self.repo.context_writes,0);gate.set()
  self.ready();self.assertEqual(self.finish().json()['score']['status'],'final')
 def test_failure_preserves_feedback_baseline_and_retry_uses_accepted_record(self):
  self.ready();self.repo.accept();before=deepcopy(self.repo.scores[ID]);feedback=deepcopy(self.repo.feedback)
  self.repo.fail_context=True;r=self.finish();self.assertEqual(r.status_code,503);self.assertEqual(self.repo.scores[ID],before)
  self.repo.fail_context=False;self.assertEqual(self.finish().json()['score']['status'],'final');self.assertEqual(self.repo.feedback,feedback)
 def test_calculation_failure_is_sanitized_and_retryable(self):
  self.ready();self.repo.accept()
  with patch('scoring_service.finalization.score_saved_baseline',side_effect=RuntimeError('private payload')):
   result=self.finish();self.assertEqual(result.status_code,503);self.assertNotIn('private payload',result.text)
  self.assertEqual(self.finish().json()['score']['status'],'final')
 def test_duplicate_and_concurrent_finalization_converge_once(self):
  self.ready();self.repo.accept()
  with ThreadPoolExecutor(2) as pool:responses=list(pool.map(lambda _:self.finish(),range(2)))
  self.assertTrue(all(r.status_code==200 for r in responses));self.assertEqual(self.repo.context_writes,1)
  self.assertEqual(responses[0].json()['score'],responses[1].json()['score'])
 def test_lost_finish_response_is_recovered_without_rewriting_final(self):
  self.ready();self.repo.accept();self.repo.lose_context_response=True
  self.assertEqual(self.finish().status_code,503)
  self.assertEqual(self.client.get(f'/api/trips/{ID}/score',headers=self.headers).json()['score']['status'],'final')
  self.assertEqual(self.finish().json()['score']['status'],'final');self.assertEqual(self.repo.context_writes,1)
 def test_provisional_retry_after_final_never_overwrites_it(self):
  self.ready();self.repo.accept();self.assertEqual(self.finish().status_code,200);before=deepcopy(self.repo.scores[ID])
  self.upload();self.client.post(f'/api/trips/{ID}/score/retry',headers=self.headers)
  self.assertEqual(self.repo.scores[ID],before)
 def test_final_result_cannot_be_reassociated_with_a_changed_feedback_record(self):
  self.ready();self.repo.accept();self.finish();before=deepcopy(self.repo.scores[ID])
  self.repo.feedback[ID]['perceived_smoothness']='very_smooth'
  self.assertEqual(self.finish().status_code,409);self.assertEqual(self.repo.scores[ID],before)
 def test_exhausted_baseline_is_unavailable_instead_of_waiting_for_a_final_forever(self):
  self.ready();self.repo.accept();row=self.repo.scores[ID];row['baseline_score']=None
  row['quality_details']['processing'].update(state='failed',attempts=3)
  result=self.finish().json()['score']
  self.assertEqual(result['contextual']['state'],'unavailable');self.assertEqual(result['status'],'provisional')
  self.assertIsNone(result['contextual']['finalScore']);self.assertEqual(self.repo.context_writes,0)
