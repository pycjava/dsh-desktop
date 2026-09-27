/**
 * dsh-remote-control: pairing and device-credential cryptography.
 *
 * Pure functions over node:crypto — no I/O, fully unit-testable.
 *
 * Two credential kinds:
 *
 *   - Pairing token: 192-bit random, shown to the operator as QR/URL,
 *     single-use, short-lived, stored only as a SHA-256 hash in memory.
 *     Exchanged by the device for a device credential.
 *   - Device credential: `drc.<deviceId>.<hmac>` — a stateless HMAC over the
 *     device id keyed by the per-installation secret persisted in the device
 *     registry. Verification is cheap; revocation is registry state, so a
 *     revoked device fails instantly even with a valid signature.
 *
 * @module dsh-remote-control/auth
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Fresh 256-bit registry secret (base64url). Created once, then persisted. */
export function newSecret() {
  return randomBytes(32).toString('base64url')
}

/** Fresh 192-bit pairing token (base64url). Single-use, TTL-bounded. */
export function newPairToken() {
  return randomBytes(24).toString('base64url')
}

/** Lookup key for a pairing token; the raw token is never stored. */
export function hashPairToken(token) {
  return createHash('sha256').update(String(token)).digest('base64url')
}

/** Fresh device id: `dev_` + 72 bits of randomness. */
export function newDeviceId() {
  return 'dev_' + randomBytes(9).toString('base64url')
}

const HMAC_DOMAIN = 'dsh-remote-control/device/v1/'
const DEVICE_ID_RE = /^dev_[A-Za-z0-9_-]{12}$/

function macFor(secret, deviceId) {
  return createHmac('sha256', String(secret)).update(HMAC_DOMAIN + deviceId).digest('base64url')
}

/** Sign a device credential for `deviceId` under `secret`. */
export function signDeviceToken(secret, deviceId) {
  return `drc.${deviceId}.${macFor(secret, deviceId)}`
}

/**
 * Verify a device credential and return its device id, or null. Constant-time
 * comparison; rejects malformed input without throwing.
 */
export function verifyDeviceToken(secret, token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'drc') return null
  const deviceId = parts[1]
  if (!DEVICE_ID_RE.test(deviceId)) return null
  const presented = Buffer.from(parts[2], 'utf8')
  const expected = Buffer.from(macFor(secret, deviceId), 'utf8')
  if (presented.length !== expected.length) return null
  return timingSafeEqual(presented, expected) ? deviceId : null
}
