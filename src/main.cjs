// @ts-check
/**
 * Electron main process for the DeepSeek Harness desktop shell.
 *
 * The window opens immediately on a local boot page (src/boot.html), then the
 * `dsh web` backend (node:http on a loopback port chosen by the OS via
 * `--port 0`) is spawned in the background under the standalone Node runtime
 * bundled at resources/node (a DSH_NODE override or a PATH node are
 * fallbacks) — never Electron's embedded node, which the backend's addons
 * cannot run under. Boot progress streams to the page
 * over IPC; on failure the page shows the error plus the backend's stderr tail
 * and a retry button — the app never quits just because a boot step failed.
 * Once the backend answers 200 on GET /, the window navigates to it. The Web
 * UI is same-origin with its backend, so the full HTTP + WebSocket transport
 * and trust perimeter are reused with no protocol changes.
 *
 * CommonJS is deliberate: the main process only needs `electron` plus Node
 * built-ins and never imports other packages, so staying CJS sidesteps
 * ESM-main-process version pitfalls. This package is private and unpublished.
 */
'use strict'

const { app, BrowserWindow, dialog, shell, nativeTheme, ipcMain } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const { ensureCliShim } = require('./ensure-cli-shim.cjs')
const { ensureDesktopPlugins } = require('./ensure-desktop-plugins.cjs')
const { checkForUpdate, compareVersions } = require('./update-check.cjs')

/** Repository root (this file lives at src/main.cjs). */
const ROOT = path.resolve(__dirname, '..')
/** Registry backend staged by `pnpm run backend` (scripts/build-desktop-backend.mjs). */
const STAGED_BACKEND = path.join(ROOT, 'dist-desktop', 'backend')
/** Backend closure directory the current boot uses for desktop plugin seeding. */
function desktopBackendRoot () {
  if (app.isPackaged) return path.join(process.resourcesPath, 'backend')
  return STAGED_BACKEND
}

/**
 * Matches the `dsh web: http://127.0.0.1:<port>` readiness line. Since dsh
 * 0.1.5 the URL carries a `?token=…` query (the UI sits behind a cookie
 * session minted by a one-time token exchange), so the whole URL is captured,
 * not just the port.
 */
const READY_RE = /http:\/\/127\.0\.0\.1:\d+\S*/

const HEALTH_TIMEOUT_MS = 30_000
const HEALTH_INTERVAL_MS = 200
/** Deadline for the backend to print its readiness URL after spawn. */
const BACKSTART_TIMEOUT_MS = 60_000
/** Backend stderr lines kept to render in the boot page's failure panel. */
const STDERR_TAIL_LINES = 200

/** @type {import('node:child_process').ChildProcess | null} */
let backend = null
/** @type {Electron.BrowserWindow | null} */
let win = null
let quitting = false
/** attemptBoot() is in flight; suppresses concurrent (re)starts. */
let starting = false
/** 'boot' until the backend URL loads, 'app' while it shows, 'error' after a failed boot. */
let phase = 'boot'
/** Guard so the boot:ready signal from a reloaded boot page cannot start a second boot. */
let bootStarted = false
/** Ring buffer of recent backend stderr lines for error reporting. */
const stderrTail = []
/** Node executable resolved by checkNode(); backendSpec spawns this. */
let nodeCmd = 'node'

/** @type {Electron.BrowserWindow | null} */
let updateWin = null
/** Version the currently open dialog describes ({version, url?}); url is the
 * browser download page and only exists for the macOS flow. */
let updateInfo = null
/** Which update flow drives the dialog: 'auto' (electron-updater, packaged
 * Windows) or 'browser' (macOS download page). */
let updateMode = 'browser'
/** Dialog flow phase: 'prompt' | 'downloading' | 'downloaded' | 'error'. */
let updatePhase = 'prompt'
/** Last download-progress sample from electron-updater, or null. */
let updateProgress = null
/** Message behind the dialog's error state, or null. */
let updateError = null
/** electron-updater handle; created lazily for packaged Windows only. */
let autoUpdater = null
/** Cancels the in-flight download when the dialog closes mid-download. */
let downloadCt = null
/** {version} once an update finished downloading; drives the quit prompt. */
let downloadedUpdate = null
/** Set once this session must not ask "install on quit?" again. */
let skipQuitInstallPrompt = false
/** maybeCheckForUpdates() is in flight; suppresses concurrent checks. */
let updateCheckRunning = false

// Title-bar controls: the custom title bar is injected into the renderer by
// preload.cjs and calls back over these channels.
ipcMain.on('win:minimize', () => win?.minimize())
ipcMain.on('win:toggle-maximize', () => {
  if (!win) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
})
ipcMain.on('win:close', () => win?.close())

// The boot page reports its status listener via preload.cjs's dshBoot bridge;
// the first boot starts then, so no early status event is lost to the page
// load race. Retries arrive on boot:retry.
ipcMain.on('boot:ready', () => {
  if (bootStarted) return
  bootStarted = true
  void attemptBoot()
})
ipcMain.on('boot:retry', () => {
  if (phase !== 'error' || starting) return
  void attemptBoot()
})

// Update dialog bridge. The page reports its listener attached and then
// receives the full dialog state; every state change is pushed on the same
// channel so the page stays a pure renderer. On Windows the buttons drive
// electron-updater (download/retry, restart to install); on macOS the dialog
// only ever offers the browser download page.
ipcMain.on('update:ready', () => pushUpdateState())
ipcMain.on('update:open-download', () => {
  const url = updateInfo?.url
  // Only ever hand https URLs to the OS browser.
  if (url && /^https:\/\//i.test(url)) shell.openExternal(url)
})
ipcMain.on('update:download', () => startUpdateDownload())
ipcMain.on('update:install', () => {
  if (!downloadedUpdate || !autoUpdater) return
  // The user just answered the install question; the quit-time prompt must
  // not re-ask when quitAndInstall re-enters before-quit. Silent install +
  // force-run-after: the wizard never shows and the app relaunches itself.
  skipQuitInstallPrompt = true
  autoUpdater.quitAndInstall(true, true)
})
ipcMain.on('update:dismiss', () => {
  // Only a prompt-stage "not now" means "stop asking for this version"; a
  // downloaded update stays cached for the quit-time install question, and a
  // cancelled download re-prompts on the next launch.
  if (updatePhase === 'prompt' && updateInfo) {
    writeUpdateState({ dismissedVersion: updateInfo.version })
  }
  updateWin?.close()
})

/**
 * Push a boot status ({state: 'loading'|'error', message, detail?}) to the
 * boot page. Silently drops it when no window can receive it.
 * @param {{ state: 'loading' | 'error', message: string, detail?: string }} status
 */
function sendStatus (status) {
  try {
    win?.webContents.send('boot:status', status)
  } catch {
    // The window can be mid-teardown during status updates; dropping is fine.
  }
}

/**
 * Resolve how to launch the backend. Packaged: run lib/bin.js from
 * resources/backend under the Node bundled at resources/node (resolved by
 * checkNode). Dev: with `DSH_SOURCE_REPO` set,
 * run that dsh checkout's source CLI via tsx (debugging harness changes);
 * otherwise run the staged registry backend — the exact closure the installer
 * ships.
 * @returns {{ cwd: string, cmd: string, args: string[] }}
 */
function backendSpec () {
  if (app.isPackaged) {
    const backendRoot = path.join(process.resourcesPath, 'backend')
    return { cwd: backendRoot, cmd: nodeCmd, args: [path.join(backendRoot, 'lib', 'bin.js'), 'web', '--port', '0', '--no-open'] }
  }
  const sourceRepo = process.env.DSH_SOURCE_REPO
  if (sourceRepo) {
    const cliBin = path.join(sourceRepo, 'apps', 'cli', 'src', 'bin.ts')
    if (!fs.existsSync(cliBin)) {
      throw new Error(`DSH_SOURCE_REPO points at ${sourceRepo}, which has no ${cliBin}`)
    }
    return { cwd: sourceRepo, cmd: nodeCmd, args: ['--import', 'tsx/esm', cliBin, 'web', '--port', '0', '--no-open'] }
  }
  const entry = path.join(STAGED_BACKEND, 'lib', 'bin.js')
  if (!fs.existsSync(entry)) {
    throw new Error(`backend not staged at ${entry}; run "pnpm run backend" first, or set DSH_SOURCE_REPO to a dsh checkout`)
  }
  return { cwd: STAGED_BACKEND, cmd: nodeCmd, args: [entry, 'web', '--port', '0', '--no-open'] }
}

const MIN_NODE_MAJOR = 22

/**
 * Path to the standalone Node bundled at resources/node by the installer
 * (dist-desktop/node-runtime staged by scripts/build-desktop-backend.mjs);
 * null in dev. The backend must run under a real Node build, never
 * Electron's embedded node: its node-addon-require-builtin addon (HMR)
 * needs V8 embedder slots Electron does not provide.
 * @returns {string | null}
 */
function bundledNodePath () {
  if (!app.isPackaged) return null
  return path.join(process.resourcesPath, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
}

/** Common standalone Node locations for macOS GUI apps, checked when plain
 * `node` is not on the GUI PATH (Finder-launched apps don't inherit the shell
 * PATH, so Homebrew/MacPorts installs are invisible by default). */
const DARWIN_NODE_CANDIDATES = [
  '/opt/homebrew/bin/node',
  '/usr/local/bin/node',
  '/opt/local/bin/node',
  '/usr/bin/node',
]

/**
 * Return `node -v` output for a candidate executable, or null when it cannot
 * be run.
 * @param {string} cmd
 * @returns {string | null}
 */
function nodeVersion (cmd) {
  try {
    return execFileSync(cmd, ['-v'], {
      encoding: 'utf8',
      // `node` on Windows may be resolved through PATHEXT shims; explicit
      // paths must not be re-interpreted by cmd (spaces in e.g. Program Files).
      shell: process.platform === 'win32' && cmd === 'node',
      timeout: 10_000,
    }).trim()
  } catch {
    return null
  }
}

/**
 * Last-resort macOS lookup: ask the user's login shell where `node` lives.
 * The shell rc can print anything (or hang), so use a marker line and a short
 * timeout; every failure falls back to the standard error message.
 * @returns {string | null}
 */
function nodeFromLoginShell () {
  if (process.platform !== 'darwin') return null
  const shellPath = process.env.SHELL || '/bin/zsh'
  const marker = '__DSH_NODE_PATH__'
  try {
    const output = execFileSync(shellPath, ['-ilc', `printf '${marker}%s' "$(command -v node)"`], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const idx = output.lastIndexOf(marker)
    if (idx < 0) return null
    const candidate = output.slice(idx + marker.length).split(/\r?\n/, 1)[0].trim()
    if (!candidate || candidate === 'node' || !fs.existsSync(candidate)) return null
    return candidate
  } catch {
    return null
  }
}

/**
 * Locate a runnable standalone Node. `DSH_NODE` is an explicit override;
 * otherwise the bundled runtime (packaged builds) wins, then `node` on PATH,
 * then macOS-only standard locations, then the login shell PATH. The bundled
 * runtime failing to run (corrupt install) falls through to the same chain
 * instead of hard-failing, so a user-installed Node can still rescue boot.
 * @returns {{ cmd: string | null, version: string | null, error: string | null }}
 */
function locateNode () {
  const explicit = process.env.DSH_NODE
  if (explicit) {
    const version = nodeVersion(explicit)
    if (version) return { cmd: explicit, version, error: null }
    return {
      cmd: null,
      version: null,
      error: `DSH_NODE points at ${explicit}, but that node binary could not be run.`,
    }
  }

  const bundled = bundledNodePath()
  if (bundled) {
    const version = nodeVersion(bundled)
    if (version) return { cmd: bundled, version, error: null }
    console.error(`[desktop] bundled Node at ${bundled} could not be run; falling back to PATH lookup`)
  }

  const pathVersion = nodeVersion('node')
  if (pathVersion) return { cmd: 'node', version: pathVersion, error: null }

  if (process.platform === 'darwin') {
    for (const candidate of DARWIN_NODE_CANDIDATES) {
      if (!fs.existsSync(candidate)) continue
      const version = nodeVersion(candidate)
      if (version) return { cmd: candidate, version, error: null }
    }
    const shellNode = nodeFromLoginShell()
    if (shellNode) {
      const version = nodeVersion(shellNode)
      if (version) return { cmd: shellNode, version, error: null }
    }
  }

  if (app.isPackaged) {
    return {
      cmd: null,
      version: null,
      error: `The bundled Node runtime is missing or unusable (expected at ${bundled ?? 'resources/node'}). Reinstall DeepSeek Harness, or set DSH_NODE to a Node.js >= 22.19 binary as a workaround.`,
    }
  }
  return {
    cmd: null,
    version: null,
    error: 'Could not find Node.js on PATH. Install Node.js >= 22.19 (https://nodejs.org) and relaunch DeepSeek Harness. On macOS, set DSH_NODE to your node binary if it lives outside the standard locations.',
  }
}

/**
 * Verify the resolved Node satisfies the backend's minimum (the bundled
 * runtime ships a pinned current LTS, so this gate mostly protects PATH /
 * DSH_NODE fallbacks) and remember the executable for backendSpec(). Returns
 * an error message to surface on the boot page, or null when acceptable.
 * @returns {string | null}
 */
function checkNode () {
  const located = locateNode()
  if (located.error || !located.cmd) return located.error
  nodeCmd = located.cmd
  const major = Number((/^v?(\d+)/.exec(located.version ?? '') ?? [])[1])
  if (!major || major < MIN_NODE_MAJOR) {
    return `DeepSeek Harness requires Node.js >= 22.19, but found ${located.version} at ${nodeCmd}. Please upgrade at https://nodejs.org.`
  }
  return null
}

/**
 * Spawn the `dsh web` backend with an OS-assigned loopback port and resolve
 * once its readiness URL is printed, or reject with the reason (including a
 * deadline and the backend's own exit) otherwise. Stderr is mirrored to the
 * console and kept in {@link stderrTail} for the boot page's failure panel.
 * @returns {Promise<string>} the backend's readiness URL (token query included)
 */
function startBackend () {
  return new Promise((resolve, reject) => {
    // Use the standalone Node resolved by checkNode() — the bundled runtime,
    // a DSH_NODE override, or PATH node — and never Electron's embedded node:
    // node-addon-require-builtin (the backend's HMR internals bridge) cannot
    // run under Electron's V8 embedder configuration. A throw from
    // backendSpec() rejects this promise.
    const spec = backendSpec()
    backend = spawn(
      spec.cmd,
      spec.args,
      {
        cwd: spec.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    )

    let settled = false
    let pendingStderr = ''
    /** @type {NodeJS.Timeout | null} */
    let timer = null
    const settle = (settleFn, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      settleFn(value)
    }
    timer = setTimeout(
      () => settle(reject, new Error(`backend did not report readiness within ${BACKSTART_TIMEOUT_MS / 1000}s`)),
      BACKSTART_TIMEOUT_MS,
    )

    const onStdout = (chunk) => {
      const text = chunk.toString()
      process.stdout.write(`[dsh] ${text}`)
      const match = READY_RE.exec(text)
      if (match) settle(resolve, match[0])
    }
    backend.stdout.on('data', onStdout)
    backend.stderr.on('data', (chunk) => {
      process.stderr.write(`[dsh] ${chunk}`)
      // Keep whole lines only; the trailing partial stays buffered until the
      // next chunk (a final partial line is dropped — cosmetic only).
      pendingStderr += chunk
      const lines = pendingStderr.split(/\r?\n/)
      pendingStderr = lines.pop() ?? ''
      for (const line of lines) {
        stderrTail.push(line)
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift()
      }
    })

    backend.on('error', (err) => settle(reject, new Error(`failed to spawn backend: ${err.message}`)))
    backend.on('exit', (code) => {
      if (!settled) {
        if (!quitting) settle(reject, new Error(`backend exited before becoming ready (code ${code})`))
        return
      }
      // An exit between the readiness URL and the health poll is rejected by
      // waitForReady's own exit listener. A crash after the UI is up strands
      // the renderer; route back to the boot page so the user can restart
      // the backend without relaunching.
      if (!quitting && phase === 'app') {
        bootFailed(`后端进程意外退出 (code ${code})`)
      }
    })
  })
}

/**
 * Poll the readiness URL until the UI is served, or reject once the deadline
 * passes. Pre-0.1.5 backends answer 200 on the URL directly; 0.1.5+ sit the
 * UI behind a cookie session and answer the `?token=` exchange with a 3xx —
 * the renderer's loadURL performs that exchange for real. A backend that dies
 * mid-poll (readiness URL printed, UI never served) rejects at once with its
 * exit code instead of grinding to the deadline.
 * @param {string} url
 * @returns {Promise<void>}
 */
function waitForReady (url) {
  const child = backend
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    let done = false
    const settle = (settleFn, value) => {
      if (done) return
      done = true
      child?.removeListener('exit', onExit)
      settleFn(value)
    }
    /** @param {number | null} code */
    const onExit = (code) => settle(reject, new Error(`backend exited before serving the UI (code ${code})`))
    // exitCode/signalCode are set the moment the child is reaped, closing the
    // race between startBackend() resolving and the listener attaching.
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      onExit(child?.exitCode ?? null)
      return
    }
    child.on('exit', onExit)
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume()
        if (res.statusCode === 200 || (res.statusCode >= 300 && res.statusCode < 400)) return settle(resolve)
        if (Date.now() > deadline) return settle(reject, new Error('backend did not return 200 in time'))
        setTimeout(tick, HEALTH_INTERVAL_MS)
      })
      req.on('error', () => {
        if (Date.now() > deadline) return settle(reject, new Error('backend unreachable before deadline'))
        setTimeout(tick, HEALTH_INTERVAL_MS)
      })
    }
    tick()
  })
}

/**
 * Open the shell window on the local boot page. The backend's URL is loaded
 * later by attemptBoot(); until then the page shows boot progress.
 */
function createWindow () {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    // Frameless: a custom title bar (brand + window buttons) is injected by
    // preload.cjs and styled with the app's CSS variables, so it tracks the
    // light/dark theme instead of using the OS chrome.
    frame: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151517' : '#ffffff',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  // Keep the renderer's maximize/restore button icon in sync.
  win.on('maximize', () => win?.webContents.send('win:maximize-changed', true))
  win.on('unmaximize', () => win?.webContents.send('win:maximize-changed', false))
  win.loadFile(path.join(__dirname, 'boot.html'))

  // Open external links in the user's browser, never inside the shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:')) return { action: 'allow' }
    shell.openExternal(url)
    return { action: 'deny' }
  })

  win.on('closed', () => {
    win = null
  })
}

/**
 * Kill the backend process tree across platforms without external deps.
 */
function stopBackend () {
  if (!backend) return
  try {
    if (process.platform === 'win32') {
      // `/T` kills the whole descendant tree.
      spawn('taskkill', ['/pid', String(backend.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } else if (backend.pid) {
      // Negative PID targets the child's process group (spawned detached).
      try {
        process.kill(-backend.pid, 'SIGTERM')
      } catch {
        backend.kill('SIGTERM')
      }
    } else {
      backend.kill('SIGTERM')
    }
  } catch {
    // Best effort: ignore teardown failures during quit.
  }
  backend = null
}

/** App teardown flavor of {@link stopBackend}: also silences exit handling. */
function killBackend () {
  quitting = true
  stopBackend()
}

/**
 * Record a boot failure and surface it on the boot page with a retry button;
 * the app stays open either way. When the SPA is showing (backend died after
 * startup), navigate back to the boot page first and deliver the status once
 * its listener is up.
 * @param {string} message
 */
function bootFailed (message) {
  stopBackend()
  phase = 'error'
  console.error('[desktop] startup failed:', message)
  const status = { state: 'error', message, detail: stderrTail.join('\n').trim() }
  if (win && !win.isDestroyed() && !win.webContents.getURL().startsWith('file:')) {
    win.loadFile(path.join(__dirname, 'boot.html'))
      .then(() => sendStatus(status))
      .catch(() => sendStatus(status))
    return
  }
  sendStatus(status)
}

/**
 * One boot attempt: verify Node, spawn the backend, wait for its health, then
 * navigate the window to it. Every failure lands in {@link bootFailed} (shown
 * in-window with a retry), never an app quit.
 */
async function attemptBoot () {
  if (starting) return
  starting = true
  try {
    phase = 'boot'
    stderrTail.length = 0
    stopBackend()

    sendStatus({ state: 'loading', message: '正在检查 Node.js 运行环境…' })
    const nodeError = checkNode()
    if (nodeError) return bootFailed(nodeError)

    if (!process.env.DSH_SOURCE_REPO) {
      sendStatus({ state: 'loading', message: '正在启用内置插件…' })
      ensureDesktopPlugins(desktopBackendRoot())
    }

    sendStatus({ state: 'loading', message: '正在启动 DeepSeek Harness 后端…' })
    const url = await startBackend()

    sendStatus({ state: 'loading', message: '正在等待后端服务就绪…' })
    await waitForReady(url)

    if (!win || win.isDestroyed()) return
    phase = 'app'
    await win.loadURL(url)
    // Expose this install's backend as the `dsh` CLI: rewrite the ~/.dsh/bin
    // shims (they track this install dir, so upgrades self-heal) and repair
    // the user PATH entry. Fire-and-forget: the CLI is a convenience, never
    // a startup dependency.
    if (app.isPackaged && process.platform === 'win32') {
      ensureCliShim(path.join(process.resourcesPath, 'backend'))
        .catch((err) => console.error('[desktop] dsh CLI shim refresh failed:', err.message))
    }
  } catch (err) {
    bootFailed(err?.message ?? String(err))
  } finally {
    starting = false
  }
}

/**
 * Where the update state (the ignored version) is persisted.
 * @returns {string}
 */
function updateStatePath () {
  return path.join(app.getPath('userData'), 'update-state.json')
}

/**
 * Read the persisted update state, tolerating a missing or corrupt file.
 * @returns {{ dismissedVersion?: string }}
 */
function readUpdateState () {
  try {
    const parsed = JSON.parse(fs.readFileSync(updateStatePath(), 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Persist the update state atomically (temp file + rename), tolerating
 * failures — update bookkeeping must never break the app.
 * @param {{ dismissedVersion?: string }} state
 */
function writeUpdateState (state) {
  try {
    const target = updateStatePath()
    const tmp = `${target}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state))
    fs.renameSync(tmp, target)
  } catch (err) {
    console.error('[desktop] failed to persist update state:', err.message)
  }
}

/**
 * Where the update check looks for the electron-builder latest.yml feed.
 * Defaults to this repo's GitHub Releases; DSH_UPDATE_FEED overrides with a
 * full feed URL or a directory base (the per-platform filename is appended),
 * and disables the check when set to `off`/`false`/`0`. Linux has no
 * installer in the MVP, so the check is disabled there.
 * @returns {string | null}
 */
function updateFeedUrl () {
  if (process.platform === 'linux') return null
  const file = process.platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml'
  const raw = process.env.DSH_UPDATE_FEED?.trim()
  if (raw) {
    if (/^(0|off|false|disabled)$/i.test(raw)) return null
    const base = raw.replace(/\/+$/, '')
    return /\.ya?ml$/i.test(base) ? base : `${base}/${file}`
  }
  return `https://github.com/pycjava/dsh-desktop/releases/latest/download/${file}`
}

/**
 * electron-updater's generic provider takes the directory serving latest.yml,
 * while DSH_UPDATE_FEED may be either a full feed URL or a directory base;
 * strip the feed filename when present.
 * @param {string} feedUrl
 * @returns {string}
 */
function genericFeedBase (feedUrl) {
  return feedUrl.replace(/\/[^/]+\.ya?ml$/i, '')
}

/**
 * Send the full dialog state to the update page; a no-op when no dialog is
 * open. Everything travels as one payload so the page is a pure renderer.
 */
function pushUpdateState () {
  if (!updateWin || !updateInfo) return
  updateWin.webContents.send('update:state', {
    mode: updateMode,
    phase: updatePhase,
    currentVersion: app.getVersion(),
    version: updateInfo.version,
    url: updateInfo.url ?? null,
    progress: updateProgress,
    error: updateError,
  })
}

/**
 * Open the small frameless "new version" dialog over the main window. Its
 * content depends on the flow: on Windows it walks prompt → downloading →
 * downloaded/error (driving electron-updater); on macOS it only links to the
 * browser download page.
 */
function showUpdateDialog () {
  if (updateWin && !updateWin.isDestroyed()) {
    updateWin.focus()
    pushUpdateState()
    return
  }
  updateWin = new BrowserWindow({
    width: 460,
    height: 250,
    parent: win ?? undefined,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151517' : '#ffffff',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'update-preload.cjs'),
    },
  })
  updateWin.loadFile(path.join(__dirname, 'update.html'))
  updateWin.on('closed', () => {
    updateWin = null
    // Closing the dialog mid-download cancels it: the user no longer sees or
    // controls the transfer, so it must not keep running in the background.
    if (updatePhase === 'downloading' && downloadCt) downloadCt.cancel()
  })
}

/**
 * Create and wire the electron-updater handle (packaged Windows only). The
 * installer's publish config ships as resources/app-update.yml and is the
 * default feed; a DSH_UPDATE_FEED override swaps in a generic provider so the
 * full flow can be tested against any static file host. Downloads and
 * installs stay user-driven: autoDownload and autoInstallOnAppQuit are off.
 * @param {string | null} overrideBase generic feed base URL, or null for the
 * packaged default
 * @returns {import('electron-updater').AppUpdater}
 */
function setupAutoUpdater (overrideBase) {
  if (autoUpdater) return autoUpdater
  const updater = require('electron-updater').autoUpdater
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  // allowPrerelease auto-enables when the running version is itself a
  // prerelease (electron-updater default), so rc installs track rc feeds and
  // future stable installs only see stable releases — no config needed.
  if (overrideBase) updater.setFeedURL({ provider: 'generic', url: overrideBase })
  updater.on('download-progress', (progress) => {
    if (updatePhase !== 'downloading') return
    updateProgress = {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    }
    pushUpdateState()
  })
  updater.on('update-downloaded', (info) => {
    downloadedUpdate = { version: info.version }
    if (updateWin) {
      updatePhase = 'downloaded'
      pushUpdateState()
    }
  })
  updater.on('error', (err) => {
    console.error('[desktop] update error:', err?.message ?? err)
    if (updateWin && updatePhase === 'downloading') {
      updatePhase = 'error'
      updateError = String(err?.message ?? err)
      pushUpdateState()
    }
  })
  autoUpdater = updater
  return updater
}

/**
 * Begin (or retry) the update download. Only reachable from the dialog's
 * download/retry buttons; concurrent starts are suppressed while one is in
 * flight, and a completed download is never restarted.
 */
function startUpdateDownload () {
  if (!autoUpdater || downloadedUpdate || downloadCt) return
  const { CancellationToken } = require('electron-updater')
  downloadCt = new CancellationToken()
  updatePhase = 'downloading'
  updateProgress = null
  updateError = null
  pushUpdateState()
  autoUpdater.downloadUpdate(downloadCt)
    .catch((err) => {
      console.error('[desktop] update download failed:', err?.message ?? err)
      // The updater's own 'error' event drives the dialog; this is the
      // fallback for rejections it does not surface.
      if (updateWin && updatePhase === 'downloading') {
        updatePhase = 'error'
        updateError = String(err?.message ?? err)
        pushUpdateState()
      }
    })
    .finally(() => {
      downloadCt = null
    })
}

/**
 * One update check per launch (no time throttle — the dialog's "not now"
 * already suppresses re-prompting for that version). Packaged Windows uses
 * electron-updater and drives download/install from the dialog; macOS keeps
 * the feed check that links to the browser download page; dev runs are
 * skipped unless DSH_UPDATE_DEV is set (and even then the auto flow needs a
 * packaged app, so dev Windows only exercises the browser flow). Any failure
 * is logged and silent — update checking never affects boot or the UI.
 */
async function maybeCheckForUpdates () {
  if (updateCheckRunning) return
  if (!app.isPackaged && !process.env.DSH_UPDATE_DEV) return
  const feedUrl = updateFeedUrl()
  if (!feedUrl) return
  updateCheckRunning = true
  try {
    const state = readUpdateState()
    const useAuto = app.isPackaged && process.platform === 'win32'
    if (useAuto) {
      // Only an explicit DSH_UPDATE_FEED override replaces the packaged
      // app-update.yml feed (the returned URL already carries it).
      const override = process.env.DSH_UPDATE_FEED?.trim()
      const updater = setupAutoUpdater(override ? genericFeedBase(feedUrl) : null)
      const result = await updater.checkForUpdates()
      const version = result?.updateInfo?.version
      if (version && compareVersions(version, app.getVersion()) > 0 && version !== state.dismissedVersion) {
        updateMode = 'auto'
        updateInfo = { version }
        updatePhase = 'prompt'
        showUpdateDialog()
      }
    } else {
      const update = await checkForUpdate({ currentVersion: app.getVersion(), feedUrl })
      if (update && update.version !== state.dismissedVersion) {
        updateMode = 'browser'
        updateInfo = { version: update.version, url: update.url }
        updatePhase = 'prompt'
        showUpdateDialog()
      }
    }
  } catch (err) {
    console.error('[desktop] update check failed:', err?.message ?? err)
  } finally {
    updateCheckRunning = false
  }
}

/** Open the window at once; the backend boot starts once the boot page signals ready. */
async function boot () {
  createWindow()
  // The update check runs detached from backend boot: it never blocks a step
  // and its failures never surface to the boot page.
  void maybeCheckForUpdates()
}

app.whenReady().then(boot)

app.on('window-all-closed', () => {
  killBackend()
  app.quit()
})

app.on('before-quit', (event) => {
  killBackend()
  // A downloaded-but-uninstalled update gets one explicit question at quit:
  // installs only ever happen with the user's consent, and once answered this
  // session never asks again (re-entrant quits pass straight through).
  if (!downloadedUpdate || !autoUpdater || skipQuitInstallPrompt) return
  event.preventDefault()
  skipQuitInstallPrompt = true
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    title: 'DeepSeek Harness',
    message: `新版本 ${downloadedUpdate.version} 已下载完成，退出时安装吗？`,
    detail: '安装完成后应用会自动重新启动。',
    buttons: ['退出并安装更新', '直接退出'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (choice === 0) {
    // Silent install + force-run-after: no wizard, app relaunches into the
    // new version.
    autoUpdater.quitAndInstall(true, true)
  } else {
    app.quit()
  }
})
