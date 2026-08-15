#!/usr/bin/env node
/**
 * One-shot desktop installer build for one Windows architecture: stage the
 * backend closure, then run electron-builder for the same architecture.
 *
 * Usage: node scripts/build-desktop-installer.mjs [--arch x64|arm64]
 * Artifacts land in dist-desktop/release/<arch>/ (installer + win-unpacked).
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** electron-builder reads its config (electron-builder.yml) at the repo root. */
const APP_DIR = root
/** Windows CPU architectures Electron 43 publishes installers for. */
const ARCHES = ['x64', 'arm64']

const argv = process.argv.slice(2)
const archIdx = argv.indexOf('--arch')
const arch = archIdx >= 0 ? argv[archIdx + 1] : 'x64'
if (!ARCHES.includes(arch)) throw new Error(`unknown --arch ${arch}; expected one of ${ARCHES.join(', ')}`)

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

console.log(`build-desktop-installer: building win32-${arch} installer`)
await run('backend closure', process.execPath, [
  resolve(root, 'scripts', 'build-desktop-backend.mjs'),
  '--arch', arch,
])
await run('electron-builder', process.execPath, [
  electronBuilderCli(),
  '--win', 'nsis', `--${arch}`,
  `--config.directories.output=${resolve(root, 'dist-desktop', 'release', arch)}`,
], APP_DIR)
console.log(`build-desktop-installer: done — dist-desktop/release/${arch}/`)
