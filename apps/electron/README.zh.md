# DeepSeek Harness Electron

[English](README.md) | 中文

`apps/electron` 是 DeepSeek Harness 的私有 Windows 桌面组装应用。它保留发布的 Web UI 与公共 CLI，同时增加原生应用生命周期、单实例行为、受限导航和 Windows 发布打包。

## 架构

第一阶段桌面边界有意保持与现有应用兼容：

- Electron 在独立的随包 Node.js 运行时中启动 `dsh web --host 127.0.0.1 --port 0`，等待通过校验的就绪 URL，然后只加载这个精确回环来源。
- renderer（渲染进程）启用 `sandbox: true` 和 `contextIsolation: true`，不启用 Node 集成、`<webview>` 或 preload API。精确应用来源以外的弹窗和导航都会被拒绝；通过校验的 HTTP(S) 链接交给系统浏览器打开。
- 只允许应用来源执行经过净化的剪贴板写入。相机、麦克风、地理位置、通知和其他权限请求均被拒绝。
- 关闭桌面应用时，先通过进程 IPC 请求 profile 优雅释放，再在有界截止时间后终止后端。父通道断开也会触发后端释放。
- Electron 主进程与加载资源位于带完整性记录的 ASAR 中。后端依赖树会在打包后合并为单独的、记录 SHA-256 的 `backend.asar`；首次启动时 Electron 会校验它，并将其展开到独立 Node 运行时所需的短路径缓存 `%APPDATA%\DSH\b\node_modules`。后续启动会复用带摘要标记的缓存。

使用独立 Node 运行时是有意决策：`node-pty`、Koffi 等原生依赖继续使用其安装时对应的 Node ABI，无需针对不同的 Electron ABI 重建。

## 开发

使用 Windows x64、Node.js x64、pnpm 和 PowerShell 7 或更新版本。在仓库根目录运行：

```powershell
$ErrorActionPreference = 'Stop'
pnpm install
pnpm run desktop:start
```

根命令会先重新构建 CLI、Web UI 和 Electron 主进程，再启动桌面应用。后端以用户主目录作为工作目录，与正常 CLI 使用方式一致，不会把仓库当作用户数据目录。

## 打包 Windows 发布物

```powershell
$ErrorActionPreference = 'Stop'
pnpm run desktop:pack:win
pnpm run desktop:dist:win
```

产物写入 `apps/electron/release/`：

- `win-unpacked/DeepSeekHarness.exe`：用于验收和调试的解包版本。
- `DeepSeek-Harness-Setup-<version>-x64.exe`：NSIS 安装器，推荐日常使用。
- `DeepSeek-Harness-<version>-x64.exe`：自解压便携版；每次启动都会把应用展开到临时目录，因此比安装版更慢。

打包步骤会复制本机精确的 x64 Node 运行时及其许可证，在 `resources/runtime/runtime.json` 中记录版本与 SHA-256，并包含所有必需 workspace peer 的完整闭包。它还会把深层后端树合并为 `resources/backend.asar` 与 `backend.asar.sha256`，避免 NSIS 截断长路径，同时在首次展开后继续为外部 Node 提供物理文件。配置签名凭据后会执行发布签名；本地未签名构建通过 `Get-AuthenticodeSignature` 显示为 `NotSigned`。

## GitHub Actions 自动构建与发布

[Electron Windows 工作流](../../.github/workflows/electron-windows.yml)会在 PR（Pull Request）、推送到 `master`、匹配 `v*` 的 tag 以及手动派发时运行。它会安装锁定的依赖，运行聚焦的 Electron、父进程监督与工作流测试，构建两个 Windows x64 可执行文件，写入 `SHA256SUMS.txt`，并在工作流运行中以 `deepseek-harness-windows-x64-<commit>` 保留这三个文件。

匹配 `v<version>` 的 tag 必须等于 Electron 包版本。构建成功后，只在 tag 上运行且具有 `contents: write` 权限的任务会把安装器、便携版和校验和文件发布到相应 GitHub Release。版本中含连字符的 tag（例如 `v0.1.0-rc.5`）会成为 prerelease，其中可以包含未签名二进制文件，Release 说明会记录其 Authenticode 状态。稳定版 tag 只有在两个可执行文件都具有有效 Authenticode 签名时才能发布。重新运行 tag 工作流会替换 Release 中的同名产物。

## 模型体验

桌面壳不会改变提示词、模型选择、工具或提供方请求。它承载与 `dsh web` 相同的 Web 组合。

#### KV Cache 影响

无；桌面进程边界不会改变模型请求内容。

## 已知限制与暂缓事项

- **优先支持 Windows x64**：当前只实现 Windows x64 运行时准备以及 NSIS／便携版目标。
- **回环载体**：第一阶段拥有随机私有回环端口，但仍使用 HTTP／WebSocket。原生 `file://` 加 IPC 载体会等到 client connection 层能在不复制协议行为的情况下切换时再实现。
- **签名依赖外部配置**：仓库代码不包含签名身份。prerelease 可以不签名，并会在 Release 说明中记录该状态；稳定版 Release 要求有效的 Authenticode 签名。
- **首次启动会展开后端**：新后端摘要的首次启动会校验依赖归档并将其复制到短路径应用缓存；后续启动直接复用。
- **产物较大**：应用携带 Electron、Node.js、原生工具和完整插件运行时。安装器无需每次执行便携版自解压，因此是推荐产物。
