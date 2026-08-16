# DeepSeek Harness Desktop

English | [中文](README.zh.md)

Electron desktop shell for DeepSeek Harness. It boots the published `dsh web`
backend on a loopback port chosen by the OS and loads the Web UI in a window,
so the full agent runtime and UI run locally with no protocol changes.

## Architecture

```
Electron main process (CommonJS)
 ├─ spawn → node lib/bin.js web --port 0   (staged registry backend; or the
 │           source CLI of $DSH_SOURCE_REPO via tsx)
 │           └─ reads "dsh web: http://127.0.0.1:<port>" from stdout
 ├─ health-poll GET / until 200
 └─ BrowserWindow.loadURL(http://127.0.0.1:<port>/)   ← same-origin HTTP + WS
```

The Web UI is served by its own backend and is same-origin with it, so the
desktop shell reuses the entire HTTP/WebSocket transport and trust perimeter.

## Prerequisites

- Node.js >= 22.19 on PATH (the backend runs under the user's standalone Node,
  not Electron's bundled one).
- `pnpm install`

macOS GUI apps do not inherit the shell PATH. The packaged app probes the
standard Homebrew/MacPorts node locations and the login shell; set
`DSH_NODE=/absolute/path/to/node` to override that lookup explicitly.

## Run

```sh
pnpm run backend            # stage the win32-x64 registry backend into dist-desktop/backend
pnpm run backend:mac        # stage the darwin-arm64 closure (Apple Silicon dev)
pnpm start                  # = electron . — dev launches the staged registry backend
```

Windows x64 is the `pnpm run backend` default. For another dev target pass the
flags explicitly, e.g. `pnpm backend -- --platform darwin --arch x64`.

Set `DSH_SOURCE_REPO` to a dsh checkout to develop against harness source
instead: the shell launches that checkout's `apps/cli/src/bin.ts` via tsx (the
checkout needs its dependencies installed). The backend inherits the process
environment, so provide your API key the same way as `dsh web` — either export
`DEEPSEEK_API_KEY` or place it in the backend cwd's `.env`.

## Package

### Windows installers

```sh
pnpm dist                        # win32 x64 (default): registry backend closure + NSIS installer
pnpm dist -- --arch arm64       # win32 arm64, cross-built on any host
```

Artifacts land in `dist-desktop/release/win32/<arch>/`: the installer is named
`DeepSeek Harness-<version>-<arch>-setup.exe` next to a `win-unpacked/` layout.

### macOS DMG + ZIP

macOS packages must be built on macOS (DMG creation uses `hdiutil`):

```sh
pnpm dist:mac                    # darwin arm64 (Apple Silicon)
pnpm dist:mac:x64                # darwin x64 (Intel)
# or explicitly:
pnpm dist -- --platform darwin --arch arm64
```

Artifacts land in `dist-desktop/release/darwin/<arch>/`:
`DeepSeek Harness-<version>-<arch>.dmg` and `.zip` next to the packaged `.app`
directory. No signing identity is required for a local build; set
`CSC_LINK`/`CSC_KEY_PASSWORD` to sign a distributable build, then notarize the
DMG before sharing it outside your machine.

The backend closure (`scripts/build-desktop-backend.mjs --platform
win32|darwin --arch x64|arm64`) materializes the committed registry manifest
(`backend/`: `@deepseek-ai/dsh` pinned to an exact version plus its lockfile)
with `npm ci --omit=dev --ignore-scripts --os=<platform> --cpu=<arch>`,
promotes the registry CLI package to the staging root (`lib/bin.js` with
`node_modules` beside it), prunes runtime-dead files and node-pty's foreign
platform `prebuilds/`, and asserts the target platform's addons staged before
packaging. Install-time `--os`/`--cpu` filtering stages only the target's
platform-optional leaves (`@img/sharp-<platform>-<arch>`,
`@koromix/koffi-<platform>-<arch>`). `--ignore-scripts` is required: koffi's
cnoke postinstall builds from source when allowed and fails on a cross-arch
host, while the prebuilt leaves make every install script in the closure
unnecessary. Cross-platform/arch builds skip the spawn-and-poll self-check
(target addons cannot load under the host node); run each closure's self-check
on matching native hardware. Upgrading the backend is deliberate: bump the pin
in `backend/package.json`, regenerate the lockfile, ship a new installer.

## Notes

- The backend is the published `@deepseek-ai/dsh` from npm; a released
  version's bump commit may not be on the deepseek-harness GitHub master yet.
  Debug a packaged regression by unpacking the installed tarballs under
  `dist-desktop/backend/node_modules` and diffing against a dsh checkout.
- Dev (source via `DSH_SOURCE_REPO`) and packaged (registry) backends share
  `~/.dsh` (`DSH_HOME`). Session formats are not compatible across pre-release
  versions; point `DSH_HOME` at a throwaway directory when smoke-testing an
  installer on a dev machine.
- MVP: local run only. Linux installers, app icons, and code signing /
  notarization are out of scope for now (next steps).
- Closing the window kills the backend process tree. On Unix the backend runs
  in its own process group; on Windows the tree is killed via `taskkill /T`.
