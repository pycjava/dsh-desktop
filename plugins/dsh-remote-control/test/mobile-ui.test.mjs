import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../page/app.js', import.meta.url), 'utf8')

function functionBody(name, nextName) {
  const start = source.indexOf(`function ${name}(`)
  const end = source.indexOf(`function ${nextName}(`, start + 1)
  assert.notEqual(start, -1, `${name} must exist`)
  assert.notEqual(end, -1, `${nextName} must follow ${name}`)
  return source.slice(start, end)
}

test('chat polling patches transcript without replacing the focused composer', () => {
  const historyFlow = functionBody('loadHistory', 'enterOffline')
  assert.match(historyFlow, /refreshChatView\(\)/)
  assert.doesNotMatch(historyFlow, /\brender\(\)/)

  const refresh = functionBody('refreshChatView', 'render')
  assert.match(refresh, /querySelector\('\.chat-scroll'\)/)
  assert.match(refresh, /savedScrollTop = scroll\.scrollTop/)
  assert.match(refresh, /nearBottom \? scroll\.scrollHeight : savedScrollTop/)
  assert.doesNotMatch(refresh, /root\.removeChild|root\.replaceChildren|renderChat\(/)

  const chatView = functionBody('renderChat', 'enterList')
  assert.doesNotMatch(chatView, /\brender\(\)/)
})

test('transient poll errors do not replace the focused chat composer', () => {
  const handler = functionBody('absorbPollError', 'renderPairInfo')
  assert.match(handler, /view === 'chat' \? refreshChatView\(\) : render\(\)/)

  const api = functionBody('api', 'dropCredentials')
  assert.match(api, /banner === '连接中断，正在重试…'/)
  assert.match(api, /banner = null/)
})
