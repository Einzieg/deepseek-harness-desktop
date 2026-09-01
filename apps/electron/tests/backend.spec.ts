/** Desktop backend readiness, crash reporting, and bounded teardown. */

import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshBackend, type BackendExit, type BackendProcess, type BackendSpawnRequest } from '../src/backend.ts'

class FakeBackendProcess implements BackendProcess {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 42
  readonly messages: unknown[] = []
  killed = false
  private readonly exitListeners: Array<(code: number) => void> = []
  private readonly errorListeners: Array<(detail: string) => void> = []

  onExit(listener: (code: number) => void): void { this.exitListeners.push(listener) }
  onError(listener: (detail: string) => void): void { this.errorListeners.push(listener) }
  postMessage(message: unknown): void { this.messages.push(message) }
  kill(): boolean { this.killed = true; return true }
  exit(code: number): void { for (const listener of this.exitListeners) listener(code) }
  fail(detail: string): void { for (const listener of this.errorListeners) listener(detail) }
}

function fixture(overrides: Partial<ConstructorParameters<typeof DshBackend>[1]> = {}): {
  backend: DshBackend
  child: FakeBackendProcess
  requests: BackendSpawnRequest[]
} {
  const child = new FakeBackendProcess()
  const requests: BackendSpawnRequest[] = []
  const backend = new DshBackend((request) => {
    requests.push(request)
    return child
  }, {
    modulePath: 'C:\\app\\dsh\\lib\\bin.js',
    cwd: 'C:\\Users\\Test',
    environment: { TESTING: '1' },
    startupTimeoutMs: 1_000,
    shutdownGraceMs: 100,
    forceWaitMs: 100,
    ...overrides,
  })
  return { backend, child, requests }
}

afterEach(() => { vi.useRealTimers() })

describe('DshBackend', () => {
  it('uses a private OS-assigned loopback port and accepts a split readiness line', async () => {
    const { backend, child, requests } = fixture()
    const started = backend.start()
    child.stdout.write('booting\r\ndsh web: http://127.0.0.')
    child.stdout.write('1:43821/?token=test_token-1\r\n')

    await expect(started).resolves.toBe('http://127.0.0.1:43821/?token=test_token-1')
    expect(requests).toEqual([{
      modulePath: 'C:\\app\\dsh\\lib\\bin.js',
      args: ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'],
      cwd: 'C:\\Users\\Test',
      environment: { TESTING: '1' },
    }])
  })

  it('ignores readiness URLs without exactly one valid authentication token', async () => {
    const { backend, child } = fixture()
    const started = backend.start()
    child.stdout.write('dsh web: http://127.0.0.1:43820/\n')
    child.stdout.write('dsh web: http://127.0.0.1:43821/?token=first&token=second\n')
    child.stdout.write('dsh web: http://127.0.0.1:43822/?token=valid_token-2\n')

    await expect(started).resolves.toBe('http://127.0.0.1:43822/?token=valid_token-2')
  })

  it('fails loudly with stderr when the backend exits before readiness', async () => {
    const { backend, child } = fixture()
    const started = backend.start()
    child.stderr.write('profile failed')
    child.exit(17)

    await expect(started).rejects.toThrow(/exited before readiness \(code 17\)[\s\S]*profile failed/)
  })

  it('rejects startup after the bounded readiness deadline', async () => {
    vi.useFakeTimers()
    const { backend } = fixture({ startupTimeoutMs: 50 })
    const started = backend.start()
    const rejected = expect(started).rejects.toThrow(/did not become ready within 50 ms/)
    await vi.advanceTimersByTimeAsync(51)

    await rejected
  })

  it('requests graceful disposal and waits for the child exit', async () => {
    const { backend, child } = fixture()
    const started = backend.start()
    child.stdout.write('dsh web: http://127.0.0.1:40001/?token=test-token\n')
    await started

    const stopped = backend.stop()
    expect(child.messages).toEqual([{ type: 'dsh:shutdown' }])
    expect(child.killed).toBe(false)
    child.exit(0)
    await stopped
    expect(child.killed).toBe(false)
  })

  it('terminates only after graceful disposal exceeds its deadline', async () => {
    vi.useFakeTimers()
    const { backend, child } = fixture({ shutdownGraceMs: 50, forceWaitMs: 50 })
    const started = backend.start()
    child.stdout.write('dsh web: http://127.0.0.1:40002/?token=test-token\n')
    await started

    const stopped = backend.stop()
    await vi.advanceTimersByTimeAsync(51)
    expect(child.killed).toBe(true)
    child.exit(1)
    await stopped
  })

  it('reports an unexpected post-readiness exit with retained diagnostics', async () => {
    const { backend, child } = fixture()
    const unexpected = vi.fn<(exit: BackendExit) => void>()
    backend.onUnexpectedExit(unexpected)
    const started = backend.start()
    child.stdout.write('dsh web: http://127.0.0.1:40003/?token=test-token\n')
    await started
    child.fail('native failure')
    child.exit(9)

    expect(unexpected).toHaveBeenCalledOnce()
    expect(unexpected.mock.calls[0]?.[0].code).toBe(9)
    expect(unexpected.mock.calls[0]?.[0].diagnostics).toMatch(/native failure/)
  })
})
