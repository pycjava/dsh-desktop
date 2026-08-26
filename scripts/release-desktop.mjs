#!/usr/bin/env node
/**
 * Publish desktop installers and their update feeds to GitHub Releases.
 *
 * Usage:
 *   GH_TOKEN=<token> node scripts/release-desktop.mjs [--platform win32|darwin] [--arch x64|arm64]
 *                        [--tag v0.1.1-rc.8] [--notes-file NOTES.md] [--draft]
 *
 * Builds stay local (`pnpm run dist` / --publish never); this script is the
 * single explicit publish step. It uploads, per target, the artifacts
 * electron-updater needs — the installer(s), the matching .blockmap(s), and
 * latest.yml / latest-mac.yml — and refuses to run when a feed's url lines do
 * not exactly name files on disk (a renamed/mismatched asset would make
 * in-app updates silently 404). Re-running replaces same-named assets, so a
 * botched upload is fixed by publishing again.
 */
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireFromRoot = createRequire(join(root, 'package.json'))
const { version } = requireFromRoot('./package.json')

const argv = process.argv.slice(2)
/**
 * @param {string} name
 * @returns {string | null}
 */
function flag (name) {
  const idx = argv.lastIndexOf(`--${name}`)
  if (idx < 0) return null
  const value = argv[idx + 1]
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`)
  return value
}
const platform = flag('platform') ?? 'win32'
const arch = flag('arch') ?? 'x64'
if (!['win32', 'darwin'].includes(platform)) throw new Error(`unknown --platform ${platform}`)
if (!['x64', 'arm64'].includes(arch)) throw new Error(`unknown --arch ${arch}`)
const tag = flag('tag') ?? `v${version}`
const owner = flag('owner') ?? 'pycjava'
const repo = flag('repo') ?? 'dsh-desktop'
const draft = argv.includes('--draft')
const notesFile = flag('notes-file')

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
if (!token) throw new Error('GH_TOKEN (or GITHUB_TOKEN) with repo contents:write is required')

const releaseDir = join(root, 'dist-desktop', 'release', platform, arch)
const feedFile = platform === 'win32' ? 'latest.yml' : 'latest-mac.yml'

/** The artifacts this target must ship; names are checked against the feed. */
function expectedArtifacts () {
  if (platform === 'win32') {
    const exe = `DeepSeek-Harness-${version}-${arch}-setup.exe`
    return [exe, `${exe}.blockmap`, feedFile]
  }
  const dmg = `DeepSeek-Harness-${version}-${arch}.dmg`
  const zip = `DeepSeek-Harness-${version}-${arch}.zip`
  return [dmg, `${dmg}.blockmap`, zip, `${zip}.blockmap`, feedFile]
}

/**
 * Assert every artifact exists and the feed's url lines match files on disk
 * exactly — spaces, dots, or renames anywhere in the chain break downloads.
 * @param {string} feedBody
 * @param {string[]} artifacts
 */
function assertFeedConsistency (feedBody, artifacts) {
  const onDisk = new Set(artifacts)
  const referenced = [...feedBody.matchAll(/^[ \t]+-[ \t]+url:[ \t]*(\S+)$/gm)].map((m) => m[1].trim())
  const problems = []
  const feedVersion = /^version:[ \t]*(\S+)$/m.exec(feedBody)?.[1]
  if (feedVersion !== version) {
    problems.push(`feed version ${feedVersion} != package.json version ${version}`)
  }
  for (const name of referenced) {
    if (!onDisk.has(name)) problems.push(`feed references "${name}" but no such artifact is staged`)
  }
  // electron-updater derives blockmap URLs by suffixing the installer/zip url
  // (never listed in the feed), and dmg files are manual downloads outside the
  // feed entirely — only feed url lines must name a staged file 1:1.
  const implicitlyReferenced = (name) => name === feedFile || name.endsWith('.blockmap') || name.endsWith('.dmg')
  for (const name of artifacts) {
    if (implicitlyReferenced(name)) continue
    if (!referenced.includes(name)) problems.push(`artifact "${name}" is not referenced by ${feedFile}`)
  }
  if (problems.length) {
    throw new Error(`${feedFile} is inconsistent with the staged artifacts:\n  ${problems.join('\n  ')}`)
  }
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
async function gh (path, init) {
  const res = await fetch(path.startsWith('http') ? path : `https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-desktop-release-script',
      ...init?.headers,
    },
  })
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} ${path}: ${await res.text()}`)
  }
  return res.status === 204 ? null : res.json()
}

const release = await gh(`/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`).catch(() => null)
  ?? await gh(`/repos/${owner}/${repo}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: tag.replace(/^v/, ''),
      body: notesFile ? await readFile(resolve(root, notesFile), 'utf8') : `DeepSeek Harness ${version} (${platform}-${arch})`,
      draft,
      // rc builds mark the release as a prerelease so stable-only users'
      // release views stay clean; the update feed is unaffected.
      prerelease: /-/.test(version),
    }),
  })
console.log(`release-desktop: ${release.html_url}`)

const feedBody = await readFile(join(releaseDir, feedFile), 'utf8')
const artifacts = expectedArtifacts()
for (const name of artifacts) {
  await stat(join(releaseDir, name)) // throws early with a clear missing-file error
}
assertFeedConsistency(feedBody, artifacts)

// Replace same-named assets so a re-publish is idempotent.
for (const asset of release.assets ?? []) {
  if (artifacts.includes(asset.name)) {
    console.log(`release-desktop: replacing existing asset ${asset.name}`)
    await gh(`/repos/${owner}/${repo}/releases/assets/${asset.id}`, { method: 'DELETE' })
  }
}

for (const name of artifacts) {
  const data = await readFile(join(releaseDir, name))
  const url = `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`
  const uploaded = await gh(url, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(data),
  })
  console.log(`release-desktop: uploaded ${name} (${(data.length / 1024 / 1024).toFixed(1)} MB) -> ${uploaded.browser_download_url}`)
}
console.log('release-desktop: done')
