// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import Recorder, { MAX_TRIP_DURATION_SECONDS } from './Recorder.jsx'
import * as sensors from '../lib/sensors.js'
import { uploadTrip } from '../lib/upload.js'

vi.mock('../lib/upload.js', () => ({ uploadTrip: vi.fn() }))

vi.mock('../lib/sensors.js', () => ({
  MAX_TRIP_DURATION_SECONDS: 1800,
  requestMotionPermission: vi.fn(),
  requestGeolocationPermission: vi.fn(),
  requestWakeLock: vi.fn(),
  releaseWakeLock: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  uploadTrip.mockResolvedValue({ success: true, error: null })
  sensors.requestMotionPermission.mockResolvedValue('granted')
  sensors.requestGeolocationPermission.mockResolvedValue('granted')
  sensors.requestWakeLock.mockResolvedValue(null)
  sensors.releaseWakeLock.mockResolvedValue(undefined)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function start() {
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start trip' })))
}

test('starts, counts buffered readings, stops, and resets for the next trip', async () => {
  render(<StrictMode><Recorder /></StrictMode>)
  expect(screen.getAllByText('not started')).toHaveLength(2)
  expect(screen.getByText('This records motion and location data while active, used only for a driving safety project.')).toBeTruthy()
  await start()
  expect(screen.getAllByText('granted')).toHaveLength(2)
  expect(sensors.requestMotionPermission).toHaveBeenCalledOnce()
  expect(sensors.requestGeolocationPermission).toHaveBeenCalledOnce()
  expect(sensors.requestWakeLock).toHaveBeenCalledOnce()
  expect(screen.getByText('Recording active')).toBeTruthy()
  const onReading = sensors.startRecording.mock.calls[0][0]
  act(() => {
    onReading({ type: 'motion', timestamp: 1, x: 0, y: 1, z: 2 })
    onReading({ type: 'motion', timestamp: 2, x: 1, y: 2, z: 3 })
    onReading({ type: 'location', timestamp: 3, lat: 12, lon: 77 })
    vi.advanceTimersByTime(250)
  })
  expect(screen.getByLabelText('Total readings captured').textContent).toBe('3')
  expect(screen.getByText('Motion: 2 · Location: 1')).toBeTruthy()
  expect(screen.getByLabelText('Elapsed time').textContent).toBe('00:00')
  sensors.stopRecording.mockClear()
  sensors.releaseWakeLock.mockClear()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Stop trip' }))
  })
  expect(sensors.stopRecording).toHaveBeenCalledOnce()
  expect(sensors.releaseWakeLock).toHaveBeenCalledOnce()
  expect(console.info).toHaveBeenCalledWith('Trip readings captured:', { motion: 2, location: 1, total: 3 })
  act(() => onReading({ type: 'motion' }))
  expect(screen.getByLabelText('Total readings captured').textContent).toBe('3')
  await start()
  expect(screen.getByLabelText('Total readings captured').textContent).toBe('0')
})

test.each(['denied', 'unsupported'])('does not record when a permission is %s', async (status) => {
  sensors.requestGeolocationPermission.mockResolvedValue(status)
  render(<Recorder />)
  await start()
  expect(screen.getByText(status)).toBeTruthy()
  expect(sensors.startRecording).not.toHaveBeenCalled()
  expect(sensors.requestWakeLock).not.toHaveBeenCalled()
  expect(uploadTrip).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Start trip' })).toBeTruthy()
})

test('motion permission is invoked synchronously from Start and a pending start can be cancelled', async () => {
  let resolveMotion
  sensors.requestMotionPermission.mockReturnValue(new Promise((resolve) => { resolveMotion = resolve }))
  render(<Recorder />)
  fireEvent.click(screen.getByRole('button', { name: 'Start trip' }))
  expect(sensors.requestMotionPermission).toHaveBeenCalledOnce()
  expect(screen.getByText('Requesting permissions…')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Stop trip' }))
  await act(async () => resolveMotion('granted'))
  expect(sensors.startRecording).not.toHaveBeenCalled()
  expect(screen.getByText('Trip start cancelled.')).toBeTruthy()
  expect(uploadTrip).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Download as JSON' })).toBeNull()
})

test('unmount cancels a pending permission request', async () => {
  let resolveMotion
  sensors.requestMotionPermission.mockReturnValue(new Promise((resolve) => { resolveMotion = resolve }))
  const { unmount } = render(<Recorder />)
  fireEvent.click(screen.getByRole('button', { name: 'Start trip' }))
  unmount()
  await act(async () => resolveMotion('granted'))
  expect(sensors.startRecording).not.toHaveBeenCalled()
  expect(sensors.stopRecording).toHaveBeenCalled()
  expect(sensors.releaseWakeLock).toHaveBeenCalled()
})

test('unmount stops recording, releases the lock, and clears the counter timer', async () => {
  const { unmount } = render(<Recorder />)
  await start()
  sensors.stopRecording.mockClear()
  sensors.releaseWakeLock.mockClear()
  unmount()
  expect(sensors.stopRecording).toHaveBeenCalledOnce()
  expect(sensors.releaseWakeLock).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  expect(uploadTrip).not.toHaveBeenCalled()
})

test('a recording setup failure restores the Start button and cleans up', async () => {
  sensors.startRecording.mockImplementation(() => { throw new Error('Sensor failure') })
  render(<Recorder />)
  await start()
  expect(screen.getByText('Could not start recording. Please try again.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Start trip' })).toBeTruthy()
  expect(sensors.stopRecording).toHaveBeenCalled()
  expect(sensors.releaseWakeLock).toHaveBeenCalled()
  expect(uploadTrip).not.toHaveBeenCalled()
})

test('uploads one completed snapshot after cleanup with recording timestamps and final counts', async () => {
  let resolveUpload
  uploadTrip.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve }))
  vi.setSystemTime(new Date('2026-10-07T10:00:00Z'))
  render(<StrictMode><Recorder /></StrictMode>)
  await start()
  const onReading = sensors.startRecording.mock.calls[0][0]
  const readings = [{ type: 'motion', timestamp: 1 }, { type: 'location', timestamp: 2 }]
  act(() => {
    readings.forEach(onReading)
    vi.advanceTimersByTime(1250)
  })
  expect(uploadTrip).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Stop trip' }))
  expect(uploadTrip).toHaveBeenCalledOnce()
  expect(uploadTrip).toHaveBeenCalledWith({
    startedAt: '2026-10-07T10:00:00.000Z', endedAt: '2026-10-07T10:00:01.250Z',
    durationSeconds: 1.25, motionCount: 1, locationCount: 1, readings,
  })
  expect(sensors.stopRecording.mock.invocationCallOrder.at(-1)).toBeLessThan(uploadTrip.mock.invocationCallOrder[0])
  expect(sensors.releaseWakeLock.mock.invocationCallOrder.at(-1)).toBeLessThan(uploadTrip.mock.invocationCallOrder[0])
  act(() => onReading({ type: 'motion', timestamp: 3 }))
  expect(uploadTrip.mock.calls[0][0].readings).toEqual(readings)
  expect(screen.getByText('Uploading trip…')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Download as JSON' })).toBeNull()
  await act(async () => resolveUpload({ success: true, error: null }))
  expect(screen.getByText('Trip uploaded.')).toBeTruthy()
  expect(uploadTrip).toHaveBeenCalledOnce()
})

test('failed upload keeps cleanup and allows another trip', async () => {
  uploadTrip.mockResolvedValue({ success: false, error: { message: 'Could not upload trip.', code: '42501' } })
  render(<Recorder />)
  await start()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop trip' })))
  expect(screen.getByText('Trip upload failed.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Download as JSON' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Start trip' })).toBeTruthy()
  expect(sensors.stopRecording).toHaveBeenCalled()
  expect(sensors.releaseWakeLock).toHaveBeenCalled()
})

test('no new trip starts while the previous upload is pending', async () => {
  let resolveUpload
  uploadTrip.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve }))
  render(<Recorder />)
  await start()
  act(() => sensors.startRecording.mock.calls[0][0]({ type: 'motion', timestamp: 1 }))
  fireEvent.click(screen.getByRole('button', { name: 'Stop trip' }))
  expect(uploadTrip).toHaveBeenCalledOnce()

  // During upload, button is disabled with "Saving trip…"
  const savingButton = screen.getByRole('button', { name: 'Saving trip…' })
  expect(savingButton.disabled).toBe(true)

  // Attempting to click does not start a new trip
  sensors.startRecording.mockClear()
  fireEvent.click(savingButton)
  expect(sensors.startRecording).not.toHaveBeenCalled()

  // Once upload resolves, "Start trip" is restored and usable
  await act(async () => resolveUpload({ success: true, error: null }))
  expect(screen.getByText('Trip uploaded.')).toBeTruthy()
  const startButton = screen.getByRole('button', { name: 'Start trip' })
  expect(startButton.disabled).toBe(false)

  await start()
  expect(sensors.startRecording).toHaveBeenCalledOnce()
})

test('manual stop before 30 minutes uploads correct duration and readings', async () => {
  vi.setSystemTime(new Date('2026-10-07T10:00:00Z'))
  render(<Recorder />)
  await start()
  const onReading = sensors.startRecording.mock.calls[0][0]
  act(() => {
    onReading({ type: 'motion', timestamp: 1 })
    vi.advanceTimersByTime(300000) // 5 minutes
  })
  expect(screen.getByLabelText('Elapsed time').textContent).toBe('05:00')
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Stop trip' }))
  })
  expect(uploadTrip).toHaveBeenCalledWith(expect.objectContaining({
    durationSeconds: 300,
    startedAt: '2026-10-07T10:00:00.000Z',
    endedAt: '2026-10-07T10:05:00.000Z',
    motionCount: 1,
  }))
})

test('automatically stops at 30 minutes, cleans up, and uploads with 1800s duration', async () => {
  let resolveUpload
  uploadTrip.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve }))
  vi.setSystemTime(new Date('2026-10-07T10:00:00Z'))
  render(<Recorder />)
  await start()
  const onReading = sensors.startRecording.mock.calls[0][0]
  act(() => {
    onReading({ type: 'motion', timestamp: 100 })
    onReading({ type: 'location', timestamp: 200, lat: 10, lon: 20 })
  })

  // Advance time by exactly 30 minutes (1800 seconds)
  await act(async () => {
    vi.advanceTimersByTime(MAX_TRIP_DURATION_SECONDS * 1000)
  })

  expect(sensors.stopRecording).toHaveBeenCalled()
  expect(sensors.releaseWakeLock).toHaveBeenCalled()
  expect(uploadTrip).toHaveBeenCalledOnce()
  expect(uploadTrip).toHaveBeenCalledWith({
    startedAt: '2026-10-07T10:00:00.000Z',
    endedAt: '2026-10-07T10:30:00.000Z',
    durationSeconds: 1800,
    motionCount: 1,
    locationCount: 1,
    readings: [
      { type: 'motion', timestamp: 100 },
      { type: 'location', timestamp: 200, lat: 10, lon: 20 },
    ],
  })
  expect(screen.getByText('30-minute limit reached. Saving trip…')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Saving trip…' }).disabled).toBe(true)

  await act(async () => resolveUpload({ success: true, error: null }))
  expect(screen.getByText('Trip uploaded.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Start trip' }).disabled).toBe(false)
})

test('delayed timer or resume past 30 minutes stops immediately and caps duration to 1800', async () => {
  vi.setSystemTime(new Date('2026-10-07T10:00:00Z'))
  render(<Recorder />)
  await start()
  const onReading = sensors.startRecording.mock.calls[0][0]
  act(() => {
    onReading({ type: 'motion', timestamp: 100 })
  })

  // Simulate backgrounding: jump time 35 minutes forward
  vi.setSystemTime(new Date('2026-10-07T10:35:00Z'))
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
  })

  expect(sensors.stopRecording).toHaveBeenCalled()
  expect(uploadTrip).toHaveBeenCalledOnce()
  expect(uploadTrip).toHaveBeenCalledWith(expect.objectContaining({
    durationSeconds: 1800,
    startedAt: '2026-10-07T10:00:00.000Z',
    endedAt: '2026-10-07T10:30:00.000Z',
    motionCount: 1,
  }))
})

test('no readings accepted at or after the 30-minute deadline', async () => {
  vi.setSystemTime(new Date('2026-10-07T10:00:00Z'))
  render(<Recorder />)
  await start()
  const onReading = sensors.startRecording.mock.calls[0][0]

  // Reading before deadline (at 29m 50s)
  vi.setSystemTime(new Date('2026-10-07T10:29:50Z'))
  act(() => {
    onReading({ type: 'motion', timestamp: 1 })
  })

  // Advance time past deadline (30m 1s)
  vi.setSystemTime(new Date('2026-10-07T10:30:01Z'))
  await act(async () => {
    onReading({ type: 'motion', timestamp: 2 })
  })

  expect(uploadTrip).toHaveBeenCalledOnce()
  // The reading at 30:01 must not be in the readings array
  expect(uploadTrip.mock.calls[0][0].readings).toEqual([{ type: 'motion', timestamp: 1 }])
  expect(uploadTrip.mock.calls[0][0].motionCount).toBe(1)
})

test('only one upload occurs when manual stop and timeout coincide', async () => {
  vi.setSystemTime(new Date('2026-10-07T10:00:00Z'))
  render(<Recorder />)
  await start()
  const onReading = sensors.startRecording.mock.calls[0][0]
  act(() => onReading({ type: 'motion', timestamp: 1 }))

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Stop trip' }))
    vi.advanceTimersByTime(MAX_TRIP_DURATION_SECONDS * 1000)
  })

  expect(uploadTrip).toHaveBeenCalledOnce()
})

test('failed upload on automatic stop displays clear error without claiming success', async () => {
  uploadTrip.mockResolvedValue({ success: false, error: { message: 'Network error', code: null } })
  vi.setSystemTime(new Date('2026-10-07T10:00:00Z'))
  render(<Recorder />)
  await start()

  await act(async () => {
    vi.advanceTimersByTime(MAX_TRIP_DURATION_SECONDS * 1000)
  })

  expect(screen.getByText('Trip upload failed.')).toBeTruthy()
  expect(screen.queryByText('Trip uploaded.')).toBeNull()
  expect(screen.getByRole('button', { name: 'Start trip' }).disabled).toBe(false)
})
