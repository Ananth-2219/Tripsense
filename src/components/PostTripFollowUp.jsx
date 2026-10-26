import { useEffect, useState, useSyncExternalStore } from 'react'
import TripQuestionnaire from './TripQuestionnaire.jsx'
import { tripTime } from '../lib/tripTime.js'
import {
  subscribeFollowUps, getFollowUpSnapshot, initializeFollowUps, retryTripUpload,
  updateFeedbackDraft, deferFeedback, skipFeedback, sendFeedback,
} from '../lib/followUps.js'

export default function PostTripFollowUp({ paused = false }) {
  const { entries, loading, storageWarning, busyIds } = useSyncExternalStore(subscribeFollowUps, getFollowUpSnapshot)
  const [message, setMessage] = useState('')
  useEffect(() => { void initializeFollowUps() }, [])
  useEffect(() => {
    if (!storageWarning || !entries.length) return
    const preventLoss = event => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [storageWarning, entries.length])

  async function submit(id, answers, comments) {
    const result = await sendFeedback(id, answers, comments)
    if (result.success) setMessage('Thank you. Your answers are saved.')
    return result
  }
  const questionnaires = entries.filter(entry => entry.status === 'feedback_pending')
  const active = questionnaires.filter(entry => !entry.deferred).at(-1)
  if (paused) return null
  return (
    <div aria-label="Trip follow-up">
      {loading && <p role="status" className="mt-6 text-sm text-slate-600">Checking unfinished trips…</p>}
      {storageWarning && <p role="alert" className="mt-6 rounded-xl bg-amber-50 p-4 text-sm text-amber-950">{storageWarning}</p>}
      {message && <p role="status" className="mt-6 rounded-xl bg-teal-50 p-4 text-sm text-teal-950">{message}</p>}
      {entries.filter(entry => entry.status === 'upload_pending').map(entry => (
        <section key={entry.id} aria-label={`Unsent trip from ${tripTime(entry.endedAt)}`} className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <h2 className="font-semibold">Trip still needs saving</h2>
          <p className="mt-2 text-sm leading-6">Trip ending {tripTime(entry.endedAt)}. Your recording is kept on this browser when device storage is available. The questionnaire opens after saving.</p>
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
        onSkip={id => { void skipFeedback(id); setMessage('Questionnaire skipped. Your trip is still saved.') }} />}
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
