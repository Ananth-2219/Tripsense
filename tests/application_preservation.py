"""Preserve frozen scoring snapshots while accounting for authorized Phase2 app edits.

No historical manifest/policy is edited. Changed application files must have
both their original archived bytes and an explicit reviewed new SHA256 seal.
"""
import hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
ALLOWED={
 'src/lib/upload.js','src/lib/followUps.js','src/lib/followUpStore.js','src/components/PostTripFollowUp.jsx',
 'src/pages/Recorder.jsx','src/pages/Recorder.test.jsx','src/lib/upload.test.js','vite.config.js','.gitignore',
 'README.md','docs/post-trip-feedback.md','package.json','scripts/test-feedback-browser.mjs',
 'tests/test_contextual_scoring_v3.py','tests/test_bus_contextual_v3.py',
}
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def verify_application_snapshot(path):
 manifest=json.loads(path.read_text());seal=json.loads((ROOT/'tests/fixtures/phase2_application_hashes.json').read_text())
 phase3=ROOT/'tests/fixtures/phase3_application_hashes.json'
 phase3_seal=json.loads(phase3.read_text()) if phase3.is_file() else {}
 for relative,original in manifest.items():
  current=ROOT/relative
  if current.is_file() and digest(current)==original:continue
  if relative not in ALLOWED and relative not in phase3_seal:raise AssertionError('Unapproved historical mutation: '+relative)
  archived=ROOT/'analysis/live_baseline_phase2/before_application'/relative
  if not archived.is_file() or digest(archived)!=original:raise AssertionError('Original application bytes not preserved: '+relative)
  expected_phase2=seal.get(relative,original)
  if current.is_file() and digest(current)==expected_phase2:continue
  archived_phase2=ROOT/'analysis/live_contextual_phase3/before_application'/relative
  if not archived_phase2.is_file():raise AssertionError('Phase3 initial application bytes absent: '+relative)
  if digest(archived_phase2)!=expected_phase2:
   provenance=ROOT/'analysis/live_contextual_phase3/preexisting_application_changes.json'
   record=json.loads(provenance.read_text()).get(relative,{}) if provenance.is_file() else {}
   restored=ROOT/'analysis/live_contextual_phase3/phase2_sealed_application'/relative
   if record.get('initial_sha256')!=digest(archived_phase2) or record.get('phase2_seal_sha256')!=expected_phase2 or not restored.is_file() or digest(restored)!=expected_phase2:
    raise AssertionError('Phase2 bytes or recorded initial user change not verified: '+relative)
  if not current.is_file() or digest(current)!=phase3_seal.get(relative):
   raise AssertionError('Application change does not match explicit Phase3 seal: '+relative)
 return len(manifest)
