"""Metadata-only contextual finalization over trusted, accepted database state."""
import hashlib,threading,time
from pathlib import Path
from scoring_service.repository import RepositoryError
from trip_scoring.contextual import score_saved_baseline,POLICY_PATH

class Finalizer:
    def __init__(self,repository):
        self.repository=repository
        self.capacity=threading.BoundedSemaphore(2)
        self.timings={}

    def run(self,trip_id,token,expected_fingerprint=None):
        if not self.capacity.acquire(blocking=False):raise RepositoryError('busy',503)
        try:
            start=time.perf_counter();source=self.repository.context_get(trip_id,token);retrieved=time.perf_counter()
            feedback=source.get('feedback');row=source.get('score') or {}
            actual_fingerprint=(row.get('quality_details') or {}).get('input_fingerprint')
            if expected_fingerprint and expected_fingerprint!=actual_fingerprint:raise RepositoryError('conflict',409)
            if not feedback:return source,'not_requested'
            if feedback.get('trip_id')!=trip_id:raise RepositoryError('conflict',409)
            if row.get('baseline_score') is None:
                state=(row.get('quality_details') or {}).get('processing',{}).get('state')
                return source,'unavailable' if state=='unavailable' else 'waiting_for_baseline'
            if row.get('score_status')=='final':
                audit=(row.get('context_details') or {}).get('contextual_v3') or {}
                if row.get('feedback_id')!=feedback.get('id') or audit.get('source_fingerprint')!=source.get('source_fingerprint') \
                  or audit.get('policy_version')!='experimental-contextual-scoring/3.0.0' \
                  or audit.get('policy_sha256')!=hashlib.sha256(POLICY_PATH.read_bytes()).hexdigest():
                    raise RepositoryError('conflict',409)
                return source,'final'
            try:
                result=score_saved_baseline(row,feedback)
                result.pop('feedback',None)  # Keep accepted record ID; do not duplicate comments.
                result['policy_sha256']=hashlib.sha256(POLICY_PATH.read_bytes()).hexdigest()
                result['implementation_sha256']=hashlib.sha256(Path(__file__).parents[1].joinpath('trip_scoring/contextual.py').read_bytes()).hexdigest()
            except (ValueError,TypeError,KeyError):raise RepositoryError('conflict',409) from None
            except Exception:raise RepositoryError('contextual_failed',503) from None
            calculated=time.perf_counter()
            saved=self.repository.context_finish(trip_id,token,feedback['id'],source['source_fingerprint'],result)
            finished=time.perf_counter()
            self.timings[trip_id]=dict(feedback_retrieval_ms=(retrieved-start)*1000,contextual_calculation_ms=(calculated-retrieved)*1000,
                database_update_ms=(finished-calculated)*1000,end_to_end_ms=(finished-start)*1000)
            if len(self.timings)>128:self.timings.pop(next(iter(self.timings)))
            return saved,'final'
        finally:self.capacity.release()
