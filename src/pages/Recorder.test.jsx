// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import Recorder from './Recorder.jsx'
import * as sensors from '../lib/sensors.js'

vi.mock('../lib/sensors.js', () => ({
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
  sensors.stopRecording.mockClear()
  sensors.releaseWakeLock.mockClear()
  fireEvent.click(screen.getByRole('button', { name: 'Stop trip' }))
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
})

test('a recording setup failure restores the Start button and cleans up', async () => {
  sensors.startRecording.mockImplementation(() => { throw new Error('Sensor failure') })
  render(<Recorder />)
  await start()
  expect(screen.getByText('Could not start recording. Please try again.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Start trip' })).toBeTruthy()
  expect(sensors.stopRecording).toHaveBeenCalled()
  expect(sensors.releaseWakeLock).toHaveBeenCalled()
})
