# Agent Note: Electron desktop shell

Status: implemented

English | [中文](2026-08-13-electron-desktop-shell.zh.md)

## Problem

The Electron fork needs to become a real desktop application without splitting the existing Web UI, plugin graph, or `dsh` CLI into a second product implementation. A Windows release must also preserve native-module compatibility, own the backend lifetime, fail with actionable diagnostics, and leave no orphan process or listening port after exit.

## Decision

`apps/electron` is a private application workspace and is excluded from the public npm release family. Its first implemented phase launches the built `@deepseek-ai/dsh` entry as `dsh web --host 127.0.0.1 --port 0`, parses only the owned readiness line, validates an uncredentialed loopback HTTP origin, and loads that exact origin in one Electron window.

The desktop application acquires Electron's single-instance lock before boot. It displays a local loading page while the profile starts, restores and focuses the existing window on a second launch, and uses the user's home directory as the backend working directory. Startup is bounded at 60 seconds. Normal exit sends the namespaced `dsh:shutdown` IPC command; the CLI disposes the booted profile and exits, while the desktop owner escalates to process termination only after a five-second grace interval. A disconnected parent IPC channel triggers the same disposal path.

## Process and security boundaries

The Electron main process owns one external Node backend. The renderer is sandboxed with context isolation, Node integration disabled, no preload bridge, and webviews disabled. It may remain on the exact private application origin; other navigation and popup requests are denied, with validated HTTP(S) destinations opened by the system browser. Permissions deny by default and admit only sanitized clipboard writes from the exact application origin.

The loopback server is a compatibility carrier, not a public service: the host is fixed to `127.0.0.1`, the port is assigned by the OS, and the window accepts only the resulting origin. Native `file://` plus IPC remains a later carrier change, not a claim made by this phase.

## Packaging boundary

Electron and the repository's installed Node runtime use different native module ABIs. The Windows package therefore carries the exact x64 `node.exe` used to install the backend dependencies, its Node license, and a metadata file containing version, architecture, and SHA-256. Electron Builder does not rebuild native modules. A runtime-closure test requires every non-optional workspace peer reachable by the packaged graph to be an explicit production dependency, preventing Loader-time missing-package failures.

The Electron main bundle and loading assets are packed into ASAR with executable integrity metadata. An after-pack hook collapses backend `node_modules` into `resources/backend.asar` and records its SHA-256. On first launch, Electron verifies the physical archive and atomically materializes it into the short `%APPDATA%\DSH\b\node_modules` cache; the standard directory name preserves Node ESM peer resolution, while the short path prevents NSIS/MAX_PATH from silently omitting deep files. Code signing is consumed when configured but no signing identity is stored in the repository.

The `Electron Windows` GitHub Actions workflow builds the NSIS and portable targets on hosted Windows x64 for pull requests, `master` pushes, matching `v*` tags, and manual dispatches. It uses the repository-pinned pnpm and an exact Node runtime, runs the focused desktop and workflow tests, verifies both PE outputs, writes their SHA-256 checksums, and retains the executables and checksum file as one workflow artifact. The build job has read-only repository permissions.

A dependent job runs only for a `v<version>` tag already validated against the Electron package version. That job alone receives `contents: write`, downloads the verified workflow artifact, and creates the corresponding GitHub Release or replaces same-named assets on a retry. Versions containing a hyphen become prereleases and record their Authenticode status in the generated notes. Stable versions fail before publication unless both executables have valid Authenticode signatures.

## Alternatives considered

| Alternative | Reason not selected |
|---|---|
| Reimplement the frontend as a native Electron renderer immediately | It duplicates the working Web composition before a product requirement justifies a second UI implementation. |
| Use a native `file://` plus IPC carrier in phase one | It requires coordinated client-connection and static-arrival work; the loopback carrier delivers desktop ownership without changing protocol behavior. |
| Run the backend inside the Electron main process | It combines browser privilege, profile lifetime, crashes, and native module ABI into one failure domain. |
| Use Electron `utilityProcess` for the backend | Its Node ABI requires rebuilding native dependencies for Electron; the release environment does not need that toolchain when an exact Node runtime can preserve the supported ABI. |
| Disable ASAR entirely | It makes every main-process source file directly mutable and gives up Electron Builder's ASAR integrity record. The external-Node dependency tree can instead use a separately verified archive and short runtime cache. |
| Publish each `master` build as a mutable GitHub Release | A version tag ties a Release to one source revision and package version. Branch, pull-request, and manual builds remain workflow artifacts instead of mutating a public Release. |

## Consequences

The fork produces an unpacked application, an NSIS installer, and a self-extracting portable executable without changing the browser or CLI entry points. The installer is the recommended artifact; the portable executable is slower because it expands the application on each launch. A new backend digest also has a one-time verification and cache-materialization cost. Windows x64 is the only implemented packaging target. GitHub automatically retains installer, portable, and checksum artifacts; matching version tags additionally publish those files as Releases. Prereleases may remain unsigned with an explicit status, while stable publication requires the external signing identity. The private random loopback port remains until the native carrier phase.

## Verification

Focused lifecycle, navigation, parent-supervisor, backend-bundle, runtime-closure, and workflow-structure tests pass. The workflow-structure test pins hosted Windows x64, immutable dependency installation, the focused test command, both packaging targets, checksum generation, read-only build permissions, tag-only write permission, stable-signature enforcement, retryable Release upload, and artifact retention. Windows acceptance starts the source shell, unpacked build, portable executable, and silently installed NSIS build; each reaches the Chinese DeepSeek Harness UI and HTTP 200 on a `127.0.0.1` listener. The NSIS test uses the same long custom installation path that previously truncated an OpenTelemetry module and proves first-run extraction from the installed archive. Second-launch checks leave one application and one backend. Alt+F4 releases the backend process and port, the portable temporary directory disappears, and the silent uninstaller removes the installed application.
