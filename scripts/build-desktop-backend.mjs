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
 * run when the host matches the target. Output: dist-desktop/backend.
 *
 * Pipeline: npm ci (target os/cpu, scripts ignored) -> promote CLI package ->
 * assert frontend dist -> prune runtime-dead files and non-target binaries ->
 * assert target binaries -> verify standalone run (native platform only).
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
import http from 'node:http'
import { existsSync, statSync } from 'node:fs'
import { chmod, cp, readdir, rm, rmdir } from 'node:fs/promises'
import { join, resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Committed registry manifest (package.json + package-lock.json) defining the closure. */
const MANIFEST_DIR = resolve(root, 'backend')
/** Flat closure output directory. */
const STAGING = resolve(root, 'dist-desktop', 'backend')
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
  for (const file of ['package.json', 'package-lock.json']) {
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
  const ptyAddons = platform === 'win32'
    ? ['pty.node', 'conpty.node', 'conpty_console_list.node']
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
 * Spawn the staged backend and confirm it serves the UI (HTTP 200) on a
 * loopback port. This is the go/no-go check for the whole packaging route.
 * Cross-platform/arch builds skip it: the boot path dlopens target-arch
 * addons (koffi backs JSONL durability from first write), which cannot load
 * under a host node of another platform/architecture; assertTargetBinaries
 * covers those builds.
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
  console.log('build-desktop-backend: verifying standalone run...')
  const READY = /http:\/\/127\.0\.0\.1:(\d+)/
  await new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, [entry, 'web', '--port', '0'], {
      cwd: STAGING, stdio: ['ignore', 'pipe', 'inherit'],
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
      const port = Number(m[1])
      poll(port).then(() => {
        settled = true
        clearTimeout(timer)
        child.kill('SIGTERM')
        console.log(`build-desktop-backend: OK — backend served UI on :${port}`)
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
}

/** Poll GET / until 200 or the deadline. */
function poll(port) {
  const deadline = Date.now() + 30_000
  return new Promise((resolveP, rejectP) => {
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
        res.resume()
        if (res.statusCode === 200) return resolveP()
        if (Date.now() > deadline) return rejectP(new Error('backend did not return 200 in 30s'))
        setTimeout(tick, 200)
      })
      req.on('error', () => {
        if (Date.now() > deadline) return rejectP(new Error('backend unreachable before deadline'))
        setTimeout(tick, 200)
      })
    }
    tick()
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
  await pruneRuntimeDeadWeight(platform, arch)
  assertTargetBinaries(platform, arch)
  if (platform === 'darwin') await ensureDarwinHelperExecutable(arch)
  await verifyRun(platform, arch)
  report()
  console.log(`build-desktop-backend: closure file count: ${await countFiles(STAGING)}`)
  console.log('build-desktop-backend: done.')
}

await main()
