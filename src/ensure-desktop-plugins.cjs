// @ts-check
/**
 * Ensure the desktop-bundled dsh plugins are enabled in the web profile.
 *
 * dsh plugins are profile bundles: npm packages whose manifest declares
 * `dsh.bundle.patch`. The desktop build adds them to the backend closure
 * (resources/backend in packaged builds, dist-desktop/backend in dev) and
 * lists them in backend/desktop-plugins.json. On first launch we make sure
 * $DSH_HOME/profiles/web/package.json includes those bundle names so users
 * get the plugins without installing pnpm or running `dsh plugin add`.
 *
 * We only add missing names and never remove user-configured bundles, so an
 * existing profile keeps its own customizations. The backend itself already
 * creates the profile when missing; this module only pre-seeds the manifest
 * so the desktop bundles are part of that first boot.
 */
'use strict'

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

/** The web profile every desktop boot uses. */
const WEB_PROFILE = 'web'
/** Default dsh web profile bundle stack, kept in sync with @deepseek-ai/dsh-app-boot. */
const DEFAULT_WEB_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
]

/**
 * Expand a leading `~` the way @deepseek-ai/dsh-home-paths does. `path.resolve`
 * on Windows does not expand tilde on its own.
 */
function expandHome (candidate) {
  if (candidate === '~') return os.homedir()
  if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    return path.join(os.homedir(), candidate.slice(2))
  }
  return candidate
}

/** Resolve the DSH_HOME this backend will use. */
function resolveDshHome () {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(expandHome(fromEnv.trim()))
  return path.join(os.homedir(), '.dsh')
}

/**
 * Write via temp file + rename so a concurrently running dsh CLI or editor
 * never observes a torn partial manifest (rename replaces atomically).
 * @param {string} file
 * @param {string} content
 */
function writeFileAtomic (file, content) {
  const temp = `${file}.dsh-tmp-${process.pid}`
  fs.writeFileSync(temp, content)
  try {
    fs.renameSync(temp, file)
  } catch (err) {
    fs.rmSync(temp, { force: true })
    throw err
  }
}

/**
 * Create the files dsh-app-boot's initProfile would create, but only when
 * they are absent. The backend writes the root cordis.yml itself; these two
 * optional files are part of the normal profile layout.
 */
function ensureProfileScaffold (profileDir) {
  fs.mkdirSync(profileDir, { recursive: true })
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  if (!fs.existsSync(patchPath)) {
    fs.writeFileSync(patchPath, '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n[]\n')
  }
  const workspacePath = path.join(profileDir, 'pnpm-workspace.yaml')
  if (!fs.existsSync(workspacePath)) {
    fs.writeFileSync(workspacePath, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  }
}

/**
 * Read the desktop plugin manifest from the staged backend closure.
 * @param {string} backendRoot
 * @returns {string[]}
 */
function readDesktopBundles (backendRoot) {
  const manifestPath = path.join(backendRoot, 'desktop-plugins.json')
  if (!fs.existsSync(manifestPath)) return []
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const bundles = manifest.bundles
  if (!Array.isArray(bundles)) throw new Error(`desktop-plugins.json at ${manifestPath} has no bundles array`)
  return bundles
}

/**
 * Make the web profile manifest carry every desktop-bundled plugin. Called
 * before the backend spawns; throws on failure so the boot page can surface it.
 * @param {string} backendRoot the staged/packaged backend closure directory
 */
function ensureDesktopPlugins (backendRoot) {
  const desktopBundles = readDesktopBundles(backendRoot)
  if (desktopBundles.length === 0) return

  const dshHome = resolveDshHome()
  const profileDir = path.join(dshHome, 'profiles', WEB_PROFILE)
  const manifestPath = path.join(profileDir, 'package.json')

  ensureProfileScaffold(profileDir)

  let manifest
  if (!fs.existsSync(manifestPath)) {
    manifest = {
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...DEFAULT_WEB_BUNDLES, ...desktopBundles] } },
    }
    writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    return
  }

  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`profile manifest ${manifestPath} must hold a JSON object`)
  }

  const existing = Array.isArray(manifest.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles
    : []
  const missing = desktopBundles.filter((name) => !existing.includes(name))
  if (missing.length === 0) return

  manifest.dsh = {
    ...manifest.dsh,
    profile: {
      ...manifest.dsh?.profile,
      bundles: existing.length === 0 ? [...DEFAULT_WEB_BUNDLES, ...missing] : [...existing, ...missing],
    },
  }
  writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}

module.exports = { ensureDesktopPlugins }
