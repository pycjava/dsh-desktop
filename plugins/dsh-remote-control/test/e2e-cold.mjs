import assert from 'node:assert/strict'
import http from 'node:http'

import { isPrivateIpv4 } from '../lan.js'

const launchUrl = process.argv[2]
if (!launchUrl) throw new Error('usage: node test/e2e-cold.mjs <launch-url-with-token>')

const launch = new URL(launchUrl)
const origin = launch.origin

function rawGetWithHost(pathname, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: launch.hostname,
      port: Number(launch.port),
      path: pathname,
      method: 'GET',
      headers: { Host: hostHeader },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

const exchange = await fetch(launchUrl, { redirect: 'manual' })
assert.equal(exchange.status, 303, 'launch token exchanges for a cookie')
const setCookies = exchange.headers.getSetCookie()
assert.ok(setCookies.length > 0, 'launch exchange sets auth cookie')
const cookie = setCookies[0].split(';', 1)[0]

let rpcSeq = 0
let lanOrigin = null
async function operator(endpoint, payload = {}) {
  const response = await fetch(`${origin}/api/remote-control/${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      origin,
    },
    body: JSON.stringify({ type: 'client-request', rpcId: `e2e-${++rpcSeq}`, payload }),
  })
  assert.equal(response.status, 200, `operator ${endpoint} returns HTTP 200`)
  const envelope = await response.json()
  assert.equal(envelope.type, 'server-response')
  return envelope.result
}

async function device(token, method, params = {}, base = lanOrigin ?? origin) {
  const response = await fetch(`${base}/remote-control/device-api`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ method, params }),
  })
  const body = await response.json()
  return { status: response.status, body }
}

function beginSlowDeviceRequest(token) {
  const target = new URL('/remote-control/device-api', lanOrigin)
  let resolveResponse
  let rejectResponse
  const response = new Promise((resolve, reject) => {
    resolveResponse = resolve
    rejectResponse = reject
  })
  const req = http.request({
    hostname: target.hostname,
    port: Number(target.port),
    path: target.pathname,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'transfer-encoding': 'chunked',
    },
  }, (res) => {
    const chunks = []
    res.on('data', (chunk) => chunks.push(chunk))
    res.on('end', () => resolveResponse({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
  })
  req.on('error', rejectResponse)
  req.write('{"method":"state","params":')
  return {
    async finish() {
      req.end('{}}')
      return response
    },
  }
}

async function pair(kind, name) {
  const issued = await operator('pair', { kind })
  assert.equal(issued.ok, true)
  assert.equal(issued.value.kind, kind)
  assert.match(issued.value.path, /^\/remote#p=/)
  const lanUrl = new URL(issued.value.url)
  assert.equal(lanUrl.protocol, 'http:')
  assert.equal(isPrivateIpv4(lanUrl.hostname), true)
  assert.equal(lanUrl.port, '57890')
  lanOrigin = lanUrl.origin

  const qr = await operator('qr', { text: issued.value.url })
  assert.equal(qr.ok, true)
  assert.match(qr.value.svg, /<svg/)

  const response = await fetch(`${lanOrigin}/remote-control/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairToken: issued.value.pairToken, deviceName: name }),
  })
  assert.equal(response.status, 200)
  const exchanged = await response.json()
  assert.match(exchanged.deviceToken, /^drc\.dev_/)

  const replay = await fetch(`${lanOrigin}/remote-control/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairToken: issued.value.pairToken, deviceName: 'Replay' }),
  })
  assert.equal(replay.status, 401, 'pair token is one-time')
  return exchanged
}

// Operator API remains cookie-authenticated.
const anonymousOperator = await fetch(`${origin}/api/remote-control/status`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin },
  body: JSON.stringify({ type: 'client-request', rpcId: 'anonymous', payload: {} }),
})
assert.equal(anonymousOperator.status, 401)

const initial = await operator('status')
assert.equal(initial.ok, true)
assert.equal(initial.value.active, false, 'cold boot starts off')

const started = await operator('start')
assert.equal(started.ok, true, JSON.stringify(started))
assert.equal(started.value.active, true)
assert.equal(started.value.network.ready, true)
lanOrigin = started.value.network.publicBaseUrl
const startedLanUrl = new URL(lanOrigin)
assert.equal(isPrivateIpv4(startedLanUrl.hostname), true)
assert.equal(startedLanUrl.port, '57890')

// Remove records from an interrupted prior E2E attempt without touching any
// user device.
for (const old of started.value.devices.filter((item) => /^E2E /.test(item.name) && item.status !== 'revoked')) {
  await operator('revoke', { deviceId: old.id })
}

// The static mobile surface is public and does not inherit the desktop Host
// fence; all data behind it still requires a device Bearer credential.
const mobile = await rawGetWithHost('/remote', 'device.example.test')
assert.equal(mobile.status, 200)
assert.match(mobile.text, /DSH 远程控制/)
const lanMobile = await fetch(`${lanOrigin}/remote`)
assert.equal(lanMobile.status, 200)
assert.match(await lanMobile.text(), /DSH 远程控制/)
assert.equal((await fetch(`${lanOrigin}/`)).status, 404)
assert.equal((await fetch(`${lanOrigin}/api/remote-control/status`, { method: 'POST' })).status, 404)
const anonymousDevice = await device(null, 'state')
assert.equal(anonymousDevice.status, 401)

// Temporary pairing: active immediately, restricted session API available.
const temp = await pair('temp', 'E2E temporary phone')
assert.equal(temp.device.kind, 'temp')
assert.equal(temp.device.status, 'active')

const tempState = await device(temp.deviceToken, 'state')
assert.equal(tempState.status, 200)
assert.equal(tempState.body.value.device.id, temp.device.id)

const workspaceList = await device(temp.deviceToken, 'workspaces')
assert.equal(workspaceList.status, 200)
assert.ok(Array.isArray(workspaceList.body.value.workspaces))
assert.ok(Array.isArray(workspaceList.body.value.sessions))

const sessions = workspaceList.body.value.sessions
if (sessions.length > 0) {
  const history = await device(temp.deviceToken, 'history', {
    sessionId: sessions[0].sessionId,
    afterSeq: -1,
  })
  assert.equal(history.status, 200)
  assert.ok(Array.isArray(history.body.value.messages))
}

// Exercise cancel and prompt delegation against a missing session. This
// validates the restricted facade without interrupting a user's running task
// or spending model tokens.
const missingCancel = await device(temp.deviceToken, 'cancel', {
  sessionId: 'e2e-session-does-not-exist',
})
assert.equal(missingCancel.status, 404)
assert.equal(missingCancel.body.error.code, 'session/not-found')

// Exercise prompt validation/delegation without starting a real agent or
// spending model tokens.
const missingPrompt = await device(temp.deviceToken, 'prompt', {
  sessionId: 'e2e-session-does-not-exist',
  text: 'not admitted',
  nonce: 'e2e-nonce-0001',
})
assert.equal(missingPrompt.status, 404)
assert.equal(missingPrompt.body.error.code, 'session/not-found')

const statusWithTemp = await operator('status')
assert.ok(statusWithTemp.value.devices.some((item) => item.id === temp.device.id))
const slowRequest = beginSlowDeviceRequest(temp.deviceToken)
await new Promise((resolve) => setTimeout(resolve, 50))
const revoked = await operator('revoke', { deviceId: temp.device.id })
assert.equal(revoked.ok, true)
const staleAdmission = await slowRequest.finish()
assert.equal(staleAdmission.status, 401)
assert.equal(staleAdmission.body.error.code, 'revoked')
const revokedState = await device(temp.deviceToken, 'state')
assert.equal(revokedState.status, 401)
assert.equal(revokedState.body.error.code, 'revoked')

// Trusted pairing: credential exists independently but remains unusable until
// the authenticated desktop operator confirms that exact device.
const trusted = await pair('trusted', 'E2E trusted tablet')
assert.equal(trusted.device.status, 'pending')
const pendingState = await device(trusted.deviceToken, 'state')
assert.equal(pendingState.status, 403)
assert.equal(pendingState.body.error.code, 'pending-confirmation')

const confirmed = await operator('confirm', { deviceId: trusted.device.id })
assert.equal(confirmed.ok, true)
assert.equal(confirmed.value.device.status, 'active')
const trustedState = await device(trusted.deviceToken, 'state')
assert.equal(trustedState.status, 200)

// Global stop gates every otherwise-valid device credential, while preserving
// the independently managed device record for a later start.
const stopped = await operator('stop', { reason: 'e2e-complete' })
assert.equal(stopped.ok, true)
assert.equal(stopped.value.active, false)
const offState = await device(trusted.deviceToken, 'state', {}, origin)
assert.equal(offState.status, 503)
assert.equal(offState.body.error.code, 'remote-off')
await assert.rejects(() => fetch(`${lanOrigin}/remote`), /fetch failed|ECONNREFUSED/)

// Clean the trusted E2E credential out of the persistent registry.
await operator('start')
await operator('revoke', { deviceId: trusted.device.id })
await operator('stop', { reason: 'e2e-cleanup' })

console.log(JSON.stringify({
  ok: true,
  sessionsRead: sessions.length,
  tempDevice: 'paired-and-revoked',
  trustedDevice: 'pending-confirmed-revoked',
  mobileHostFence: 'public-shell-only',
}, null, 2))
