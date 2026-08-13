/** Collapse the external-Node dependency tree into one install-safe ASAR. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPackage, listPackage } from '@electron/asar'

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** @param {import('electron-builder').AfterPackContext} context */
export default async function archiveBackend(context) {
  if (context.electronPlatformName !== 'win32') return
  const resources = join(context.appOutDir, 'resources')
  const unpackedRoot = join(resources, 'app.asar.unpacked')
  const source = join(unpackedRoot, 'node_modules')
  const archive = join(resources, 'backend.asar')
  const digestPath = `${archive}.sha256`

  await rm(archive, { force: true })
  await rm(digestPath, { force: true })
  await createPackage(source, archive)

  const entries = new Set(listPackage(archive).map(entry => entry.replaceAll('\\', '/').replace(/^\//, '')))
  const required = [
    '@deepseek-ai/dsh/lib/bin.js',
    '@deepseek-ai/dsh-session-telemetry-otel/node_modules/@opentelemetry/resources/build/src/detectors/platform/node/machine-id/getMachineId.js',
  ]
  for (const entry of required) {
    if (!entries.has(entry)) throw new Error(`Packaged backend archive is missing ${entry}`)
  }

  const digest = await sha256File(archive)
  await writeFile(digestPath, `${digest}\n`, 'utf8')
  await rm(unpackedRoot, { recursive: true, force: true })
  console.log(`  • archived external Node backend  file=${archive} sha256=${digest}`)
}
