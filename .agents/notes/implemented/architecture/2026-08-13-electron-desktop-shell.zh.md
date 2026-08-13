# Agent Note：Electron 桌面壳

Status: implemented

[English](2026-08-13-electron-desktop-shell.md) | 中文

## 问题

Electron fork 需要成为真正的桌面应用，同时不能把现有 Web UI、插件图或 `dsh` CLI 拆成第二套产品实现。Windows 发布物还必须保持原生模块兼容性、拥有后端生命周期、在失败时给出可操作诊断，并在退出后不留下孤儿进程或监听端口。

## 决策

`apps/electron` 是私有应用 workspace，不进入公共 npm 发布族。其已实现的第一阶段以 `dsh web --host 127.0.0.1 --port 0` 启动构建后的 `@deepseek-ai/dsh` 入口，只解析其拥有的就绪行，校验不含凭据的回环 HTTP 来源，并在单个 Electron 窗口中加载这个精确来源。

桌面应用在启动前取得 Electron 单实例锁。profile 启动期间显示本地加载页；第二次启动会恢复并聚焦现有窗口；后端工作目录为用户主目录。启动时限为 60 秒。正常退出会发送带命名空间的 `dsh:shutdown` IPC 命令；CLI 释放已启动的 profile 后退出，桌面所有者只在五秒宽限期结束后才升级为终止进程。父 IPC 通道断开会触发同一条释放路径。

## 进程与安全边界

Electron 主进程拥有一个外部 Node 后端。renderer（渲染进程）启用沙箱和上下文隔离，禁用 Node 集成，不提供 preload 桥，并禁用 webview。它只能停留在精确的私有应用来源；其他导航和弹窗请求会被拒绝，通过校验的 HTTP(S) 目标交给系统浏览器打开。权限默认拒绝，只允许精确应用来源执行经过净化的剪贴板写入。

回环服务器是兼容载体，而不是公共服务：host 固定为 `127.0.0.1`，端口由 OS 分配，窗口只接受最终得到的来源。原生 `file://` 加 IPC 仍是后续载体变更，不是本阶段的实现声明。

## 打包边界

Electron 与仓库已安装的 Node 运行时使用不同的原生模块 ABI。因此 Windows 包会携带安装后端依赖时所用的精确 x64 `node.exe`、Node 许可证，以及包含版本、架构和 SHA-256 的元数据文件。Electron Builder 不重建原生模块。运行时闭包测试要求打包图可达的每个非可选 workspace peer 都是显式生产依赖，从而防止 Loader 阶段出现缺包故障。

Electron 主 bundle 和加载资源被打入带可执行文件完整性元数据的 ASAR。after-pack hook 会把后端 `node_modules` 合并为 `resources/backend.asar` 并记录其 SHA-256。首次启动时，Electron 会校验物理归档，并将其原子化展开到短路径缓存 `%APPDATA%\DSH\b\node_modules`；标准目录名保留 Node ESM 的 peer 解析，短路径则防止 NSIS／MAX_PATH 静默漏掉深层文件。配置后会使用代码签名，但仓库中不保存签名身份。

`Electron Windows` GitHub Actions 工作流会在 PR（Pull Request）、推送到 `master`、匹配 `v*` 的 tag 和手动派发时，在托管的 Windows x64 环境中构建 NSIS 与便携版目标。它使用仓库固定的 pnpm 和精确 Node 运行时，运行聚焦的桌面端与工作流测试，校验两个 PE 输出，写入其 SHA-256 校验和，并把可执行文件与校验和文件作为一个工作流产物保留。构建任务只有仓库读取权限。

依赖构建任务的发布任务只在已经对照 Electron 包版本完成校验的 `v<version>` tag 上运行。只有该任务拥有 `contents: write` 权限；它会下载经过校验的工作流产物，并创建相应 GitHub Release，或在重试时替换同名产物。版本中含连字符时会创建 prerelease，并在生成的说明中记录 Authenticode 状态。稳定版只有在两个可执行文件都具备有效 Authenticode 签名时才能发布。

## 考虑过的替代方案

| 替代方案 | 未采用原因 |
|---|---|
| 立即把前端重写为原生 Electron renderer | 在产品需求证明第二套 UI 实现有必要之前，这会复制已经可用的 Web 组合。 |
| 第一阶段使用原生 `file://` 加 IPC 载体 | 它要求协调修改 client connection 与 static-arrival；回环载体无需改变协议行为即可交付桌面生命周期所有权。 |
| 在 Electron 主进程内运行后端 | 它会把浏览器权限、profile 生命周期、崩溃和原生模块 ABI 合并到同一个故障域。 |
| 使用 Electron `utilityProcess` 运行后端 | 其 Node ABI 要求为 Electron 重建原生依赖；精确 Node 运行时能够保留受支持 ABI，发布环境无需承担该工具链。 |
| 完全禁用 ASAR | 这会让每个主进程源文件都能被直接修改，并放弃 Electron Builder 的 ASAR 完整性记录。外部 Node 依赖树可以改用单独校验的归档与短路径运行时缓存。 |
| 把每次 `master` 构建发布为可变 GitHub Release | 版本 tag 会把 Release 绑定到一个源码修订和包版本。分支、PR 和手动构建保留为工作流产物，不会改写公开 Release。 |

## 后果

该 fork 在不改变浏览器或 CLI 入口的情况下生成解包应用、NSIS 安装器和自解压便携版。安装器是推荐产物；便携版每次启动都会展开应用，因此更慢。新后端摘要还会产生一次性的校验与缓存展开成本。当前只实现 Windows x64 打包。GitHub 会自动保留安装器、便携版和校验和产物；匹配版本的 tag 还会把这些文件发布为 Release。prerelease 可以在明确记录状态的情况下不签名，稳定版发布则需要外部签名身份。私有随机回环端口会保留到原生载体阶段。

## 验证

针对生命周期、导航、父进程监督、后端归档、运行时闭包和工作流结构的测试均通过。工作流结构测试固定使用托管的 Windows x64 环境、不可变依赖安装、聚焦测试命令、两个打包目标、校验和生成、只读构建权限、仅限 tag 的写入权限、稳定版签名强制、可重试 Release 上传和产物保留。Windows 验收会启动源码壳、解包版本、便携版和静默安装后的 NSIS 版本；每个版本都到达中文 DeepSeek Harness UI，并在 `127.0.0.1` 监听上返回 HTTP 200。NSIS 测试使用此前会截断 OpenTelemetry 模块的同一条长自定义安装路径，并证明首次启动从已安装归档完成展开。第二次启动检查只保留一个应用和一个后端。Alt+F4 会释放后端进程与端口，便携版临时目录会消失，静默卸载器会移除已安装应用。
