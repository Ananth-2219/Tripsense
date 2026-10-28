import { tripTime } from '../lib/tripTime.js'
import IndependentComfortRating from './IndependentComfortRating.jsx'
import ScoreAgreement from './ScoreAgreement.jsx'

export default function TripScore({
  entry,
  onRetry,
  onFeedback,
  onFinalize,
  onComfortRating,
  onSkipComfort,
  onScoreAgreement,
  onSkipAgreement,
  busy = false,
}) {
  const { score, id } = entry
  if (!score) return null
  const analyzing = ['pending', 'processing'].includes(score.state)
  const ready = score.state === 'ready'
  const context = score.contextual ?? {}
  const final = ready && score.status === 'final' && context.state === 'final'
  const feedbackSaved = entry.feedbackDisposition === 'submitted' || context.feedbackAccepted
  const quality = score.quality ?? {}
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '—'
  const evalState = entry.evaluation
  const needsComfortRating = evalState && !evalState.comfortSubmitted && !evalState.comfortSkipped

  return (
    <section aria-labelledby={`score-${id}`} className="mt-6 overflow-hidden rounded-2xl border border-teal-200 bg-white">
      <div className="border-b border-teal-100 bg-teal-50 px-5 py-4 sm:px-6">
        <p className="text-xs font-semibold uppercase tracking-wider text-teal-800">Ride saved · Experimental assessment</p>
        <h2 id={`score-${id}`} className="mt-1 text-lg font-semibold text-slate-900">
          {needsComfortRating ? 'Ride comfort evaluation' : final ? 'Final ride-smoothness score' : ready ? 'Provisional ride-smoothness score' : analyzing ? 'Analyzing ride' : 'Score unavailable'}
        </h2>
        {entry.endedAt && <p className="mt-1 text-xs text-slate-600">Ride ending {tripTime(entry.endedAt)}</p>}
      </div>
      <div className="p-5 sm:p-6">
        {needsComfortRating ? (
          <IndependentComfortRating
            tripId={id}
            onSave={rating => onComfortRating?.(id, rating)}
            onSkip={() => onSkipComfort?.(id)}
            busy={busy}
          />
        ) : (
          <>
            {analyzing && <div role="status" className="space-y-3">
              <p className="text-sm leading-6 text-slate-600">Your ride is saved. We’re checking the recorded motion.</p>
              <div aria-hidden="true" className="h-3 w-2/3 animate-pulse rounded bg-slate-100 motion-reduce:animate-none" />
              {(entry.scoreChecks ?? 0) >= 30 && <button type="button" onClick={() => onRetry?.(id)} className="min-h-12 rounded-lg border border-teal-700 px-4 text-sm font-semibold text-teal-800">Check analysis</button>}
            </div>}
            {ready && <>
              <p className="flex items-baseline gap-2 text-teal-950"><span className="text-5xl font-bold tracking-tight tabular-nums">{number(final ? context.finalScore : score.baselineScore)}</span><span className="text-lg text-slate-500">/100</span></p>
              <p className="mt-2 text-xs font-medium text-slate-500">Status: {final ? 'Final · Includes accepted rider feedback' : 'Provisional · Recorded phone motion'}</p>
          {final ? <>
            <dl className="mt-5 grid grid-cols-2 gap-3 border-y border-slate-100 py-4">
              <div><dt className="text-xs text-slate-600">Original baseline</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{number(score.baselineScore)}</dd></div>
              <div><dt className="text-xs text-slate-600">Contextual sensor</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{number(context.sensorScore)}</dd></div>
            </dl>
            <p className="mt-3 text-sm text-slate-700">Change from baseline: <strong className="tabular-nums">{context.deltaFromBaseline > 0 ? '+' : ''}{number(context.deltaFromBaseline)}</strong> points.</p>
            <p className="mt-3 text-sm leading-6 text-slate-600">{context.effects?.length
              ? `Feedback used: ${context.effects.map(effect => effect.label.toLowerCase()).join(', ')}.`
              : 'The accepted answers produce a neutral adjustment under this policy.'}</p>
          </> : <dl className="mt-6 grid grid-cols-3 gap-2 border-y border-slate-100 py-4 text-center">
            {[['A', 'Acceleration'], ['J', 'Jerk'], ['R', 'Rotation']].map(([key, label]) => <div key={key}>
              <dt className="text-xs text-slate-600">{label}</dt><dd className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{number(score.components?.[key])}</dd>
            </div>)}
          </dl>}
          {typeof quality.motion_coverage_percent === 'number' && <p className="mt-4 text-sm leading-6 text-slate-700">Motion coverage: <strong>{number(quality.motion_coverage_percent)}%</strong> of this recording.</p>}
          <p className="mt-2 text-sm leading-6 text-slate-600">This experimental ride-smoothness assessment is not a certified safety or driver-skill rating.</p>
          <details className="mt-4 border-t border-slate-100 pt-4">
            <summary className="min-h-11 cursor-pointer text-sm font-semibold text-teal-800">Score breakdown</summary>
            <div className="mt-2 space-y-2 break-words text-xs leading-6 text-slate-600">
              <p>Baseline weights: acceleration 35%, jerk 40%, rotation 25%. {final ? 'The original baseline is preserved.' : 'No feedback adjustment is applied to this baseline.'}</p>
              {final && <>
                <p>Sensor components: acceleration {number(score.components?.A)}, jerk {number(score.components?.J)}, rotation {number(score.components?.R)}.</p>
                <p>Adjusted weights: acceleration {number(context.weights?.A * 100)}%, jerk {number(context.weights?.J * 100)}%, rotation {number(context.weights?.R * 100)}%.</p>
                <p>Perceived-smoothness component: {number(context.experienceScore)}. Contribution: {number(context.experienceContribution)} points.{context.experienceSource === 'neutral_contextual_sensor_score' ? ' A neutral experience value was used.' : ''}</p>
                <p>Incident-experience penalty: {number(context.incidentPenalty)} points. A reported incident does not establish driver fault.</p>
                {context.effects?.map(effect => <p key={effect.field}>{effect.label}: {Array.isArray(effect.answer) ? effect.answer.join(', ') : String(effect.answer ?? '').replaceAll('_', ' ')}.</p>)}
                {context.fallbackFields?.length > 0 && <p>Some answers have no adjustment in this experimental policy.</p>}
              </>}
              <p>Observed motion: {number(quality.observed_motion_seconds)} seconds of {number(quality.duration_seconds)} seconds. Missing time is unobserved.</p>
              {(quality.warnings ?? []).map(warning => <p key={warning}>{warning}</p>)}
            </div>
          </details>
          {evalState && !evalState.agreementSkipped && (
            <ScoreAgreement
              tripId={id}
              chosen={evalState.scoreAgreement}
              onSelect={agreement => onScoreAgreement?.(id, agreement)}
              onSkip={() => onSkipAgreement?.(id)}
              busy={busy}
            />
          )}
        </>}
        {!ready && !analyzing && <div role="status">
          <p className="text-sm leading-6 text-slate-700">Your ride is saved. {score.reason || 'The analysis could not be confirmed.'}</p>
          {score.retryable && <button type="button" disabled={busy} onClick={() => onRetry?.(id)} className="mt-4 min-h-12 w-full rounded-xl border border-teal-700 px-4 py-3 font-semibold text-teal-800 disabled:opacity-50">{busy ? 'Checking analysis…' : 'Retry analysis'}</button>}
        </div>}
        {feedbackSaved && !final && <div role="status" className="mt-4 rounded-xl bg-slate-50 p-4 text-sm leading-6 text-slate-700">
          <p>Your feedback is saved. {context.state === 'failed' ? 'The final score could not be confirmed.'
            : context.state === 'unavailable' ? 'A valid baseline is needed for a final score.'
              : context.state === 'waiting_for_baseline' || analyzing ? 'The final score will follow the baseline analysis.' : 'Finalizing ride score…'}</p>
          {context.state === 'failed' && <button type="button" disabled={busy} onClick={() => onFinalize?.(id)}
            className="mt-3 min-h-12 w-full rounded-xl border border-teal-700 px-3 py-2 font-semibold text-teal-800 disabled:opacity-50">Retry final score</button>}
        </div>}
        {onFeedback && !entry.feedbackComplete && <button type="button" onClick={() => onFeedback(id)} className="mt-4 min-h-12 w-full rounded-xl px-4 py-3 text-sm font-semibold text-teal-800 underline">Add ride feedback <span className="font-normal">(optional)</span></button>}
      </>
    )}
  </div>
</section>
  )
}
