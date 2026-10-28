import { useEffect, useState, useSyncExternalStore } from 'react'
import TripQuestionnaire from './TripQuestionnaire.jsx'
import TripScore from './TripScore.jsx'
import IndependentComfortRating from './IndependentComfortRating.jsx'
import { tripTime } from '../lib/tripTime.js'
import {
  subscribeFollowUps, getFollowUpSnapshot, initializeFollowUps, retryTripUpload,
  updateFeedbackDraft, deferFeedback, skipFeedback, sendFeedback,
  refreshScore, retryAnalysis, retryFinalization,
  submitComfortRating, skipComfortRating, submitScoreAgreement, skipScoreAgreement,
} from '../lib/followUps.js'

export default function PostTripFollowUp({ paused = false }) {
  const { entries, results, loading, storageWarning, busyIds } = useSyncExternalStore(subscribeFollowUps, getFollowUpSnapshot)
  const [message, setMessage] = useState('')
  useEffect(() => { void initializeFollowUps() }, [])
  useEffect(() => {
    if (paused) return
    const timers = entries.filter(entry => entry.status === 'feedback_pending' && entry.score
      && ['pending', 'processing'].includes(entry.score.state) && (entry.scoreChecks ?? 0) < 30)
      .map(entry => setTimeout(() => { void refreshScore(entry.id) }, 1000))
    return () => timers.forEach(clearTimeout)
  }, [entries, paused])
  useEffect(() => {
    if (!storageWarning || !entries.length) return
    const preventLoss = event => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [storageWarning, entries.length])

  async function submit(id, answers, comments) {
    const result = await sendFeedback(id, answers, comments)
    if (result.success) setMessage(result.acceptedPreviously ? 'Your earlier feedback is already saved.' : 'Thank you. Your answers are saved.')
    return result
  }
  const questionnaires = entries.filter(entry => entry.status === 'feedback_pending' && !entry.feedbackComplete)
  const active = questionnaires.filter(entry => !entry.deferred).at(-1)
  if (paused) return null
  return (
    <div aria-label="Trip follow-up">
      {loading && <p role="status" className="mt-6 text-sm text-slate-600">Checking unfinished trips…</p>}
      {storageWarning && <p role="alert" className="mt-6 rounded-xl bg-amber-50 p-4 text-sm text-amber-950">{storageWarning}</p>}
      {message && <p role="status" className="mt-6 rounded-xl bg-teal-50 p-4 text-sm text-teal-950">{message}</p>}
      {[...entries.filter(entry => entry.status === 'feedback_pending' && entry.score),
        ...results.filter(result => !entries.some(entry => entry.id === result.id))]
        .sort((a, b) => b.endedAt.localeCompare(a.endedAt)).map(entry => <TripScore key={entry.id} entry={entry}
          busy={busyIds.includes(entry.id)} onRetry={id => { void retryAnalysis(id) }}
          onFinalize={id => { void retryFinalization(id) }}
          onComfortRating={(id, rating) => { void submitComfortRating(id, rating) }}
          onSkipComfort={id => { void skipComfortRating(id) }}
          onScoreAgreement={(id, agreement) => { void submitScoreAgreement(id, agreement) }}
          onSkipAgreement={id => { void skipScoreAgreement(id) }}
          onFeedback={entries.some(e => e.id === entry.id && !e.feedbackComplete) ? id => {
            void deferFeedback(id, false)
            document.getElementById('questionnaire-title')?.focus()
            document.getElementById('questionnaire-title')?.scrollIntoView?.({ behavior: 'smooth' })
          } : undefined} />)}
      {entries.filter(entry => entry.status === 'upload_pending').map(entry => (
        <section key={entry.id} aria-label={`Unsent trip from ${tripTime(entry.endedAt)}`} className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <h2 className="font-semibold">Trip still needs saving</h2>
          <p className="mt-2 text-sm leading-6">Trip ending {tripTime(entry.endedAt)}. Your recording is kept on this browser when device storage is available. The questionnaire opens after saving.</p>
          {entry.evaluation && !entry.evaluation.comfortSubmitted && !entry.evaluation.comfortSkipped && (
            <div className="mt-3">
              <IndependentComfortRating
                tripId={entry.id}
                onSave={rating => { void submitComfortRating(entry.id, rating) }}
                onSkip={() => { void skipComfortRating(entry.id) }}
                busy={busyIds.includes(entry.id)}
              />
            </div>
          )}
          <button type="button" disabled={busyIds.includes(entry.id)} onClick={async () => {
            const result = await retryTripUpload(entry.id)
            setMessage(result.success ? 'Trip saved.' : result.error?.message ?? 'Could not save the trip. Please retry.')
          }} className="mt-3 min-h-12 w-full rounded-xl bg-teal-700 px-4 py-3 font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:opacity-60">
            {busyIds.includes(entry.id) ? 'Saving trip…' : 'Retry saving trip'}
          </button>
        </section>
      ))}
      {active && <TripQuestionnaire key={active.id} entry={active} onDraft={updateFeedbackDraft} onSubmit={submit}
        onLater={id => { void deferFeedback(id, true); setMessage('Draft kept. You can finish it here later.') }}
        onSkip={async id => { await skipFeedback(id); setMessage('Questionnaire skipped. Your trip is still saved.') }} />}
      {questionnaires.filter(entry => entry.id !== active?.id).map(entry => (
        <section key={entry.id} aria-label={`Unfinished questionnaire from ${tripTime(entry.endedAt)}`} className="mt-6 rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="font-semibold">Finish your ride questionnaire</h2>
          <p className="mt-2 text-sm text-slate-600">Trip ending {tripTime(entry.endedAt)}.</p>
          <button type="button" onClick={() => { setMessage(''); void deferFeedback(entry.id, false) }} className="mt-3 min-h-12 w-full rounded-xl border border-teal-600 px-4 py-3 font-medium text-teal-800 focus-visible:outline-2 focus-visible:outline-teal-700">Finish questionnaire</button>
        </section>
      ))}
    </div>
  )
}
