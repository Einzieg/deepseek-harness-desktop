/** Verified first-run materialization for the packaged external-Node backend. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const READY_MARKER = '.ready.sha256'

/** Inputs for one immutable packaged backend archive. */
export interface BackendBundleOptions {
  /** Electron-readable ASAR root whose entries are copied into the cache. */
  readonly archivePath: string
  /** Physical archive used for integrity verification; defaults to archivePath. */
  readonly archiveFilePath?: string
  /** UTF-8 sidecar containing the expected lowercase SHA-256 digest. */
  readonly digestPath: string
  /** App-owned short cache root, kept outside the installation directory. */
  readonly cacheRoot: string
}

/** Return whether a path exists without hiding non-ENOENT failures. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Parse the build-produced digest sidecar without accepting ambiguous data. */
export function parseBackendDigest(value: string): string {
  const digest = value.trim()
  if (!SHA256_PATTERN.test(digest)) {
    throw new Error('Packaged backend digest is missing or malformed')
  }
  return digest
}

/** Hash the physical ASAR file rather than Electron's virtual archive root. */
async function sha256PhysicalFile(path: string): Promise<string> {
  const electronProcess = process as NodeJS.Process & { noAsar?: boolean }
  const previousNoAsar = electronProcess.noAsar
  electronProcess.noAsar = true
  try {
    const hash = createHash('sha256')
    await pipeline(createReadStream(path), hash)
    return hash.digest('hex')
  } finally {
    electronProcess.noAsar = previousNoAsar
  }
}

/** Copy a regular directory or Electron ASAR tree without following links. */
async function copyBackendTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  const entries = await readdir(source, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const sourcePath = join(source, entry.name)
    const destinationPath = join(destination, entry.name)
    if (entry.isDirectory()) {
      await copyBackendTree(sourcePath, destinationPath)
    } else if (entry.isFile()) {
      await copyFile(sourcePath, destinationPath)
    } else {
      throw new Error(`Packaged backend contains an unsupported entry: ${entry.name}`)
    }
  }
}

/** Required CLI entry used both as a cache health check and the spawn target. */
function dshBin(nodeModules: string): string {
  return join(nodeModules, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/** Decide whether an existing immutable cache is complete for this archive. */
async function cacheReady(target: string, digest: string): Promise<boolean> {
  try {
    const marker = parseBackendDigest(await readFile(join(target, READY_MARKER), 'utf8'))
    return marker === digest && await exists(dshBin(target))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    if (error instanceof Error && error.message === 'Packaged backend digest is missing or malformed') return false
    throw error
  }
}

/**
 * Verify and materialize one backend ASAR into a short, digest-marked
 * `node_modules` directory. Keeping that conventional directory name is
 * required by Node's ESM package resolver for top-level workspace peers.
 * The fixed staging name is safe because Electron already owns a single-instance
 * lock before this function runs.
 */
export async function materializeBackendBundle(options: BackendBundleOptions): Promise<string> {
  const digest = parseBackendDigest(await readFile(options.digestPath, 'utf8'))
  const target = join(options.cacheRoot, 'node_modules')
  if (await cacheReady(target, digest)) return target

  const actualDigest = await sha256PhysicalFile(options.archiveFilePath ?? options.archivePath)
  if (actualDigest !== digest) {
    throw new Error(`Packaged backend integrity check failed: expected ${digest}, received ${actualDigest}`)
  }

  await mkdir(options.cacheRoot, { recursive: true })
  const staging = join(options.cacheRoot, 't')
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging)
  try {
    await copyBackendTree(options.archivePath, staging)
    if (!await exists(dshBin(staging))) {
      throw new Error('Packaged backend archive does not contain @deepseek-ai/dsh/lib/bin.js')
    }
    await writeFile(join(staging, READY_MARKER), `${digest}\n`, 'utf8')
    await rm(target, { recursive: true, force: true })
    await rename(staging, target)
    return target
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}
