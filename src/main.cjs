// @ts-check
/**
 * Electron main process for the DeepSeek Harness desktop shell.
 *
 * The shell spawns the `dsh web` backend (node:http on a loopback port chosen
 * by the OS via `--port 0`), reads the printed readiness URL from stdout, then
 * loads it in a BrowserWindow. The Web UI is same-origin with its backend, so
 * the full HTTP + WebSocket transport and trust perimeter are reused with no
 * protocol changes.
 *
 * CommonJS is deliberate: the main process only needs `electron` plus Node
 * built-ins and never imports other packages, so staying CJS sidesteps
 * ESM-main-process version pitfalls. This package is private and unpublished.
 */
'use strict'

const { app, BrowserWindow, shell, nativeTheme, ipcMain, dialog } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const { ensureCliShim } = require('./ensure-cli-shim.cjs')

/** Repository root (this file lives at src/main.cjs). */
const ROOT = path.resolve(__dirname, '..')
/** Registry backend staged by `pnpm run backend` (scripts/build-desktop-backend.mjs). */
const STAGED_BACKEND = path.join(ROOT, 'dist-desktop', 'backend')
/** Matches the `dsh web: http://127.0.0.1:<port>` readiness line. */
const READY_RE = /http:\/\/127\.0\.0\.1:(\d+)/

const HEALTH_TIMEOUT_MS = 30_000
const HEALTH_INTERVAL_MS = 200

/** @type {import('node:child_process').ChildProcess | null} */
let backend = null
/** @type {Electron.BrowserWindow | null} */
let win = null
let quitting = false
/** Node executable resolved by checkNode(); backendSpec spawns this. */
let nodeCmd = 'node'

// Title-bar controls: the custom title bar is injected into the renderer by
// preload.cjs and calls back over these channels.
ipcMain.on('win:minimize', () => win?.minimize())
ipcMain.on('win:toggle-maximize', () => {
  if (!win) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
})
ipcMain.on('win:close', () => win?.close())

/**
 * Resolve how to launch the backend. Packaged: run lib/bin.js from
 * resources/backend under the user's Node. Dev: with `DSH_SOURCE_REPO` set,
 * run that dsh checkout's source CLI via tsx (debugging harness changes);
 * otherwise run the staged registry backend — the exact closure the installer
 * ships.
 * @returns {{ cwd: string, cmd: string, args: string[] }}
 */
function backendSpec () {
  if (app.isPackaged) {
    const backendRoot = path.join(process.resourcesPath, 'backend')
    return { cwd: backendRoot, cmd: nodeCmd, args: [path.join(backendRoot, 'lib', 'bin.js'), 'web', '--port', '0'] }
  }
  const sourceRepo = process.env.DSH_SOURCE_REPO
  if (sourceRepo) {
    const cliBin = path.join(sourceRepo, 'apps', 'cli', 'src', 'bin.ts')
    if (!fs.existsSync(cliBin)) {
      throw new Error(`DSH_SOURCE_REPO points at ${sourceRepo}, which has no ${cliBin}`)
    }
    return { cwd: sourceRepo, cmd: nodeCmd, args: ['--import', 'tsx/esm', cliBin, 'web', '--port', '0'] }
  }
  const entry = path.join(STAGED_BACKEND, 'lib', 'bin.js')
  if (!fs.existsSync(entry)) {
    throw new Error(`backend not staged at ${entry}; run "pnpm run backend" first, or set DSH_SOURCE_REPO to a dsh checkout`)
  }
  return { cwd: STAGED_BACKEND, cmd: nodeCmd, args: [entry, 'web', '--port', '0'] }
}

const MIN_NODE_MAJOR = 22

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
 * otherwise `node` on PATH wins (previous behavior), then macOS-only standard
 * locations, then the login shell PATH.
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

  return {
    cmd: null,
    version: null,
    error: 'Could not find Node.js on PATH. Install Node.js >= 22.19 (https://nodejs.org) and relaunch DeepSeek Harness. On macOS, set DSH_NODE to your node binary if it lives outside the standard locations.',
  }
}

/**
 * Verify the user's Node satisfies the backend's minimum and remember the
 * resolved executable for backendSpec(). Returns an error message to surface
 * (and quit) or null when acceptable.
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
 * once its readiness URL is printed.
 * @returns {Promise<number>} the resolved port
 */
function startBackend () {
  return new Promise((resolve, reject) => {
    // Use the user's standalone Node (resolved by checkNode), not Electron's
    // bundled node, so the backend runs under a real, project-supported Node
    // version.
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
    const fail = (msg) => {
      if (!settled) {
        settled = true
        reject(new Error(msg))
      }
    }

    const onStdout = (chunk) => {
      const text = chunk.toString()
      process.stdout.write(`[dsh] ${text}`)
      if (settled) return
      const match = READY_RE.exec(text)
      if (match) {
        settled = true
        resolve(Number(match[1]))
      }
    }
    backend.stdout.on('data', onStdout)
    backend.stderr.on('data', (chunk) => process.stderr.write(`[dsh] ${chunk}`))

    backend.on('error', (err) => fail(`failed to spawn backend: ${err.message}`))
    backend.on('exit', (code) => {
      if (!settled && !quitting) {
        fail(`backend exited before becoming ready (code ${code})`)
      }
    })
  })
}

/**
 * Poll `GET /` until it answers 200, or reject once the deadline passes.
 * @param {number} port
 * @returns {Promise<void>}
 */
function waitForReady (port) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
        res.resume()
        if (res.statusCode === 200) return resolve()
        if (Date.now() > deadline) return reject(new Error('backend did not return 200 in time'))
        setTimeout(tick, HEALTH_INTERVAL_MS)
      })
      req.on('error', () => {
        if (Date.now() > deadline) return reject(new Error('backend unreachable before deadline'))
        setTimeout(tick, HEALTH_INTERVAL_MS)
      })
    }
    tick()
  })
}

/**
 * @param {number} port
 */
function createWindow (port) {
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
  win.loadURL(`http://127.0.0.1:${port}/`)

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
function killBackend () {
  if (!backend) return
  quitting = true
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

async function boot () {
  const nodeError = checkNode()
  if (nodeError) {
    await dialog.showMessageBox({ type: 'error', title: 'Node.js required', message: nodeError })
    app.quit()
    return
  }
  try {
    const port = await startBackend()
    await waitForReady(port)
    createWindow(port)
    // Expose this install's backend as the `dsh` CLI: rewrite the ~/.dsh/bin
    // shims (they track this install dir, so upgrades self-heal) and repair
    // the user PATH entry. Fire-and-forget: the CLI is a convenience, never
    // a startup dependency.
    if (app.isPackaged && process.platform === 'win32') {
      ensureCliShim(path.join(process.resourcesPath, 'backend'))
        .catch((err) => console.error('[desktop] dsh CLI shim refresh failed:', err.message))
    }
  } catch (err) {
    console.error('[desktop] startup failed:', err.message)
    killBackend()
    app.quit()
  }
}

app.whenReady().then(boot)

app.on('window-all-closed', () => {
  killBackend()
  app.quit()
})

app.on('before-quit', killBackend)
