window.__ModuleLoader__.load({
  id: 'dsh-remote-control',
  factory(require) {
    // The DSH browser ModuleLoader invokes factories with only `require`.
    // Keep the CommonJS-shaped exports below self-contained instead of
    // relying on Node's ambient `module` and `exports` bindings.
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    let ReactDOM = null
    try { ReactDOM = require('react-dom') } catch (_) {}
    const { useCallback, useEffect, useState, useSyncExternalStore } = React

    //#region css — --dsw-alias-* tokens only; literal colors are fallbacks for
    // tokens that exist in the running build but not in every token listing.
    const css = [
      ".dshRc_launcher{box-sizing:border-box;min-width:28px;height:28px;border:none;background:transparent;border-radius:6px;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;padding:0 6px;font:inherit;font-size:12px;line-height:16px}",
      ".dshRc_launcher:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15));color:var(--dsw-alias-label-primary)}",
      ".dshRc_launcherIcon{display:inline-flex;flex:none}",
      ".dshRc_launcherLabel{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px}",
      ".dshRc_overlay{position:fixed;inset:0;z-index:1000;box-sizing:border-box;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask,rgba(0,0,0,.45));animation:dshRcFade .18s ease-out;pointer-events:auto}",
      ".dshRc_panel{box-sizing:border-box;width:min(440px,calc(100vw - 32px));max-height:min(640px,calc(100vh - 48px));background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-3,#1c1c1f));border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:var(--dsw-shadow-lv2,0 8px 28px #0000004d);flex-direction:column;display:flex;overflow:hidden;animation:dshRcPop .18s ease-out}",
      ".dshRc_head{box-sizing:border-box;color:var(--dsw-alias-label-primary);border-bottom:1px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:8px;padding:8px 8px 8px 14px;font-size:13px;line-height:20px;display:flex;flex:none}",
      ".dshRc_title{min-width:0;display:inline-flex;align-items:center;gap:8px;font-weight:600}",
      ".dshRc_close{box-sizing:border-box;width:24px;height:24px;color:var(--dsw-alias-label-secondary);text-align:center;background:0 0;cursor:pointer;border:none;border-radius:6px;padding:0;font:inherit;font-size:14px;line-height:24px;display:inline-flex;align-items:center;justify-content:center;flex:none}",
      ".dshRc_close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15))}",
      ".dshRc_body{min-height:0;flex:1;flex-direction:column;gap:12px;padding:14px;display:flex;overflow:auto}",
      ".dshRc_statusCard{box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:6px}",
      ".dshRc_statusRow{display:flex;align-items:center;gap:8px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary)}",
      ".dshRc_dot{border-radius:50%;flex:none;width:8px;height:8px}",
      ".dshRc_dotOn{background:var(--dsw-alias-state-success-primary)}",
      ".dshRc_dotOff{background:var(--dsw-alias-state-idle-primary)}",
      ".dshRc_meta{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;line-height:16px}",
      ".dshRc_action{box-sizing:border-box;width:100%;height:32px;border:none;border-radius:8px;cursor:pointer;font:inherit;font-size:13px;line-height:16px;color:#fff;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:0 12px}",
      ".dshRc_action:disabled{opacity:.55;cursor:default}",
      ".dshRc_start{background:var(--dsw-alias-brand-primary)}",
      ".dshRc_stop{background:var(--dsw-alias-state-error-primary)}",
      ".dshRc_error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:16px;word-break:break-word}",
      ".dshRc_notice{box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
      ".dshRc_section{display:flex;flex-direction:column;gap:6px}",
      ".dshRc_sectionTitle{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;line-height:16px;display:flex;align-items:center;justify-content:space-between;gap:8px}",
      ".dshRc_empty{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px;line-height:16px}",
      ".dshRc_pairRow{display:flex;gap:8px}",
      ".dshRc_pairBtn{box-sizing:border-box;flex:1;height:30px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;cursor:pointer;font:inherit;font-size:12px;line-height:16px;padding:0 10px}",
      ".dshRc_pairBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15))}",
      ".dshRc_pairBtn:disabled{opacity:.55;cursor:default}",
      ".dshRc_qrCard{box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;display:flex;flex-direction:column;align-items:center;gap:10px}",
      ".dshRc_qrBox{background:#fff;border-radius:8px;padding:8px;line-height:0;max-width:200px}",
      ".dshRc_qrBox svg{width:184px;height:184px;display:block}",
      ".dshRc_qrTitle{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600}",
      ".dshRc_qrUrl{width:100%;box-sizing:border-box;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px;font-size:11px;line-height:16px;word-break:break-all;font-family:monospace}",
      ".dshRc_copyRow{display:flex;gap:8px;align-items:center;justify-content:space-between;width:100%}",
      ".dshRc_copyBtn{box-sizing:border-box;height:26px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;cursor:pointer;font:inherit;font-size:11px;padding:0 10px;flex:none}",
      ".dshRc_copyBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15))}",
      ".dshRc_deviceRow{box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px;display:flex;align-items:center;gap:8px}",
      ".dshRc_deviceMeta{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
      ".dshRc_deviceName{color:var(--dsw-alias-label-primary);font-size:12px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshRc_deviceSub{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;line-height:14px}",
      ".dshRc_badge{flex:none;display:inline-flex;align-items:center;height:16px;padding:0 6px;border-radius:8px;font-size:10px;line-height:16px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}",
      ".dshRc_badgePending{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}",
      ".dshRc_badgeActive{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}",
      ".dshRc_badgeDead{opacity:.6}",
      ".dshRc_deviceBtn{box-sizing:border-box;height:24px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;cursor:pointer;font:inherit;font-size:11px;padding:0 8px;flex:none}",
      ".dshRc_deviceBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15))}",
      ".dshRc_deviceBtnDanger:hover{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
      "@keyframes dshRcFade{from{opacity:0}to{opacity:1}}",
      "@keyframes dshRcPop{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}",
    ].join('\n')
    const tagId = 'dsh-remote-control/client.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-remote-control'
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      document.head.appendChild(tag)
    }
    //#endregion

    //#region dictionaries
    const NS = 'dsh-remote-control'
    const zh = {
      appName: '远程控制',
      statusOn: '远控已开启',
      statusOff: '远控未开启',
      startedAt: '开启于 {time}',
      stoppedAt: '关闭于 {time}',
      start: '启动远控',
      stop: '停止远控',
      busyStart: '启动中…',
      busyStop: '停止中…',
      networkReady: '局域网入口已就绪',
      networkNotReady: '局域网入口未就绪',
      networkAddress: '{interface}：{host}:{port}',
      pairTitle: '配对设备',
      pairTemp: '临时配对（{hours} 小时）',
      pairTrusted: '添加受信任设备',
      pairHint: '连接同一可信 Wi‑Fi/局域网的手机扫码或打开此链接',
      pairingTemp: '临时连接',
      pairingTrusted: '受信任设备（需在下方确认）',
      pairExpires: '二维码有效期至 {time}',
      copyLink: '复制链接',
      copied: '已复制',
      devices: '设备（{count}）',
      devicesEmpty: '暂无已配对设备',
      kindTemp: '临时',
      kindTrusted: '受信任',
      statusPending: '待确认',
      statusActive: '已配对',
      statusRevoked: '已撤销',
      statusExpired: '已过期',
      lastSeen: '最后活动：{time}',
      confirm: '确认',
      confirmHint: '允许这台设备长期访问',
      revoke: '撤销',
      revokeHint: '立即使这台设备的凭据失效',
      refresh: '刷新',
      phaseNotice: '局域网入口使用未加密 HTTP，仅限可信家庭/办公网络；不要在公共 Wi‑Fi 使用。DSH 主页面与管理 API 不会开放。',
      failed: '操作失败：{message}',
      rpcUnavailable: '控制通道不可用',
      close: '关闭',
      closeHint: '关闭远程控制面板',
      launcherHint: '远程控制',
      timeJustNow: '刚刚',
      timeMinutes: '{n} 分钟前',
      timeHours: '{n} 小时前',
      timeDays: '{n} 天前',
    }
    const en = {
      appName: 'Remote Control',
      statusOn: 'Remote control is on',
      statusOff: 'Remote control is off',
      startedAt: 'Started at {time}',
      stoppedAt: 'Stopped at {time}',
      start: 'Start remote control',
      stop: 'Stop remote control',
      busyStart: 'Starting…',
      busyStop: 'Stopping…',
      networkReady: 'LAN ingress is ready',
      networkNotReady: 'LAN ingress is not ready',
      networkAddress: '{interface}: {host}:{port}',
      pairTitle: 'Pair a device',
      pairTemp: 'Temporary pairing ({hours}h)',
      pairTrusted: 'Add trusted device',
      pairHint: 'Scan or open this link on a phone connected to the same trusted LAN',
      pairingTemp: 'Temporary connection',
      pairingTrusted: 'Trusted device (confirm below)',
      pairExpires: 'QR valid until {time}',
      copyLink: 'Copy link',
      copied: 'Copied',
      devices: 'Devices ({count})',
      devicesEmpty: 'No paired devices yet',
      kindTemp: 'temporary',
      kindTrusted: 'trusted',
      statusPending: 'pending',
      statusActive: 'paired',
      statusRevoked: 'revoked',
      statusExpired: 'expired',
      lastSeen: 'Last seen: {time}',
      confirm: 'Confirm',
      confirmHint: 'Allow this device long-term access',
      revoke: 'Revoke',
      revokeHint: 'Immediately invalidate this device',
      refresh: 'Refresh',
      phaseNotice: 'LAN access uses unencrypted HTTP. Use it only on trusted home/office networks, never public Wi-Fi. DSH operator routes remain private.',
      failed: 'Operation failed: {message}',
      rpcUnavailable: 'Control channel unavailable',
      close: 'Close',
      closeHint: 'Close the remote control panel',
      launcherHint: 'Remote control',
      timeJustNow: 'just now',
      timeMinutes: '{n}m ago',
      timeHours: '{n}h ago',
      timeDays: '{n}d ago',
    }
    //#endregion

    /** Shared panel-open store so the footer launcher and the overlay panel
     * (separate slot occupants) stay in sync without DOM probing. */
    const panelSubs = new Set()
    let panelOpen = false
    const subscribePanel = (onChange) => {
      panelSubs.add(onChange)
      return () => panelSubs.delete(onChange)
    }
    const getPanelOpen = () => panelOpen
    const setPanelOpen = (next) => {
      const value = typeof next === 'function' ? next(panelOpen) : next
      if (value === panelOpen) return
      panelOpen = value
      for (const onChange of panelSubs) onChange()
    }

    function formatTime(iso, t, key) {
      if (typeof iso !== 'string' || iso === '') return null
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return null
      return t(key, { time: date.toLocaleString() })
    }

    function relativeTime(iso, t) {
      if (typeof iso !== 'string' || iso === '') return t('timeJustNow')
      const then = Date.parse(iso)
      if (!Number.isFinite(then)) return t('timeJustNow')
      const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
      if (s < 90) return t('timeJustNow')
      const m = Math.floor(s / 60)
      if (m < 60) return t('timeMinutes', { n: m })
      const h = Math.floor(m / 60)
      if (h < 24) return t('timeHours', { n: h })
      return t('timeDays', { n: Math.floor(h / 24) })
    }

    /** Inline SVG icons keep the bundle dependency-free. */
    function PhoneIcon({ size = 14 }) {
      return React.createElement(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        React.createElement('path', {
          fill: 'currentColor',
          d: 'M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24c1.12.37 2.33.57 3.57.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C10.85 21 3 13.15 3 3.5a1 1 0 0 1 1-1H7.5a1 1 0 0 1 1 1c0 1.24.2 2.45.57 3.57a1 1 0 0 1-.25 1.02l-2.2 2.2Z',
        }),
      )
    }

    function CloseIcon({ size = 14 }) {
      return React.createElement(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        React.createElement('path', {
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          d: 'M4 4l8 8M12 4l-8 8',
        }),
      )
    }

    /**
     * Sidebar footer launcher (beside Settings): a phone-shaped button that
     * opens the local control panel. Root-scoped slot, so props are only the
     * column state (`wide`) plus the injected RPC caller and dictionary.
     */
    function RemoteLauncher({ wide, t }) {
      const open = useSyncExternalStore(subscribePanel, getPanelOpen)
      const label = t('launcherHint')
      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'dshRc_launcher',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': label,
          title: label,
          onClick: () => setPanelOpen(true),
        },
        React.createElement('span', { className: 'dshRc_launcherIcon' }, PhoneIcon({})),
        wide === true ? React.createElement('span', { className: 'dshRc_launcherLabel' }, label) : null,
      )
    }

    const DEVICE_STATUS_KEY = {
      pending: 'statusPending',
      active: 'statusActive',
      revoked: 'statusRevoked',
      expired: 'statusExpired',
    }

    function DeviceRow({ device, t, onAction, busy }) {
      const badgeKey = DEVICE_STATUS_KEY[device.status] ?? 'statusActive'
      const badgeClass = 'dshRc_badge' +
        (device.status === 'pending' ? ' dshRc_badgePending'
          : device.status === 'active' ? ' dshRc_badgeActive'
            : ' dshRc_badgeDead')
      const kindLabel = device.kind === 'trusted' ? t('kindTrusted') : t('kindTemp')
      const sub = `${kindLabel} · ${t(badgeKey)} · ${t('lastSeen', { time: relativeTime(device.lastSeenAt, t) })}`
      const buttons = []
      if (device.status === 'pending') {
        buttons.push(React.createElement(
          'button',
          {
            key: 'confirm',
            type: 'button',
            className: 'dshRc_deviceBtn',
            title: t('confirmHint'),
            disabled: busy,
            onClick: () => onAction('confirm', device.id),
          },
          t('confirm'),
        ))
      }
      if (device.status === 'active' || device.status === 'pending') {
        buttons.push(React.createElement(
          'button',
          {
            key: 'revoke',
            type: 'button',
            className: 'dshRc_deviceBtn dshRc_deviceBtnDanger',
            title: t('revokeHint'),
            disabled: busy,
            onClick: () => onAction('revoke', device.id),
          },
          t('revoke'),
        ))
      }
      return React.createElement(
        'div',
        { className: 'dshRc_deviceRow' },
        React.createElement(
          'div',
          { className: 'dshRc_deviceMeta' },
          React.createElement('span', { className: 'dshRc_deviceName' }, device.name),
          React.createElement('span', { className: 'dshRc_deviceSub' }, sub),
        ),
        React.createElement('span', { className: badgeClass }, t(badgeKey)),
        buttons,
      )
    }

    /**
     * Frame-wide control panel rendered into `shell.overlay`: lifecycle state,
     * start/stop, pairing QR, and the device registry.
     */
    function RemoteControlPanel({ t, call }) {
      const open = useSyncExternalStore(subscribePanel, getPanelOpen)
      const [state, setState] = useState({ status: 'idle', value: null, error: null })
      const [busy, setBusy] = useState(null)
      const [deviceBusy, setDeviceBusy] = useState(false)
      const [pairing, setPairing] = useState(null) // { kind, url, svg, expiresAt }
      const [copied, setCopied] = useState(false)
      const [, forceTick] = useState(0)

      const load = useCallback(async () => {
        if (typeof call !== 'function') {
          setState({ status: 'error', value: null, error: t('rpcUnavailable') })
          return
        }
        try {
          const result = await call('status', {})
          if (result?.ok === true) {
            setState({ status: 'ready', value: result.value, error: null })
          } else {
            const message = result?.error?.message ?? 'remote-control RPC failed'
            setState((prev) => ({ status: 'error', value: prev.value, error: message }))
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          setState((prev) => ({ status: 'error', value: prev.value, error: message }))
        }
      }, [call, t])

      // Load on open; poll while open so device events (pairing, confirmation
      // requests) appear without a manual refresh.
      useEffect(() => {
        if (!open) return undefined
        void load()
        const timer = window.setInterval(() => { void load() }, 5000)
        return () => window.clearInterval(timer)
      }, [open, load])

      // 1s tick while a QR is shown, so the expiry countdown stays honest.
      useEffect(() => {
        if (pairing === null) return undefined
        const timer = window.setInterval(() => forceTick((n) => n + 1), 1000)
        return () => window.clearInterval(timer)
      }, [pairing])

      // Drop a QR whose pairing token has lapsed.
      useEffect(() => {
        if (pairing !== null && Date.parse(pairing.expiresAt) < Date.now()) setPairing(null)
      })

      // Escape closes the panel.
      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setPanelOpen(false)
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open])

      if (!open) return null

      const value = state.value
      const active = value?.active === true
      const startedLine = active ? formatTime(value?.startedAt, t, 'startedAt') : formatTime(value?.stoppedAt, t, 'stoppedAt')
      const devices = Array.isArray(value?.devices) ? value.devices : []
      const limits = value?.limits ?? { tempHours: 8, trustedIdleDays: 90 }
      const network = value?.network ?? { ready: false, message: t('networkNotReady'), publicBaseUrl: null, host: null, port: null, interfaceName: null }

      const toggle = async () => {
        if (busy !== null || typeof call !== 'function') return
        const endpoint = active ? 'stop' : 'start'
        setBusy(endpoint)
        try {
          const result = await call(endpoint, {})
          if (result?.ok === true) {
            setState({ status: 'ready', value: result.value, error: null })
          } else {
            setState((prev) => ({ ...prev, error: result?.error?.message ?? 'request failed' }))
          }
        } catch (error) {
          setState((prev) => ({ ...prev, error: error instanceof Error ? error.message : String(error) }))
        } finally {
          setBusy(null)
        }
      }

      const startPairing = async (kind) => {
        if (busy !== null || typeof call !== 'function') return
        setBusy('pair')
        setCopied(false)
        try {
          const pairResult = await call('pair', { kind })
          if (pairResult?.ok !== true) {
            setState((prev) => ({ ...prev, error: pairResult?.error?.message ?? 'pairing failed' }))
            return
          }
          const url = pairResult.value.url
          const qrResult = await call('qr', { text: url })
          const svg = qrResult?.ok === true ? qrResult.value.svg : null
          setPairing({ kind, url, svg, expiresAt: pairResult.value.expiresAt })
        } catch (error) {
          setState((prev) => ({ ...prev, error: error instanceof Error ? error.message : String(error) }))
        } finally {
          setBusy(null)
        }
      }

      const copyLink = async () => {
        if (pairing === null) return
        try {
          await navigator.clipboard.writeText(pairing.url)
          setCopied(true)
        } catch {
          setCopied(false)
        }
      }

      const deviceAction = async (action, deviceId) => {
        if (deviceBusy || typeof call !== 'function') return
        setDeviceBusy(true)
        try {
          const result = await call(action, { deviceId })
          if (result?.ok !== true) {
            setState((prev) => ({ ...prev, error: result?.error?.message ?? `${action} failed` }))
          }
          await load()
        } catch (error) {
          setState((prev) => ({ ...prev, error: error instanceof Error ? error.message : String(error) }))
        } finally {
          setDeviceBusy(false)
        }
      }

      const pairingExpired = pairing !== null && Date.parse(pairing.expiresAt) < Date.now()

      const panel = React.createElement(
        'div',
        {
          className: 'dshRc_overlay',
          onClick: (event) => { if (event.target === event.currentTarget) setPanelOpen(false) },
        },
        React.createElement(
          'div',
          { className: 'dshRc_panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('appName') },
          React.createElement(
            'div',
            { className: 'dshRc_head' },
            React.createElement(
              'span',
              { className: 'dshRc_title' },
              React.createElement('span', { className: 'dshRc_launcherIcon' }, PhoneIcon({ size: 15 })),
              t('appName'),
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dshRc_close',
                title: t('closeHint'),
                'aria-label': t('close'),
                onClick: () => setPanelOpen(false),
              },
              CloseIcon({}),
            ),
          ),
          React.createElement(
            'div',
            { className: 'dshRc_body' },
            React.createElement(
              'div',
              { className: 'dshRc_statusCard' },
              React.createElement(
                'div',
                { className: 'dshRc_statusRow' },
                React.createElement('span', { className: 'dshRc_dot ' + (active ? 'dshRc_dotOn' : 'dshRc_dotOff'), 'aria-hidden': 'true' }),
                active ? t('statusOn') : t('statusOff'),
              ),
              startedLine !== null ? React.createElement('div', { className: 'dshRc_meta' }, startedLine) : null,
            ),
            React.createElement(
              'div',
              { className: 'dshRc_statusCard' },
              React.createElement(
                'div',
                { className: 'dshRc_statusRow' },
                React.createElement('span', { className: 'dshRc_dot ' + (network.ready ? 'dshRc_dotOn' : 'dshRc_dotOff'), 'aria-hidden': 'true' }),
                network.ready ? t('networkReady') : t('networkNotReady'),
              ),
              React.createElement('div', { className: 'dshRc_meta' }, network.publicBaseUrl ?? network.message),
              network.host !== null
                ? React.createElement('div', { className: 'dshRc_meta' }, t('networkAddress', {
                    interface: network.interfaceName ?? 'LAN', host: network.host, port: network.port,
                  }))
                : null,
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dshRc_action ' + (active ? 'dshRc_stop' : 'dshRc_start'),
                disabled: busy !== null || state.status !== 'ready',
                onClick: () => void toggle(),
              },
              busy === 'start' ? t('busyStart') : busy === 'stop' ? t('busyStop') : active ? t('stop') : t('start'),
            ),
            state.error !== null ? React.createElement('div', { className: 'dshRc_error' }, t('failed', { message: state.error })) : null,
            active === true
              ? React.createElement(
                  'div',
                  { className: 'dshRc_section' },
                  React.createElement('div', { className: 'dshRc_sectionTitle' }, t('pairTitle')),
                  React.createElement(
                    'div',
                    { className: 'dshRc_pairRow' },
                    React.createElement(
                      'button',
                      { type: 'button', className: 'dshRc_pairBtn', disabled: busy !== null || !network.ready, onClick: () => void startPairing('temp') },
                      t('pairTemp', { hours: limits.tempHours }),
                    ),
                    React.createElement(
                      'button',
                      { type: 'button', className: 'dshRc_pairBtn', disabled: busy !== null || !network.ready, onClick: () => void startPairing('trusted') },
                      t('pairTrusted'),
                    ),
                  ),
                  pairing !== null && !pairingExpired
                    ? React.createElement(
                        'div',
                        { className: 'dshRc_qrCard' },
                        React.createElement('div', { className: 'dshRc_qrTitle' }, pairing.kind === 'trusted' ? t('pairingTrusted') : t('pairingTemp')),
                        pairing.svg !== null
                          ? React.createElement('div', { className: 'dshRc_qrBox', dangerouslySetInnerHTML: { __html: pairing.svg } })
                          : null,
                        React.createElement('div', { className: 'dshRc_meta' }, t('pairHint')),
                        React.createElement('div', { className: 'dshRc_qrUrl' }, pairing.url),
                        React.createElement(
                          'div',
                          { className: 'dshRc_copyRow' },
                          React.createElement('span', { className: 'dshRc_meta' }, t('pairExpires', { time: new Date(pairing.expiresAt).toLocaleTimeString() })),
                          React.createElement(
                            'button',
                            { type: 'button', className: 'dshRc_copyBtn', onClick: () => void copyLink() },
                            copied ? t('copied') : t('copyLink'),
                          ),
                        ),
                      )
                    : null,
                )
              : null,
            React.createElement(
              'div',
              { className: 'dshRc_section' },
              React.createElement(
                'div',
                { className: 'dshRc_sectionTitle' },
                React.createElement('span', null, t('devices', { count: devices.length })),
                React.createElement(
                  'button',
                  { type: 'button', className: 'dshRc_copyBtn', onClick: () => void load() },
                  t('refresh'),
                ),
              ),
              devices.length === 0
                ? React.createElement('div', { className: 'dshRc_empty' }, t('devicesEmpty'))
                : devices.map((device) => React.createElement(DeviceRow, { key: device.id, device, t, onAction: deviceAction, busy: deviceBusy })),
            ),
            React.createElement('div', { className: 'dshRc_notice' }, t('phaseNotice')),
          ),
        ),
      )

      return ReactDOM !== null && ReactDOM.createPortal && typeof document !== 'undefined'
        ? ReactDOM.createPortal(panel, document.body)
        : panel
    }

    //#region client entry
    /** Services required by the slot registrations. */
    const inject = ['slots', 'locale', 'connection']

    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        'dsh-remote-control: dictionaries',
      )

      const call = (endpoint, payload) => ctx.connection.rpc.call('/api', 'remote-control/' + endpoint, payload)

      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'remote-control-launcher',
            order: 10,
            locale: NS,
            inject: () => ({ call }),
          },
          RemoteLauncher,
        ),
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'remote-control-panel',
            order: 50,
            locale: NS,
            inject: () => ({ call }),
          },
          RemoteControlPanel,
        ),
      )
    }
    //#endregion

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
