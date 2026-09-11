/** @typedef {'granted' | 'denied' | 'unsupported'} PermissionStatus */

let activeRecording = null

/**
 * Start one recording session, replacing any previous session. Request sensor
 * permissions first. Unsupported data sources are skipped.
 * Motion readings: { type: 'motion', timestamp, x, y, z } (m/s²).
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
    watchId: null,
  }
  activeRecording = session

  session.motionListener = (event) => {
    if (activeRecording !== session) return

    let acceleration = event.acceleration
    if (!acceleration || [acceleration.x, acceleration.y, acceleration.z].every((axis) => axis == null)) {
      acceleration = event.accelerationIncludingGravity
    }
    if (!acceleration || [acceleration.x, acceleration.y, acceleration.z].every((axis) => axis == null)) return

    onReading({
      type: 'motion',
      timestamp: Date.now(),
      x: acceleration.x ?? null,
      y: acceleration.y ?? null,
      z: acceleration.z ?? null,
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
  } catch (error) {
    stopRecording()
    throw error
  }
}

/** Remove the motion listener and location watch. Safe to call repeatedly. */
export function stopRecording() {
  const session = activeRecording
  if (!session) return
  activeRecording = null

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

