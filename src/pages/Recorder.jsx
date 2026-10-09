import { useCallback, useEffect, useRef, useState } from 'react'
import { uploadTrip } from '../lib/upload.js'
import {
  requestMotionPermission,
  requestGeolocationPermission,
  requestWakeLock,
  releaseWakeLock,
  startRecording,
  stopRecording,
} from '../lib/sensors.js'

export const MAX_TRIP_DURATION_SECONDS = 1800

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds))
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

const permissionStyles = {
  'not started': 'bg-slate-100 text-slate-600',
  granted: 'bg-teal-50 text-teal-800',
  denied: 'bg-rose-50 text-rose-800',
  unsupported: 'bg-amber-50 text-amber-800',
}

export default function Recorder() {
  const [phase, setPhase] = useState('idle')
  const [permissions, setPermissions] = useState({ motion: 'not started', location: 'not started' })
  const [counts, setCounts] = useState({ motion: 0, location: 0 })
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [message, setMessage] = useState('')
  const [uploadStatus, setUploadStatus] = useState('')
  const readingsRef = useRef([])
  const countsRef = useRef({ motion: 0, location: 0 })
  const sessionRef = useRef(null)
  const uploadRef = useRef(null)

  const stopTrip = useCallback((options = {}) => {
    const { autoStop = false } = options
    const session = sessionRef.current
    if (!session) return
    sessionRef.current = null

    if (session.timeoutId) {
      clearTimeout(session.timeoutId)
      session.timeoutId = null
    }

    stopRecording()
    void releaseWakeLock()

    const totals = { ...countsRef.current }
    setCounts(totals)

    const hadStarted = Boolean(session.startedAt)

    if (!hadStarted) {
      setPhase('idle')
      setMessage('Trip start cancelled.')
      return
    }

    const now = new Date()
    const rawDuration = (now.getTime() - session.startedAt.getTime()) / 1000
    const reachedLimit = autoStop || rawDuration >= MAX_TRIP_DURATION_SECONDS
    const durationSeconds = reachedLimit
      ? MAX_TRIP_DURATION_SECONDS
      : rawDuration
    const endedAt = reachedLimit
      ? new Date(session.startedAt.getTime() + MAX_TRIP_DURATION_SECONDS * 1000)
      : now

    setElapsedSeconds(Math.floor(durationSeconds))
    setPhase('uploading')

    if (reachedLimit) {
      setMessage('30-minute limit reached.')
      setUploadStatus('30-minute limit reached. Saving trip…')
    } else {
      setMessage('Trip stopped.')
      setUploadStatus('Uploading trip…')
    }

    console.info('Trip readings captured:', { ...totals, total: readingsRef.current.length })

    const trip = {
      startedAt: session.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationSeconds,
      motionCount: totals.motion,
      locationCount: totals.location,
      readings: [...readingsRef.current],
    }

    uploadRef.current = session
    void uploadTrip(trip).then(({ success }) => {
      if (uploadRef.current !== session) return
      setUploadStatus(success ? 'Trip uploaded.' : 'Trip upload failed.')
      setPhase('idle')
    })
  }, [])

  useEffect(() => () => {
    // Invalidate pending permission requests and timers when navigating away.
    if (sessionRef.current?.timeoutId) {
      clearTimeout(sessionRef.current.timeoutId)
    }
    sessionRef.current = null
    uploadRef.current = null
    stopRecording()
    void releaseWakeLock()
  }, [])

  useEffect(() => {
    if (phase !== 'recording') return

    // Keep every reading, check elapsed limit, and update timer/counts.
    const interval = setInterval(() => {
      if (!sessionRef.current?.startedAt) return
      const elapsed = (Date.now() - sessionRef.current.startedAt.getTime()) / 1000
      if (elapsed >= MAX_TRIP_DURATION_SECONDS) {
        stopTrip({ autoStop: true })
        return
      }
      setElapsedSeconds(Math.floor(elapsed))
      setCounts({ ...countsRef.current })
    }, 250)

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && sessionRef.current?.startedAt) {
        const elapsed = (Date.now() - sessionRef.current.startedAt.getTime()) / 1000
        if (elapsed >= MAX_TRIP_DURATION_SECONDS) {
          stopTrip({ autoStop: true })
        }
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [phase, stopTrip])

  async function startTrip() {
    if (sessionRef.current || phase === 'uploading') return
    const session = { timeoutId: null, startedAt: null }
    sessionRef.current = session
    uploadRef.current = null
    setUploadStatus('')
    readingsRef.current = []
    countsRef.current = { motion: 0, location: 0 }
    setCounts({ ...countsRef.current })
    setElapsedSeconds(0)
    setMessage('')
    setPermissions({ motion: 'not started', location: 'not started' })
    setPhase('requesting')

    try {
      // Invoke motion permission directly in the click handler for iOS.
      const motionRequest = requestMotionPermission()
      const locationRequest = requestGeolocationPermission()
      const [motion, location] = await Promise.all([motionRequest, locationRequest])
      if (sessionRef.current !== session) return
      setPermissions({ motion, location })

      if (motion !== 'granted' || location !== 'granted') {
        sessionRef.current = null
        setPhase('idle')
        setMessage(motion === 'unsupported' || location === 'unsupported'
          ? 'This browser does not support all required sensors. Try a supported browser on your phone.'
          : 'Motion and location access are needed to start a trip. Allow both in your browser settings and try again.')
        return
      }

      const startedAt = new Date()
      session.startedAt = startedAt

      startRecording((reading) => {
        if (sessionRef.current !== session) return
        if (reading.type !== 'motion' && reading.type !== 'location') return
        const elapsed = (Date.now() - session.startedAt.getTime()) / 1000
        if (elapsed >= MAX_TRIP_DURATION_SECONDS) {
          stopTrip({ autoStop: true })
          return
        }
        readingsRef.current.push(reading)
        countsRef.current[reading.type]++
      })

      // Schedule strict auto-stop timeout
      session.timeoutId = setTimeout(() => {
        if (sessionRef.current === session) {
          stopTrip({ autoStop: true })
        }
      }, MAX_TRIP_DURATION_SECONDS * 1000)

      // startRecording also requests a lock; the helper deduplicates this call.
      void requestWakeLock()
      setPhase('recording')
    } catch (error) {
      if (sessionRef.current !== session) return
      if (session.timeoutId) clearTimeout(session.timeoutId)
      sessionRef.current = null
      stopRecording()
      void releaseWakeLock()
      setPhase('idle')
      setMessage('Could not start recording. Please try again.')
      console.error('Could not start trip:', error)
    }
  }

  const isRecordingOrRequesting = phase === 'recording' || phase === 'requesting'

  return (
    <section aria-labelledby="recorder-title" className="mx-auto max-w-md">
      <h1 id="recorder-title" className="text-3xl font-bold tracking-tight">Recorder</h1>
      <p id="recording-disclosure" className="mt-3 text-sm leading-6 text-slate-600">
        This records motion and location data while active, used only for a driving safety project.
      </p>

      <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
        <dl aria-label="Sensor permissions" aria-live="polite" className="space-y-4">
          {Object.entries(permissions).map(([sensor, status]) => (
            <div key={sensor} className="flex items-center justify-between gap-3">
              <dt className="text-sm font-medium">{sensor === 'motion' ? 'Motion permission' : 'Location permission'}</dt>
              <dd className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ${permissionStyles[status]}`}>
                {status}
              </dd>
            </div>
          ))}
        </dl>

        <p role="status" className="mt-6 text-sm font-medium text-slate-600">
          {phase === 'recording'
            ? 'Recording active'
            : phase === 'requesting'
              ? 'Requesting permissions…'
              : phase === 'uploading'
                ? 'Saving trip…'
                : 'Not recording'}
        </p>
        <div className="mt-2">
          <p className="text-5xl font-bold tabular-nums tracking-tight" aria-label="Total readings captured">
            {counts.motion + counts.location}
          </p>
          <p className="mt-1 text-sm text-slate-500">readings captured</p>
          <p className="mt-3 text-sm tabular-nums text-slate-600">
            Motion: {counts.motion} · Location: {counts.location}
          </p>
          <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
            <span className="text-sm text-slate-500">Elapsed time</span>
            <span className="font-mono text-base font-semibold tabular-nums text-slate-700" aria-label="Elapsed time">
              {formatDuration(elapsedSeconds)}
            </span>
          </div>
        </div>

        <button
          type="button"
          disabled={phase === 'uploading'}
          onClick={isRecordingOrRequesting ? () => stopTrip({ autoStop: false }) : startTrip}
          aria-describedby="recording-disclosure"
          className={`mt-6 min-h-14 w-full rounded-xl px-5 py-4 text-base font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-700 ${
            phase === 'uploading'
              ? 'cursor-not-allowed bg-slate-400 opacity-70'
              : isRecordingOrRequesting
                ? 'bg-rose-700 hover:bg-rose-800'
                : 'bg-teal-700 hover:bg-teal-800'
          }`}
        >
          {isRecordingOrRequesting
            ? 'Stop trip'
            : phase === 'uploading'
              ? 'Saving trip…'
              : 'Start trip'}
        </button>
        {message && <p role="status" className="mt-4 text-sm leading-6 text-slate-600">{message}</p>}
        {uploadStatus && <p role="status" className="mt-4 text-sm leading-6 text-slate-600">{uploadStatus}</p>}
      </div>
    </section>
  )
}

