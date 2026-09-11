import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requestGeolocationPermission, requestMotionPermission } from './sensors.js'

function setWindow(t, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else delete globalThis.window
  })
}

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
