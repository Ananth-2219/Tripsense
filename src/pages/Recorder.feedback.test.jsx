// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('../lib/upload.js',()=>({
  createTripIdentity:()=>({id:'877f6a92-fa06-4b3a-a967-57b72f54cd59',feedbackToken:'a'.repeat(64)}), uploadTrip:vi.fn(),
}))
vi.mock('../lib/feedback.js',()=>({submitTripFeedback:vi.fn(),getTripFeedbackState:vi.fn().mockResolvedValue('trip_saved')}))
vi.mock('../lib/sensors.js',()=>({
  requestMotionPermission:vi.fn(),requestGeolocationPermission:vi.fn(),requestWakeLock:vi.fn(),
  releaseWakeLock:vi.fn(),startRecording:vi.fn(),stopRecording:vi.fn(),
}))
let Recorder, uploadTrip, submitTripFeedback, sensors
beforeEach(async()=>{
  vi.resetModules()
  vi.stubGlobal('indexedDB',new IDBFactory())
  ;({default:Recorder}=await import('./Recorder.jsx'))
  ;({uploadTrip}=await import('../lib/upload.js'))
  ;({submitTripFeedback}=await import('../lib/feedback.js'))
  sensors=await import('../lib/sensors.js')
  sensors.requestMotionPermission.mockResolvedValue('granted')
  sensors.requestGeolocationPermission.mockResolvedValue('granted')
  vi.spyOn(console,'info').mockImplementation(()=>{})
})
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals()})
async function startAndStop() {
  fireEvent.click(screen.getByRole('button',{name:'Start trip'}))
  await waitFor(()=>expect(screen.getByText('Recording active')).toBeTruthy())
  act(()=>sensors.startRecording.mock.calls.at(-1)[0]({type:'motion',timestamp:Date.now(),x:1,y:2,z:3}))
  fireEvent.click(screen.getByRole('button',{name:'Stop trip'}))
}

test('failed upload survives navigation, retry opens feedback only after confirmed save, and feedback failure keeps the correct draft',async()=>{
  let finishUpload
  uploadTrip.mockImplementationOnce(()=>new Promise(resolve=>{finishUpload=resolve}))
  uploadTrip.mockImplementationOnce(async trip=>({success:true,tripId:trip.id}))
  const mounted=render(<Recorder />)
  await startAndStop()
  await waitFor(()=>expect(uploadTrip).toHaveBeenCalledOnce())
  expect(screen.queryByText('How was your ride?')).toBeNull()
  await act(async()=>finishUpload({success:false}))
  expect(screen.getByRole('button',{name:'Retry saving trip'})).toBeTruthy()
  const snapshot=uploadTrip.mock.calls[0][0]
  mounted.unmount()
  render(<Recorder />)
  fireEvent.click(await screen.findByRole('button',{name:'Retry saving trip'}))
  expect(await screen.findByText('How was your ride?')).toBeTruthy()
  expect(uploadTrip.mock.calls[1][0]).toEqual(snapshot)
  expect(snapshot.readings).toHaveLength(1)
  for (const group of screen.getAllByRole('group')) fireEvent.click(within(group).getAllByRole('radio').at(-1))
  fireEvent.change(screen.getByLabelText('Comments (optional)'),{target:{value:'A saved draft'}})
  fireEvent.click(screen.getByRole('button',{name:'Submit later'}))
  expect(await screen.findByRole('button',{name:'Finish questionnaire'})).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'Finish questionnaire'}))
  expect(screen.getByLabelText('Comments (optional)').value).toBe('A saved draft')
  submitTripFeedback.mockResolvedValueOnce({success:false,error:{message:'Connection interrupted'}})
  submitTripFeedback.mockResolvedValueOnce({success:true,submittedAt:'2026-10-26T10:00:00Z'})
  fireEvent.click(screen.getByRole('button',{name:'Submit answers'}))
  expect(await screen.findByText('Connection interrupted')).toBeTruthy()
  expect(screen.getByLabelText('Comments (optional)').value).toBe('A saved draft')
  fireEvent.click(screen.getByRole('button',{name:'Submit answers'}))
  expect(await screen.findByText('Thank you. Your answers are saved.')).toBeTruthy()
  expect(submitTripFeedback.mock.calls.every(([id,token])=>id===snapshot.id&&token===snapshot.feedbackToken)).toBe(true)
  const {readEntries}=await import('../lib/followUpStore.js')
  await waitFor(async()=>expect(await readEntries()).toEqual([]))
})

test('a resumed trip hitting the 30-minute cap also opens the questionnaire after saving',async()=>{
  uploadTrip.mockImplementation(async trip=>({success:true,tripId:trip.id}))
  render(<Recorder />)
  fireEvent.click(screen.getByRole('button',{name:'Start trip'}))
  await waitFor(()=>expect(screen.getByText('Recording active')).toBeTruthy())
  vi.spyOn(Date,'now').mockReturnValue(Date.now()+1800001)
  act(()=>document.dispatchEvent(new Event('visibilitychange')))
  expect(await screen.findByText('How was your ride?')).toBeTruthy()
  expect(uploadTrip.mock.calls[0][0].durationSeconds).toBe(1800)
  expect(screen.getByText('30-minute limit reached.')).toBeTruthy()
})
