import { useEffect, useRef, useState } from 'react'
import { QUESTIONS, validateFeedback } from '../lib/feedbackQuestions.js'
import { tripTime } from '../lib/tripTime.js'

export default function TripQuestionnaire({ entry, onDraft, onSubmit, onLater, onSkip }) {
  const [answers, setAnswers] = useState(entry.answers ?? {})
  const [comments, setComments] = useState(entry.comments ?? '')
  const [errors, setErrors] = useState({})
  const [failure, setFailure] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const locked = useRef(false)
  const heading = useRef(null)
  const form = useRef(null)
  useEffect(() => {
    heading.current?.focus()
    heading.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }, [])

  function change(nextAnswers, nextComments) {
    setAnswers(nextAnswers)
    setComments(nextComments)
    setFailure('')
    onDraft(entry.id, nextAnswers, nextComments)
  }

  async function submit(event) {
    event.preventDefault()
    if (locked.current) return
    const nextErrors = validateFeedback(answers, comments)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) {
      setFailure('Please answer all seven questions, or select Not sure. Check any highlighted comments too.')
      form.current?.querySelector('[aria-invalid="true"] input, textarea[aria-invalid="true"]')?.focus()
      return
    }
    locked.current = true
    setSubmitting(true)
    setFailure('')
    try {
      const result = await onSubmit(entry.id, answers, comments)
      if (!result.success) setFailure(result.error?.message ?? 'Could not save your answers. Please retry.')
    } catch { setFailure('Could not save your answers. Your choices are still here; please retry.') }
    finally { locked.current = false; setSubmitting(false) }
  }

  const answered = QUESTIONS.filter(q => q.options.some(([value]) => value === answers[q.key])).length
  return (
    <section aria-labelledby="questionnaire-title" className="mt-8 rounded-2xl border border-teal-200 bg-white p-5 sm:p-6">
      <p className="text-sm font-semibold text-teal-700">Trip saved</p>
      <h2 id="questionnaire-title" ref={heading} tabIndex={-1} className="mt-2 text-2xl font-bold tracking-tight focus:outline-none">How was your ride?</h2>
      <p className="mt-2 text-sm text-slate-600">For the trip ending {tripTime(entry.endedAt)}.</p>
      <p className="mt-3 text-sm leading-6 text-slate-600">Share what you noticed. This is optional, and your answers will be kept separate from the recorded sensors.</p>
      <p className="mt-3 text-sm font-medium text-teal-800" aria-live="polite">{answered} of 7 answered</p>
      <form ref={form} onSubmit={submit} noValidate className="mt-6 space-y-7" aria-busy={submitting}>
        {QUESTIONS.map(({ key, title, prompt, options }, index) => (
          <fieldset key={key} disabled={submitting} aria-invalid={Boolean(errors[key])} aria-describedby={`${key}-prompt${errors[key] ? ` ${key}-error` : ''}`}>
            <legend className="text-base font-semibold">{index + 1}. <span>{title}</span></legend>
            <p id={`${key}-prompt`} className="mt-1 text-sm text-slate-600">{prompt}</p>
            <div className="mt-3 grid gap-2">
              {options.map(([value, label]) => (
                <label key={value} className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-3 py-3 text-sm ${answers[key] === value ? 'border-teal-600 bg-teal-50 text-teal-950' : 'border-slate-200 text-slate-700'} has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-teal-700`}>
                  <input type="radio" name={`${entry.id}-${key}`} value={value} required checked={answers[key] === value}
                    onChange={() => change({ ...answers, [key]: value }, comments)} className="h-5 w-5 shrink-0 accent-teal-700" />
                  {label}
                </label>
              ))}
            </div>
            {errors[key] && <p id={`${key}-error`} className="mt-2 text-sm font-medium text-rose-800">{errors[key]}</p>}
          </fieldset>
        ))}
        <div>
          <label htmlFor="feedback-comments" className="block text-sm font-semibold">Comments (optional)</label>
          <p id="comments-help" className="mt-1 text-sm text-slate-600">Anything else? Up to 1,000 characters. Please avoid personal details.</p>
          <textarea id="feedback-comments" rows={4} maxLength={1000} value={comments} disabled={submitting}
            aria-invalid={Boolean(errors.comments)} aria-describedby={`comments-help${errors.comments ? ' comments-error' : ''}`}
            onChange={event => change(answers, event.target.value)}
            className="mt-3 w-full rounded-xl border border-slate-300 p-3 text-base focus-visible:outline-2 focus-visible:outline-teal-700" />
          {errors.comments && <p id="comments-error" className="mt-2 text-sm text-rose-800">{errors.comments}</p>}
        </div>
        {failure && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm leading-6 text-rose-900">{failure}</p>}
        <div className="space-y-2">
          <button type="submit" disabled={submitting} className="min-h-12 w-full rounded-xl bg-teal-700 px-4 py-3 font-semibold text-white hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:opacity-60">{submitting ? 'Saving answers…' : 'Submit answers'}</button>
          <button type="button" disabled={submitting} onClick={() => onLater(entry.id)} className="min-h-12 w-full rounded-xl border border-slate-300 px-4 py-3 font-medium focus-visible:outline-2 focus-visible:outline-teal-700 disabled:opacity-60">Submit later</button>
          <button type="button" disabled={submitting} onClick={() => onSkip(entry.id)} className="min-h-12 w-full rounded-xl px-4 py-3 text-sm text-slate-600 underline focus-visible:outline-2 focus-visible:outline-teal-700 disabled:opacity-60">Skip questionnaire</button>
        </div>
        <p className="text-xs leading-5 text-slate-500">Unfinished answers stay on this browser when device storage is available. Submit later keeps your draft; Skip removes it. Your trip stays saved either way.</p>
      </form>
    </section>
  )
}
