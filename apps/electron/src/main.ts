/** Electron desktop assembly: secure window plus a supervised loopback DSH backend. */

import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, Menu, shell } from 'electron'
import { DshBackend, type BackendProcess, type BackendSpawnRequest } from './backend.ts'
import { materializeBackendBundle } from './backend-bundle.ts'
import { isAppUrl, safeExternalUrl } from './navigation.ts'

const APP_ID = 'ai.deepseek.harness.electron'
const APP_PARTITION = 'persist:deepseek-harness-electron'
const LOADING_PAGE = fileURLToPath(new URL('../assets/loading.html', import.meta.url))

let mainWindow: BrowserWindow | undefined
let backend: DshBackend | undefined
let backendUrl: string | undefined
let quitRequested = false
let shutdownComplete = false
let shutdownPromise: Promise<void> | undefined

/** Resolve the built CLI entry from source or the verified short-path backend cache. */
async function resolveDshBin(): Promise<string> {
  if (app.isPackaged) {
    const nodeModules = await materializeBackendBundle({
      archivePath: join(process.resourcesPath, 'backend.asar'),
      digestPath: join(process.resourcesPath, 'backend.asar.sha256'),
      cacheRoot: join(app.getPath('appData'), 'DSH', 'b'),
    })
    return join(nodeModules, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  }
  const require = createRequire(import.meta.url)
  const manifest = require.resolve('@deepseek-ai/dsh/package.json')
  const resolvedBin = join(dirname(manifest), 'lib', 'bin.js')
  if (!existsSync(resolvedBin)) {
    throw new Error(`DeepSeek Harness CLI artifact is missing at ${resolvedBin}. Run pnpm run build first.`)
  }
  return resolvedBin
}

/** Resolve the Node runtime whose ABI owns the packaged backend dependencies. */
function resolveBackendNode(): string {
  if (!app.isPackaged) return process.platform === 'win32' ? 'node.exe' : 'node'
  const runtime = join(process.resourcesPath, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
  if (!existsSync(runtime)) throw new Error(`Packaged Node runtime is missing at ${runtime}`)
  return runtime
}

/** Adapt a Node fork to the lifecycle module's testable process surface. */
function spawnBackend(request: BackendSpawnRequest): BackendProcess {
  const child = spawn(resolveBackendNode(), ['--expose-internals', request.modulePath, ...request.args], {
    cwd: request.cwd,
    env: request.environment,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    get pid() { return child.pid },
    onExit(listener) { child.on('exit', (code) => { listener(code ?? 1) }) },
    onError(listener) { child.on('error', (error) => { listener(String(error)) }) },
    postMessage(message) {
      if (!child.connected) throw new Error('DeepSeek Harness backend IPC channel is closed')
      if (message === null || typeof message !== 'object') throw new Error('DeepSeek Harness backend IPC requires an object message')
      child.send(message)
    },
    kill() { return child.kill() },
  }
}

/** Open only validated Web URLs outside the privileged desktop process. */
async function openExternal(candidate: string): Promise<void> {
  const url = safeExternalUrl(candidate)
  if (url === undefined) return
  try {
    await shell.openExternal(url)
  } catch (error) {
    console.error('DeepSeek Harness: failed to open external URL', error)
  }
}

/** Apply navigation, popup, webview, and permission restrictions to the app window. */
function secureWindow(window: BrowserWindow, appOrigin: string): void {
  const { webContents } = window
  webContents.on('will-attach-webview', (event) => { event.preventDefault() })
  webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url, appOrigin)) return
    event.preventDefault()
    void openExternal(url)
  })
  webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url, appOrigin)) {
      void webContents.loadURL(url)
    } else {
      void openExternal(url)
    }
    return { action: 'deny' }
  })

  const session = webContents.session
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return permission === 'clipboard-sanitized-write' && isAppUrl(requestingOrigin, appOrigin)
  })
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const requestingUrl = details.requestingUrl
    callback(permission === 'clipboard-sanitized-write' && isAppUrl(requestingUrl, appOrigin))
  })
}

/** Create the native window and keep the loading page visible until DSH is ready. */
async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f4f7fb',
    autoHideMenuBar: true,
    title: 'DeepSeek Harness',
    icon: fileURLToPath(new URL('../assets/icon.svg', import.meta.url)),
    webPreferences: {
      partition: APP_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  })
  window.once('ready-to-show', () => { window.show() })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })
  await window.loadFile(LOADING_PAGE)
  if (!window.isVisible()) window.show()
  return window
}

/** Display a native fatal error, stop the backend, and finish application exit. */
async function failAndQuit(title: string, error: unknown): Promise<void> {
  if (quitRequested) return
  quitRequested = true
  const detail = error instanceof Error ? error.message : String(error)
  console.error(`${title}: ${detail}`)
  dialog.showErrorBox(title, detail)
  try {
    await backend?.stop()
  } catch (stopError) {
    console.error('DeepSeek Harness: backend cleanup failed', stopError)
  }
  shutdownComplete = true
  app.quit()
}

/** Boot one desktop lifetime after Electron is ready. */
async function launch(): Promise<void> {
  Menu.setApplicationMenu(null)
  app.setAppUserModelId(APP_ID)
  mainWindow = await createWindow()
  backend = new DshBackend(spawnBackend, {
    modulePath: await resolveDshBin(),
    cwd: app.getPath('home'),
    environment: process.env,
  })
  backend.onUnexpectedExit((exit) => {
    void failAndQuit(
      'DeepSeek Harness backend stopped',
      new Error(`The backend exited unexpectedly with code ${String(exit.code)}.\n\n${exit.diagnostics}`),
    )
  })
  backendUrl = await backend.start()
  secureWindow(mainWindow, backendUrl)
  await mainWindow.loadURL(backendUrl)
}

/** Coalesce app quit events around one bounded backend shutdown. */
function beginShutdown(): Promise<void> {
  if (shutdownPromise !== undefined) return shutdownPromise
  quitRequested = true
  shutdownPromise = (async () => {
    try {
      await backend?.stop()
    } catch (error) {
      console.error('DeepSeek Harness: backend did not stop cleanly', error)
    } finally {
      shutdownComplete = true
    }
  })()
  return shutdownPromise
}

app.enableSandbox()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === undefined) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  app.on('before-quit', (event) => {
    if (shutdownComplete || backend === undefined) return
    event.preventDefault()
    void beginShutdown().then(() => { app.quit() })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => {
    const url = backendUrl
    if (mainWindow !== undefined || url === undefined) return
    void createWindow().then(async (window) => {
      mainWindow = window
      secureWindow(window, url)
      await window.loadURL(url)
    }).catch((error: unknown) => { void failAndQuit('DeepSeek Harness could not open a window', error) })
  })
  void app.whenReady()
    .then(launch)
    .catch((error: unknown) => { void failAndQuit('DeepSeek Harness could not start', error) })
}
