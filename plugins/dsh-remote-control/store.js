/**
 * dsh-remote-control: device registry persistence + audit log.
 *
 * One JSON document at `$DSH_HOME/remote-control/devices.json` holds the
 * registry secret and every device record; writes go through tmp-file +
 * rename so a crash never leaves a torn file. Security-relevant actions are
 * appended to `audit.jsonl` (device ids and session ids only — never prompt
 * text or file content, per the confirmed audit policy).
 *
 * Device record:
 *   { id, name, kind: 'temp'|'trusted',
 *     status: 'pending'|'active'|'revoked'|'expired',
 *     createdAt, lastSeenAt, expiresAt|null, confirmedAt|null, revokedAt|null }
 *
 * Temp devices expire `tempHours` after creation. Trusted devices start
 * `pending` (desktop confirmation required), then expire after
 * `trustedIdleDays` without a seen request.
 *
 * @module dsh-remote-control/store
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { newDeviceId, newSecret } from './auth.js'

/** Debounce window for lastSeenAt persistence (touch() is per-request). */
const TOUCH_WRITE_MS = 60_000

export class DeviceStore {
  /**
   * @param {string} dir registry directory (created on demand).
   */
  constructor(dir) {
    this.dir = dir
    this.file = path.join(dir, 'devices.json')
    this.auditFile = path.join(dir, 'audit.jsonl')
    this.state = { version: 1, secret: null, devices: [] }
    this.lastTouchWrite = 0
  }

  /** Load from disk; a missing or corrupt file starts a fresh registry. */
  load() {
    mkdirSync(this.dir, { recursive: true })
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (parsed && Array.isArray(parsed.devices)) {
        this.state = {
          version: 1,
          secret: typeof parsed.secret === 'string' ? parsed.secret : null,
          devices: parsed.devices.filter((d) => d && typeof d.id === 'string'),
        }
      }
    } catch {
      // Fresh install or unreadable file — start empty. A corrupt registry
      // fails closed: existing device credentials stop verifying only if the
      // secret is lost, which is the safe direction.
    }
    if (!this.state.secret) {
      this.state.secret = newSecret()
      this.save()
    }
  }

  /** Atomic persist: write temp file, then rename over the target. */
  save() {
    mkdirSync(this.dir, { recursive: true })
    const temp = `${this.file}.tmp-${process.pid}`
    writeFileSync(temp, JSON.stringify(this.state, null, 2) + '\n')
    renameSync(temp, this.file)
  }

  /**
   * Append one audit line. Best-effort by design: an audit write failure
   * must never break the control path.
   */
  audit(action, fields = {}) {
    try {
      const line = JSON.stringify({ time: new Date().toISOString(), action, ...fields }) + '\n'
      appendFileSync(this.auditFile, line)
    } catch {
      // see docstring
    }
  }

  /** Register a freshly exchanged device. Returns the stored record. */
  addDevice({ name, kind, tempHours }) {
    const now = new Date().toISOString()
    const device = {
      id: newDeviceId(),
      name,
      kind,
      status: kind === 'trusted' ? 'pending' : 'active',
      createdAt: now,
      lastSeenAt: now,
      expiresAt: kind === 'temp'
        ? new Date(Date.now() + tempHours * 3_600_000).toISOString()
        : null,
      confirmedAt: null,
      revokedAt: null,
    }
    this.state.devices.push(device)
    this.save()
    return device
  }

  get(id) {
    return this.state.devices.find((d) => d.id === id)
  }

  list() {
    return this.state.devices
  }

  /** Operator confirmed a pending trusted device. */
  confirm(id) {
    const device = this.get(id)
    if (!device || device.status !== 'pending') return undefined
    device.status = 'active'
    device.confirmedAt = new Date().toISOString()
    device.lastSeenAt = device.confirmedAt
    this.save()
    return device
  }

  /** Operator revoked a device; its credential dies immediately. */
  revoke(id) {
    const device = this.get(id)
    if (!device || device.status === 'revoked') return undefined
    device.status = 'revoked'
    device.revokedAt = new Date().toISOString()
    this.save()
    return device
  }

  markExpired(id) {
    const device = this.get(id)
    if (!device || device.status === 'revoked' || device.status === 'expired') return undefined
    device.status = 'expired'
    this.save()
    return device
  }

  /** Update lastSeenAt; persists at most once per minute. */
  touch(id) {
    const device = this.get(id)
    if (!device) return
    device.lastSeenAt = new Date().toISOString()
    if (Date.now() - this.lastTouchWrite > TOUCH_WRITE_MS) {
      this.lastTouchWrite = Date.now()
      try {
        this.save()
      } catch {
        // lastSeenAt is advisory; a failed write only delays idle expiry.
      }
    }
  }

  /**
   * Sweep: mark lapsed temp/trusted devices expired, and rewrite the audit
   * log dropping entries older than `auditRetainDays`.
   */
  sweep(config) {
    const now = Date.now()
    let dirty = false
    for (const device of this.state.devices) {
      if (device.status !== 'active' && device.status !== 'pending') continue
      if (device.kind === 'temp' && device.expiresAt && Date.parse(device.expiresAt) < now) {
        device.status = 'expired'
        dirty = true
      } else if (device.kind === 'trusted' && device.status === 'active') {
        const idleMs = now - Date.parse(device.lastSeenAt)
        if (idleMs > config.trustedIdleDays * 86_400_000) {
          device.status = 'expired'
          dirty = true
        }
      }
    }
    if (dirty) this.save()

    if (existsSync(this.auditFile)) {
      try {
        const cutoff = now - config.auditRetainDays * 86_400_000
        const kept = readFileSync(this.auditFile, 'utf8')
          .split('\n')
          .filter((line) => {
            if (line.trim() === '') return false
            try {
              return Date.parse(JSON.parse(line).time) >= cutoff
            } catch {
              return false
            }
          })
        const temp = `${this.auditFile}.tmp-${process.pid}`
        writeFileSync(temp, kept.length > 0 ? kept.join('\n') + '\n' : '')
        renameSync(temp, this.auditFile)
      } catch {
        // retention is hygiene, not correctness
      }
    }
  }
}
