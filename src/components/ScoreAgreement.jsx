export default function ScoreAgreement({ tripId, onSelect, onSkip, busy = false, chosen = null }) {
  const options = [
    { label: 'Yes', value: 'yes' },
    { label: 'Partially', value: 'partially' },
    { label: 'No', value: 'no' },
    { label: 'Not sure', value: 'not_sure' },
  ]

  if (chosen) {
    return (
      <div role="status" className="mt-4 rounded-xl bg-teal-50/70 p-3 text-xs text-teal-900 border border-teal-200">
        Score agreement recorded: <strong>{chosen.replace('_', ' ')}</strong>. Thank you!
      </div>
    )
  }

  return (
    <div
      role="region"
      aria-labelledby={`agreement-heading-${tripId}`}
      className="mt-6 rounded-xl border border-slate-200 bg-slate-50/80 p-4"
    >
      <div className="flex items-center justify-between">
        <h4 id={`agreement-heading-${tripId}`} className="text-sm font-semibold text-slate-900">
          Does this score match your experience?
        </h4>
        <button
          type="button"
          disabled={busy}
          onClick={onSkip}
          className="text-xs text-slate-500 hover:text-slate-800 underline disabled:opacity-50"
        >
          Skip
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {options.map(({ label, value }) => (
          <button
            key={value}
            type="button"
            disabled={busy}
            onClick={() => onSelect(value)}
            className="min-h-10 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-800 shadow-xs hover:border-teal-600 hover:bg-teal-50 focus-visible:outline-2 focus-visible:outline-teal-700 disabled:opacity-50 capitalize"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
