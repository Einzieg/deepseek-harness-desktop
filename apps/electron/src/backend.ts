/** Supervised lifecycle for the private loopback `dsh web` backend. */

/** Message understood by the CLI's optional parent supervisor. */
const PARENT_SHUTDOWN_MESSAGE = 'dsh:shutdown'
/** Readiness line owned by the Web application bundle. */
const READY_LINE = /(?:^|\r?\n)dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)(?=\s|$)/
/** Maximum retained output used in fail-loud desktop diagnostics. */
const OUTPUT_LIMIT = 64 * 1024

/** Child-process operations the lifecycle owns. */
export interface BackendProcess {
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  readonly pid: number | undefined
  onExit(listener: (code: number) => void): void
  onError(listener: (detail: string) => void): void
  postMessage(message: unknown): void
  kill(): boolean
}

/** Inputs passed to the Electron-specific process adapter. */
export interface BackendSpawnRequest {
  readonly modulePath: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly environment: NodeJS.ProcessEnv
}

/** Electron-free process factory, replaceable by focused lifecycle tests. */
export type BackendSpawner = (request: BackendSpawnRequest) => BackendProcess

/** Configuration for one desktop backend lifetime. */
export interface DshBackendOptions {
  readonly modulePath: string
  readonly cwd: string
  readonly environment: NodeJS.ProcessEnv
  readonly startupTimeoutMs?: number
  readonly shutdownGraceMs?: number
  readonly forceWaitMs?: number
}

/** Unexpected exit observed after the backend had announced readiness. */
export interface BackendExit {
  readonly code: number
  readonly diagnostics: string
}

/** Format an unknown stream chunk without assuming Buffer-only output. */
function chunkText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8')
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8')
  }
  return String(chunk)
}

/** Validate that a readiness candidate is an uncredentialed loopback HTTP URL. */
function validateReadyUrl(candidate: string): string | undefined {
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return undefined
    if (url.username !== '' || url.password !== '' || url.port === '') return undefined
    const port = Number(url.port)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
    const parameters = [...url.searchParams.entries()]
    if (url.pathname !== '/' || url.hash !== '') return undefined
    if (parameters.length !== 1 || parameters[0]?.[0] !== 'token') return undefined
    if (!/^[A-Za-z0-9_-]+$/u.test(parameters[0][1])) return undefined
    return url.href
  } catch {
    return undefined
  }
}

/** Wait for a promise within a bounded interval without leaving a live timer. */
async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => { resolve(false) }, timeoutMs)
  })
  try {
    return await Promise.race([promise.then(() => true), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** One start-once, stop-once supervised `dsh web` process. */
export class DshBackend {
  private readonly startupTimeoutMs: number
  private readonly shutdownGraceMs: number
  private readonly forceWaitMs: number
  private child: BackendProcess | undefined
  private exitPromise: Promise<number> | undefined
  private startPromise: Promise<string> | undefined
  private stopPromise: Promise<void> | undefined
  private stdout = ''
  private output = ''
  private ready = false
  private stopRequested = false
  private unexpectedExit: ((exit: BackendExit) => void) | undefined

  constructor(
    private readonly spawn: BackendSpawner,
    private readonly options: DshBackendOptions,
  ) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? 60_000
    this.shutdownGraceMs = options.shutdownGraceMs ?? 5_000
    this.forceWaitMs = options.forceWaitMs ?? 2_000
  }

  /** Register the owner invoked when a ready backend later exits on its own. */
  onUnexpectedExit(listener: (exit: BackendExit) => void): void {
    this.unexpectedExit = listener
  }

  /** Last bounded stdout/stderr/error context for a native error dialog. */
  diagnostics(): string {
    const trimmed = this.output.trim()
    return trimmed === '' ? 'No backend diagnostic output was produced.' : trimmed
  }

  /** Start the Web profile on an OS-assigned loopback port and await its readiness line. */
  start(): Promise<string> {
    if (this.startPromise !== undefined) return this.startPromise
    this.startPromise = this.startOnce()
    return this.startPromise
  }

  /** Request complete profile disposal, then escalate only after the grace deadline. */
  stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise
    this.stopPromise = this.stopOnce()
    return this.stopPromise
  }

  private appendOutput(channel: 'stdout' | 'stderr' | 'process', text: string): void {
    this.output = `${this.output}[${channel}] ${text}`.slice(-OUTPUT_LIMIT)
  }

  private async startOnce(): Promise<string> {
    if (this.stopRequested) throw new Error('DeepSeek Harness backend was stopped before startup')
    const child = this.spawn({
      modulePath: this.options.modulePath,
      args: ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'],
      cwd: this.options.cwd,
      environment: this.options.environment,
    })
    this.child = child

    let resolveExit!: (code: number) => void
    this.exitPromise = new Promise<number>((resolve) => { resolveExit = resolve })
    child.onExit((code) => {
      resolveExit(code)
      if (this.ready && !this.stopRequested) {
        this.unexpectedExit?.({ code, diagnostics: this.diagnostics() })
      }
    })
    child.onError((detail) => { this.appendOutput('process', `${detail}\n`) })

    let resolveReady!: (url: string) => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<string>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    let settled = false
    const acceptReady = (url: string): void => {
      if (settled) return
      settled = true
      this.ready = true
      resolveReady(url)
    }
    const failReady = (message: string): void => {
      if (settled) return
      settled = true
      rejectReady(new Error(`${message}\n\n${this.diagnostics()}`))
    }

    child.stdout?.on('data', (chunk: unknown) => {
      const text = chunkText(chunk)
      this.stdout = `${this.stdout}${text}`.slice(-OUTPUT_LIMIT)
      this.appendOutput('stdout', text)
      const match = READY_LINE.exec(this.stdout)
      const url = match?.[1] === undefined ? undefined : validateReadyUrl(match[1])
      if (url !== undefined) acceptReady(url)
    })
    child.stderr?.on('data', (chunk: unknown) => {
      this.appendOutput('stderr', chunkText(chunk))
    })
    void this.exitPromise.then((code) => {
      failReady(`DeepSeek Harness backend exited before readiness (code ${String(code)})`)
    })

    const timer = setTimeout(() => {
      failReady(`DeepSeek Harness backend did not become ready within ${String(this.startupTimeoutMs)} ms`)
    }, this.startupTimeoutMs)
    try {
      return await ready
    } finally {
      clearTimeout(timer)
    }
  }

  private async stopOnce(): Promise<void> {
    this.stopRequested = true
    const child = this.child
    const exit = this.exitPromise
    if (child === undefined || exit === undefined) return

    try {
      child.postMessage({ type: PARENT_SHUTDOWN_MESSAGE })
    } catch (error) {
      this.appendOutput('process', `Could not request graceful shutdown: ${String(error)}\n`)
    }
    if (await settlesWithin(exit, this.shutdownGraceMs)) return

    this.appendOutput('process', `Graceful shutdown exceeded ${String(this.shutdownGraceMs)} ms; terminating backend.\n`)
    child.kill()
    if (!await settlesWithin(exit, this.forceWaitMs)) {
      throw new Error(`DeepSeek Harness backend process ${String(child.pid ?? 'unknown')} did not exit after termination`)
    }
  }
}
