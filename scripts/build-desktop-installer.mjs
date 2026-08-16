#!/usr/bin/env node
/**
 * One-shot desktop installer build for one target platform/architecture:
 * stage the backend closure, then run electron-builder for the same target.
 *
 * Usage:
 *   node scripts/build-desktop-installer.mjs [--platform win32|darwin] [--arch x64|arm64]
 * Artifacts land in dist-desktop/release/<platform>/<arch>/.
 *
 * Windows installers cross-build from any host. macOS DMG/ZIP builds must run
 * on macOS: electron-builder's DMG tooling uses macOS-only hdiutil.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** electron-builder reads its config (electron-builder.yml) at the repo root. */
const APP_DIR = root
/** Platforms the desktop installers target (Electron 43 publishes installers for these). */
const PLATFORMS = ['win32', 'darwin']
/** CPU architectures Electron 43 publishes installers for. */
const ARCHES = ['x64', 'arm64']

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
if (platform === 'darwin' && process.platform !== 'darwin') {
  throw new Error('macOS installers must be built on macOS (DMG creation requires hdiutil); stage the darwin backend closure with scripts/build-desktop-backend.mjs --platform darwin on any host instead')
}

/**
 * Resolve electron-builder's bin entry through this repo's dependency tree.
 * electron-builder is invoked with the host node directly, not through
 * `pnpm exec`: a package-manager dependency check may decide to reinstall the
 * tree, and packaging must never mutate the dev tree.
 * @returns {string} absolute path to the electron-builder CLI entry
 */
function electronBuilderCli() {
  const requireFromApp = createRequire(resolve(APP_DIR, 'package.json'))
  const pkg = requireFromApp('electron-builder/package.json')
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['electron-builder']
  if (!bin) throw new Error('electron-builder package.json exposes no bin entry')
  return resolve(dirname(requireFromApp.resolve('electron-builder/package.json')), bin)
}

/**
 * Run one subprocess with inherited stdio; reject on non-zero exit.
 * @param {string} label
 * @param {string} command
 * @param {string[]} args
 * @param {string} [cwd]
 */
function run(label, command, args, cwd = root) {
  const printable = [command, ...args].map((p) => (p.includes(' ') ? JSON.stringify(p) : p)).join(' ')
  console.log(`build-desktop-installer: ${label}: ${printable}`)
  return new Promise((resolveP, rejectP) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: 'true' }, shell: process.platform === 'win32' })
    child.once('error', (err) => rejectP(new Error(`${label} failed to spawn: ${err.message}`)))
    child.once('exit', (code, signal) => {
      if (code === 0) return resolveP()
      rejectP(new Error(`${label} failed (${code === null ? `signal ${signal}` : `exit ${code}`})`))
    })
  })
}

const outDir = resolve(root, 'dist-desktop', 'release', platform, arch)
console.log(`build-desktop-installer: building ${platform}-${arch} installer`)
await run('backend closure', process.execPath, [
  resolve(root, 'scripts', 'build-desktop-backend.mjs'),
  '--platform', platform,
  '--arch', arch,
])
await run('electron-builder', process.execPath, [
  electronBuilderCli(),
  ...(platform === 'win32' ? ['--win', 'nsis'] : ['--mac', 'dmg', 'zip']),
  `--${arch}`,
  `--config.directories.output=${outDir}`,
  // run() exports CI=true, which makes electron-builder attempt an implicit
  // GitHub publish and fail without GH_TOKEN. This script only ever produces
  // local artifacts, so publishing stays an explicit, separate step.
  '--publish', 'never',
], APP_DIR)
console.log(`build-desktop-installer: done — ${outDir}/`)
