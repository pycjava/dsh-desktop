import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  hashPairToken,
  newDeviceId,
  newPairToken,
  newSecret,
  signDeviceToken,
  verifyDeviceToken,
} from '../auth.js'
import { recordsToMessages } from '../reducer.js'
import { DeviceStore } from '../store.js'

test('desktop pairing uses the Host-provided reachable URL, never the loopback browser origin', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /window\.location\.origin\s*\+\s*pairResult\.value\.path/)
  assert.match(source, /pairResult\.value\.url/)
})

test('device credentials round-trip and reject tampering', () => {
  const secret = newSecret()
  const deviceId = newDeviceId()
  const token = signDeviceToken(secret, deviceId)

  assert.equal(verifyDeviceToken(secret, token), deviceId)
  assert.equal(verifyDeviceToken(newSecret(), token), null)
  assert.equal(verifyDeviceToken(secret, token + 'x'), null)
  assert.equal(verifyDeviceToken(secret, 'drc.bad.token'), null)
  assert.equal(verifyDeviceToken(secret, null), null)
})

test('pairing tokens are random and hash deterministically', () => {
  const first = newPairToken()
  const second = newPairToken()
  assert.notEqual(first, second)
  assert.equal(hashPairToken(first), hashPairToken(first))
  assert.notEqual(hashPairToken(first), first)
})

test('device registry persists, confirms, revokes, expires, and audits without content', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'drc-store-'))
  try {
    const store = new DeviceStore(dir)
    store.load()
    const secret = store.state.secret

    const temp = store.addDevice({ name: 'Phone', kind: 'temp', tempHours: 8 })
    const trusted = store.addDevice({ name: 'Tablet', kind: 'trusted', tempHours: 8 })
    assert.equal(temp.status, 'active')
    assert.equal(trusted.status, 'pending')
    assert.equal(store.confirm(trusted.id).status, 'active')
    assert.equal(store.revoke(temp.id).status, 'revoked')

    const expired = store.addDevice({ name: 'Old phone', kind: 'temp', tempHours: 8 })
    expired.expiresAt = new Date(Date.now() - 1000).toISOString()
    store.save()
    store.sweep({ trustedIdleDays: 90, auditRetainDays: 30 })
    assert.equal(store.get(expired.id).status, 'expired')

    store.audit('prompt', { deviceId: trusted.id, sessionId: 'session-1' })
    const audit = readFileSync(store.auditFile, 'utf8')
    assert.match(audit, /"action":"prompt"/)
    assert.doesNotMatch(audit, /secret prompt text/)

    const reloaded = new DeviceStore(dir)
    reloaded.load()
    assert.equal(reloaded.state.secret, secret)
    assert.equal(reloaded.get(trusted.id).status, 'active')
    assert.equal(reloaded.get(temp.id).status, 'revoked')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function frame(type, seq, data) {
  return { type: 'event', event: { type, seq, time: 1_700_000_000_000 + seq, data } }
}

test('session records reduce to mobile messages and merge settled states', () => {
  const records = [
    frame('user/message', 0, { content: [{ type: 'text', text: 'hello' }] }),
    frame('assistant/message', 1, { message: { content: [{ type: 'text', text: 'hi' }] } }),
    frame('tool/call', 2, { callId: 'call-1', name: 'read' }),
    frame('tool/result', 3, { message: { toolCallId: 'call-1', content: [{ type: 'text', text: 'done' }] } }),
    frame('approval/asked', 4, { id: 'approval-1', toolName: 'write', reason: 'needs permission' }),
    frame('approval/decided', 5, { id: 'approval-1', outcome: 'approved' }),
    frame('turn/end', 6, { reason: { kind: 'completed' } }),
  ]

  const reduced = recordsToMessages(records)
  assert.equal(reduced.latestSeq, 6)
  assert.deepEqual(reduced.messages.map((message) => message.kind), [
    'user', 'assistant', 'tool', 'approval', 'status',
  ])
  assert.equal(reduced.messages[2].state, 'done')
  assert.equal(reduced.messages[2].detail, 'done')
  assert.equal(reduced.messages[3].state, 'approved')
})

test('surface replacement copies advance the cursor without duplicating transcript messages', () => {
  const replacement = frame('assistant/message', 7, {
    message: { content: [{ type: 'text', text: 'compacted model copy' }] },
  })
  replacement.event.surfaceOp = { op: 'replace', startSeq: 0, endSeq: 1 }
  const reduced = recordsToMessages([replacement])
  assert.equal(reduced.latestSeq, 7)
  assert.deepEqual(reduced.messages, [])
})

test('incremental tool results and approval decisions emit stable-id patches', () => {
  const incremental = recordsToMessages([
    frame('tool/result', 3, { message: { toolCallId: 'call-1', content: [{ type: 'text', text: 'done' }] } }),
    frame('approval/decided', 5, { id: 'approval-1', outcome: 'denied' }),
  ], { afterSeq: 2 })

  assert.equal(incremental.latestSeq, 5)
  assert.deepEqual(incremental.messages.map((message) => [message.kind, message.state]), [
    ['tool', 'done'],
    ['approval', 'denied'],
  ])
  assert.equal(incremental.messages[0].callId, 'call-1')
  assert.equal(incremental.messages[1].id, 'approval-1')
})
