/**
 * dsh-remote-control: host service.
 *
 * Phase 2: pairing + device credentials + the `/remote` mobile surface.
 *
 * Three surfaces, three trust levels:
 *
 *   1. Operator endpoints (`/api/remote-control/*` via `connection.fetch`)
 *      — inside the shared Connection authentication fence, used by the
 *      desktop control panel: lifecycle, pairing issuance, device management.
 *   2. Pairing exchange (`POST /remote-control/exchange` via `webServer`)
 *      — unauthenticated but gated by a single-use, TTL-bounded pairing
 *      token that only the operator could see.
 *   3. Device API (`POST /remote-control/device-api` via `webServer`) and
 *      the static `/remote` page — Bearer device credentials, registry
 *      checked on every call (revocation and expiry are immediate), and the
 *      whole surface returns 503 while remote control is off.
 *
 * The device API is a narrow whitelist over `sessionController`
 * (list/page/prompt/cancel). It never touches terminals, settings, plugin
 * management, or arbitrary paths — the confirmed capability boundary.
 *
 * Prompts carry `drc-<deviceId>-<nonce>` request ids and an in-memory result
 * cache, so retries after a reconnect can never admit a prompt twice.
 *
 * @module dsh-remote-control/service
 */

import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import qrcode from 'qrcode'
import { hashPairToken, newPairToken, signDeviceToken, verifyDeviceToken } from './auth.js'
import { DeviceStore } from './store.js'
import {
  AsyncSerialQueue,
  LanGateway,
  buildLanPairingUrl,
  canonicalAllowedLanPath,
  isLanIngressRequest,
  markLanIngressRequest,
} from './lan.js'
import { recordsToMessages } from './reducer.js'

export const name = 'dsh-remote-control'

/** Operator-tunable knobs; edited through this row's config in a patch layer. */
export const Config = z.object({
  /** Hours a temporary pairing stays valid after exchange. */
  tempHours: z.number().step(1).min(1).max(72).default(8),
  /** Days a trusted device may stay idle before its credential lapses. */
  trustedIdleDays: z.number().step(1).min(1).max(365).default(90),
  /** Seconds a pairing token/QR stays valid. */
  pairTtlSeconds: z.number().step(1).min(60).max(3600).default(300),
  /** Days audit lines are kept. */
  auditRetainDays: z.number().step(1).min(1).max(365).default(30),
  /** Body cap for device-facing JSON posts. */
  maxBodyBytes: z.number().step(1).min(4096).default(262_144),
  /** Max events read per history poll. */
  historyMaxMessages: z.number().step(1).min(20).max(2000).default(300),
  /** Max prompt characters accepted from a device. */
  maxPromptChars: z.number().step(1).min(100).default(20_000),
  /** Optional RFC1918 adapter address; empty selects the best physical LAN. */
  lanHost: z.string().default(''),
  /** Dedicated fixed LAN port, suitable for a LocalSubnet firewall rule. */
  lanPort: z.number().step(1).min(1024).max(65535).default(57_890),
})

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url))

const OPERATOR_ENDPOINTS = ['status', 'start', 'stop', 'pair', 'devices', 'revoke', 'confirm', 'qr']

const DEVICE_METHODS = new Set(['state', 'workspaces', 'history', 'prompt', 'cancel'])

const DEVICE_NAME_RE = /[\x00-\x1F\x7F\u202A-\u202E\u2066-\u2069]/g

/** Connection-RPC business failure in the wire shape the host expects. */
export function badRequest(message) {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

/**
 * Adapt one payload handler to a Connection exact-Fetch-route handler (the
 * same envelope dsh-git-tree speaks): unwrap the client-request envelope,
 * run the handler, reply with a server-response envelope on HTTP 200.
 */
export function envelopeFetch(run) {
  return async (request) => {
    let message
    try {
      message = await request.json()
    } catch {
      return new Response('body is not JSON', { status: 400 })
    }
    const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
    const reply = (result) => Response.json({ type: 'server-response', rpcId, result })
    if (message?.type !== 'client-request') {
      return reply(badRequest('invalid client-request message'))
    }
    try {
      return reply(await run(message.payload, request))
    } catch (error) {
      return new Response(`handler failure: ${String(error)}`, { status: 500 })
    }
  }
}

/** Read a JSON body from a raw node request with a hard size cap. */
function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** Write one JSON response on a raw node response. */
function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

/** The wire view of a device record — never carries secrets. */
function publicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    kind: device.kind,
    status: device.status,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    expiresAt: device.expiresAt,
    confirmedAt: device.confirmedAt,
  }
}

/** Device names are display text: trimmed, control characters stripped. */
function sanitizeDeviceName(input) {
  const cleaned = String(input ?? '').replace(DEVICE_NAME_RE, '').trim().slice(0, 60)
  return cleaned === '' ? '未命名设备' : cleaned
}

/**
 * Device routes accept ordinary loopback requests plus requests marked inside
 * the dedicated, private-address-only LAN server. The public DSH web server
 * cannot forge that in-process symbol.
 */
function isAllowedDeviceTransport(req) {
  if (isLanIngressRequest(req)) return true
  const address = req.socket?.remoteAddress
  return typeof address === 'string' && (
    address === '::1'
    || address.startsWith('127.')
    || address.startsWith('::ffff:127.')
  )
}

/**
 * Host-plane service: remote-control lifecycle, pairing, device registry,
 * and the restricted device API.
 */
export class RemoteControlService extends Service {
  static inject = ['connection', 'webServer']
  static Config = Config

  /** Lifecycle record; replaced wholesale on every transition. */
  lifecycle = {
    active: false,
    startedAt: null,
    stoppedAt: null,
    stopReason: 'initial-off',
  }

  /** hash(pairToken) → { kind, expiresAt }. Memory-only, single-use. */
  pairTokens = new Map()

  /** requestId → settled result; makes later device retries idempotent. */
  promptCache = new Map()

  /** requestId → Promise; coalesces concurrent retries before settlement. */
  promptInFlight = new Map()

  /** Changes on every start/stop; fences mutations admitted by older state. */
  lifecycleEpoch = 0

  /** Coalesces unauthenticated failure audit writes to avoid disk/log DoS. */
  lastAuthFailureAuditAt = 0

  /** @type {DeviceStore | null} */
  store = null

  /** Static `/remote` assets, read once at activation. */
  assets = null

  /** Set by the optional sessionController injection. */
  sessionCtl = null

  /** Dedicated RFC1918-only HTTP listener; created from plugin config. */
  networkGateway = null

  /** Orders status/start/stop/pair around listener transitions. */
  networkQueue = new AsyncSerialQueue()

  networkState = {
    mode: 'lan-http', ready: false, encrypted: false,
    host: null, interfaceName: null, prefixLength: null,
    port: null, publicBaseUrl: null,
    code: 'lan/status-unchecked', message: '正在检查局域网地址',
    warning: 'HTTP 未加密，仅限可信局域网使用',
  }

  constructor(ctx, config) {
    super(ctx, 'remoteControl')
    this.config = config
    this.networkGateway = new LanGateway({ host: config.lanHost, port: config.lanPort })
  }

  async [Service.init]() {
    const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : path.join(os.homedir(), '.dsh')
    this.store = new DeviceStore(path.join(home, 'remote-control'))
    this.store.load()
    this.store.sweep(this.config)

    this.assets = {
      html: readFileSync(path.join(PACKAGE_DIR, 'page', 'remote.html'), 'utf8'),
      js: readFileSync(path.join(PACKAGE_DIR, 'page', 'app.js'), 'utf8'),
      css: readFileSync(path.join(PACKAGE_DIR, 'page', 'app.css'), 'utf8'),
    }

    // The session controller is optional so the panel still works in
    // profile shapes without it; device session methods then fail closed
    // with a clear error instead of a crash.
    this.ctx.inject(['sessionController'], (sessionCtx) => {
      const controller = sessionCtx.sessionController
      this.sessionCtl = controller
      sessionCtx.effect(() => () => {
        if (this.sessionCtl === controller) this.sessionCtl = null
      }, 'dsh-remote-control: session controller reference')
    })

    // Operator surface: inside Connection's Host/Origin/cookie fence.
    this.ctx.inject(['connection'], (connCtx) => {
      for (const endpoint of OPERATOR_ENDPOINTS) {
        connCtx.connection.fetch.register({
          path: `/api/remote-control/${endpoint}`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: envelopeFetch((payload, request) => this.handleOperator(endpoint, payload, request)),
        })
      }
    })

    // Device surface: raw web routes with independent Bearer auth. These are
    // deliberately NOT behind the operator fence — devices arrive from
    // non-loopback hosts once network exposure lands (phase 3).
    this.ctx.effect(() => {
      const disposers = [
        this.ctx.webServer.register({ kind: 'exact', path: '/remote', handler: (req, res) => this.serveAsset(req, res, 'html') }),
        this.ctx.webServer.register({ kind: 'exact', path: '/remote/app.js', handler: (req, res) => this.serveAsset(req, res, 'js') }),
        this.ctx.webServer.register({ kind: 'exact', path: '/remote/app.css', handler: (req, res) => this.serveAsset(req, res, 'css') }),
        this.ctx.webServer.register({ kind: 'exact', path: '/remote-control/exchange', handler: (req, res) => this.handleExchange(req, res) }),
        this.ctx.webServer.register({ kind: 'exact', path: '/remote-control/device-api', handler: (req, res) => this.handleDeviceApi(req, res) }),
      ]
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-remote-control: device routes')

    // Periodic registry/audit retention sweep.
    this.ctx.effect(() => {
      const timer = setInterval(() => {
        try {
          this.store.sweep(this.config)
        } catch {
          // retention is hygiene
        }
      }, 6 * 3_600_000)
      timer.unref?.()
      return () => clearInterval(timer)
    }, 'dsh-remote-control: sweep timer')

    // Best-effort cleanup on HMR/shutdown: close the dedicated LAN listener.
    this.ctx.effect(() => () => this.networkQueue
      .run(() => this.networkGateway.stop())
      .catch(() => {}), 'dsh-remote-control: LAN listener cleanup')

    this.ctx.logger.info('dsh-remote-control: ready (remote control is off)')
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  startRemote() {
    if (this.lifecycle.active) return
    this.lifecycleEpoch++
    this.lifecycle = { active: true, startedAt: new Date().toISOString(), stoppedAt: null, stopReason: null }
    this.store.audit('start', {})
    this.ctx.logger.info('dsh-remote-control: remote control started')
  }

  stopRemote(reason = 'manual') {
    if (!this.lifecycle.active) return
    this.lifecycleEpoch++
    this.lifecycle = { active: false, startedAt: null, stoppedAt: new Date().toISOString(), stopReason: reason }
    this.pairTokens.clear()
    this.store.audit('stop', { reason })
    this.ctx.logger.info(`dsh-remote-control: remote control stopped (${reason})`)
  }

  /** Wire-facing state for the operator panel. */
  publicState() {
    return {
      active: this.lifecycle.active,
      phase: 'pairing',
      startedAt: this.lifecycle.startedAt,
      stoppedAt: this.lifecycle.stoppedAt,
      stopReason: this.lifecycle.stopReason,
      pairing: { available: this.networkState.ready, ttlSeconds: this.config.pairTtlSeconds },
      network: this.networkState,
      devices: this.store.list().map(publicDevice),
      limits: {
        tempHours: this.config.tempHours,
        trustedIdleDays: this.config.trustedIdleDays,
      },
    }
  }

  // ── operator endpoints (Connection fence) ─────────────────────────────────

  networkFailure(error) {
    const code = typeof error?.code === 'string' ? error.code : 'lan/unknown'
    const state = {
      ...this.networkState,
      ready: false,
      publicBaseUrl: null,
      code,
      message: error instanceof Error ? error.message : String(error),
    }
    this.networkState = state
    this.ctx.logger.warn(`dsh-remote-control: LAN gateway unavailable (${code}): ${state.message}`)
    return state
  }

  async refreshNetwork(configure) {
    try {
      const state = configure
        ? await this.networkGateway.start((req, res) => this.handleLanIngress(req, res))
        : this.networkGateway.inspect()
      this.networkState = state
      return state
    } catch (error) {
      return this.networkFailure(error)
    }
  }

  async disableNetwork() {
    try {
      const state = await this.networkGateway.stop()
      this.networkState = state
      return state
    } catch (error) {
      return this.networkFailure(error)
    }
  }

  async handleOperator(endpoint, payload, request) {
    switch (endpoint) {
      case 'status':
        return this.networkQueue.run(async () => {
          await this.refreshNetwork(false)
          return { ok: true, value: this.publicState() }
        })
      case 'start':
        return this.networkQueue.run(async () => {
          const network = await this.refreshNetwork(true)
          if (!network.ready) return badRequest(network.message)
          this.startRemote()
          return { ok: true, value: this.publicState() }
        })
      case 'stop':
        return this.networkQueue.run(async () => {
          const reason = typeof payload?.reason === 'string' && payload.reason !== '' ? payload.reason : 'manual'
          this.stopRemote(reason)
          await this.disableNetwork()
          return { ok: true, value: this.publicState() }
        })
      case 'pair':
        return this.networkQueue.run(async () => {
          if (!this.lifecycle.active) return badRequest('remote control is off')
          const network = await this.refreshNetwork(true)
          if (!this.lifecycle.active) return badRequest('remote control was stopped while pairing')
          if (!network.ready || network.publicBaseUrl === null) return badRequest(network.message)
          const kind = payload?.kind === 'trusted' ? 'trusted' : 'temp'
          const token = newPairToken()
          const expiresAt = Date.now() + this.config.pairTtlSeconds * 1000
          const pairingPath = `/remote#p=${token}`
          const url = buildLanPairingUrl(network.publicBaseUrl, pairingPath)
          this.pairTokens.set(hashPairToken(token), { kind, expiresAt })
          this.sweepPairTokens()
          this.store.audit('pair-issued', { kind })
          return {
            ok: true,
            value: {
              pairToken: token,
              kind,
              path: pairingPath,
              url,
              expiresAt: new Date(expiresAt).toISOString(),
            },
          }
        })
      case 'devices':
        return { ok: true, value: { devices: this.store.list().map(publicDevice) } }
      case 'confirm': {
        const deviceId = String(payload?.deviceId ?? '')
        const device = this.store.confirm(deviceId)
        if (!device) return badRequest(`device "${deviceId}" is not pending confirmation`)
        this.store.audit('confirm', { deviceId })
        return { ok: true, value: { device: publicDevice(device) } }
      }
      case 'revoke': {
        const deviceId = String(payload?.deviceId ?? '')
        const device = this.store.revoke(deviceId)
        if (!device) return badRequest(`device "${deviceId}" not found or already revoked`)
        this.store.audit('revoke', { deviceId })
        return { ok: true, value: { device: publicDevice(device) } }
      }
      case 'qr': {
        const text = String(payload?.text ?? '')
        if (text === '' || text.length > 512) return badRequest('qr text missing or too long')
        const svg = await qrcode.toString(text, { type: 'svg', margin: 1, width: 320, errorCorrectionLevel: 'M' })
        return { ok: true, value: { svg } }
      }
      default:
        return badRequest(`unknown endpoint ${endpoint}`)
    }
  }

  sweepPairTokens() {
    const now = Date.now()
    for (const [hash, grant] of this.pairTokens) {
      if (grant.expiresAt < now) this.pairTokens.delete(hash)
    }
  }

  // ── dedicated LAN ingress ─────────────────────────────────────────────────

  async handleLanIngress(req, res) {
    if (!this.networkGateway.allowsPeer(req.socket?.remoteAddress)) {
      sendJson(res, 403, { error: 'outside-local-subnet' })
      return
    }
    markLanIngressRequest(req)
    const pathname = canonicalAllowedLanPath(req.url)
    if (pathname === null) {
      sendJson(res, 404, { error: 'not-found' })
      return
    }
    try {
      switch (pathname) {
        case '/remote':
          this.serveAsset(req, res, 'html')
          return
        case '/remote/app.js':
          this.serveAsset(req, res, 'js')
          return
        case '/remote/app.css':
          this.serveAsset(req, res, 'css')
          return
        case '/remote-control/exchange':
          await this.handleExchange(req, res)
          return
        case '/remote-control/device-api':
          await this.handleDeviceApi(req, res)
          return
        default:
          sendJson(res, 404, { error: 'not-found' })
      }
    } catch (error) {
      this.ctx.logger.warn(`dsh-remote-control: LAN request failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal-error' })
      else if (!res.writableEnded) res.end()
    }
  }

  // ── static `/remote` assets ───────────────────────────────────────────────

  serveAsset(req, res, which) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method-not-allowed' })
      return
    }
    const body = which === 'html' ? this.assets.html : which === 'js' ? this.assets.js : this.assets.css
    const type = which === 'html'
      ? 'text/html; charset=utf-8'
      : which === 'js'
        ? 'text/javascript; charset=utf-8'
        : 'text/css; charset=utf-8'
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      // The page talks only to its own origin, loads no inline script, and
      // cannot be framed around a token-bearing pairing URL.
      'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'", 
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  // ── pairing exchange (unauthenticated, pairing-token gated) ──────────────

  async handleExchange(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed' })
      return
    }
    if (!isAllowedDeviceTransport(req)) {
      sendJson(res, 403, { error: 'trusted-ingress-required' })
      return
    }
    if (!this.lifecycle.active) {
      sendJson(res, 403, { error: 'remote-off' })
      return
    }
    let body
    try {
      body = await readJsonBody(req, this.config.maxBodyBytes)
    } catch {
      sendJson(res, 400, { error: 'bad-body' })
      return
    }
    const hash = hashPairToken(body?.pairToken ?? '')
    const grant = this.pairTokens.get(hash)
    if (!grant || grant.expiresAt < Date.now()) {
      this.pairTokens.delete(hash)
      this.auditAuthFailure('pair-token-invalid')
      sendJson(res, 401, { error: 'pair-token-invalid' })
      return
    }
    this.pairTokens.delete(hash) // single use

    const device = this.store.addDevice({
      name: sanitizeDeviceName(body?.deviceName),
      kind: grant.kind,
      tempHours: this.config.tempHours,
    })
    this.store.audit('exchange', { deviceId: device.id, kind: device.kind, status: device.status })
    this.ctx.logger.info(`dsh-remote-control: device paired (${device.kind}, ${device.status}) — ${device.name}`)

    sendJson(res, 200, {
      deviceToken: signDeviceToken(this.store.state.secret, device.id),
      device: publicDevice(device),
      limits: { tempHours: this.config.tempHours, trustedIdleDays: this.config.trustedIdleDays },
    })
  }

  // ── device API (Bearer device credential) ────────────────────────────────

  /**
   * Authenticate one device request. Returns `{ device }` or
   * `{ error: <http status>, code }`. Every check is registry-backed, so
   * revocation and expiry take effect on the next request.
   */
  authenticate(req) {
    if (!this.lifecycle.active) return { error: 503, code: 'remote-off' }
    const header = req.headers.authorization
    const match = /^Bearer\s+(.+)$/.exec(typeof header === 'string' ? header : '')
    const deviceId = match ? verifyDeviceToken(this.store.state.secret, match[1]) : null
    if (!deviceId) {
      this.auditAuthFailure('bad-token')
      return { error: 401, code: 'bad-token' }
    }
    const device = this.store.get(deviceId)
    if (!device) return { error: 401, code: 'unknown-device' }
    if (device.status === 'revoked') return { error: 401, code: 'revoked' }
    if (device.status === 'expired') return { error: 401, code: 'expired' }
    if (device.status === 'pending') return { error: 403, code: 'pending-confirmation' }
    const now = Date.now()
    if (device.kind === 'temp' && device.expiresAt && Date.parse(device.expiresAt) < now) {
      this.store.markExpired(device.id)
      return { error: 401, code: 'expired' }
    }
    if (device.kind === 'trusted' && now - Date.parse(device.lastSeenAt) > this.config.trustedIdleDays * 86_400_000) {
      this.store.markExpired(device.id)
      return { error: 401, code: 'expired' }
    }
    this.store.touch(device.id)
    return { device, epoch: this.lifecycleEpoch }
  }

  auditAuthFailure(reason) {
    const now = Date.now()
    if (now - this.lastAuthFailureAuditAt < 60_000) return
    this.lastAuthFailureAuditAt = now
    this.store.audit('auth-failed', { reason })
  }

  async handleDeviceApi(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed' })
      return
    }
    if (!isAllowedDeviceTransport(req)) {
      sendJson(res, 403, { ok: false, error: { code: 'trusted-ingress-required' } })
      return
    }
    const auth = this.authenticate(req)
    if (auth.error) {
      sendJson(res, auth.error, { ok: false, error: { code: auth.code } })
      return
    }
    let body
    try {
      body = await readJsonBody(req, this.config.maxBodyBytes)
    } catch {
      sendJson(res, 400, { ok: false, error: { code: 'bad-body' } })
      return
    }
    const refreshedAuth = this.authenticate(req)
    if (refreshedAuth.error) {
      sendJson(res, refreshedAuth.error, { ok: false, error: { code: refreshedAuth.code } })
      return
    }
    const method = String(body?.method ?? '')
    if (!DEVICE_METHODS.has(method)) {
      sendJson(res, 404, { ok: false, error: { code: 'unknown-method' } })
      return
    }
    try {
      const value = await this.handleDeviceMethod(refreshedAuth.device, refreshedAuth.epoch, method, body?.params ?? {})
      const finalAuth = this.authenticate(req)
      if (finalAuth.error) {
        sendJson(res, finalAuth.error, { ok: false, error: { code: finalAuth.code } })
        return
      }
      sendJson(res, 200, { ok: true, value })
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'internal'
      const status = code === 'remote-off'
        ? 503
        : code === 'session/not-found'
          ? 404
          : code === 'revoked' || code === 'expired'
            ? 401
            : code === 'pending-confirmation'
              ? 403
              : code.startsWith('gateway/') ? 400 : 500
      sendJson(res, status, {
        ok: false,
        error: { code, message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  /** Restricted, whitelist-dispatched device methods. */
  async handleDeviceMethod(device, epoch, method, params) {
    switch (method) {
      case 'state':
        return {
          active: this.lifecycle.active,
          device: publicDevice(device),
          serverTime: new Date().toISOString(),
          sessionsAvailable: this.sessionCtl !== null,
        }
      case 'workspaces': {
        const sessions = await this.listSessions()
        const groups = new Map()
        for (const session of sessions) {
          const key = session.cwd ?? 'unknown'
          let group = groups.get(key)
          if (group === undefined) {
            group = {
              id: key,
              cwd: session.cwd,
              name: session.cwd === null ? '未关联工作区' : path.basename(session.cwd),
              sessions: [],
            }
            groups.set(key, group)
          }
          group.sessions.push(session)
        }
        return { workspaces: [...groups.values()], sessions }
      }
      case 'history':
        return this.readHistory(params)
      case 'prompt':
        return this.sendPrompt(device, epoch, params)
      case 'cancel':
        return this.cancelSession(device, epoch, params)
      default:
        throw Object.assign(new Error(`unknown method ${method}`), { code: 'unknown-method' })
    }
  }

  requireSessionCtl() {
    if (this.sessionCtl === null) {
      throw Object.assign(new Error('session controller is not available in this profile'), { code: 'sessions-unavailable' })
    }
    return this.sessionCtl
  }

  /** Session rows shaped for the phone: no subagents, no internals. */
  async listSessions() {
    const ctl = this.requireSessionCtl()
    const list = await ctl.list({}, AbortSignal.timeout(10_000))
    const items = Array.isArray(list?.items) ? list.items : []
    return items
      .filter((item) => item?.origin !== 'subagent')
      .map((item) => ({
        sessionId: item.sessionId,
        title: item.projections?.values?.title ?? null,
        running: item.running === true,
        blank: item.blank === true,
        updatedAt: item.updatedAt ?? null,
        cwd: typeof item.cwd === 'string' ? item.cwd : null,
        asOfSeq: typeof item.projections?.asOfSeq === 'number' ? item.projections.asOfSeq : -1,
      }))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  async readHistory(params) {
    const ctl = this.requireSessionCtl()
    const sessionId = String(params?.sessionId ?? '')
    if (sessionId === '') throw Object.assign(new Error('sessionId required'), { code: 'gateway/bad-request' })
    const afterSeq = Number.isSafeInteger(params?.afterSeq) ? params.afterSeq : -1
    const maxMessages = Math.min(
      Number.isSafeInteger(params?.maxMessages) && params.maxMessages > 0 ? params.maxMessages : this.config.historyMaxMessages,
      this.config.historyMaxMessages,
    )
    const signal = AbortSignal.timeout(15_000)

    const summaries = await this.listSessions().catch(() => [])
    const summary = summaries.find((item) => item.sessionId === sessionId)
    if (!summary) {
      throw Object.assign(new Error(`session "${sessionId}" not found`), { code: 'session/not-found' })
    }

    let records = []
    let hasMore = false
    if (summary.asOfSeq >= 0 && summary.asOfSeq > afterSeq) {
      // The controller pages backwards. Initial load intentionally takes one
      // bounded tail page. Incremental polls must keep walking backwards until
      // the first returned seq touches the caller's cursor; otherwise a burst
      // larger than one page would advance latestSeq across a permanent gap.
      let beforeSeq
      for (;;) {
        const page = await ctl.page(
          {
            address: { kind: 'session', sessionId },
            throughSeq: summary.asOfSeq,
            ...(beforeSeq === undefined ? {} : { beforeSeq }),
            maxMessages,
          },
          signal,
        )
        const pageRecords = Array.isArray(page?.records) ? page.records : []
        records = pageRecords.concat(records)
        hasMore = page?.hasMore === true
        const firstSeq = pageRecords[0]?.event?.seq
        if (
          afterSeq < 0
          || !hasMore
          || !Number.isSafeInteger(firstSeq)
          || firstSeq <= afterSeq + 1
        ) break
        beforeSeq = firstSeq
      }
    } else if (summary.asOfSeq < 0) {
      // Legacy/persisted headers without a projection cursor are uncommon;
      // inspect is the bounded compatibility fallback for that exact case.
      const inspection = await ctl.inspect(sessionId, signal)
      const events = Array.isArray(inspection?.events) ? inspection.events : []
      records = events.map((event) => ({ type: 'event', event }))
    }

    const reduced = recordsToMessages(records, {
      afterSeq,
      // Never trim an incremental bridge after fetching it: doing so would
      // move the cursor past dropped events. Initial load remains bounded.
      maxMessages: afterSeq < 0 ? maxMessages : Number.MAX_SAFE_INTEGER,
    })
    return {
      sessionId,
      title: summary.title,
      running: summary.running,
      messages: reduced.messages,
      latestSeq: reduced.latestSeq,
      hasMore,
    }
  }

  assertMutationAllowed(device, epoch) {
    if (!this.lifecycle.active || epoch !== this.lifecycleEpoch) {
      throw Object.assign(new Error('remote control was stopped before mutation admission'), { code: 'remote-off' })
    }
    const current = this.store.get(device.id)
    if (current === null || current.status !== 'active') {
      const code = current?.status === 'expired' ? 'expired' : current?.status === 'pending' ? 'pending-confirmation' : 'revoked'
      throw Object.assign(new Error('device authorization changed before mutation admission'), { code })
    }
  }

  async sendPrompt(device, epoch, params) {
    const ctl = this.requireSessionCtl()
    const sessionId = String(params?.sessionId ?? '')
    const text = String(params?.text ?? '').trim()
    const nonce = String(params?.nonce ?? '')
    if (sessionId === '') throw Object.assign(new Error('sessionId required'), { code: 'gateway/bad-request' })
    if (text === '') throw Object.assign(new Error('empty prompt'), { code: 'gateway/bad-request' })
    if (text.length > this.config.maxPromptChars) {
      throw Object.assign(new Error(`prompt exceeds ${this.config.maxPromptChars} characters`), { code: 'gateway/bad-request' })
    }
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) {
      throw Object.assign(new Error('a client nonce of 8-64 [A-Za-z0-9_-] characters is required'), { code: 'gateway/bad-request' })
    }

    const requestId = `drc-${device.id}-${nonce}`
    const cached = this.promptCache.get(requestId)
    if (cached !== undefined) return { ...cached, replayed: true }
    const inFlight = this.promptInFlight.get(requestId)
    if (inFlight !== undefined) return { ...await inFlight, replayed: true }

    // Store the Promise before the first await that can race another request.
    // The session controller also adopts an existing requestId durably, so
    // this coalesces local concurrency while preserving restart-safe dedupe.
    const operation = (async () => {
      const summaries = await this.listSessions().catch(() => [])
      const running = summaries.find((item) => item.sessionId === sessionId)?.running === true
      let mode = running ? 'queue' : 'steer'
      this.assertMutationAllowed(device, epoch)
      try {
        await ctl.prompt(
          { requestId, sessionId, mode, content: [{ type: 'text', text }] },
          AbortSignal.timeout(15_000),
        )
      } catch (error) {
        if (mode === 'steer' && error?.code === 'session/agent-busy') {
          mode = 'queue'
          this.assertMutationAllowed(device, epoch)
          await ctl.prompt(
            { requestId, sessionId, mode, content: [{ type: 'text', text }] },
            AbortSignal.timeout(15_000),
          )
        } else {
          throw error
        }
      }

      const result = { accepted: true, requestId, mode }
      this.promptCache.set(requestId, result)
      if (this.promptCache.size > 500) {
        const oldest = this.promptCache.keys().next().value
        this.promptCache.delete(oldest)
      }
      this.store.audit('prompt', { deviceId: device.id, sessionId })
      return result
    })()

    this.promptInFlight.set(requestId, operation)
    try {
      return await operation
    } finally {
      if (this.promptInFlight.get(requestId) === operation) this.promptInFlight.delete(requestId)
    }
  }

  async cancelSession(device, epoch, params) {
    const ctl = this.requireSessionCtl()
    const sessionId = String(params?.sessionId ?? '')
    if (sessionId === '') throw Object.assign(new Error('sessionId required'), { code: 'gateway/bad-request' })
    this.assertMutationAllowed(device, epoch)
    const value = await ctl.cancel({ sessionId })
    this.store.audit('cancel', { deviceId: device.id, sessionId })
    return value
  }
}

export default RemoteControlService
