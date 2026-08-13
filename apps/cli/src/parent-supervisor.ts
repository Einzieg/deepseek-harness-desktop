/** Optional parent-process shutdown channel used by embedded application hosts. */

import type { ProcessShutdown } from './process-shutdown.ts'

/** Namespaced command sent by an embedding host to request graceful disposal. */
export const PARENT_SHUTDOWN_MESSAGE = 'dsh:shutdown'
/** Message confirming that the child installed its shutdown listener. */
export const PARENT_READY_MESSAGE = 'dsh:supervisor-ready'

/** Minimal parent channel shared by Electron utility and Node fork processes. */
export interface ParentSupervisorPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  postMessage(message: unknown): void
  onDisconnect?(listener: () => void): void
}

type SupervisedProcess = NodeJS.Process & {
  parentPort?: ParentSupervisorPort | null
  connected?: boolean
  send?: (message: unknown) => boolean
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'disconnect', listener: () => void): unknown
}

/** Resolve an Electron parent port or Node fork IPC without importing either host API. */
export function resolveParentSupervisorPort(host: NodeJS.Process = process): ParentSupervisorPort | undefined {
  const supervised = host as SupervisedProcess
  const candidate = supervised.parentPort
  if (candidate !== undefined && candidate !== null
    && typeof candidate.on === 'function'
    && typeof candidate.postMessage === 'function') return candidate
  const send = supervised.send
  if (typeof send !== 'function') return undefined
  return {
    on(_event, listener) {
      supervised.on('message', (data) => { listener({ data }) })
    },
    postMessage(message) { send.call(supervised, message) },
    onDisconnect(listener) { supervised.on('disconnect', listener) },
  }
}

/** Whether an IPC payload is the exact namespaced shutdown command. */
function isShutdownMessage(value: unknown): boolean {
  return value !== null
    && typeof value === 'object'
    && 'type' in value
    && value.type === PARENT_SHUTDOWN_MESSAGE
}

/**
 * Attach a graceful shutdown listener when this CLI runs under an application
 * supervisor. Ordinary Node invocations have no parent channel and remain unchanged.
 *
 * Electron and Node fork channels queue messages sent before listener
 * registration, so a desktop host can request shutdown while profile boot is
 * still settling. A Node channel disconnect also disposes the profile, which
 * prevents an orphan backend when its desktop parent terminates unexpectedly.
 * @param shutdown - the booted profile's bounded shutdown controller.
 * @param port - injected parent port, or the current process's Electron port.
 * @param exit - final process exit after complete disposal, replaceable by tests.
 * @returns whether a supervisor channel was attached.
 */
export function attachParentSupervisor(
  shutdown: ProcessShutdown,
  port: ParentSupervisorPort | null | undefined = resolveParentSupervisorPort(),
  exit: (code: number) => void = (code) => { process.exit(code) },
): boolean {
  if (port === undefined || port === null) return false
  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    void shutdown.shutdown(0).then(() => { exit(0) })
  }
  port.on('message', (event) => {
    if (!isShutdownMessage(event.data)) return
    stop()
  })
  port.onDisconnect?.(stop)
  port.postMessage({ type: PARENT_READY_MESSAGE })
  return true
}
