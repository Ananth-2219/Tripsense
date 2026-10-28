"""The real HTTP adapter fails closed and never exposes upstream error contents."""
import os,unittest
from unittest.mock import patch
import httpx
from fastapi.testclient import TestClient
from scoring_service.app import create_app
from scoring_service.repository import SupabaseRepository,RepositoryError

class RepositoryTests(unittest.TestCase):
    def test_non_https_supabase_url_rejected_except_explicit_loopback_test(self):
        for url in ['http://example.org','http://127.0.0.1:9000']:
            with self.assertRaises(ValueError):SupabaseRepository(url,'not-a-real-key')
        repo=SupabaseRepository('http://127.0.0.1:9000','local-key',allow_local_http=True)
        repo.close()

    def test_upstream_failures_mapped_without_leaking_private_messages(self):
        repo=SupabaseRepository('https://local.invalid','test-key');repo.client.close()
        try:
            for code,msg,expected,status in [('42501','Trip access denied','forbidden',403),('23514','conflict msg','conflict',409),('22023','invalid msg','invalid',422),('PGRST202','not found','configuration_required',503),('UNKNOWN','other','unavailable',503)]:
                with httpx.Client(transport=httpx.MockTransport(lambda request,m=msg,c=code:httpx.Response(400,json={'code':c,'message':m})),base_url='https://local.invalid/') as client:
                    repo.client=client
                    with self.assertRaises(RepositoryError) as failure:repo.rpc('live_baseline_get',{})
                    self.assertEqual((failure.exception.code,failure.exception.status),(expected,status))
                    self.assertNotIn('private',str(failure.exception))
        finally:repo.close()

    def test_function_execute_denied_is_configuration_not_authorization_error(self):
        """42501 from PostgreSQL permission denied (wrong role) must not look like a trip token failure."""
        repo=SupabaseRepository('https://local.invalid','test-key');repo.client.close()
        try:
            with httpx.Client(transport=httpx.MockTransport(lambda request:httpx.Response(403,json={'code':'42501','message':'permission denied for function live_baseline_ingest'})),base_url='https://local.invalid/') as client:
                repo.client=client
                with self.assertRaises(RepositoryError) as failure:repo.rpc('live_baseline_ingest',{})
                self.assertEqual(failure.exception.code,'configuration_required')
                self.assertEqual(failure.exception.status,503)
        finally:repo.close()

    def test_timeout_and_invalid_json_are_sanitized(self):
        repo=SupabaseRepository('https://local.invalid','test-key');repo.client.close()
        def timeout(request):raise httpx.ReadTimeout('sensitive upstream URL')
        for handler in [timeout,lambda request:httpx.Response(500,text='private upstream response')]:
            with httpx.Client(transport=httpx.MockTransport(handler),base_url='https://local.invalid/') as client:
                repo.client=client
                with self.assertRaises(RepositoryError) as failure:repo.rpc('live_baseline_get',{})
                self.assertEqual(str(failure.exception),'unavailable')

    def test_missing_credentials_health_and_protected_endpoints_fail_closed(self):
        with patch.dict(os.environ,{'SCORING_SUPABASE_URL':'','SCORING_SUPABASE_SERVICE_KEY':''}),TestClient(create_app()) as client:
            self.assertFalse(client.get('/api/health').json()['configured'])
            result=client.get('/api/trips/31e14df0-1020-4d15-af90-003d48ef2631/score')
            self.assertEqual(result.status_code,503)
            self.assertEqual(result.json()['error']['code'],'configuration_required')

    def test_invalid_api_key_maps_to_configuration_required(self):
        """PostgREST 401 response with 'Invalid API key' (no DB code) must raise configuration_required, not unavailable."""
        repo=SupabaseRepository('https://local.invalid','test-key');repo.client.close()
        try:
            with httpx.Client(transport=httpx.MockTransport(lambda request:httpx.Response(401,json={'message':'Invalid API key','hint':'Double check your Supabase `anon` or `service_role` API key.'})),base_url='https://local.invalid/') as client:
                repo.client=client
                with self.assertRaises(RepositoryError) as failure:repo.rpc('live_baseline_get',{})
                self.assertEqual(failure.exception.code,'configuration_required')
                self.assertEqual(failure.exception.status,503)
        finally:repo.close()

    def test_placeholder_credentials_fail_closed(self):
        from scoring_service.repository import from_environment
        for placeholder in ['<YOUR_SECRET_KEY>','<YOUR_SUPABASE_SERVICE_ROLE_KEY>','BACKEND-ONLY-SERVICE-ROLE-KEY']:
            with patch.dict(os.environ,{'SCORING_SUPABASE_URL':'https://example.supabase.co','SCORING_SUPABASE_SERVICE_KEY':placeholder}):
                self.assertIsNone(from_environment())

