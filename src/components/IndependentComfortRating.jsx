import { useState } from 'react'

export default function IndependentComfortRating({ tripId, onSave, onSkip, busy = false }) {
  const [value, setValue] = useState(50)

  return (
    <div
      role="region"
      aria-labelledby={`comfort-heading-${tripId}`}
      className="rounded-xl border border-teal-200 bg-teal-50/60 p-4 sm:p-5"
    >
      <h3 id={`comfort-heading-${tripId}`} className="text-base font-semibold text-slate-900">
        How comfortable and smooth did this ride feel?
      </h3>
      <p className="mt-1 text-xs text-slate-600">
        Rate your ride comfort before seeing the calculated score (optional).
      </p>

      <div className="mt-4">
        <div className="flex items-center justify-between text-xs font-medium text-slate-600">
          <span>0 = Extremely uncomfortable</span>
          <span className="rounded-full bg-teal-100 px-2.5 py-0.5 text-sm font-bold text-teal-900 tabular-nums" aria-label={`Current rating: ${value}`}>
            {value} / 100
          </span>
          <span>100 = Extremely smooth</span>
        </div>
        <input
          type="range"
          min="0"
          max="100"
          value={value}
          onChange={e => setValue(Number(e.target.value))}
          disabled={busy}
          aria-label="Ride comfort rating slider from 0 to 100"
          className="mt-2 w-full accent-teal-700 cursor-pointer h-2 bg-slate-200 rounded-lg"
        />
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => onSave(value)}
          className="flex-1 min-h-11 rounded-xl bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white shadow-xs hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-teal-700 disabled:opacity-50"
        >
          {busy ? 'Saving rating…' : 'Save rating & view score'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onSkip}
          className="min-h-11 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-slate-500 disabled:opacity-50"
        >
          Skip
        </button>
      </div>
    </div>
  )
}
