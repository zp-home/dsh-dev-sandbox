/**
 * Locate the dsh installation the sandboxes boot from.
 *
 * A sandbox is a fresh DSH CLI process with its own `DSH_HOME`. Source
 * checkouts use `node --import tsx/esm apps/cli/src/bin.ts web`; published npm
 * installs use the compiled entry declared by `@deepseek-ai/dsh` instead. The
 * harness is resolved lazily on first `start`, so a resolution failure never
 * blocks the plugin from mounting — it surfaces as a per-request error.
 * @module dsh-dev-sandbox/harness
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** How the selected DSH CLI is launched. */
export type HarnessKind = 'source' | 'installed'

/** What a sandbox needs to know about the harness it boots. */
export interface HarnessInfo {
  /** Source checkout root or installed @deepseek-ai/dsh package root. */
  root: string
  /** Absolute path of the CLI entry. */
  cliEntry: string
  /** Node arguments that must precede the CLI entry. */
  nodeArgs: string[]
  /** Whether the selected CLI is source or a published build. */
  kind: HarnessKind
  /** The node binary used to spawn sandboxes (the host's own executable). */
  nodeExec: string
}

/** How far any discovery walk climbs looking for the checkout anchor. */
const MAX_UPSTEPS = 16

/** Whether `dir` looks like a dsh source checkout (has the source CLI entry). */
function isCheckout(dir: string): boolean {
  return existsSync(join(dir, 'apps', 'cli', 'src', 'bin.ts'))
}

/** Resolve the published CLI entry declared by an installed @deepseek-ai/dsh package. */
function installedCliEntry(dir: string): string | undefined {
  const manifestFile = join(dir, 'package.json')
  if (!existsSync(manifestFile)) return undefined
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { name?: unknown; bin?: unknown }
    if (manifest.name !== '@deepseek-ai/dsh') return undefined
    const bin = typeof manifest.bin === 'string'
      ? manifest.bin
      : manifest.bin !== null && typeof manifest.bin === 'object'
        ? (manifest.bin as Record<string, unknown>).dsh
        : undefined
    if (typeof bin !== 'string' || bin.trim() === '') return undefined
    const entry = resolve(dir, bin)
    return existsSync(entry) ? entry : undefined
  } catch {
    return undefined
  }
}

/** Return launch metadata for either a source checkout or published CLI root. */
function infoFor(dir: string): HarnessInfo | undefined {
  const root = resolve(dir)
  if (isCheckout(root)) {
    return {
      root,
      cliEntry: join(root, 'apps', 'cli', 'src', 'bin.ts'),
      nodeArgs: ['--import', 'tsx/esm'],
      kind: 'source',
      nodeExec: process.execPath,
    }
  }
  const cliEntry = installedCliEntry(root)
  if (cliEntry !== undefined) {
    return { root, cliEntry, nodeArgs: [], kind: 'installed', nodeExec: process.execPath }
  }
  return undefined
}

/** Walk up from `start` (bounded) and return the first supported DSH root. */
function walkUp(start: string): HarnessInfo | undefined {
  let dir = resolve(start)
  for (let step = 0; step < MAX_UPSTEPS; step++) {
    const info = infoFor(dir)
    if (info !== undefined) return info
    const parent = resolve(dir, '..')
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** Find the sibling published CLI package from a package installed under node_modules. */
function siblingCliFromNodeModules(start: string): HarnessInfo | undefined {
  let dir = resolve(start)
  for (let step = 0; step < MAX_UPSTEPS; step++) {
    if (basename(dir) === 'node_modules') return infoFor(join(dir, '@deepseek-ai', 'dsh'))
    const parent = resolve(dir, '..')
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/**
 * Resolve the harness root from an explicit config value or by discovery.
 * @param configured - `harnessRoot` from the plugin config; a source checkout or installed CLI package root.
 * @returns the selected DSH root, CLI entry, and node executable.
 * @throws when neither the configured path nor discovery yields a supported CLI.
 */
export function resolveHarness(configured: string | undefined): HarnessInfo {
  if (configured !== undefined && configured.trim() !== '') {
    const root = resolve(configured)
    const info = infoFor(root)
    if (info === undefined) {
      throw new Error(
        `dsh-dev-sandbox: harnessRoot ${root} is not a dsh source checkout or installed @deepseek-ai/dsh package `
        + '(expected apps/cli/src/bin.ts or package.json with a working dsh bin entry)',
      )
    }
    return info
  }
  // The development instance and source-backed sandboxes run from the checkout
  // root. Published npm installs instead expose the compiled CLI through argv.
  const cwdInfo = walkUp(process.cwd())
  if (cwdInfo !== undefined) return cwdInfo
  const argvInfo = process.argv[1] === undefined ? undefined : walkUp(dirname(process.argv[1]))
  if (argvInfo !== undefined) return argvInfo
  // This plugin's own real location is a best-effort source checkout anchor.
  if (import.meta.url.startsWith('file:')) {
    const ownInfo = walkUp(dirname(fileURLToPath(import.meta.url)))
    if (ownInfo !== undefined) return ownInfo
  }
  try {
    const require = createRequire(import.meta.url)
    const cliPkg = require.resolve('@deepseek-ai/dsh/package.json')
    const installedInfo = infoFor(dirname(cliPkg))
    if (installedInfo !== undefined) return installedInfo
    const bootPkg = require.resolve('@deepseek-ai/dsh-app-boot/package.json')
    const siblingInfo = siblingCliFromNodeModules(dirname(bootPkg))
    if (siblingInfo !== undefined) return siblingInfo
    const bootInfo = walkUp(dirname(bootPkg))
    if (bootInfo !== undefined) return bootInfo
  } catch {
    // Discovery failed — the explicit error below is the user-facing contract.
  }
  throw new Error(
    'dsh-dev-sandbox: cannot locate the dsh installation automatically. '
    + 'Set "harnessRoot" to a dsh source checkout or installed @deepseek-ai/dsh package directory.',
  )
}
