/**
 * Dedicated trusted-LAN HTTP ingress.
 *
 * The main DSH web server remains loopback-only. This server binds one RFC1918
 * address and dispatches only the remote-control mobile surface.
 *
 * HTTP is intentionally a first-step transport: use it only on a trusted
 * private Wi-Fi/LAN. The operator panel exposes this warning prominently.
 *
 * @module dsh-remote-control/lan
 */

import http from 'node:http'
import os from 'node:os'

const LAN_REQUEST = Symbol('dsh-remote-control:lan-request')
const VIRTUAL_INTERFACE_RE = /tailscale|flclash|clash|vethernet|wsl|docker|vmware|virtualbox|loopback|zerotier|easytier|wireguard|\bwg\b|\btun\b|\btap\b|\bvpn\b|hamachi|radmin|hyper-v/i
const PREFERRED_INTERFACE_RE = /^(wlan|wi-?fi|无线|ethernet|以太网)/i
const ALLOWED_LAN_PATHS = new Set([
  '/remote',
  '/remote/app.js',
  '/remote/app.css',
  '/remote-control/exchange',
  '/remote-control/device-api',
])

export class LanGatewayError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LanGatewayError'
    this.code = code
  }
}

/** Serialize start/stop/pair across asynchronous listener transitions. */
export class AsyncSerialQueue {
  tail = Promise.resolve()

  run(task) {
    const result = this.tail.then(task, task)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

function ipv4Octets(address) {
  const parts = String(address).split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null
  return parts.map(Number)
}

export function isPrivateIpv4(address) {
  const parts = ipv4Octets(address)
  if (parts === null) return false
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
}

function normalizeRemoteIpv4(address) {
  const value = String(address ?? '')
  return value.startsWith('::ffff:') ? value.slice(7) : value
}

export function isSameIpv4Subnet(firstAddress, secondAddress, prefixLength) {
  const first = ipv4Octets(normalizeRemoteIpv4(firstAddress))
  const second = ipv4Octets(normalizeRemoteIpv4(secondAddress))
  if (first === null || second === null || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) return false
  if (prefixLength === 0) return true
  const firstValue = (((first[0] << 24) | (first[1] << 16) | (first[2] << 8) | first[3]) >>> 0)
  const secondValue = (((second[0] << 24) | (second[1] << 16) | (second[2] << 8) | second[3]) >>> 0)
  const mask = prefixLength === 32 ? 0xFFFFFFFF : (0xFFFFFFFF << (32 - prefixLength)) >>> 0
  return (firstValue & mask) === (secondValue & mask)
}

function prefixLength(record) {
  const match = /\/(\d{1,2})$/.exec(String(record?.cidr ?? ''))
  return match === null ? null : Number(match[1])
}

/** Return safe auto-selection candidates in preference order. */
export function discoverPrivateLanAddresses(interfaces = os.networkInterfaces()) {
  const candidates = []
  for (const [interfaceName, records] of Object.entries(interfaces ?? {})) {
    if (!Array.isArray(records) || VIRTUAL_INTERFACE_RE.test(interfaceName)) continue
    for (const record of records) {
      const ipv4 = record?.family === 'IPv4' || record?.family === 4
      if (!ipv4 || record.internal === true || !isPrivateIpv4(record.address)) continue
      const first = Number(String(record.address).split('.')[0])
      const score = (PREFERRED_INTERFACE_RE.test(interfaceName) ? 100 : 0)
        + (first === 192 ? 30 : first === 10 ? 20 : 10)
      candidates.push({
        interfaceName,
        address: record.address,
        prefixLength: prefixLength(record),
        score,
      })
    }
  }
  return candidates.sort((a, b) => b.score - a.score || a.interfaceName.localeCompare(b.interfaceName) || a.address.localeCompare(b.address))
}

export function isAllowedLanPath(pathname) {
  return ALLOWED_LAN_PATHS.has(pathname)
}

/** Accept only a literal origin-form request target matching the allowlist. */
export function canonicalAllowedLanPath(rawTarget) {
  if (
    typeof rawTarget !== 'string'
    || !rawTarget.startsWith('/')
    || rawTarget.startsWith('//')
    || rawTarget.includes('\\')
    || rawTarget.includes('?')
    || rawTarget.includes('#')
    || rawTarget.includes('%')
  ) return null
  let pathname
  try {
    pathname = new URL(rawTarget, 'http://lan.invalid').pathname
  } catch {
    return null
  }
  return pathname === rawTarget && isAllowedLanPath(pathname) ? pathname : null
}

export function markLanIngressRequest(request) {
  Object.defineProperty(request, LAN_REQUEST, { value: true, enumerable: false })
  return request
}

export function isLanIngressRequest(request) {
  return request?.[LAN_REQUEST] === true
}

export function buildLanPairingUrl(publicBaseUrl, pairingPath) {
  let base
  try {
    base = new URL(String(publicBaseUrl ?? ''))
  } catch {
    throw new LanGatewayError('lan/not-ready', 'LAN base URL is unavailable')
  }
  if (base.protocol !== 'http:' || !isPrivateIpv4(base.hostname) || base.username !== '' || base.password !== '') {
    throw new LanGatewayError('lan/not-private', 'LAN pairing requires an HTTP private IPv4 base URL')
  }
  const pathname = String(pairingPath ?? '')
  if (!pathname.startsWith('/remote#p=')) {
    throw new LanGatewayError('lan/invalid-pairing-path', 'pairing path is invalid')
  }
  return new URL(pathname, base.origin).href
}

function unavailableState(code, message, selected = null, port = null) {
  return {
    mode: 'lan-http',
    ready: false,
    encrypted: false,
    host: selected?.address ?? null,
    interfaceName: selected?.interfaceName ?? null,
    prefixLength: selected?.prefixLength ?? null,
    port,
    publicBaseUrl: null,
    code,
    message,
    warning: 'HTTP 未加密，仅限可信局域网使用',
  }
}

/** Own one path-restricted HTTP listener on one private adapter address. */
export class LanGateway {
  constructor({ host = '', port = 57_890, interfaces = () => os.networkInterfaces(), createServer = http.createServer } = {}) {
    this.configuredHost = host.trim()
    this.port = port
    this.interfaces = interfaces
    this.createServer = createServer
    this.server = null
    this.selected = null
  }

  selectAddress() {
    const candidates = discoverPrivateLanAddresses(this.interfaces())
    if (this.configuredHost !== '') {
      if (!isPrivateIpv4(this.configuredHost)) {
        throw new LanGatewayError('lan/invalid-host', 'configured LAN host must be an RFC1918 private IPv4 address')
      }
      const selected = candidates.find((candidate) => candidate.address === this.configuredHost)
      if (selected === undefined) {
        throw new LanGatewayError('lan/host-unavailable', `configured LAN host ${this.configuredHost} is not active`)
      }
      return selected
    }
    if (candidates.length === 0) {
      throw new LanGatewayError('lan/no-private-address', 'no physical RFC1918 LAN address is available')
    }
    if (candidates.length > 1) {
      throw new LanGatewayError(
        'lan/ambiguous-address',
        `multiple private LAN addresses are active; configure lanHost explicitly (${candidates.map((item) => `${item.interfaceName}=${item.address}`).join(', ')})`,
      )
    }
    return candidates[0]
  }

  allowsPeer(remoteAddress) {
    const selected = this.selected ?? this.selectAddress()
    return selected.prefixLength !== null
      && isSameIpv4Subnet(remoteAddress, selected.address, selected.prefixLength)
  }

  inspect() {
    let selected
    try {
      selected = this.selected ?? this.selectAddress()
    } catch (error) {
      return unavailableState(error?.code ?? 'lan/inspect-failed', error instanceof Error ? error.message : String(error), null, this.port)
    }
    if (this.server === null || !this.server.listening) {
      return unavailableState('lan/not-started', '局域网入口尚未启动', selected, this.port)
    }
    const address = this.server.address()
    const port = typeof address === 'object' && address !== null ? address.port : this.port
    return {
      mode: 'lan-http',
      ready: true,
      encrypted: false,
      host: selected.address,
      interfaceName: selected.interfaceName,
      prefixLength: selected.prefixLength,
      port,
      publicBaseUrl: `http://${selected.address}:${port}`,
      code: null,
      message: '局域网入口已就绪',
      warning: 'HTTP 未加密，仅限可信局域网使用',
    }
  }

  async start(handler) {
    if (this.server !== null && this.server.listening) return this.inspect()
    const selected = this.selectAddress()
    const server = this.createServer(handler)
    server.requestTimeout = 30_000
    server.headersTimeout = 15_000
    server.keepAliveTimeout = 5_000
    server.maxHeadersCount = 64
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen({ host: selected.address, port: this.port, exclusive: true })
    }).catch((error) => {
      try { server.close() } catch {}
      const code = error?.code === 'EADDRINUSE' ? 'lan/port-in-use' : 'lan/listen-failed'
      throw new LanGatewayError(code, error instanceof Error ? error.message : String(error))
    })
    this.server = server
    this.selected = selected
    return this.inspect()
  }

  async stop() {
    const server = this.server
    this.server = null
    if (server !== null) {
      await new Promise((resolve) => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          server.closeAllConnections?.()
          done()
        }, 2_000)
        timer.unref?.()
        try {
          server.close(done)
          server.closeIdleConnections?.()
        } catch {
          done()
        }
      })
    }
    return this.inspect()
  }
}
