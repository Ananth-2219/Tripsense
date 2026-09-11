import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requestGeolocationPermission, requestMotionPermission, startRecording, stopRecording, requestWakeLock, releaseWakeLock } from './sensors.js'
import { setImmediate } from 'node:timers/promises'

function setWindow(t, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else delete globalThis.window
  })
}

function recordingBrowser(t, { location = true, throws = false } = {}) {
  const target = new EventTarget()
  const watches = []
  const cleared = []
  target.navigator = location ? { geolocation: {
    watchPosition(success, _error, options) {
      if (throws) throw new Error('Watch failed')
      watches.push({ success, options })
      return watches.length - 1
    },
    clearWatch(id) { cleared.push(id) },
  } } : {}
  setWindow(t, target)
  t.after(stopRecording)
  return {
    target, watches, cleared,
    motion(acceleration, accelerationIncludingGravity = null, rotationRate = null) {
      const event = new Event('devicemotion')
      Object.assign(event, { acceleration, accelerationIncludingGravity, rotationRate })
      target.dispatchEvent(event)
    },
  }
}

function wakeLockBrowser(t) {
  const browser = recordingBrowser(t)
  const document = new EventTarget()
  document.visibilityState = 'visible'
  browser.target.document = document
  const sentinels = []
  browser.target.navigator.wakeLock = {
    async request(type) {
      assert.equal(type, 'screen')
      const sentinel = new EventTarget()
      sentinel.released = false
      sentinel.releaseCalls = 0
      sentinel.release = async () => {
        sentinel.releaseCalls++
        sentinel.released = true
        sentinel.dispatchEvent(new Event('release'))
      }
      sentinels.push(sentinel)
      return sentinel
    },
  }
  return { ...browser, document, sentinels }
}

test('wake lock requests share one sentinel and release is idempotent', async (t) => {
  const browser = wakeLockBrowser(t)
  const [first, second] = await Promise.all([requestWakeLock(), requestWakeLock()])
  assert.equal(first, second)
  assert.equal(await requestWakeLock(), first)
  assert.equal(browser.sentinels.length, 1)
  await releaseWakeLock()
  await releaseWakeLock()
  assert.equal(first.releaseCalls, 1)
})

test('recording reacquires after visibility returns and removes listener on stop', async (t) => {
  const browser = wakeLockBrowser(t)
  const removed = t.mock.method(browser.document, 'removeEventListener')
  const added = t.mock.method(browser.document, 'addEventListener')
  startRecording(() => {})
  await setImmediate()
  assert.equal(browser.sentinels.length, 1)
  browser.document.visibilityState = 'hidden'
  await browser.sentinels[0].release()
  browser.document.dispatchEvent(new Event('visibilitychange'))
  await setImmediate()
  assert.equal(browser.sentinels.length, 1)
  browser.document.visibilityState = 'visible'
  browser.document.dispatchEvent(new Event('visibilitychange'))
  browser.document.dispatchEvent(new Event('visibilitychange'))
  await setImmediate()
  assert.equal(browser.sentinels.length, 2)
  stopRecording()
  assert.deepEqual(removed.mock.calls[0].arguments, added.mock.calls[0].arguments)
  assert.equal(browser.sentinels[1].released, true)
  browser.document.dispatchEvent(new Event('visibilitychange'))
  await setImmediate()
  assert.equal(browser.sentinels.length, 2)
})

test('hidden recording defers acquisition and explicit release disables reacquisition', async (t) => {
  const browser = wakeLockBrowser(t)
  browser.document.visibilityState = 'hidden'
  startRecording(() => {})
  await setImmediate()
  assert.equal(browser.sentinels.length, 0)
  browser.document.visibilityState = 'visible'
  browser.document.dispatchEvent(new Event('visibilitychange'))
  await setImmediate()
  assert.equal(browser.sentinels.length, 1)
  await releaseWakeLock()
  browser.document.dispatchEvent(new Event('visibilitychange'))
  await setImmediate()
  assert.equal(browser.sentinels.length, 1)
})

test('unsupported and rejected wake locks log without interrupting recording', async (t) => {
  const browser = recordingBrowser(t)
  const log = t.mock.method(console, 'info', () => {})
  assert.equal(await requestWakeLock(), null)
  browser.target.navigator.wakeLock = { request: async () => { throw new Error('Battery saver') } }
  assert.equal(await requestWakeLock(), null)
  const readings = []
  startRecording((reading) => readings.push(reading))
  await setImmediate()
  browser.motion({ x: 1, y: 2, z: 3 })
  assert.equal(readings.length, 1)
  assert.ok(log.mock.callCount() >= 2)
})

test('a lock resolving after stop is immediately released', async (t) => {
  const browser = wakeLockBrowser(t)
  const originalRequest = browser.target.navigator.wakeLock.request
  let resolveRequest
  browser.target.navigator.wakeLock.request = () => new Promise((resolve) => { resolveRequest = resolve })
  startRecording(() => {})
  await setImmediate()
  stopRecording()
  const sentinel = await originalRequest('screen')
  resolveRequest(sentinel)
  await setImmediate()
  assert.equal(sentinel.releaseCalls, 1)
})

test('a stale request cannot replace the lock of a restarted recording', async (t) => {
  const browser = wakeLockBrowser(t)
  const originalRequest = browser.target.navigator.wakeLock.request
  let resolveRequest
  browser.target.navigator.wakeLock.request = () => new Promise((resolve) => { resolveRequest = resolve })
  startRecording(() => {})
  await setImmediate()
  browser.target.navigator.wakeLock.request = originalRequest
  startRecording(() => {})
  await setImmediate()
  const current = browser.sentinels[0]
  const stale = await originalRequest('screen')
  resolveRequest(stale)
  await setImmediate()
  assert.equal(stale.released, true)
  assert.equal(current.released, false)
  assert.equal(await requestWakeLock(), current)
  stopRecording()
  assert.equal(current.released, true)
})

test('wake lock release failures do not throw', async (t) => {
  wakeLockBrowser(t)
  const log = t.mock.method(console, 'info', () => {})
  const sentinel = await requestWakeLock()
  sentinel.release = async () => { throw new Error('Release failed') }
  await assert.doesNotReject(releaseWakeLock())
  assert.equal(log.mock.callCount(), 1)
})

test('recording emits motion, gravity fallback, and timestamped location readings', (t) => {
  const browser = recordingBrowser(t)
  const readings = []
  t.mock.method(Date, 'now', () => 1700000000000)
  startRecording((reading) => readings.push(reading))
  browser.motion({ x: 0, y: -2, z: 3 }, { x: 9, y: 9, z: 9 })
  browser.motion(null, { x: 1, y: 2, z: 9.8 })
  browser.motion({ x: null, y: null, z: null }, { x: 4, y: 5, z: 6 })
  browser.motion(null)
  browser.watches[0].success({ timestamp: 1700000000123, coords: { latitude: 12, longitude: 77 } })
  assert.deepEqual(readings, [
    { type: 'motion', timestamp: 1700000000000, x: 0, y: -2, z: 3, rotationAlpha: null, rotationBeta: null, rotationGamma: null },
    { type: 'motion', timestamp: 1700000000000, x: 1, y: 2, z: 9.8, rotationAlpha: null, rotationBeta: null, rotationGamma: null },
    { type: 'motion', timestamp: 1700000000000, x: 4, y: 5, z: 6, rotationAlpha: null, rotationBeta: null, rotationGamma: null },
    { type: 'location', timestamp: 1700000000123, lat: 12, lon: 77 },
  ])
  assert.equal(browser.watches[0].options.enableHighAccuracy, true)
})

test('motion includes rotation rates alongside gravity fallback acceleration', (t) => {
  const browser = recordingBrowser(t)
  const readings = []
  t.mock.method(Date, 'now', () => 123)
  startRecording((reading) => readings.push(reading))
  browser.motion(null, { x: 1, y: 2, z: 9.8 }, { alpha: 0, beta: -12, gamma: 3.5 })
  assert.deepEqual(readings, [{
    type: 'motion', timestamp: 123, x: 1, y: 2, z: 9.8,
    rotationAlpha: 0, rotationBeta: -12, rotationGamma: 3.5,
  }])
})

for (const [axis, field] of [['alpha', 'rotationAlpha'], ['beta', 'rotationBeta'], ['gamma', 'rotationGamma']]) {
  test(`rotation-only readings retain a zero ${axis} value`, (t) => {
    const browser = recordingBrowser(t)
    const readings = []
    t.mock.method(Date, 'now', () => 123)
    startRecording((reading) => readings.push(reading))
    browser.motion(null, null, { [axis]: 0 })
    browser.motion({ x: null, y: null, z: null }, null, { [axis]: 0 })
    const expected = {
      type: 'motion', timestamp: 123, x: null, y: null, z: null,
      rotationAlpha: null, rotationBeta: null, rotationGamma: null,
      [field]: 0,
    }
    assert.deepEqual(readings, [expected, expected])
  })
}

test('motion with neither acceleration nor rotation data is skipped', (t) => {
  const browser = recordingBrowser(t)
  const readings = []
  startRecording((reading) => readings.push(reading))
  browser.motion(null)
  browser.motion(undefined, undefined, {})
  browser.motion({ x: null, y: null, z: null }, null, { alpha: null, beta: null, gamma: null })
  assert.deepEqual(readings, [])
})

test('stop removes exact motion listener, clears watch ID zero, and ignores queued callbacks', (t) => {
  const browser = recordingBrowser(t)
  const added = t.mock.method(browser.target, 'addEventListener')
  const removed = t.mock.method(browser.target, 'removeEventListener')
  const readings = []
  startRecording((reading) => readings.push(reading))
  stopRecording()
  stopRecording()
  assert.deepEqual(removed.mock.calls[0].arguments, added.mock.calls[0].arguments)
  assert.equal(removed.mock.callCount(), 1)
  assert.deepEqual(browser.cleared, [0])
  browser.motion({ x: 1, y: 2, z: 3 })
  browser.watches[0].success({ timestamp: 123, coords: { latitude: 1, longitude: 2 } })
  assert.deepEqual(readings, [])
})

test('restarting replaces listeners and suppresses the previous location callback', (t) => {
  const browser = recordingBrowser(t)
  const first = []
  const second = []
  startRecording((reading) => first.push(reading))
  startRecording((reading) => second.push(reading))
  assert.deepEqual(browser.cleared, [0])
  browser.motion({ x: 1, y: 2, z: 3 })
  const position = { timestamp: 123, coords: { latitude: 1, longitude: 2 } }
  browser.watches[0].success(position)
  browser.watches[1].success(position)
  assert.equal(first.length, 0)
  assert.equal(second.length, 2)
  stopRecording()
  assert.deepEqual(browser.cleared, [0, 1])
})

test('recording works without geolocation and preserves missing motion axes', (t) => {
  const browser = recordingBrowser(t, { location: false })
  const readings = []
  startRecording((reading) => readings.push(reading))
  browser.motion({ x: 1, y: null, z: null })
  assert.equal(readings[0].x, 1)
  assert.equal(readings[0].y, null)
  assert.equal(readings[0].z, null)
  stopRecording()
})

test('failed watch setup rolls back the motion listener', (t) => {
  const browser = recordingBrowser(t, { throws: true })
  const removed = t.mock.method(browser.target, 'removeEventListener')
  assert.throws(() => startRecording(() => assert.fail('Unexpected reading')), /Watch failed/)
  assert.equal(removed.mock.callCount(), 1)
  browser.motion({ x: 1, y: 2, z: 3 })
  stopRecording()
})

test('recording validates callbacks and tolerates non-browser environments', (t) => {
  setWindow(t, undefined)
  assert.throws(() => startRecording(null), TypeError)
  assert.doesNotThrow(() => startRecording(() => {}))
  assert.doesNotThrow(stopRecording)
})

test('missing browser APIs return unsupported', async (t) => {
  setWindow(t, undefined)
  assert.equal(await requestMotionPermission(), 'unsupported')
  assert.equal(await requestGeolocationPermission(), 'unsupported')
})

test('motion without an explicit permission API needs no listener', async (t) => {
  setWindow(t, { DeviceMotionEvent: class {} })
  assert.equal(await requestMotionPermission(), 'granted')
})

for (const outcome of ['granted', 'denied', 'reject', 'throw']) {
  test(`iOS motion permission: ${outcome}`, async (t) => {
    let called = false
    const motion = {
      requestPermission() {
        assert.equal(this, motion)
        called = true
        if (outcome === 'throw') throw new Error('No user activation')
        return outcome === 'reject' ? Promise.reject(new Error('Blocked')) : Promise.resolve(outcome)
      },
    }
    setWindow(t, { DeviceMotionEvent: motion })
    const result = requestMotionPermission()
    assert.equal(called, true, 'request must happen before yielding user activation')
    assert.equal(await result, outcome === 'granted' ? 'granted' : 'denied')
  })
}

for (const state of ['granted', 'denied']) {
  test(`known location permission ${state} skips coordinate acquisition`, async (t) => {
    setWindow(t, { navigator: {
      permissions: { query: async () => ({ state }) },
      geolocation: { getCurrentPosition: () => assert.fail('Unexpected location request') },
    } })
    assert.equal(await requestGeolocationPermission(), state)
  })
}

for (const permissionAPI of ['missing', 'prompt', 'reject']) {
  test(`location prompts when permission query is ${permissionAPI}`, async (t) => {
    let requests = 0
    setWindow(t, { navigator: {
      permissions: permissionAPI === 'missing' ? undefined : {
        query: async (descriptor) => {
          assert.deepEqual(descriptor, { name: 'geolocation' })
          if (permissionAPI === 'reject') throw new TypeError('Unsupported query')
          return { state: 'prompt' }
        },
      },
      geolocation: {
        getCurrentPosition(success, _failure, options) {
          requests++
          assert.equal(options.enableHighAccuracy, true)
          assert.ok(options.timeout > 0 && Number.isFinite(options.timeout))
          success({ coords: { latitude: 1, longitude: 2 } })
        },
        watchPosition: () => assert.fail('Must not start watching'),
      },
    } })
    assert.equal(await requestGeolocationPermission(), 'granted')
    assert.equal(requests, 1)
  })
}

for (const [code, status] of [[1, 'denied'], [2, 'granted'], [3, 'granted']]) {
  test(`location error ${code} returns permission status ${status}`, async (t) => {
    setWindow(t, { navigator: {
      geolocation: { getCurrentPosition: (_success, failure) => failure({ code }) },
    } })
    assert.equal(await requestGeolocationPermission(), status)
  })
}

test('synchronous location rejection returns denied', async (t) => {
  setWindow(t, { navigator: {
    geolocation: { getCurrentPosition() { throw new Error('Blocked') } },
  } })
  assert.equal(await requestGeolocationPermission(), 'denied')
})

test('insecure contexts cannot request permission', async (t) => {
  setWindow(t, {
    isSecureContext: false,
    DeviceMotionEvent: { requestPermission: () => assert.fail('Unexpected prompt') },
    navigator: { geolocation: { getCurrentPosition: () => assert.fail('Unexpected request') } },
  })
  assert.equal(await requestMotionPermission(), 'denied')
  assert.equal(await requestGeolocationPermission(), 'denied')
})
