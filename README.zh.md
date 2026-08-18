# DeepSeek Harness 桌面版

[English](README.md) | 中文

DeepSeek Harness 的 Electron 桌面外壳。它把发布的 `dsh web` 后端启动在由 OS 选择的回环端口上，并把 Web UI 加载进窗口，因此完整的 agent 运行时与 UI 都在本地运行，协议零改动。

## 架构

```
Electron main process (CommonJS)
 ├─ BrowserWindow 立即打开本地启动页 src/boot.html(不等任何后端)
 ├─ 后台 spawn → node lib/bin.js web --port 0   (staged registry backend,跑在
 │           内置的独立 Node 下;或经 tsx 启动 $DSH_SOURCE_REPO 的源码 CLI)
 │           └─ reads "dsh web: http://127.0.0.1:<port>" from stdout
 ├─ health-poll GET / until 200
 └─ 成功后 loadURL(http://127.0.0.1:<port>/)   ← same-origin HTTP + WS
```

启动进度通过 IPC 实时推送到启动页;任一步失败(Node 缺失、后端退出、健康检查超时),启动页会显示错误、后端 stderr 尾部和一个"重试"按钮,应用不会退出。UI 运行期间后端崩溃也会回到启动页等待重试。

Web UI 由它自己的后端托管、与后端同源，所以桌面外壳原样复用整套 HTTP/WebSocket 传输层与信任围栏。

## 前置条件

- 从源码构建/运行:Node.js >= 22.19 + `pnpm install`。
- 最终用户什么都不用装:安装器自带一份钉版本的独立 Node 运行时
  (`resources/node`,由后端构建脚本从 nodejs.org 官方归档下载并校验
  SHASUMS256),后端、`dsh` CLI shim 与 Electron 外壳都用它。后端不能用
  Electron 内置的 Node——它的 `node-addon-require-builtin` 插件(HMR)需要
  Electron 不提供的 V8 embedder 槽位。

内置运行时是便利而非锁定:设置 `DSH_NODE=/绝对路径/node` 可强制指定 Node
 二进制(优先级高于内置),删掉 `resources/node` 则回落到 PATH 上的 `node`。
macOS GUI 启动时,回落链还会自动探测 Homebrew/MacPorts 的标准 node 位置与
登录 shell。

## 运行

```sh
pnpm run backend            # stage win32-x64 registry backend 到 dist-desktop/backend
pnpm run backend:mac        # stage darwin-arm64 闭包(Apple Silicon 开发)
pnpm start                  # = electron . — dev 启动已 stage 的 registry backend
```

`pnpm run backend` 默认面向 win32 x64;其他开发目标请显式传参,例如
`pnpm backend -- --platform darwin --arch x64`。

把 `DSH_SOURCE_REPO` 指向一个 dsh 检出即可改为对着 harness 源码开发:外壳会用 tsx 启动那个检出的 `apps/cli/src/bin.ts`(该检出需要装好依赖)。后端继承进程环境,提供 API key 的方式与 `dsh web` 相同——导出 `DEEPSEEK_API_KEY`,或放进后端工作目录的 `.env`。

## 打包

### Windows 安装器

```sh
pnpm dist                        # win32 x64(默认):registry backend closure + NSIS 安装器
pnpm dist -- --arch arm64       # win32 arm64,任意宿主可交叉构建
```

产物落在 `dist-desktop/release/win32/<arch>/`:安装器命名为 `DeepSeek Harness-<版本>-<架构>-setup.exe`,同级是 `win-unpacked/` 便携布局。

### macOS DMG + ZIP

macOS 包必须在 macOS 上构建(DMG 创建依赖 `hdiutil`):

```sh
pnpm dist:mac                    # darwin arm64(Apple Silicon)
pnpm dist:mac:x64                # darwin x64(Intel)
# 或显式指定:
pnpm dist -- --platform darwin --arch arm64
```

产物落在 `dist-desktop/release/darwin/<arch>/`:`.dmg` 与 `.zip` 命名为
`DeepSeek Harness-<版本>-<架构>.<ext>`,同级是打包后的 `.app` 目录。本地构建无需签名证书;若要分发,请设置 `CSC_LINK`/`CSC_KEY_PASSWORD` 签名,并在对外分享前对 DMG 做 notarization。

后端闭包(`scripts/build-desktop-backend.mjs --platform win32|darwin --arch x64|arm64`)把提交在仓库里的 registry 清单(`backend/`:精确版本钉住的 `@deepseek-ai/dsh` 及其 lockfile)用 `npm ci --omit=dev --ignore-scripts --os=<platform> --cpu=<arch>` 物化,把 registry CLI 包提升到 staging 根(`lib/bin.js` 与 `node_modules` 并列),裁掉运行时死文件与 node-pty 的非目标平台 `prebuilds/`,并在打包前以 fail-loud 断言确认目标平台的 addon 在位。安装期 `--os`/`--cpu` 过滤只装目标平台叶子包(`@img/sharp-<platform>-<arch>`、`@koromix/koffi-<platform>-<arch>`)。`--ignore-scripts` 是硬要求:放行的话 koffi 的 cnoke postinstall 会在异构主机上尝试源码构建并失败,而预编译叶子包让闭包里的安装脚本全无必要。跨平台/跨架构构建会跳过 spawn 自检(目标 addon 在宿主 node 下无法加载);各闭包的自检需在匹配的原生硬件上运行。同一脚本还会落盘内置 Node 运行时(钉在 `scripts/build-desktop-backend.mjs` 的 `NODE_VERSION`):从 nodejs.org 下载官方归档(`DSH_NODE_DIST_MIRROR` 可覆盖镜像)、对官方 `SHASUMS256.txt` 校验、缓存到 `dist-desktop/cache/`,只装 node 二进制本体(不含 npm/corepack)到 `resources/node`。自检用这份运行时加一次性 `DSH_HOME` 跑,等价于新用户首启。后端升级是显式动作:改 `backend/package.json` 的钉住版本、重新生成 lockfile、发新安装器;升级内置 Node 是对 `NODE_VERSION` 的同一套流程。

### 内置插件

桌面安装包默认启用 4 个 dsh 插件:

- `dsh-fusion`(dsh-preset)
- `@liustack/modlens`
- `dsh-usage-ledger`
- `dsh-git-tree`

它们作为 backend closure 的依赖打包进 `resources/backend`;首次启动时 Electron 主进程会把清单 `backend/desktop-plugins.json` 中的 bundle 追加到 `$DSH_HOME/profiles/web` 的 `dsh.profile.bundles`,因此用户无需安装 pnpm 或手动执行 `dsh plugin add`。

维护入口:插件 tarball(`plugins/`)、`backend/package.json`、`backend/desktop-plugins.json` 三处同步。

## 说明

- 后端是 npm 发布的 `@deepseek-ai/dsh`;已发布版本的 bump 提交可能还没出现在 deepseek-harness 的 GitHub master 上。排查打包产物回归时,解包 `dist-desktop/backend/node_modules` 下的 tarball 与 dsh 检出对比。
- dev(经 `DSH_SOURCE_REPO` 的源码)与打包产物(registry 版)共用 `~/.dsh`(`DSH_HOME`)。pre-release 各版本之间会话格式不兼容;在开发机上冒烟测试安装器时,把 `DSH_HOME` 指向一次性目录。
- MVP:仅本地运行。Linux 安装器、图标与代码签名/公证暂不在范围内(下一步)。
- 关窗会杀掉后端进程树。Unix 上后端跑在自己的进程组里;Windows 上通过 `taskkill /T` 杀整棵树。
