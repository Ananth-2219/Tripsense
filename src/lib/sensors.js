/** @typedef {'granted' | 'denied' | 'unsupported'} PermissionStatus */

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

