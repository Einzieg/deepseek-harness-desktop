# DeepSeek Harness Electron

English | [中文](README.zh.md)

`apps/electron` is the private Windows desktop assembly for DeepSeek Harness. It preserves the shipped Web UI and public CLI while adding a native application lifetime, single-instance behavior, hardened navigation, and Windows release packaging.

## Architecture

The phase-one desktop boundary is deliberately compatible with the existing application:

- Electron starts `dsh web --host 127.0.0.1 --port 0` in a separate bundled Node.js runtime, waits for its validated readiness URL, and loads that exact loopback origin.
- The renderer has `sandbox: true`, `contextIsolation: true`, no Node integration, no `<webview>`, and no preload API. Popups and navigation outside the exact application origin are denied and validated HTTP(S) links open in the system browser.
- Only sanitized clipboard writes from the application origin are permitted. Camera, microphone, geolocation, notifications, and other permission requests are denied.
- Closing the desktop application requests graceful profile disposal over process IPC, then terminates the backend after a bounded deadline. Parent-channel disconnect also disposes the backend.
- The Electron main process and loading assets live in an integrity-recorded ASAR. The backend dependency tree is post-packed into a separate SHA-256-recorded `backend.asar`; on first launch Electron verifies it and materializes it into the short `%APPDATA%\DSH\b\node_modules` cache required by the separate Node runtime. Later launches reuse the digest-marked cache.

The separate Node runtime is intentional: native dependencies such as `node-pty` and Koffi remain on the Node ABI they were installed for instead of being rebuilt for Electron's different ABI.

## Develop

Use Windows x64, Node.js x64, pnpm, and PowerShell 7 or newer. From the repository root:

```powershell
$ErrorActionPreference = 'Stop'
pnpm install
pnpm run desktop:start
```

The root command rebuilds the CLI, Web UI, and Electron main process before launching the desktop application. The backend uses the user's home directory as its working directory, matching normal CLI use rather than treating the repository as user data.

## Package for Windows

```powershell
$ErrorActionPreference = 'Stop'
pnpm run desktop:pack:win
pnpm run desktop:dist:win
```

Outputs are written under `apps/electron/release/`:

- `win-unpacked/DeepSeekHarness.exe`: unpacked acceptance/debug build.
- `DeepSeek-Harness-Setup-<version>-x64.exe`: NSIS installer; recommended for regular use.
- `DeepSeek-Harness-<version>-x64.exe`: self-extracting portable build; every launch expands the application into a temporary directory, so it starts more slowly than the installer.

The packaging step copies the exact local x64 Node runtime plus its license, records its version and SHA-256 in `resources/runtime/runtime.json`, and includes the complete required workspace peer closure. It also collapses the deep backend tree into `resources/backend.asar` plus `backend.asar.sha256`, avoiding NSIS path truncation while retaining physical files for external Node after first-run materialization. Release signing is used when signing credentials are configured; local unsigned builds report `NotSigned` through `Get-AuthenticodeSignature`.

## GitHub Actions builds and releases

The [Electron Windows workflow](../../.github/workflows/electron-windows.yml) runs for pull requests, pushes to `master`, matching `v*` tags, and manual dispatches. It installs the locked dependencies, runs the focused Electron, parent-supervisor, and workflow tests, builds both Windows x64 executables, writes `SHA256SUMS.txt`, and retains those three files as `deepseek-harness-windows-x64-<commit>` in the workflow run.

A matching `v<version>` tag must equal the Electron package version. After that build succeeds, a tag-only job with `contents: write` publishes the installer, portable executable, and checksum file to the corresponding GitHub Release. Tags whose version contains a hyphen, such as `v0.1.0-rc.5`, become prereleases and may carry unsigned binaries with their Authenticode status in the notes. Stable tags fail publication unless both executables have valid Authenticode signatures. Re-running a tag workflow replaces same-named Release assets.

## Model Experience

The desktop shell does not alter prompts, model selection, tools, or provider requests. It hosts the same Web composition as `dsh web`.

#### KV Cache effect

None; the desktop process boundary does not change model request content.

## Known Limitations and Deferred Work

- **Windows x64 first** — only Windows x64 runtime preparation and NSIS/portable targets are implemented.
- **Loopback carrier** — phase one owns a random private loopback port but still uses HTTP/WebSocket. A native `file://` plus IPC carrier is deferred until the client connection layer can switch without duplicating protocol behavior.
- **Signing is external** — repository code does not contain a signing identity. Prereleases may be unsigned and state that status in their Release notes; stable Release publication requires valid Authenticode signatures.
- **First launch materializes the backend** — the first launch of a new backend digest verifies and copies its dependency archive into the short application cache; subsequent launches reuse it.
- **Large artifacts** — the app carries Electron, Node.js, native tools, and the complete plugin runtime. The installer avoids repeated portable self-extraction and is the recommended artifact.
