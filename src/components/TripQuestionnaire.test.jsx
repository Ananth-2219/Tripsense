// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import TripQuestionnaire from './TripQuestionnaire.jsx'
import { QUESTIONS } from '../lib/feedbackQuestions.js'

afterEach(cleanup)
const entry = {id:'877f6a92-fa06-4b3a-a967-57b72f54cd59',endedAt:'2026-10-26T10:00:00Z',answers:{},comments:''}
function setup(overrides={}) {
  const props = {entry,onDraft:vi.fn(),onSubmit:vi.fn().mockResolvedValue({success:true}),onLater:vi.fn(),onSkip:vi.fn(),...overrides}
  render(<TripQuestionnaire {...props} />)
  return props
}
function answerAll() {
  for (const q of QUESTIONS) fireEvent.click(within(screen.getByRole('group',{name:name=>name.endsWith(q.title)})).getAllByRole('radio').at(-1))
}

test('renders seven accessible single-choice questions, comments and voluntary actions', () => {
  setup()
  expect(screen.getAllByRole('group')).toHaveLength(7)
  expect(screen.getByLabelText('Comments (optional)')).toBeTruthy()
  expect(screen.getByRole('button',{name:'Submit answers'})).toBeTruthy()
  expect(screen.getByRole('button',{name:'Submit later'})).toBeTruthy()
  expect(screen.getByRole('button',{name:'Skip questionnaire'})).toBeTruthy()
})
test('incomplete answers cannot be submitted; not sure is an explicit valid answer', async () => {
  const {onSubmit} = setup()
  fireEvent.click(screen.getByRole('button',{name:'Submit answers'}))
  expect(screen.getByRole('alert').textContent).toContain('answer all seven')
  expect(onSubmit).not.toHaveBeenCalled()
  answerAll()
  fireEvent.click(screen.getByRole('button',{name:'Submit answers'}))
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(entry.id,Object.fromEntries(QUESTIONS.map(q=>[q.key,'unsure'])),''))
})
test('failed saving preserves choices and comments, permits retry and never changes trip ID', async () => {
  const onSubmit = vi.fn().mockResolvedValueOnce({success:false,error:{message:'Connection interrupted'}}).mockResolvedValueOnce({success:true})
  setup({onSubmit})
  answerAll()
  fireEvent.change(screen.getByLabelText('Comments (optional)'),{target:{value:'Road works'}})
  fireEvent.click(screen.getByRole('button',{name:'Submit answers'}))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Connection interrupted'))
  expect(screen.getByLabelText('Comments (optional)').value).toBe('Road works')
  expect(screen.getAllByRole('radio').filter(r=>r.checked)).toHaveLength(7)
  fireEvent.click(screen.getByRole('button',{name:'Submit answers'}))
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
  expect(onSubmit.mock.calls.every(([id])=>id===entry.id)).toBe(true)
})
test('double submit is locked while waiting, with inputs and skip disabled', async () => {
  let finish
  const onSubmit=vi.fn(()=>new Promise(resolve=>{finish=resolve}))
  setup({onSubmit})
  answerAll()
  const button=screen.getByRole('button',{name:'Submit answers'})
  fireEvent.click(button)
  fireEvent.click(button)
  expect(onSubmit).toHaveBeenCalledOnce()
  expect(screen.getByRole('button',{name:'Skip questionnaire'}).disabled).toBe(true)
  finish({success:false,error:{message:'Retry'}})
  await waitFor(()=>expect(screen.getByRole('button',{name:'Submit answers'}).disabled).toBe(false))
})
test('restores draft, switches a radio choice, and defers/skips only the associated trip', () => {
  const {onDraft,onLater,onSkip}=setup({entry:{...entry,answers:{phone_placement:'mount'},comments:'Draft'}})
  expect(screen.getByLabelText('In a mount').checked).toBe(true)
  fireEvent.click(screen.getByLabelText('In my hand'))
  expect(screen.getByLabelText('In a mount').checked).toBe(false)
  expect(onDraft).toHaveBeenLastCalledWith(entry.id,{phone_placement:'hand'},'Draft')
  fireEvent.click(screen.getByRole('button',{name:'Submit later'}))
  expect(onLater).toHaveBeenCalledWith(entry.id)
  fireEvent.click(screen.getByRole('button',{name:'Skip questionnaire'}))
  expect(onSkip).toHaveBeenCalledWith(entry.id)
})
