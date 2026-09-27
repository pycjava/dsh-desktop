/**
 * dsh-remote-control: reduce raw session history records to the compact
 * message list the mobile surface renders.
 *
 * Pure function, no I/O. Input records are `{ type: 'event', event }` frames
 * as returned by the session controller (`event` = `{ type, seq, time, data }`).
 * Output messages are chronological and carry the event seq for incremental
 * sync (`afterSeq`).
 *
 * Rendered kinds:
 *   user      — user/message text
 *   assistant — assistant/message text
 *   tool      — tool/call, merged with tool/result (running → done|error)
 *   approval  — approval/asked, updated by approval/decided
 *   status    — turn/end reason line
 *
 * @module dsh-remote-control/reducer
 */

/** Join the text blocks of a message's content; ignores non-text blocks. */
function textOf(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** One-line preview of a tool result, capped for the phone screen. */
function preview(text, cap = 300) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > cap ? flat.slice(0, cap - 1) + '…' : flat
}

const TURN_REASON_TEXT = {
  completed: '本轮完成',
  aborted: '已中止',
  blocked: '已阻塞',
  error: '出错',
  'max-tokens': '达到长度上限',
  interrupted: '已中断',
  forked: '已分叉',
}

/**
 * @param {readonly object[]} records session history records
 * @param {{ afterSeq?: number, maxMessages?: number }} [options]
 * @returns {{ messages: object[], latestSeq: number }}
 */
export function recordsToMessages(records, { afterSeq = -1, maxMessages = 300 } = {}) {
  const messages = []
  let latestSeq = afterSeq
  const toolById = new Map()
  const approvalById = new Map()

  for (const record of records) {
    const event = record?.event
    if (!event || typeof event.seq !== 'number') continue
    if (event.seq <= afterSeq) continue
    latestSeq = Math.max(latestSeq, event.seq)
    const data = event.data ?? {}

    // Human transcript semantics use durable append-origin events. Surface
    // replacements are model-context copies (compaction/edit operations), not
    // new messages the user should see a second time.
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue

    if (event.type === 'user/message') {
      const text = textOf(data)
      if (text !== '') {
        messages.push({ kind: 'user', seq: event.seq, time: event.time, text })
      }
    } else if (event.type === 'assistant/message') {
      const text = textOf(data.message)
      if (text !== '') {
        messages.push({
          kind: 'assistant',
          seq: event.seq,
          time: event.time,
          text,
          interrupted: data.interrupted === true,
        })
      }
    } else if (event.type === 'tool/call') {
      const message = {
        kind: 'tool',
        seq: event.seq,
        time: event.time,
        callId: data.callId,
        name: data.name ?? 'tool',
        state: 'running',
        detail: '',
      }
      toolById.set(data.callId, message)
      messages.push(message)
    } else if (event.type === 'tool/result') {
      const callId = data.message?.toolCallId ?? data.callId
      const existing = toolById.get(callId)
      const target = existing ?? {
        kind: 'tool',
        seq: event.seq,
        time: event.time,
        callId,
        name: data.message?.name ?? 'tool',
        state: 'running',
        detail: '',
      }
      target.state = data.error ? 'error' : 'done'
      target.detail = preview(textOf(data.message))
      if (!existing) messages.push(target)
    } else if (event.type === 'approval/asked') {
      const message = {
        kind: 'approval',
        seq: event.seq,
        time: event.time,
        id: data.id,
        toolName: data.toolName ?? '',
        reason: typeof data.reason === 'string' ? data.reason : '',
        state: 'pending',
      }
      approvalById.set(data.id, message)
      messages.push(message)
    } else if (event.type === 'approval/decided') {
      const existing = approvalById.get(data.id)
      if (existing) {
        existing.state = String(data.outcome ?? 'decided')
      } else {
        // Incremental polls can contain the decision but not the older ask.
        // Emit a stable-id patch row so the phone can merge it into the
        // approval card it already holds.
        messages.push({
          kind: 'approval',
          seq: event.seq,
          time: event.time,
          id: data.id,
          toolName: '',
          reason: '',
          state: String(data.outcome ?? 'decided'),
        })
      }
    } else if (event.type === 'turn/end') {
      const kind = data.reason?.kind
      messages.push({
        kind: 'status',
        seq: event.seq,
        time: event.time,
        text: TURN_REASON_TEXT[kind] ?? '回合结束',
      })
    }
  }

  // Keep the tail when the full slice exceeds the render budget.
  const trimmed = messages.length > maxMessages ? messages.slice(messages.length - maxMessages) : messages
  return { messages: trimmed, latestSeq }
}
