/** Keep Electron Builder's workspace dependency graph closed over required peers. */

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../..')
const SKIPPED_DIRECTORIES = new Set(['dist', 'lib', 'node_modules', 'release'])

/** Read workspace manifests without depending on a shell glob or package manager. */
function workspaceManifests(): Map<string, PackageManifest> {
  const manifests = new Map<string, PackageManifest>()
  const queue = [REPOSITORY_ROOT]
  while (queue.length > 0) {
    const directory = queue.pop()
    if (directory === undefined) continue
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue
        queue.push(join(directory, entry.name))
        continue
      }
      if (entry.name !== 'package.json') continue
      const manifest = JSON.parse(readFileSync(join(directory, entry.name), 'utf8')) as PackageManifest
      if (manifest.name !== undefined) manifests.set(manifest.name, manifest)
    }
  }
  return manifests
}

describe('packaged runtime closure', () => {
  it('makes every required workspace peer reachable through production dependencies', () => {
    const workspace = workspaceManifests()
    const reachable = new Set<string>()
    const queue = ['deepseek-harness-electron']
    for (let index = 0; index < queue.length; index += 1) {
      const name = queue[index]
      if (name === undefined || reachable.has(name)) continue
      reachable.add(name)
      const manifest = workspace.get(name)
      if (manifest === undefined) continue
      const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies }
      for (const dependency of Object.keys(dependencies)) {
        if (workspace.has(dependency) && !reachable.has(dependency)) queue.push(dependency)
      }
    }

    const missing: string[] = []
    for (const packageName of [...reachable].sort()) {
      const manifest = workspace.get(packageName)
      if (manifest === undefined) continue
      for (const peer of Object.keys(manifest.peerDependencies ?? {}).sort()) {
        if (!workspace.has(peer) || manifest.peerDependenciesMeta?.[peer]?.optional === true) continue
        if (!reachable.has(peer)) missing.push(`${packageName} -> ${peer}`)
      }
    }
    expect(missing, 'Electron Builder does not auto-install workspace peers').toEqual([])
  })
})
