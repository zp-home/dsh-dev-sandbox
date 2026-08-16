/**
 * Locate the dsh installation the sandboxes boot from.
 *
 * A sandbox is a fresh `node --import tsx/esm <harness>/apps/cli/src/bin.ts web`
 * process with its own `DSH_HOME`. The harness root is resolved lazily on the
 * first `start` through a candidate chain, so a resolution failure never
 * blocks the plugin from mounting — it surfaces as a per-request error:
 *   1. an explicit `harnessRoot` config value;
 *   2. the process working directory (both the development instance and every
 *      spawned sandbox run with cwd = the harness checkout root);
 *   3. walking up from this plugin's real location;
 *   4. resolving `@deepseek-ai/dsh-app-boot` from this plugin's require scope
 *      (the healed `profiles/node_modules` fallback) and walking up from it.
 * @module dsh-dev-sandbox/harness
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** What a sandbox needs to know about the harness it boots. */
export interface HarnessInfo {
  /** Absolute harness root (the directory containing apps/cli/src/bin.ts). */
  root: string
  /** Absolute path of the source CLI entry. */
  cliEntry: string
  /** The node binary used to spawn sandboxes (the host's own executable). */
  nodeExec: string
}

/** How far any discovery walk climbs looking for the checkout anchor. */
const MAX_UPSTEPS = 16

/** Whether `dir` looks like a dsh source checkout (has the source CLI entry). */
function isCheckout(dir: string): boolean {
  return existsSync(join(dir, 'apps', 'cli', 'src', 'bin.ts'))
}

/** Walk up from `start` (bounded) and return the first checkout directory. */
function walkUp(start: string): string | undefined {
  let dir = resolve(start)
  for (let step = 0; step < MAX_UPSTEPS; step++) {
    if (isCheckout(dir)) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/**
 * Resolve the harness root from an explicit config value or by discovery.
 * @param configured - `harnessRoot` from the plugin config; absolute path of a dsh source checkout.
 * @returns the harness root, CLI entry, and node executable.
 * @throws when neither the configured path nor discovery yields a checkout.
 */
export function resolveHarness(configured: string | undefined): HarnessInfo {
  const nodeExec = process.execPath
  if (configured !== undefined && configured.trim() !== '') {
    const root = resolve(configured)
    if (!isCheckout(root)) {
      throw new Error(
        `dsh-dev-sandbox: harnessRoot ${root} is not a dsh source checkout `
        + '(apps/cli/src/bin.ts not found)',
      )
    }
    return { root, cliEntry: join(root, 'apps', 'cli', 'src', 'bin.ts'), nodeExec }
  }
  // The process working directory: the dev instance is launched from the
  // checkout root and every sandbox is spawned with cwd = the checkout root.
  const cwdRoot = walkUp(process.cwd())
  if (cwdRoot !== undefined) {
    return { root: cwdRoot, cliEntry: join(cwdRoot, 'apps', 'cli', 'src', 'bin.ts'), nodeExec }
  }
  // This plugin's own real location (the loader may import it through a
  // virtual URL, so this is a best-effort anchor).
  if (import.meta.url.startsWith('file:')) {
    const ownRoot = walkUp(dirname(import.meta.url.replace(/^file:\/\//, '').split('/').map(decodeURIComponent).join('/')))
    if (ownRoot !== undefined) {
      return { root: ownRoot, cliEntry: join(ownRoot, 'apps', 'cli', 'src', 'bin.ts'), nodeExec }
    }
  }
  // The resolved app-boot package (the healed profiles fallback symlinks into
  // the hosting installation).
  try {
    const require = createRequire(import.meta.url)
    const bootPkg = require.resolve('@deepseek-ai/dsh-app-boot/package.json')
    const bootRoot = walkUp(dirname(bootPkg))
    if (bootRoot !== undefined) {
      return { root: bootRoot, cliEntry: join(bootRoot, 'apps', 'cli', 'src', 'bin.ts'), nodeExec }
    }
  } catch {
    // Discovery failed — the explicit error below is the user-facing contract.
  }
  throw new Error(
    'dsh-dev-sandbox: cannot locate the dsh installation automatically. '
    + 'Set "harnessRoot" in the dev-sandbox row config to the absolute path of the dsh source checkout '
    + '(the directory that contains apps/cli/src/bin.ts).',
  )
}
