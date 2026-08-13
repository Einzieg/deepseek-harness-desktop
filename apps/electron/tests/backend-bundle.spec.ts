/** Packaged backend integrity, short-cache materialization, and reuse. */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { materializeBackendBundle, parseBackendDigest } from '../src/backend-bundle.ts'

const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-electron-backend-'))
  temporaryRoots.push(root)
  return root
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('packaged backend bundle', () => {
  it('rejects malformed digest sidecars', () => {
    expect(() => parseBackendDigest('not-a-digest')).toThrow(/missing or malformed/)
    expect(parseBackendDigest(`${'a'.repeat(64)}\n`)).toBe('a'.repeat(64))
  })

  it('verifies, materializes, and reuses a standard short-path node_modules cache', async () => {
    const root = temporaryRoot()
    const archiveRoot = join(root, 'archive-root')
    const bin = join(archiveRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    mkdirSync(join(archiveRoot, '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    writeFileSync(bin, 'first', 'utf8')

    const archiveFile = join(root, 'backend.asar')
    const archiveBytes = 'physical archive bytes'
    writeFileSync(archiveFile, archiveBytes, 'utf8')
    const digest = sha256(archiveBytes)
    const digestPath = join(root, 'backend.asar.sha256')
    writeFileSync(digestPath, `${digest}\n`, 'utf8')
    const cacheRoot = join(root, 'cache')

    const first = await materializeBackendBundle({
      archivePath: archiveRoot,
      archiveFilePath: archiveFile,
      digestPath,
      cacheRoot,
    })
    expect(basename(first)).toBe('node_modules')
    expect(readFileSync(join(first, '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'utf8')).toBe('first')

    writeFileSync(bin, 'changed', 'utf8')
    const second = await materializeBackendBundle({
      archivePath: archiveRoot,
      archiveFilePath: archiveFile,
      digestPath,
      cacheRoot,
    })
    expect(second).toBe(first)
    expect(readFileSync(join(second, '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'utf8')).toBe('first')
  })

  it('rejects a backend archive whose physical digest does not match', async () => {
    const root = temporaryRoot()
    const archiveRoot = join(root, 'archive-root')
    mkdirSync(archiveRoot)
    const archiveFile = join(root, 'backend.asar')
    writeFileSync(archiveFile, 'corrupt', 'utf8')
    const digestPath = join(root, 'backend.asar.sha256')
    writeFileSync(digestPath, `${'0'.repeat(64)}\n`, 'utf8')

    await expect(materializeBackendBundle({
      archivePath: archiveRoot,
      archiveFilePath: archiveFile,
      digestPath,
      cacheRoot: join(root, 'cache'),
    })).rejects.toThrow(/integrity check failed/)
  })
})
