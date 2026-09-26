// @ts-check
/**
 * Ensure desktop-chosen feature entries are enabled in the web profile.
 *
 * Some dsh features ship disabled upstream and are switched on per profile:
 * dsh 0.1.7 lists both scheduled reminders (`schedule`, the backend service
 * plus the agent's create/list/update/delete tools) and its browser half
 * (`ui-schedule`, the session-panel task catalog) as `disabled: true`
 * entries inside dsh-web-app's bundle patch. The Web UI's plugin page flips
 * them by appending id-targeted overrides to the profile's cordis.patch.yml —
 * the layer applied after every bundle, so an override always wins.
 *
 * The desktop is a curated distribution, so it pre-seeds those overrides the
 * same way ensure-desktop-plugins seeds plugin bundles. Like the plugin
 * manager's own writer (dsh-plugin-manager's writePluginEnabled), an existing
 * override — either direction — marks the feature as user-configured and is
 * never touched again.
 *
 * The main process deliberately has no YAML dependency, so this is a
 * conservative textual edit: overrides are detected by item-level
 * `- id: <name>` lines, and appends happen only while the document still
 * looks like a plain YAML sequence (the scaffold this shell writes).
 */
'use strict'

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

/**
 * Feature entries the desktop enables by default. `id` is the composition
 * entry id from dsh-web-app's patch; `name` is the module the entry loads.
 * Keep in sync with the disabled-by-default entries of the bundled backend.
 */
const FEATURE_DEFAULTS = [
  { id: 'schedule', name: '@deepseek-ai/dsh-schedule' },
  { id: 'ui-schedule', name: '@deepseek-ai/dsh-client-ui-schedule' },
]

/**
 * Expand a leading `~` the way @deepseek-ai/dsh-home-paths does.
 * @param {string} candidate
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

/** @param {string} trimmed a trimmed source line @returns {boolean} */
function isComment (trimmed) {
  return trimmed.length === 0 || trimmed.startsWith('#')
}

/**
 * Write via temp file + rename so a concurrently running dsh CLI or editor
 * never observes a torn partial file (rename replaces atomically).
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
 * Every non-comment line must either start a top-level sequence item (`- `),
 * continue one (leading whitespace), or be the empty-sequence placeholder
 * `[]`. A line starting with any other non-space character means the file
 * holds mapping keys or anchors this writer does not understand — leave it
 * untouched rather than guess.
 * @param {string[]} lines
 * @param {string} patchPath
 */
function assertPlainSequence (lines, patchPath) {
  for (const line of lines) {
    if (isComment(line.trim())) continue
    if (line.trim() === '[]') continue
    if (line.startsWith('-')) continue
    if (/^[ \t]/.test(line)) continue
    throw new Error(`profile patch ${patchPath} holds YAML this writer cannot extend; enable the desktop features manually`)
  }
}

/**
 * Enable every FEATURE_DEFAULTS entry that has no override yet. Called
 * before the backend spawns; anything unexpected throws so the boot page can
 * surface it instead of corrupting the user's patch layer.
 */
function ensureFeatureDefaults () {
  const profileDir = path.join(resolveDshHome(), 'profiles', 'web')
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  fs.mkdirSync(profileDir, { recursive: true })
  if (!fs.existsSync(patchPath)) {
    writeFileAtomic(patchPath, '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n[]\n')
  }

  const text = fs.readFileSync(patchPath, 'utf8')
  const lines = text.split(/\r?\n/)
  assertPlainSequence(lines, patchPath)

  /** @param {string} id @returns {boolean} an override for this id exists */
  const hasOverride = (id) => lines.some((line) =>
    new RegExp(`^\\s*-\\s*id:\\s*["']?${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*$`).test(line))

  const missing = FEATURE_DEFAULTS.filter((feature) => !hasOverride(feature.id))
  if (missing.length === 0) return

  // Drop a lone `[]` placeholder so the appended items become the sequence.
  const carriesOnlyPlaceholder = lines.filter((line) => !isComment(line.trim()))
    .every((line) => line.trim() === '[]' || line === '')
  const body = (carriesOnlyPlaceholder
    ? lines.filter((line) => line.trim() !== '[]').join('\n')
    : lines.join('\n')
  ).replace(/[ \t]+$/, '').replace(/\r?\n+$/, '')

  const append = missing.map((feature) =>
    `# Desktop default: enabled by the DeepSeek Harness shell (upstream ships it disabled).\n- id: ${feature.id}\n  name: "${feature.name}"\n  disabled: false\n`).join('')
  const separator = body === '' ? '' : '\n'
  writeFileAtomic(patchPath, `${body}${separator}${append}`)
}

module.exports = { ensureFeatureDefaults, FEATURE_DEFAULTS }
