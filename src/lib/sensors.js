/** @typedef {'granted' | 'denied' | 'unsupported'} PermissionStatus */

export const MAX_TRIP_DURATION_SECONDS = 1800

let activeRecording = null
let wakeLock = null
let pendingWakeLock = null
let wakeLockWanted = false

async function releaseSentinel(sentinel) {
  if (!sentinel || sentinel.released) return
  try {
    await sentinel.release()
  } catch (error) {
    console.info('Unable to release screen wake lock:', error)
  }
}

/** Request a screen wake lock. Returns the sentinel, or null if unavailable. */
export async function requestWakeLock() {
  wakeLockWanted = true
  const browser = typeof window === 'undefined' ? undefined : window
  const api = browser?.navigator?.wakeLock
  if (typeof api?.request !== 'function') {
    console.info('Screen Wake Lock API is unsupported; continuing without a wake lock.')
    return null
  }
  if (browser.document?.visibilityState === 'hidden') return null
  if (wakeLock && !wakeLock.released) return wakeLock
  if (pendingWakeLock) return pendingWakeLock.promise

  // A unique request token prevents a late result from surviving stop/restart.
  const request = { promise: null }
  pendingWakeLock = request
  request.promise = Promise.resolve().then(async () => {
    if (pendingWakeLock !== request) return null
    try {
      const sentinel = await api.request('screen')
      if (pendingWakeLock !== request || !wakeLockWanted) {
        await releaseSentinel(sentinel)
        return null
      }
      wakeLock = sentinel
      sentinel.addEventListener('release', () => {
        if (wakeLock === sentinel) wakeLock = null
      }, { once: true })
      return sentinel
    } catch (error) {
      console.info('Unable to acquire screen wake lock; continuing recording:', error)
      return null
    } finally {
      if (pendingWakeLock === request) pendingWakeLock = null
    }
  })
  return request.promise
}

/** Release the lock and cancel pending acquisition. Safe to call repeatedly. */
export async function releaseWakeLock() {
  wakeLockWanted = false
  const pending = pendingWakeLock
  const sentinel = wakeLock
  pendingWakeLock = null
  wakeLock = null
  await Promise.all([releaseSentinel(sentinel), pending?.promise])
}

/**
 * Start one recording session, replacing any previous session. Request sensor
 * permissions first. Unsupported data sources are skipped.
 * Motion readings: { type: 'motion', timestamp, x, y, z } (m/s²).
 * Also includes rotationAlpha, rotationBeta, rotationGamma (degrees/sec around
 * the phone's z, x, y axes respectively); unavailable values default to null.
 * Location readings: { type: 'location', timestamp, lat, lon } (degrees).
 * Timestamps are Unix milliseconds; motion uses receipt time, location uses
 * the position's timestamp. Missing motion axes remain null.
 * @param {(reading: object) => void} onReading
 */
export function startRecording(onReading) {
  if (typeof onReading !== 'function') {
    throw new TypeError('onReading must be a function')
  }

  stopRecording()
  if (typeof window === 'undefined') return

  const session = {
    target: window,
    geolocation: window.navigator?.geolocation,
    motionListener: null,
    lastMotionTimestamp: null,
    watchId: null,
    document: window.document,
    visibilityListener: null,
  }
  activeRecording = session

  session.motionListener = (event) => {
    if (activeRecording !== session) return

    let acceleration = event.acceleration
    if (!acceleration || [acceleration.x, acceleration.y, acceleration.z].every((axis) => axis == null)) {
      acceleration = event.accelerationIncludingGravity
    }
    const motion = {
      x: acceleration?.x ?? null,
      y: acceleration?.y ?? null,
      z: acceleration?.z ?? null,
      rotationAlpha: event.rotationRate?.alpha ?? null,
      rotationBeta: event.rotationRate?.beta ?? null,
      rotationGamma: event.rotationRate?.gamma ?? null,
    }
    if (Object.values(motion).every((value) => value === null)) return

    // Filter real callbacks to at most one valid reading every 100 ms.
    const motionTimestamp = event.timeStamp
    if (session.lastMotionTimestamp !== null && motionTimestamp - session.lastMotionTimestamp < 100) return
    session.lastMotionTimestamp = motionTimestamp

    onReading({
      type: 'motion',
      timestamp: Date.now(),
      ...motion,
    })
  }

  try {
    session.target.addEventListener('devicemotion', session.motionListener)
    if (typeof session.geolocation?.watchPosition === 'function') {
      session.watchId = session.geolocation.watchPosition(
        (position) => {
          // A callback queued before stop/restart must not emit stale readings.
          if (activeRecording !== session) return
          onReading({
            type: 'location',
            timestamp: position.timestamp,
            lat: position.coords.latitude,
            lon: position.coords.longitude,
          })
        },
        null,
        { enableHighAccuracy: true, maximumAge: 0 },
      )
    }
    session.visibilityListener = () => {
      if (activeRecording === session && wakeLockWanted && session.document.visibilityState === 'visible') {
        void requestWakeLock()
      }
    }
    session.document?.addEventListener('visibilitychange', session.visibilityListener)
    void requestWakeLock()
  } catch (error) {
    stopRecording()
    throw error
  }
}

/** Remove listeners, clear the location watch, and release the screen lock. */
export function stopRecording() {
  const session = activeRecording
  void releaseWakeLock()
  if (!session) return
  activeRecording = null
  session.lastMotionTimestamp = null
  session.document?.removeEventListener('visibilitychange', session.visibilityListener)

  try {
    session.target.removeEventListener('devicemotion', session.motionListener)
  } finally {
    // Zero is a valid watch ID.
    if (session.watchId !== null) session.geolocation.clearWatch(session.watchId)
  }
}

/**
 * Call directly from a user gesture (such as a button click) on iOS.
 * Without an explicit permission API, granted means no prompt is required;
 * it does not guarantee that the device has working motion sensors.
 * Does not register event listeners.
 * @returns {Promise<PermissionStatus>}
 */
export async function requestMotionPermission() {
  if (typeof window === 'undefined' || !window.DeviceMotionEvent) {
    return 'unsupported'
  }
  if (window.isSecureContext === false) return 'denied'

  const motion = window.DeviceMotionEvent
  if (typeof motion.requestPermission !== 'function') return 'granted'

  try {
    // Invoke before any await to preserve the browser's user activation.
    const status = await motion.requestPermission()
    return status === 'granted' ? 'granted' : 'denied'
  } catch {
    return 'denied'
  }
}

/**
 * Check permission, prompting with a single high-accuracy location request
 * when needed. Discards coordinates and does not start watchPosition or
 * permission-change listeners.
 * @returns {Promise<PermissionStatus>}
 */
export async function requestGeolocationPermission() {
  if (
    typeof window === 'undefined' ||
    typeof window.navigator?.geolocation?.getCurrentPosition !== 'function'
  ) {
    return 'unsupported'
  }
  if (window.isSecureContext === false) return 'denied'

  const { navigator } = window
  try {
    const permission = await navigator.permissions?.query({ name: 'geolocation' })
    if (permission?.state === 'granted' || permission?.state === 'denied') {
      return permission.state
    }
  } catch {
    // Some browsers expose Permissions but do not support this query.
  }

  return new Promise((resolve) => {
    try {
      navigator.geolocation.getCurrentPosition(
        () => resolve('granted'),
        (error) => {
          // POSITION_UNAVAILABLE (2) and TIMEOUT (3) are acquisition failures
          // after permission is granted, not a refusal of permission.
          resolve(error.code === 2 || error.code === 3 ? 'granted' : 'denied')
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
      )
    } catch {
      resolve('denied')
    }
  })
}

