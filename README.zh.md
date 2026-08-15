# DeepSeek Harness 桌面版

[English](README.md) | 中文

DeepSeek Harness 的 Electron 桌面外壳。它把发布的 `dsh web` 后端启动在由 OS 选择的回环端口上，并把 Web UI 加载进窗口，因此完整的 agent 运行时与 UI 都在本地运行，协议零改动。

## 架构

```
Electron main process (CommonJS)
 ├─ spawn → node lib/bin.js web --port 0   (staged registry backend; or the
 │           source CLI of $DSH_SOURCE_REPO via tsx)
 │           └─ reads "dsh web: http://127.0.0.1:<port>" from stdout
 ├─ health-poll GET / until 200
 └─ BrowserWindow.loadURL(http://127.0.0.1:<port>/)   ← same-origin HTTP + WS
```

Web UI 由它自己的后端托管、与后端同源，所以桌面外壳原样复用整套 HTTP/WebSocket 传输层与信任围栏。

## 前置条件

- PATH 上有 Node.js >= 22.19(后端跑在用户独立安装的 Node 下，不是 Electron 内置的)。
- `pnpm install`

## 运行

```sh
pnpm run backend    # stage the registry backend into dist-desktop/backend (x64)
pnpm start          # = electron . — dev launches the staged registry backend
```

把 `DSH_SOURCE_REPO` 指向一个 dsh 检出即可改为对着 harness 源码开发:外壳会用 tsx 启动那个检出的 `apps/cli/src/bin.ts`(该检出需要装好依赖)。后端继承进程环境,提供 API key 的方式与 `dsh web` 相同——导出 `DEEPSEEK_API_KEY`,或放进后端工作目录的 `.env`。

## 打包(Windows 安装器)

```sh
pnpm dist                        # x64 (default): registry backend closure + NSIS installer
pnpm dist -- --arch arm64       # arm64, cross-built on any host
```

产物落在 `dist-desktop/release/<arch>/`:安装器命名为 `DeepSeek Harness-<版本>-<架构>-setup.exe`,同级是 `win-unpacked/` 便携布局。

后端闭包(`scripts/build-desktop-backend.mjs --arch x64|arm64`)把提交在仓库里的 registry 清单(`backend/`:精确版本钉住的 `@deepseek-ai/dsh` 及其 lockfile)用 `npm ci --omit=dev --ignore-scripts --os=win32 --cpu=<arch>` 物化,把 registry CLI 包提升到 staging 根(`lib/bin.js` 与 `node_modules` 并列),裁掉运行时死文件与 node-pty 的非目标架构 `prebuilds/`,并在打包前以 fail-loud 断言确认目标架构的 addon 在位。安装期 `--cpu` 过滤只装目标架构的平台叶子包(`@img/sharp-win32-*`、`@koromix/koffi-win32-*`)。`--ignore-scripts` 是硬要求:放行的话 koffi 的 cnoke postinstall 会在异构主机上尝试源码构建并失败,而预编译叶子包让闭包里的安装脚本全无必要。跨架构构建会跳过 spawn 自检(目标架构 addon 在宿主 node 下无法加载);arm64 闭包的自检需在原生 arm64 硬件上运行。后端升级是显式动作:改 `backend/package.json` 的钉住版本、重新生成 lockfile、发新安装器。

## 说明

- 后端是 npm 发布的 `@deepseek-ai/dsh`;已发布版本的 bump 提交可能还没出现在 deepseek-harness 的 GitHub master 上。排查打包产物回归时,解包 `dist-desktop/backend/node_modules` 下的 tarball 与 dsh 检出对比。
- dev(经 `DSH_SOURCE_REPO` 的源码)与打包产物(registry 版)共用 `~/.dsh`(`DSH_HOME`)。pre-release 各版本之间会话格式不兼容;在开发机上冒烟测试安装器时,把 `DSH_HOME` 指向一次性目录。
- MVP:仅本地运行。macOS/Linux 安装器、图标与代码签名暂不在范围内(下一步)。
- 关窗会杀掉后端进程树。Unix 上后端跑在自己的进程组里;Windows 上通过 `taskkill /T` 杀整棵树。
