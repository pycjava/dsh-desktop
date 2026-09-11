#!/usr/bin/env node
/**
 * Build the self-contained backend closure for the desktop app from the
 * published npm registry packages.
 *
 * The closure is owned by backend/ (a committed dependency manifest + lockfile
 * pinning @deepseek-ai/dsh). This script materializes it with `npm ci`
 * narrowed to one target platform/CPU architecture, promotes the CLI package
 * to the staging root — the layout the desktop shell launches: `node
 * lib/bin.js` with `node_modules` beside it — prunes what the backend never
 * loads, asserts the target platform's binaries, and verifies the standalone
 * run when the host matches the target. It also stages the pinned standalone
 * Node runtime the installer bundles (resources/node), so users never need a
 * pre-installed Node. Output: dist-desktop/backend + dist-desktop/node-runtime.
 *
 * Pipeline: npm ci (target os/cpu, scripts ignored) -> promote CLI package ->
 * assert frontend dist -> assert desktop plugins -> prune runtime-dead files and
 * non-target binaries -> assert target binaries -> stage the bundled Node runtime -> verify the
 * standalone run under that exact runtime with a fresh DSH_HOME (native
 * platform only).
 *
 * Install-time platform filtering stages only the target's platform-optional
 * leaves (sharp's `@img/*` and koffi's `@koromix/*` declare os/cpu). node-pty
 * ships one tarball carrying every platform's `prebuilds/`, so its foreign
 * entries are pruned here. `--ignore-scripts` is load-bearing: koffi's cnoke
 * postinstall builds from source when allowed and fails on a cross-arch host,
 * while the prebuilt leaves make every install script in this closure
 * unnecessary.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs'
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Committed registry manifest (package.json + package-lock.json) defining the closure. */
const MANIFEST_DIR = resolve(root, 'backend')
/** Flat closure output directory. */
const STAGING = resolve(root, 'dist-desktop', 'backend')
/** Bundled standalone Node runtime output (extraResources `node`), one binary. */
const NODE_STAGING = resolve(root, 'dist-desktop', 'node-runtime')
/**
 * Official Node the installer bundles so the backend never depends on a
 * user-installed Node. The backend's closure (notably HMR's
 * node-addon-require-builtin) requires a real Node build: it refuses to run
 * under Electron's embedded Node, so a separate runtime must ship.
 */
const NODE_VERSION = '24.19.0'
/** Mirror override for downloading node archives (e.g. corporate or regional mirrors). */
const NODE_DIST_BASE = (process.env.DSH_NODE_DIST_MIRROR || 'https://nodejs.org/dist').replace(/\/+$/, '')
/**
 * Checksums always come from official nodejs.org: a mirror may serve the
 * archive, but never the sums that vouch for it — a compromised mirror must
 * not be able to forge both sides of the verification.
 */
const NODE_OFFICIAL_DIST = 'https://nodejs.org/dist'
/** Archive cache so repeat builds re-fetch nothing; hash-verified on every use. */
const NODE_CACHE = resolve(root, 'dist-desktop', 'cache')
/** Backend entry, at the staging root after the CLI package is promoted. */
const ENTRY = join('lib', 'bin.js')
/** Registry package the promoted CLI is copied from. */
const CLI_PACKAGE = join('node_modules', '@deepseek-ai', 'dsh')
/** Frontend dist must ship inside the registry closure (asserted, never copied). */
const FRONTEND_DIST = join('node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
/** Platforms the desktop installers target (Electron 43 publishes installers for these). */
const PLATFORMS = ['win32', 'darwin']
/** CPU architectures Electron 43 publishes installers for. */
const ARCHES = ['x64', 'arm64']

const npmBin = () => (process.platform === 'win32' ? 'npm.cmd' : 'npm')

/**
 * Run one subprocess with inherited stdio; reject on non-zero exit.
 * @param {string} label
 * @param {string} command
 * @param {string[]} args
 * @param {string} [cwd]
 */
function run(label, command, args, cwd = root) {
  const printable = [command, ...args].map((p) => (p.includes(' ') ? JSON.stringify(p) : p)).join(' ')
  console.log(`build-desktop-backend: ${label}: ${printable}`)
  return new Promise((resolveP, rejectP) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: 'true' }, shell: process.platform === 'win32' })
    child.once('error', (err) => rejectP(new Error(`${label} failed to spawn: ${err.message}`)))
    child.once('exit', (code, signal) => {
      if (code === 0) return resolveP()
      rejectP(new Error(`${label} failed (${code === null ? `signal ${signal}` : `exit ${code}`})`))
    })
  })
}

/**
 * Copy the committed manifest into a cleared staging directory and install the
 * closure for one target platform/architecture. The lockfile makes the install
 * reproducible; `--cpu` and `--os` leave platform-optional packages of other
 * targets unstaged.
 * @param {string} platform target OS (`win32` | `darwin`)
 * @param {string} arch target CPU architecture
 */
async function installStaging(platform, arch) {
  if (STAGING === root || root.startsWith(STAGING + sep)) {
    throw new Error(`refusing to clear staging ${STAGING}: contains repo root`)
  }
  console.log(`build-desktop-backend: clearing ${STAGING}`)
  await rm(STAGING, { recursive: true, force: true })
  const pluginsSrc = resolve(root, 'plugins')
  const stagedPlugins = resolve(root, 'dist-desktop', 'plugins')
  await rm(stagedPlugins, { recursive: true, force: true })
  await mkdir(resolve(root, 'dist-desktop'), { recursive: true })
  if (existsSync(pluginsSrc)) await cp(pluginsSrc, stagedPlugins, { recursive: true })
  for (const file of ['package.json', 'package-lock.json', 'desktop-plugins.json']) {
    await cp(join(MANIFEST_DIR, file), join(STAGING, file))
  }
  await run('install', npmBin(), [
    'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
    `--os=${platform}`, `--cpu=${arch}`,
  ], STAGING)
}

/**
 * Promote the registry CLI package to the staging root so the closure keeps
 * the `lib/bin.js` + `node_modules` layout the desktop shell launches.
 */
async function promoteCliPackage() {
  const src = join(STAGING, CLI_PACKAGE)
  if (!existsSync(join(src, ENTRY))) {
    throw new Error(`registry CLI package missing ${ENTRY}; cannot promote`)
  }
  const nested = join(src, 'node_modules')
  await cp(src, STAGING, {
    recursive: true, dereference: true,
    filter: (p) => p !== nested && !p.startsWith(nested + sep),
  })
  console.log('build-desktop-backend: promoted registry CLI package to staging root')
}

/**
 * Fail loud when the registry closure stops shipping the web frontend dist:
 * `dsh web` serves it from the installed dsh-web-frontend package.
 */
async function assertFrontendDist() {
  if (!existsSync(join(STAGING, FRONTEND_DIST))) {
    throw new Error(`frontend dist missing at ${FRONTEND_DIST}; registry closure incomplete`)
  }
  console.log('build-desktop-backend: frontend dist present in closure')
}

/**
 * Fail loud when a desktop-bundled plugin is missing or no longer declares a
 * dsh bundle patch. The desktop shell relies on these packages being present
 * in the backend closure and listed in backend/desktop-plugins.json.
 */
async function assertDesktopPlugins() {
  const manifest = JSON.parse(await readFile(join(STAGING, 'desktop-plugins.json'), 'utf8'))
  const bundles = manifest.bundles
  if (!Array.isArray(bundles) || bundles.length === 0) {
    throw new Error('desktop-plugins.json must list at least one bundle')
  }
  for (const packageName of bundles) {
    const packageDir = join(STAGING, 'node_modules', ...packageName.split('/'))
    const manifestPath = join(packageDir, 'package.json')
    if (!existsSync(manifestPath)) {
      throw new Error(`desktop plugin ${JSON.stringify(packageName)} missing at ${manifestPath}; npm ci did not stage the plugin closure`)
    }
    const plugin = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (!plugin.dsh?.bundle?.patch) {
      throw new Error(`desktop plugin ${JSON.stringify(packageName)} declares no dsh.bundle.patch in its package.json`)
    }
    console.log(`build-desktop-backend: desktop plugin ${packageName} staged (${plugin.version ?? 'unknown'})`)
  }
}

/** Windows-version-scoped binary dirs, e.g. node-pty's conpty `win10-arm64`. */
const WINDOWS_CPU_DIR = /^win1[01]-(x64|arm64|ia32)$/i

/**
 * Delete files the backend never loads at runtime: source maps, TypeScript
 * declarations, tsbuildinfo artifacts, non-license docs, Windows debug symbols,
 * and every binary built for another platform/architecture inside
 * single-tarball packages (prebuildify dirs like node-pty's
 * `prebuilds/<platform>-<arch>`, Windows-version-scoped dirs like node-pty's
 * conpty `win10-arm64`). The Windows installer writes files one by one through
 * Defender's real-time scan, so every dead file multiplies install time.
 * Platform-optional leaf packages need no pruning here: install-time `--os`
 * and `--cpu` filtering never stages them. `.ts` sources stay: Node >=22.19
 * type-stripping keeps them runtime-loadable, and no blanket rule separates
 * shipped-source packages from dead weight.
 * @param {string} platform target OS (`win32` | `darwin`)
 * @param {string} arch target CPU architecture
 * @returns {Promise<void>}
 */
async function pruneRuntimeDeadWeight(platform, arch) {
  const FILE = /\.(map|d\.ts|tsbuildinfo|pdb)$/i
  const DOC = /\.md$/i
  const KEPT_DOC = /(licen[cs]e|notice|copying|third[-_]party)/i
  const target = `${platform}-${arch}`
  let removed = 0
  let foreign = 0
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'prebuilds') {
          for (const child of await readdir(p, { withFileTypes: true }).catch(() => [])) {
            if (child.name === target) continue
            await rm(join(p, child.name), { recursive: true, force: true })
            foreign++
          }
        } else if (WINDOWS_CPU_DIR.test(entry.name)) {
          const isTargetWindowsCpuDir = platform === 'win32' && (
            entry.name.toLowerCase() === `win10-${arch}` ||
            entry.name.toLowerCase() === `win11-${arch}`
          )
          if (!isTargetWindowsCpuDir) {
            await rm(p, { recursive: true, force: true })
            foreign++
            continue
          }
        }
        await walk(p)
        // Drop directories pruning emptied (e.g. a types/ dir holding only
        // d.ts). Only ENOTEMPTY and access-denied refusals reach this catch.
        await rmdir(p).catch(() => {})
      } else if (FILE.test(entry.name) || (DOC.test(entry.name) && !KEPT_DOC.test(entry.name))) {
        await rm(p, { force: true })
        removed++
      }
    }
  }
  await walk(STAGING)
  console.log(`build-desktop-backend: pruned ${removed} runtime-dead files (maps, declarations, build-info, docs, debug symbols) and ${foreign} foreign-architecture entries (target ${target})`)
}

/**
 * Fail loud when the closure lacks the target platform/architecture's loadable
 * binaries. Each family is optional at the dependency-graph level, so a
 * missing family is fine; a family present without its <platform>-<arch>
 * variant means the install or prune staged dead binaries.
 * @param {string} platform target OS (`win32` | `darwin`)
 * @param {string} arch target CPU architecture
 * @returns {void}
 */
function assertTargetBinaries(platform, arch) {
  const target = `${platform}-${arch}`
  const ptyDir = join(STAGING, 'node_modules', 'node-pty', 'prebuilds', target)
  // node-pty 1.2.0-beta.15 (pulled in by @deepseek-ai/dsh rc.7) dropped the
  // legacy win32 pty.node/winpty prebuilds and ships ConPTY only.
  const ptyAddons = platform === 'win32'
    ? ['conpty.node', 'conpty_console_list.node']
    : ['pty.node', 'spawn-helper']
  for (const addon of ptyAddons) {
    if (!existsSync(join(ptyDir, addon))) {
      throw new Error(`node-pty ${target} prebuild missing ${addon}; install did not stage target binaries`)
    }
  }
  const leafFamilies = [
    ['sharp', join('node_modules', '@img', `sharp-${target}`)],
    ['koffi', join('node_modules', '@koromix', `koffi-${target}`)],
  ]
  for (const [name, leaf] of leafFamilies) {
    if (existsSync(join(STAGING, 'node_modules', name)) && !existsSync(join(STAGING, leaf))) {
      throw new Error(`${name} ships without its ${target} platform package`)
    }
  }
}

/**
 * node-pty's darwin prebuild tarball ships `spawn-helper` mode 0644, but the
 * native addon posix_spawns it on the first terminal fork. Make it executable
 * so the packaged backend works without running node-pty's install scripts.
 * @param {string} arch target CPU architecture
 * @returns {Promise<void>}
 */
async function ensureDarwinHelperExecutable(arch) {
  const helper = join(STAGING, 'node_modules', 'node-pty', 'prebuilds', `darwin-${arch}`, 'spawn-helper')
  await chmod(helper, 0o755)
  console.log('build-desktop-backend: marked node-pty spawn-helper executable')
}

/**
 * Run a short subprocess without a shell (args pass through CreateProcess /
 * posix_spawn untouched, so paths with spaces need no quoting games) and
 * report success plus captured stderr.
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<{ ok: boolean, why: string }>}
 */
function execOk(command, args) {
  return new Promise((resolveP) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.once('error', (err) => resolveP({ ok: false, why: err.message }))
    child.once('exit', (code) => resolveP({ ok: code === 0, why: code === 0 ? '' : stderr.trim() || `exit ${code}` }))
  })
}

/** @param {string} file @returns {Promise<string>} hex sha256 */
async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** @param {string} url @param {string} dest */
async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

/** Recursive first match by file name; the archives' inner layout is a
 * version property, not an interface, so search instead of hardcoding paths.
 * @param {string} dir @param {string} name @returns {Promise<string | null>} */
async function findFile(dir, name) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      const hit = await findFile(p, name)
      if (hit) return hit
    } else if (entry.name === name) {
      return p
    }
  }
  return null
}

/**
 * Expected sha256 for a node archive, from the version's cached
 * SHASUMS256.txt (fetched once per version, always from official nodejs.org
 * even when the archive itself comes from a mirror).
 * @param {string} fileName
 * @returns {Promise<string>}
 */
async function expectedChecksum(fileName) {
  const sumsFile = join(NODE_CACHE, `SHASUMS256.txt.v${NODE_VERSION}`)
  let text
  try {
    text = await readFile(sumsFile, 'utf8')
  } catch {
    const res = await fetch(`${NODE_OFFICIAL_DIST}/v${NODE_VERSION}/SHASUMS256.txt`)
    if (!res.ok) throw new Error(`fetching SHASUMS256.txt failed: HTTP ${res.status}`)
    text = await res.text()
    await writeFile(sumsFile, text)
  }
  const sum = text.split(/\r?\n/).find((line) => line.endsWith(` ${fileName}`))?.split(/\s+/)[0]
  if (!/^[0-9a-f]{64}$/.test(sum ?? '')) throw new Error(`SHASUMS256.txt has no entry for ${fileName}`)
  return sum
}

/**
 * Quote as a PowerShell single-quoted string literal (' escaped by doubling)
 * so archive/destination paths survive interpolation into -Command.
 * @param {string} value
 */
const psQuote = (value) => `'${value.replaceAll("'", "''")}'`

/**
 * Stage the bundled Node runtime for one target: download the official
 * archive (cache hit when the hash still matches), verify it against
 * SHASUMS256.txt, extract, and copy just the node binary to
 * dist-desktop/node-runtime — the whole content the installer ships at
 * resources/node. npm, corepack, headers and docs stay out: the backend
 * closure is preinstalled, so nothing but the binary is ever executed.
 * @param {string} platform target OS (`win32` | `darwin`)
 * @param {string} arch target CPU architecture
 */
async function stageNodeRuntime(platform, arch) {
  const archiveName = platform === 'win32'
    ? `node-v${NODE_VERSION}-win-${arch}.zip`
    : `node-v${NODE_VERSION}-darwin-${arch}.tar.gz`
  const binaryName = platform === 'win32' ? 'node.exe' : 'node'
  await mkdir(NODE_CACHE, { recursive: true })
  const archive = join(NODE_CACHE, archiveName)
  const expected = await expectedChecksum(archiveName)
  if (!existsSync(archive) || await sha256(archive) !== expected) {
    console.log(`build-desktop-backend: downloading node v${NODE_VERSION} ${platform}-${arch} (${NODE_DIST_BASE})`)
    const part = `${archive}.part`
    await download(`${NODE_DIST_BASE}/v${NODE_VERSION}/${archiveName}`, part)
    const got = await sha256(part)
    if (got !== expected) throw new Error(`node archive checksum mismatch for ${archiveName}: expected ${expected}, got ${got}`)
    await rm(archive, { force: true })
    await cp(part, archive)
    await rm(part, { force: true })
  } else {
    console.log(`build-desktop-backend: node v${NODE_VERSION} ${platform}-${arch} archive cached`)
  }

  const extractDir = await mkdtemp(join(tmpdir(), 'dsh-node-extract-'))
  try {
    const extraction = archiveName.endsWith('.zip')
      ? (process.platform === 'win32'
        ? execOk('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `Expand-Archive -LiteralPath ${psQuote(archive)} -DestinationPath ${psQuote(extractDir)} -Force`])
        : execOk('tar', ['-xf', archive, '-C', extractDir]))
      : execOk('tar', ['-xzf', archive, '-C', extractDir])
    const { ok, why } = await extraction
    if (!ok) throw new Error(`extracting ${archiveName} failed: ${why}`)
    const binary = await findFile(extractDir, binaryName)
    if (!binary) throw new Error(`extracted ${archiveName} contains no ${binaryName}`)
    await rm(NODE_STAGING, { recursive: true, force: true })
    await mkdir(NODE_STAGING, { recursive: true })
    await cp(binary, join(NODE_STAGING, binaryName))
    if (platform === 'darwin') await chmod(join(NODE_STAGING, binaryName), 0o755)
    console.log(`build-desktop-backend: staged bundled node v${NODE_VERSION} (${(statSync(join(NODE_STAGING, binaryName)).size / 1e6).toFixed(1)} MB) at ${NODE_STAGING}`)
  } finally {
    await rm(extractDir, { recursive: true, force: true })
  }
}

/**
 * Spawn the staged backend and confirm it serves the UI (HTTP 200) on a
 * loopback port. This is the go/no-go check for the whole packaging route.
 * Cross-platform/arch builds skip it: the boot path dlopens target-arch
 * addons (koffi backs JSONL durability from first write), which cannot load
 * under a host node of another platform/architecture; assertTargetBinaries
 * covers those builds. The run uses the exact bundled runtime the installer
 * ships (never the host's node) and a throwaway DSH_HOME: a fresh user
 * machine has no ~/.dsh, and the developer's own profiles can pull in
 * plugins that mask what the installer actually ships.
 * @param {string} platform target OS (`win32` | `darwin`)
 * @param {string} arch target CPU architecture
 */
async function verifyRun(platform, arch) {
  if (process.platform !== platform || process.arch !== arch) {
    console.log(`build-desktop-backend: skipping runtime verify: closure targets ${platform}-${arch}, host is ${process.platform}-${process.arch}`)
    return
  }
  const entry = join(STAGING, ENTRY)
  if (!existsSync(entry)) throw new Error(`entry ${entry} missing after install`)
  const nodeBin = join(NODE_STAGING, platform === 'win32' ? 'node.exe' : 'node')
  if (!existsSync(nodeBin)) throw new Error(`bundled node runtime missing at ${nodeBin}`)
  console.log('build-desktop-backend: verifying standalone run under the bundled node...')
  const READY = /(http:\/\/127\.0\.0\.1:\d+\S*)/
  const home = await mkdtemp(join(tmpdir(), 'dsh-verify-home-'))
  try {
    await new Promise((resolveP, rejectP) => {
      const child = spawn(nodeBin, [entry, 'web', '--port', '0', '--no-open'], {
        cwd: STAGING, stdio: ['ignore', 'pipe', 'inherit'],
        env: { ...process.env, DSH_HOME: home },
      })
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill('SIGTERM')
          rejectP(new Error('backend did not become ready in 90s'))
        }
      }, 90_000)
      child.stdout.on('data', (chunk) => {
        process.stdout.write(`[verify] ${chunk}`)
        if (settled) return
        const m = READY.exec(String(chunk))
        if (!m) return
        const url = m[1]
        poll(url).then(() => {
          settled = true
          clearTimeout(timer)
          child.kill('SIGTERM')
          console.log(`build-desktop-backend: OK — backend served UI at ${new URL(url).origin}`)
          resolveP()
        }).catch((err) => {
          settled = true
          clearTimeout(timer)
          child.kill('SIGTERM')
          rejectP(err)
        })
      })
      child.on('exit', (code) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          rejectP(new Error(`backend exited before ready (code ${code})`))
        }
      })
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

/**
 * Poll the readiness URL until it serves the UI with a 200. dsh 0.1.5+ guard
 * GET / behind a cookie session: the `?token=` query answers 303 + Set-Cookie
 * and only the cookie-authenticated follow-up returns 200, so the probe
 * replays that exchange; older versions answer 200 on / directly.
 * @param {string} url the backend's readiness URL (token query included)
 * @returns {Promise<void>}
 */
function poll(url) {
  const deadline = Date.now() + 30_000
  return new Promise((resolveP, rejectP) => {
    const tick = () => {
      probe(url)
        .then((ok) => {
          if (ok) return resolveP()
          if (Date.now() > deadline) return rejectP(new Error('backend did not return 200 in 30s'))
          setTimeout(tick, 200)
        })
        .catch(() => {
          if (Date.now() > deadline) return rejectP(new Error('backend unreachable before deadline'))
          setTimeout(tick, 200)
        })
    }
    tick()
  })
}

/**
 * GET the readiness URL and replay the redirect it answers with, carrying the
 * cookies it set. Resolves true only when the final response is a 200.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
function probe(url) {
  return new Promise((resolveP, rejectP) => {
    const req = http.get(url, (res) => {
      res.resume()
      if (res.statusCode === 200) return resolveP(true)
      const cookies = (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0])
      const location = res.headers.location
      if (!cookies.length || !location) return resolveP(false)
      const follow = http.get(new URL(location, url), { headers: { cookie: cookies.join('; ') } }, (res2) => {
        res2.resume()
        resolveP(res2.statusCode === 200)
      })
      follow.on('error', rejectP)
    })
    req.on('error', rejectP)
  })
}

/** @param {string} dir @returns {Promise<number>} */
async function countFiles(dir) {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) total += await countFiles(p)
    else total++
  }
  return total
}

function report() {
  const entry = join(STAGING, ENTRY)
  console.log(`build-desktop-backend: staging at ${STAGING} (entry ${statSync(entry).size} bytes)`)
  const nodeBin = join(NODE_STAGING, process.platform === 'win32' ? 'node.exe' : 'node')
  if (existsSync(nodeBin)) console.log(`build-desktop-backend: bundled node v${NODE_VERSION} at ${nodeBin}`)
}

async function main() {
  const argv = process.argv.slice(2)
  /**
   * @param {string} name
   * @returns {string | null}
   */
  const flag = (name) => {
    const idx = argv.lastIndexOf(`--${name}`)
    if (idx < 0) return null
    const value = argv[idx + 1]
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`)
    return value
  }
  const platform = flag('platform') ?? 'win32'
  const arch = flag('arch') ?? 'x64'
  if (!PLATFORMS.includes(platform)) throw new Error(`unknown --platform ${platform}; expected one of ${PLATFORMS.join(', ')}`)
  if (!ARCHES.includes(arch)) throw new Error(`unknown --arch ${arch}; expected one of ${ARCHES.join(', ')}`)
  console.log(`build-desktop-backend: target ${platform}-${arch}`)
  await installStaging(platform, arch)
  await promoteCliPackage()
  await assertFrontendDist()
  await assertDesktopPlugins()
  await pruneRuntimeDeadWeight(platform, arch)
  assertTargetBinaries(platform, arch)
  if (platform === 'darwin') await ensureDarwinHelperExecutable(arch)
  await stageNodeRuntime(platform, arch)
  await verifyRun(platform, arch)
  report()
  console.log(`build-desktop-backend: closure file count: ${await countFiles(STAGING)}`)
  console.log('build-desktop-backend: done.')
}

await main()
