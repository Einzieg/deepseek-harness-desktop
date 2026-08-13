/** Parent-supervised CLI disposal without an Electron dependency in the CLI package. */

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  attachParentSupervisor,
  PARENT_READY_MESSAGE,
  PARENT_SHUTDOWN_MESSAGE,
  resolveParentSupervisorPort,
  type ParentSupervisorPort,
} from '../src/parent-supervisor.ts'

class FakeParentPort extends EventEmitter implements ParentSupervisorPort {
  readonly sent: unknown[] = []

  postMessage(message: unknown): void {
    this.sent.push(message)
  }

  onDisconnect(listener: () => void): void {
    this.on('disconnect', listener)
  }
}

describe('parent supervisor', () => {
  it('leaves ordinary Node processes unchanged', () => {
    expect(resolveParentSupervisorPort({} as NodeJS.Process)).toBeUndefined()
    expect(attachParentSupervisor({ shutdown: vi.fn(), interrupt: vi.fn() }, null)).toBe(false)
  })

  it('announces readiness and awaits one exact shutdown request before exit', async () => {
    const port = new FakeParentPort()
    const shutdown = vi.fn(async () => {})
    const exit = vi.fn()

    expect(attachParentSupervisor({ shutdown, interrupt: vi.fn() }, port, exit)).toBe(true)
    expect(port.sent).toEqual([{ type: PARENT_READY_MESSAGE }])

    port.emit('message', { data: { type: 'unrelated' } })
    port.emit('message', { data: { type: PARENT_SHUTDOWN_MESSAGE } })
    port.emit('message', { data: { type: PARENT_SHUTDOWN_MESSAGE } })
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(0) })

    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(shutdown).toHaveBeenCalledWith(0)
  })

  it('disposes when a Node IPC parent disconnects', async () => {
    const port = new FakeParentPort()
    const shutdown = vi.fn(async () => {})
    const exit = vi.fn()
    attachParentSupervisor({ shutdown, interrupt: vi.fn() }, port, exit)

    port.emit('disconnect')
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(0) })
    expect(shutdown).toHaveBeenCalledTimes(1)
  })
})
