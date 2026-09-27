/**
 * dsh-remote-control mobile surface (`/remote/app.js`).
 *
 * Dependency-free vanilla JS: the page is a standalone document outside the
 * desktop SPA, so no host module table, no React, no host theme. All data
 * flows through POST /remote-control/device-api with a Bearer device
 * credential obtained from the pairing exchange. Credentials live in
 * localStorage (per-origin); the pairing token itself arrives in the URL
 * fragment (#p=...), which is never sent to the server, and is stripped from
 * the address bar immediately after reading.
 */
(function () {
  'use strict'

  var TOKEN_KEY = 'drc.token'
  var DEVICE_KEY = 'drc.device'
  var PENDING_PROMPT_KEY = 'drc.pending-prompt'

  var root = document.getElementById('app')

  var token = null
  var device = null
  var view = 'loading' // loading | pair-info | pair-form | pending | offline | list | chat
  var viewError = null
  var banner = null

  var sessions = []
  var workspaces = []
  var current = null // { sessionId, title }
  var messages = []
  var latestSeq = -1
  var running = false
  var sending = false

  var pollTimer = null
  var pollGeneration = 0
  var listInFlight = null
  var historyInFlight = null
  var pendingPrompt = null
  var currentPairToken = null

  // ── helpers ──────────────────────────────────────────────────────────────

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = text
    return node
  }

  function relTime(epochMs) {
    if (!epochMs) return ''
    var then = typeof epochMs === 'number' ? epochMs : Date.parse(epochMs)
    if (!Number.isFinite(then)) return ''
    var s = Math.max(0, Math.floor((Date.now() - then) / 1000))
    if (s < 60) return s + ' 秒前'
    var m = Math.floor(s / 60)
    if (m < 60) return m + ' 分钟前'
    var h = Math.floor(m / 60)
    if (h < 24) return h + ' 小时前'
    return Math.floor(h / 24) + ' 天前'
  }

  function clockTime(epochMs) {
    if (!epochMs) return ''
    var d = new Date(epochMs)
    var hh = String(d.getHours()).padStart(2, '0')
    var mm = String(d.getMinutes()).padStart(2, '0')
    return hh + ':' + mm
  }

  function basename(p) {
    if (!p) return ''
    return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
  }

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID()
    return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12)
  }

  function setView(next, error) {
    view = next
    viewError = error || null
    pollGeneration++
    if (pollTimer !== null) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
    render()
  }

  /** Self-scheduling timeout: the next poll starts only after this one settles. */
  function schedule(fn, ms) {
    pollGeneration++
    var generation = pollGeneration
    if (pollTimer !== null) clearTimeout(pollTimer)
    function arm() {
      pollTimer = setTimeout(function () {
        Promise.resolve(fn()).catch(function () {}).finally(function () {
          if (pollGeneration === generation) arm()
        })
      }, ms)
    }
    arm()
  }

  // ── API ──────────────────────────────────────────────────────────────────

  /**
   * One device-API call. Transport/auth failures are surfaced as Error with
   * `code`; callers decide view transitions. 401 drops credentials and jumps
   * to pairing (nothing sensible remains to do).
   */
  function api(method, params) {
    return fetch('/remote-control/device-api', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + token,
      },
      body: JSON.stringify({ method: method, params: params || {} }),
    }).then(function (res) {
      return res.json().catch(function () { return null }).then(function (body) {
        if (res.status === 401) {
          dropCredentials()
          setView('pair-info', '凭据已失效或被撤销，请重新配对。')
          var authError = new Error('unauthorized')
          authError.code = 'unauthorized'
          throw authError
        }
        if (!body || body.ok !== true) {
          var err = new Error((body && body.error && body.error.message) || ('请求失败（' + res.status + '）'))
          err.code = (body && body.error && body.error.code) || ('http-' + res.status)
          err.status = res.status
          throw err
        }
        if (banner === '远端已关闭远控。' || banner === '连接中断，正在重试…') {
          banner = null
        }
        return body.value
      })
    })
  }

  function dropCredentials() {
    token = null
    device = null
    pendingPrompt = null
    try {
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(DEVICE_KEY)
      localStorage.removeItem(PENDING_PROMPT_KEY)
    } catch (_) { /* private mode */ }
  }

  function saveCredentials(nextToken, nextDevice) {
    token = nextToken
    device = nextDevice
    try {
      localStorage.setItem(TOKEN_KEY, nextToken)
      localStorage.setItem(DEVICE_KEY, JSON.stringify(nextDevice))
    } catch (_) { /* private mode: credentials live for this tab only */ }
  }

  function savePendingPrompt(value) {
    pendingPrompt = value
    try {
      if (value === null) localStorage.removeItem(PENDING_PROMPT_KEY)
      else localStorage.setItem(PENDING_PROMPT_KEY, JSON.stringify(value))
    } catch (_) { /* keep the in-memory nonce */ }
  }

  /** Shared error handling for polling loops. */
  function absorbPollError(err) {
    if (!err) return
    if (err.code === 'unauthorized') return // api() already navigated
    if (err.code === 'pending-confirmation') {
      enterPending()
      return
    }
    if (err.code === 'remote-off') {
      enterOffline()
      return
    }
    // transient network failure: keep the view, show a soft banner
    banner = '连接中断，正在重试…'
    view === 'chat' ? refreshChatView() : render()
  }

  // ── views ────────────────────────────────────────────────────────────────

  function renderPairInfo() {
    var card = el('div', 'pair-card')
    card.appendChild(el('h2', null, '连接这台电脑'))
    card.appendChild(el('p', null, '请在这台电脑的 DeepSeek Harness 中打开「远程控制」面板，启动远控后生成配对链接，用本机浏览器打开链接或扫描二维码。'))
    if (viewError) card.appendChild(el('p', 'error', viewError))
    return card
  }

  function renderPairForm() {
    var card = el('div', 'pair-card')
    card.appendChild(el('h2', null, '确认配对'))
    card.appendChild(el('p', null, '为这台设备起个名字，便于在桌面端识别与撤销。'))
    var input = el('input')
    input.type = 'text'
    input.value = guessDeviceName()
    input.maxLength = 60
    card.appendChild(input)
    if (viewError) card.appendChild(el('p', 'error', viewError))
    var button = el('button', 'btn', '配对')
    button.addEventListener('click', function () {
      button.disabled = true
      button.textContent = '配对中…'
      fetch('/remote-control/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairToken: currentPairToken, deviceName: input.value }),
      }).then(function (res) {
        return res.json().catch(function () { return null }).then(function (body) {
          if (!res.ok || !body || !body.deviceToken) {
            var code = body && body.error
            viewError = code === 'pair-token-invalid'
              ? '配对链接已过期或已被使用，请回到桌面端重新生成。'
              : code === 'remote-off'
                ? '远端未开启远控。'
                : '配对失败，请重试。'
            button.disabled = false
            button.textContent = '配对'
            render()
            return
          }
          saveCredentials(body.deviceToken, body.device)
          if (body.device && body.device.status === 'pending') {
            enterPending()
          } else {
            enterList()
          }
        })
      }).catch(function () {
        viewError = '网络错误，请重试。'
        button.disabled = false
        button.textContent = '配对'
        render()
      })
    })
    card.appendChild(button)
    return card
  }

  function guessDeviceName() {
    var ua = navigator.userAgent || ''
    if (/iPhone/i.test(ua)) return 'iPhone'
    if (/iPad/i.test(ua)) return 'iPad'
    if (/Android/i.test(ua)) return 'Android 设备'
    if (/Mac/i.test(ua)) return 'Mac'
    if (/Windows/i.test(ua)) return 'Windows 电脑'
    if (/Linux/i.test(ua)) return 'Linux 电脑'
    return '新设备'
  }

  function renderPending() {
    var card = el('div', 'pair-card')
    card.appendChild(el('h2', null, '等待桌面端确认'))
    card.appendChild(el('p', null, '这台设备申请成为受信任设备。请在电脑上的「远程控制」面板中点击确认；确认后本页面会自动进入。'))
    if (viewError) card.appendChild(el('p', 'error', viewError))
    return card
  }

  function renderOffline() {
    var card = el('div', 'pair-card')
    card.appendChild(el('h2', null, '远程控制已关闭'))
    card.appendChild(el('p', null, '设备凭据仍然保留。请在电脑端启动远控，本页面会自动重新连接。'))
    return card
  }

  function renderList() {
    var frag = document.createDocumentFragment()
    var bar = el('div', 'topbar')
    bar.appendChild(el('h1', null, 'DSH 远程控制'))
    var who = el('span', null, device ? device.name : '')
    who.style.color = 'var(--rc-dim)'
    who.style.fontSize = '12px'
    bar.appendChild(who)
    frag.appendChild(bar)

    if (banner) frag.appendChild(el('div', 'banner', banner))

    if (sessions.length === 0) {
      frag.appendChild(el('div', 'center-note', '暂无会话。先在电脑端开始一个任务，再回到这里查看。'))
      return frag
    }

    var list = el('div', 'session-list')
    var groups = workspaces.length > 0 ? workspaces : [{ name: '会话', cwd: null, sessions: sessions }]
    groups.forEach(function (workspace) {
      var heading = el('div', 'workspace-heading')
      heading.appendChild(el('div', 'workspace-name', workspace.name || basename(workspace.cwd) || '工作区'))
      if (workspace.cwd) heading.appendChild(el('div', 'workspace-path', workspace.cwd))
      list.appendChild(heading)
      ;(workspace.sessions || []).forEach(function (s) {
        var card = el('button', 'session-card')
        card.appendChild(el('span', 'dot' + (s.running ? ' on' : '')))
        var meta = el('span', 'meta')
        meta.appendChild(el('div', 'title', s.title || basename(s.cwd) || String(s.sessionId).slice(0, 12)))
        meta.appendChild(el('div', 'sub', (s.running ? '运行中 · ' : '') + relTime(s.updatedAt)))
        card.appendChild(meta)
        card.addEventListener('click', function () { enterChat(s) })
        list.appendChild(card)
      })
    })
    frag.appendChild(list)
    return frag
  }

  function messageNode(m) {
    if (m.kind === 'user' || m.kind === 'assistant') {
      var bubble = el('div', 'msg ' + m.kind)
      bubble.appendChild(document.createTextNode(m.text))
      var time = el('span', 'time', (m.interrupted ? '（已中断）' : '') + clockTime(m.time))
      bubble.appendChild(time)
      return bubble
    }
    if (m.kind === 'tool') {
      var tool = el('div', 'msg tool' + (m.state === 'error' ? ' error' : ''))
      var label = m.state === 'running' ? '正在执行' : m.state === 'error' ? '执行失败' : '已完成'
      tool.appendChild(el('span', 'name', '🔧 ' + m.name + ' · ' + label))
      if (m.detail) tool.appendChild(el('span', 'detail', m.detail))
      return tool
    }
    if (m.kind === 'approval') {
      var text = m.state === 'pending'
        ? '⚠ 需要审批：' + m.toolName + (m.reason ? '（' + m.reason + '）' : '') + ' —— 请在电脑端处理'
        : '审批：' + m.toolName + ' → ' + m.state
      return el('div', 'msg approval', text)
    }
    return el('div', 'msg status', m.text || '')
  }

  function fillChatMessages(scroll) {
    while (scroll.firstChild) scroll.removeChild(scroll.firstChild)
    if (messages.length === 0) {
      scroll.appendChild(el('div', 'center-note', '暂无消息。'))
    } else {
      messages.forEach(function (m) { scroll.appendChild(messageNode(m)) })
    }
  }

  function renderChat() {
    var frag = document.createDocumentFragment()
    var bar = el('div', 'topbar')
    var back = el('button', 'back', '‹ 返回')
    back.addEventListener('click', function () { enterList() })
    bar.appendChild(back)
    bar.appendChild(el('h1', null, current.title || '会话'))
    var stop = el('button', 'btn danger small chat-stop', '停止')
    stop.hidden = !running
    stop.addEventListener('click', function () {
      api('cancel', { sessionId: current.sessionId }).then(loadHistory).catch(absorbPollError)
    })
    bar.appendChild(stop)
    frag.appendChild(bar)

    var chatBanner = el('div', 'banner chat-banner', banner || '')
    chatBanner.hidden = !banner
    frag.appendChild(chatBanner)

    var scroll = el('div', 'chat-scroll')
    fillChatMessages(scroll)
    frag.appendChild(scroll)

    var composer = el('div', 'composer')
    var textarea = el('textarea')
    textarea.rows = 1
    textarea.placeholder = '补充指令…（Ctrl/⌘+Enter 发送）'
    if (pendingPrompt && pendingPrompt.sessionId === current.sessionId) textarea.value = pendingPrompt.text
    var send = el('button', 'btn', sending ? '发送中…' : '发送')
    send.disabled = sending
    function doSend() {
      var text = textarea.value.trim()
      if (text === '' || sending) return
      var sessionId = current.sessionId
      var submission = pendingPrompt
      if (submission !== null && (submission.sessionId !== sessionId || submission.text !== text)) {
        banner = '上一条指令的结果尚未确认，请先重试原指令。'
        refreshChatView()
        return
      }
      if (submission === null) {
        submission = { sessionId: sessionId, text: text, nonce: uuid() }
        savePendingPrompt(submission)
      }
      sending = true
      send.disabled = true
      send.textContent = '发送中…'
      api('prompt', submission)
        .then(function () {
          savePendingPrompt(null)
          if (current && current.sessionId === sessionId) {
            textarea.value = ''
            banner = null
            return loadHistory()
          }
        })
        .catch(function (err) {
          // A 4xx reply is definitive: the prompt was not admitted. Network
          // failures/5xx keep the same persisted nonce for a safe retry.
          if (err && err.status >= 400 && err.status < 500 && err.code !== 'unauthorized') savePendingPrompt(null)
          if (err && (err.code === 'unauthorized' || err.code === 'pending-confirmation' || err.code === 'remote-off')) {
            absorbPollError(err)
          } else if (err) {
            banner = '发送失败：' + err.message + '；再次发送会安全复用同一请求编号。'
            refreshChatView()
          }
        })
        .finally(function () {
          sending = false
          send.disabled = false
          send.textContent = '发送'
        })
    }
    send.addEventListener('click', doSend)
    textarea.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        doSend()
      }
    })
    composer.appendChild(textarea)
    composer.appendChild(send)
    frag.appendChild(composer)
    return frag
  }

  // ── data flows ───────────────────────────────────────────────────────────

  function enterList() {
    current = null
    setView('list')
    loadSessions()
    schedule(loadSessions, 4000)
  }

  function loadSessions() {
    if (listInFlight !== null) return listInFlight
    var request = api('workspaces', {}).then(function (value) {
      sessions = Array.isArray(value.sessions) ? value.sessions : []
      workspaces = Array.isArray(value.workspaces) ? value.workspaces : []
      if (view === 'list') render()
    }).catch(absorbPollError).finally(function () {
      if (listInFlight === request) listInFlight = null
    })
    listInFlight = request
    return request
  }

  function enterChat(session) {
    current = { sessionId: session.sessionId, title: session.title || basename(session.cwd) || '会话' }
    messages = []
    latestSeq = -1
    running = session.running === true
    setView('chat')
    loadHistory()
    schedule(loadHistory, 1500)
  }

  function loadHistory() {
    if (!current) return Promise.resolve()
    var sessionId = current.sessionId
    if (historyInFlight !== null && historyInFlight.sessionId === sessionId) return historyInFlight.promise
    var cursor = latestSeq
    var marker = { sessionId: sessionId, promise: null }
    var request = api('history', { sessionId: sessionId, afterSeq: cursor }).then(function (value) {
      // A response for chat A must never mutate chat B after fast navigation.
      if (view !== 'chat' || !current || current.sessionId !== sessionId) return
      if (typeof value.latestSeq === 'number' && value.latestSeq > latestSeq) latestSeq = value.latestSeq
      running = value.running === true
      if (Array.isArray(value.messages)) {
        value.messages.forEach(function (m) {
          for (var i = 0; i < messages.length; i++) {
            var existing = messages[i]
            var stableMatch = m.kind === 'tool' && existing.kind === 'tool' && m.callId && existing.callId === m.callId
              || m.kind === 'approval' && existing.kind === 'approval' && m.id && existing.id === m.id
            if (stableMatch || existing.seq === m.seq && existing.kind === m.kind) {
              messages[i] = Object.assign({}, existing, m, {
                toolName: m.toolName || existing.toolName,
                reason: m.reason || existing.reason,
                name: m.name || existing.name,
              })
              return
            }
          }
          messages.push(m)
        })
        messages.sort(function (a, b) { return a.seq - b.seq })
      }
      refreshChatView()
    }).catch(function (err) {
      if (current && current.sessionId === sessionId) absorbPollError(err)
    }).finally(function () {
      if (historyInFlight === marker) historyInFlight = null
    })
    marker.promise = request
    historyInFlight = marker
    return request
  }

  function enterOffline() {
    if (view === 'offline' && pollTimer !== null) return
    setView('offline')
    schedule(function () {
      return api('state', {}).then(function (value) {
        device = value.device
        if (device && device.status === 'active') enterList()
      }).catch(function (err) {
        if (err && err.code === 'remote-off') return
        if (err && err.code === 'pending-confirmation') enterPending()
        else absorbPollError(err)
      })
    }, 3000)
  }

  function enterPending() {
    if (view === 'pending' && pollTimer !== null) return
    setView('pending')
    schedule(function () {
      return api('state', {}).then(function (value) {
        device = value.device
        if (device && device.status === 'active') enterList()
      }).catch(function (err) {
        if (err && err.code === 'pending-confirmation') return // keep waiting
        absorbPollError(err)
      })
    }, 5000)
  }

  // Polling must not replace the composer: doing so blurs the textarea and
  // collapses the mobile virtual keyboard every 1.5 seconds.
  function refreshChatView() {
    if (view !== 'chat') return
    var scroll = root.querySelector('.chat-scroll')
    if (!scroll) {
      render()
      return
    }
    var savedScrollTop = scroll.scrollTop
    var nearBottom = scroll.scrollHeight - savedScrollTop - scroll.clientHeight < 80
    fillChatMessages(scroll)
    var stop = root.querySelector('.chat-stop')
    if (stop) stop.hidden = !running
    var chatBanner = root.querySelector('.chat-banner')
    if (chatBanner) {
      chatBanner.textContent = banner || ''
      chatBanner.hidden = !banner
    }
    scroll.scrollTop = nearBottom ? scroll.scrollHeight : savedScrollTop
  }

  // ── render root ──────────────────────────────────────────────────────────

  function render() {
    while (root.firstChild) root.removeChild(root.firstChild)
    if (view === 'loading') {
      root.appendChild(el('div', 'boot', '正在加载…'))
    } else if (view === 'pair-info') {
      root.appendChild(renderPairInfo())
    } else if (view === 'pair-form') {
      root.appendChild(renderPairForm())
    } else if (view === 'pending') {
      root.appendChild(renderPending())
    } else if (view === 'offline') {
      root.appendChild(renderOffline())
    } else if (view === 'list') {
      root.appendChild(renderList())
    } else if (view === 'chat') {
      root.appendChild(renderChat())
      var scroll = root.querySelector('.chat-scroll')
      if (scroll) scroll.scrollTop = scroll.scrollHeight
    }
  }

  // ── bootstrap ────────────────────────────────────────────────────────────

  function boot() {
    var hash = window.location.hash || ''
    var match = /[#&]p=([A-Za-z0-9_-]+)/.exec(hash)
    if (match) {
      currentPairToken = match[1]
      // The pairing token must not linger in the address bar or history.
      try {
        history.replaceState(null, '', window.location.pathname)
      } catch (_) { /* ignore */ }
      setView('pair-form')
      return
    }

    try {
      token = localStorage.getItem(TOKEN_KEY)
      device = JSON.parse(localStorage.getItem(DEVICE_KEY) || 'null')
      pendingPrompt = JSON.parse(localStorage.getItem(PENDING_PROMPT_KEY) || 'null')
    } catch (_) {
      token = null
      device = null
      pendingPrompt = null
    }

    if (!token) {
      setView('pair-info')
      return
    }

    // Validate the stored credential before entering.
    api('state', {})
      .then(function (value) {
        device = value.device
        if (device && device.status === 'pending') enterPending()
        else enterList()
      })
      .catch(function (err) {
        if (err && err.code === 'pending-confirmation') enterPending()
        else absorbPollError(err)
      })
  }

  boot()
})()
