"""Explicit Phase3 application seal; all older manifests/seals remain untouched."""
import hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
ALLOWED={
 'README.md','docs/live-baseline-scoring.md','docs/post-trip-feedback.md','package.json',
 'src/components/TripScore.jsx','src/components/PostTripFollowUp.jsx',
 'src/lib/followUps.js','src/lib/followUpStore.js','src/lib/scoring.js',
 'src/lib/followUps.test.js','src/lib/liveScoringFlow.test.js','src/lib/scoring.test.js',
 'src/pages/Recorder.feedback.test.jsx',
 'scoring_service/app.py','scoring_service/repository.py',
 'tests/application_preservation.py','tests/test_scoring_repository.py','scripts/scoring-test-database.mjs',
 'scripts/test-scoring-browser.mjs','scripts/test-feedback-browser.mjs',
}
manifest={name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in sorted(ALLOWED)}
(ROOT/'tests/fixtures/phase3_application_hashes.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Explicit Phase3 application seal written. Phase2 seal and originals retained.')
