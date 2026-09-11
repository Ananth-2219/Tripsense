import { useEffect, useRef, useState } from 'react'
import {
  requestMotionPermission,
  requestGeolocationPermission,
  requestWakeLock,
  releaseWakeLock,
  startRecording,
  stopRecording,
} from '../lib/sensors.js'

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
  const [message, setMessage] = useState('')
  const readingsRef = useRef([])
  const countsRef = useRef({ motion: 0, location: 0 })
  const sessionRef = useRef(null)

  useEffect(() => () => {
    // Invalidate pending permission requests when navigating away.
    sessionRef.current = null
    stopRecording()
    void releaseWakeLock()
  }, [])

  useEffect(() => {
    if (phase !== 'recording') return
    // Keep every reading, but avoid rerendering at the motion sensor's rate.
    const interval = setInterval(() => setCounts({ ...countsRef.current }), 250)
    return () => clearInterval(interval)
  }, [phase])

  async function startTrip() {
    if (sessionRef.current) return
    const session = {}
    sessionRef.current = session
    readingsRef.current = []
    countsRef.current = { motion: 0, location: 0 }
    setCounts({ ...countsRef.current })
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

      startRecording((reading) => {
        if (sessionRef.current !== session) return
        if (reading.type !== 'motion' && reading.type !== 'location') return
        readingsRef.current.push(reading)
        countsRef.current[reading.type]++
      })
      // startRecording also requests a lock; the helper deduplicates this call.
      void requestWakeLock()
      setPhase('recording')
    } catch (error) {
      if (sessionRef.current !== session) return
      sessionRef.current = null
      stopRecording()
      void releaseWakeLock()
      setPhase('idle')
      setMessage('Could not start recording. Please try again.')
      console.error('Could not start trip:', error)
    }
  }

  function stopTrip() {
    sessionRef.current = null
    stopRecording()
    void releaseWakeLock()
    const totals = { ...countsRef.current }
    setCounts(totals)
    setPhase('idle')
    setMessage(phase === 'requesting' ? 'Trip start cancelled.' : 'Trip stopped.')
    console.info('Trip readings captured:', { ...totals, total: readingsRef.current.length })
  }

  const active = phase !== 'idle'

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
          {phase === 'recording' ? 'Recording active' : phase === 'requesting' ? 'Requesting permissions…' : 'Not recording'}
        </p>
        <div className="mt-2">
          <p className="text-5xl font-bold tabular-nums tracking-tight" aria-label="Total readings captured">
            {counts.motion + counts.location}
          </p>
          <p className="mt-1 text-sm text-slate-500">readings captured</p>
          <p className="mt-3 text-sm tabular-nums text-slate-600">
            Motion: {counts.motion} · Location: {counts.location}
          </p>
        </div>

        <button
          type="button"
          onClick={active ? stopTrip : startTrip}
          aria-describedby="recording-disclosure"
          className={`mt-6 min-h-14 w-full rounded-xl px-5 py-4 text-base font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-700 ${active ? 'bg-rose-700 hover:bg-rose-800' : 'bg-teal-700 hover:bg-teal-800'}`}
        >
          {active ? 'Stop trip' : 'Start trip'}
        </button>
        {message && <p role="status" className="mt-4 text-sm leading-6 text-slate-600">{message}</p>}
      </div>
    </section>
  )
}

