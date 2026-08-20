// @ts-check
/**
 * Update feed check for the desktop shell (Phase 0: detect + prompt).
 *
 * Electron-free on purpose: the main process calls checkForUpdate(), while
 * the pure pieces (version comparison, latest.yml parsing) stay unit-testable
 * under plain Node. The feed is the latest.yml electron-builder emits next to
 * the installers when publishing (GitHub Releases or a generic file host);
 * its `version` line is compared against app.getVersion().
 *
 * Phase 0 never downloads or installs anything — it only decides whether a
 * newer build exists and where the user can get it.
 */
'use strict'

/** Regular expression for `X.Y.Z[-prerelease][+build]`, the semver subset this
 * project actually ships (e.g. `0.1.1-rc.7`). */
const VERSION_RE = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Parse a version string into numeric main parts plus prerelease identifiers,
 * or null when it does not match the supported subset.
 * @param {string} version
 * @returns {{ main: [number, number, number], pre: string[] } | null}
 */
function parseVersion (version) {
  const m = VERSION_RE.exec(version.trim())
  if (!m) return null
  return { main: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

/**
 * Compare one semver prerelease identifier against another: numeric
 * identifiers compare numerically and sort before alphanumeric ones
 * (semver 2.0.0 §11).
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
function compareIdentifier (a, b) {
  const aNum = /^\d+$/.test(a)
  const bNum = /^\d+$/.test(b)
  if (aNum && bNum) {
    const diff = Number(a) - Number(b)
    return diff === 0 ? 0 : diff > 0 ? 1 : -1
  }
  if (aNum) return -1
  if (bNum) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Compare two versions of the supported semver subset. Returns 1 when `a` is
 * newer than `b`, -1 when older, 0 when equal — and 0 for unparseable input
 * (an unparseable feed version must never claim to be newer).
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
function compareVersions (a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    const diff = pa.main[i] - pb.main[i]
    if (diff) return diff > 0 ? 1 : -1
  }
  // Release beats any prerelease of the same main version.
  if (!pa.pre.length && !pb.pre.length) return 0
  if (!pa.pre.length) return 1
  if (!pb.pre.length) return -1
  const len = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i] ?? ''
    const y = pb.pre[i] ?? ''
    if (x === y) continue
    if (x === '') return -1
    if (y === '') return 1
    return compareIdentifier(x, y)
  }
  return 0
}

/**
 * Pull the version and primary artifact URL out of an electron-builder
 * latest.yml (or latest-mac.yml) body. electron-builder lists per-file
 * entries under `files:` and names the primary artifact again as a top-level
 * `path:` — the file its top-level `sha512:` vouches for. The primary is the
 * one users should download, so `path:` wins; the first `files:` url is the
 * fallback for feeds that omit it. Both are relative to the feed URL and may
 * contain spaces (the installer name does). Returns null when the body has no
 * usable version line — a malformed feed must read as "no update", never as
 * one.
 * @param {string} text
 * @param {string} feedUrl
 * @returns {{ version: string, url: string, sha512: string | null } | null}
 */
function parseLatestYml (text, feedUrl) {
  const version = /^version:[ \t]*(\S+)[ \t]*$/m.exec(text)?.[1]
  if (!version) return null
  const pathUrl = /^path:[ \t]*(\S[^\r\n]*?)[ \t]*$/m.exec(text)?.[1]
  const listed = /^[ \t]+-[ \t]+url:[ \t]*(\S[^\r\n]*?)[ \t]*$/m.exec(text)?.[1]
  const url = (pathUrl || listed || '').trim()
  if (!url) return null
  const sha512 = /^sha512:[ \t]*(\S+)[ \t]*$/m.exec(text)?.[1] ?? null
  return { version, url: new URL(url, feedUrl).toString(), sha512 }
}

/**
 * Fetch the platform's latest.yml and decide whether it announces a build
 * newer than `currentVersion`. Resolves to the parsed feed info (version,
 * absolute artifact URL, sha512) when there is one, null when the installed
 * build is current — and rejects on network/HTTP/parse failures so the
 * caller stays silent (Phase 0 checks must never affect boot).
 * @param {{ currentVersion: string, feedUrl: string, timeoutMs?: number }} opts
 * @returns {Promise<{ version: string, url: string, sha512: string | null } | null>}
 */
async function checkForUpdate ({ currentVersion, feedUrl, timeoutMs = 10_000 }) {
  const res = await fetch(feedUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      // GitHub's download endpoint rejects UA-less clients; mirrors may too.
      'user-agent': `dsh-desktop/${currentVersion} update-check`,
      accept: 'text/plain, application/octet-stream, */*',
    },
  })
  if (!res.ok) throw new Error(`update feed ${feedUrl} responded ${res.status}`)
  // Relative artifact URLs resolve against the final URL (after redirects).
  const info = parseLatestYml(await res.text(), res.url || feedUrl)
  if (!info) throw new Error(`update feed ${feedUrl} has no parseable version line`)
  if (compareVersions(info.version, currentVersion) > 0) return info
  return null
}

module.exports = { checkForUpdate, compareVersions, parseLatestYml }
