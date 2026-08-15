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

## Run

```sh
pnpm run backend    # stage the registry backend into dist-desktop/backend (x64)
pnpm start          # = electron . — dev launches the staged registry backend
```

Set `DSH_SOURCE_REPO` to a dsh checkout to develop against harness source
instead: the shell launches that checkout's `apps/cli/src/bin.ts` via tsx (the
checkout needs its dependencies installed). The backend inherits the process
environment, so provide your API key the same way as `dsh web` — either export
`DEEPSEEK_API_KEY` or place it in the backend cwd's `.env`.

## Package (Windows installers)

```sh
pnpm dist                        # x64 (default): registry backend closure + NSIS installer
pnpm dist -- --arch arm64       # arm64, cross-built on any host
```

Artifacts land in `dist-desktop/release/<arch>/`: the installer is named
`DeepSeek Harness-<version>-<arch>-setup.exe` next to a `win-unpacked/` layout.

The backend closure (`scripts/build-desktop-backend.mjs --arch x64|arm64`)
materializes the committed registry manifest (`backend/`: `@deepseek-ai/dsh`
pinned to an exact version plus its lockfile) with
`npm ci --omit=dev --ignore-scripts --os=win32 --cpu=<arch>`, promotes the
registry CLI package to the staging root (`lib/bin.js` with `node_modules`
beside it), prunes runtime-dead files and node-pty's foreign-architecture
`prebuilds/`, and asserts the target architecture's addons staged before
packaging. Install-time `--cpu` filtering stages only the target's
platform-optional leaves (`@img/sharp-win32-*`, `@koromix/koffi-win32-*`).
`--ignore-scripts` is required: koffi's cnoke postinstall builds from source
when allowed and fails on a cross-arch host, while the prebuilt leaves make
every install script in the closure unnecessary. Cross-arch builds skip the
spawn-and-poll self-check (target-arch addons cannot load under the host
node); run the arm64 closure's self-check on native arm64 hardware. Upgrading
the backend is deliberate: bump the pin in `backend/package.json`, regenerate
the lockfile, ship a new installer.

## Notes

- The backend is the published `@deepseek-ai/dsh` from npm; a released
  version's bump commit may not be on the deepseek-harness GitHub master yet.
  Debug a packaged regression by unpacking the installed tarballs under
  `dist-desktop/backend/node_modules` and diffing against a dsh checkout.
- Dev (source via `DSH_SOURCE_REPO`) and packaged (registry) backends share
  `~/.dsh` (`DSH_HOME`). Session formats are not compatible across pre-release
  versions; point `DSH_HOME` at a throwaway directory when smoke-testing an
  installer on a dev machine.
- MVP: local run only. macOS/Linux installers, icons, and code signing are out
  of scope for now (next step).
- Closing the window kills the backend process tree. On Unix the backend runs
  in its own process group; on Windows the tree is killed via `taskkill /T`.
