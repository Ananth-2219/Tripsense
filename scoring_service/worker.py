"""Bounded execution, DB-backed leases/attempts and compact recoverable features."""
from concurrent.futures import ThreadPoolExecutor
import hashlib,json,threading,time
from pathlib import Path
from uuid import uuid4
from trip_scoring.extraction import extract_features,EXTRACTION_VERSION
from trip_scoring.baseline import score_baseline,POLICY_PATH

class Worker:
    def __init__(self,repository,workers=2):
        self.repository=repository;self.capacity=threading.BoundedSemaphore(workers)
        self.pool=ThreadPoolExecutor(max_workers=workers,thread_name_prefix='baseline')
        self.timings={}
    def submit(self,id,token,*,record=None,fingerprint=None):
        if not self.capacity.acquire(blocking=False):return False
        try:self.pool.submit(self.run,id,token,record,fingerprint)
        except RuntimeError:self.capacity.release();return False
        return True
    def run(self,id,token,record,fingerprint):
        lease=str(uuid4());claimed=False
        try:
            if record is None:
                saved=self.repository.get(id,token,True)
                record=dict(saved['trip'],readings=saved['readings'])
                fingerprint=(saved.get('score') or {}).get('quality_details',{}).get('input_fingerprint')
                if not fingerprint:fingerprint=hashlib.sha256(json.dumps(record,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            claimed=self.repository.claim(id,token,fingerprint,lease)
            if not claimed:return
            start=time.perf_counter();features=extract_features(record);after_features=time.perf_counter()
            result=score_baseline(features);after_score=time.perf_counter()
            result['quality_details']=dict(features['quality'],feature_summary={k:v for k,v in features.items() if k!='quality'})
            result['audit']=dict(policy_sha256=hashlib.sha256(POLICY_PATH.read_bytes()).hexdigest(),
                extraction_version=EXTRACTION_VERSION,extraction_implementation_sha256=hashlib.sha256(Path(__file__).parents[1].joinpath('trip_scoring/extraction.py').read_bytes()).hexdigest(),
                contextual_scoring_applied=False,feature_input_fingerprint=fingerprint)
            self.repository.finish(id,token,fingerprint,lease,result);after_write=time.perf_counter()
            self.timings[id]=dict(extraction_ms=(after_features-start)*1000,baseline_ms=(after_score-after_features)*1000,score_persistence_ms=(after_write-after_score)*1000)
            if len(self.timings)>128:self.timings.pop(next(iter(self.timings)))
        except Exception:
            # No exception repr: HTTP errors can embed secrets or request bodies.
            if claimed:
                try:self.repository.finish(id,token,fingerprint,lease,dict(state='failed',reason='Analysis could not be completed. Your ride is saved.'))
                except Exception:pass  # The persisted lease expires; authenticated retry can reclaim it.
        finally:self.capacity.release()
    def close(self):self.pool.shutdown(wait=True,cancel_futures=False)
