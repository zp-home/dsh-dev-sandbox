/** Optional DSH Desktop adapter for the development-sandbox Host plugin. */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxBuildRunner, SandboxHostProfile } from './manager.ts'

/** Public Desktop profile capability, represented structurally to keep Desktop optional at runtime. */
interface DesktopProfilesLike {
  readonly current: {
    readonly name: string
    readonly dir: string
  }
}

/** Public Desktop package-manager operation outcome. */
interface DesktopPnpmOutcomeLike {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

/** Public Desktop package-manager operation handle. */
interface DesktopPnpmHandleLike {
  readonly stdout: { resume?: () => unknown }
  readonly stderr: { resume?: () => unknown }
  readonly done: Promise<DesktopPnpmOutcomeLike>
  cancel(): void
}

/** Public Desktop package-manager capability used for an explicit plugin build. */
interface DesktopPnpmLike {
  run(args: readonly string[], signal?: AbortSignal): DesktopPnpmHandleLike
}

/** Active Desktop capabilities adapted for one plugin generation. */
export interface DesktopSandboxAdapter {
  readonly hostProfile: SandboxHostProfile
  readonly buildRunner: SandboxBuildRunner
}

const BUILD_TIMEOUT_MS = 5 * 60_000

/** Read a late-bound Cordis service without making it a top-level dependency. */
function service(ctx: Context, name: string): unknown {
  return (ctx as unknown as { get(name: string): unknown }).get(name)
}

/** Narrow the documented public profile service shape. */
function isDesktopProfiles(value: unknown): value is DesktopProfilesLike {
  if (value === null || typeof value !== 'object') return false
  const current = (value as { current?: unknown }).current
  if (current === null || typeof current !== 'object') return false
  const candidate = current as { name?: unknown; dir?: unknown }
  return typeof candidate.name === 'string'
    && candidate.name.length > 0
    && !candidate.name.includes('\0')
    && typeof candidate.dir === 'string'
    && isAbsolute(candidate.dir)
    && !candidate.dir.includes('\0')
}

/** Narrow the documented public package-manager service shape. */
function isDesktopPnpm(value: unknown): value is DesktopPnpmLike {
  return value !== null
    && typeof value === 'object'
    && typeof (value as { run?: unknown }).run === 'function'
}

/** Drain an operation stream so a verbose build cannot block its child process. */
function drain(stream: { resume?: () => unknown }): void {
  stream.resume?.()
}

/**
 * Adapt the documented Desktop services for this external plugin.
 *
 * The host plugin calls this only from a nested
 * `ctx.inject(['desktopProfiles', 'desktopPnpm'])` callback. Structural forms
 * keep standalone typechecking independent of the optional Desktop package
 * tree when the same package runs in ordinary DSH.
 */
export function desktopSandboxAdapter(ctx: Context): DesktopSandboxAdapter | undefined {
  const profiles = service(ctx, 'desktopProfiles')
  const pnpm = service(ctx, 'desktopPnpm')
  if (!isDesktopProfiles(profiles) || !isDesktopPnpm(pnpm)) return undefined

  const hostProfile = Object.freeze({
    name: profiles.current.name,
    dir: profiles.current.dir,
  })
  const buildRunner: SandboxBuildRunner = {
    async build(pluginPath: string, signal?: AbortSignal): Promise<number> {
      if (!isAbsolute(pluginPath) || pluginPath.includes('\0')) {
        throw new Error('dsh-dev-sandbox: Desktop plugin build path must be absolute and NUL-free')
      }
      const timeout = AbortSignal.timeout(BUILD_TIMEOUT_MS)
      const buildSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
      const operation = pnpm.run(['--dir', pluginPath, 'run', 'build'], buildSignal)
      const cancel = () => operation.cancel()
      if (buildSignal.aborted) cancel()
      else buildSignal.addEventListener('abort', cancel, { once: true })
      try {
        drain(operation.stdout)
        drain(operation.stderr)
        const outcome = await operation.done
        if (outcome.signal !== null) {
          const reason = timeout.aborted
            ? `timed out after ${BUILD_TIMEOUT_MS}ms`
            : buildSignal.aborted
              ? 'was cancelled'
              : 'was terminated'
          throw new Error(`dsh-dev-sandbox: Desktop plugin build ${reason} (signal ${outcome.signal})`)
        }
        return outcome.exitCode ?? 1
      } finally {
        buildSignal.removeEventListener('abort', cancel)
      }
    },
  }
  return { hostProfile, buildRunner }
}
