/**
 * @zp-home/dsh-dev-sandbox — DSH plugin developer sandbox.
 *
 * Host half: a lifecycle manager for isolated dsh web instances ("business
 * mirrors"). Each sandbox gets its own DSH_HOME, its own web profile that
 * mounts the plugin under development, and its own port, spawned from the
 * same harness checkout — so plugin work never touches or breaks the
 * development instance. The host half registers `/api/dsh-dev-sandbox/*`
 * routes and the `sandbox_*` agent tools.
 *
 * The browser half (`./client`) renders a sidebar entry + panel for driving
 * the sandboxes from the GUI.
 * @module @zp-home/dsh-dev-sandbox
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { desktopSandboxAdapter, type DesktopSandboxAdapter } from './desktop.ts'
import { defaultHomeRoot, SandboxManager, type ManagerOptions } from './manager.ts'
import { registerRoutes } from './routes.ts'
import { sandboxTools } from './tools.ts'

/** Stable cordis plugin name. */
export const name = 'dev-sandbox'

/** Services required before the sandbox surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Plugin row config, resolved by the loader's schema. */
// schemastery object fields are optional unless `.required()`; `.default()`
// supplies the fallback the apply() re-reads.
export const Config = z.object({
  /** Absolute sandbox root; each sandbox is one subdirectory (its DSH_HOME). */
  homeRoot: z.string().default('~/.dsh-sandboxes'),
  /** Optional absolute path of the dsh source checkout to boot sandboxes from. */
  harnessRoot: z.string(),
  /** First port tried when allocating a sandbox port. */
  basePort: z.natural().default(4000),
  /** Run the plugin's build script before every start. */
  buildOnStart: z.boolean().default(false),
  /** Inject the host's DEEPSEEK_* API env (key/base URL) into each sandbox. */
  inheritHostApi: z.boolean().default(true),
  /** Copy the host's settings.yaml into a fresh sandbox home (model defaults). */
  inheritHostModel: z.boolean().default(true),
  /** Announce the plugin's presence and tools in the system prompt. */
  announceToAgent: z.boolean().default(true),
  /** Master switch; when false the plugin mounts nothing. */
  enabled: z.boolean().default(true),
  /** How long a start waits for the sandbox to answer on its port (ms). */
  readyTimeoutMs: z.natural().default(90000),
  /** How long a stop waits for graceful exit before force-killing (ms). */
  stopTimeoutMs: z.natural().default(10000),
})

/** The resolved config type (schemastery schema mirror). */
export interface DevSandboxConfig {
  homeRoot?: string
  harnessRoot?: string
  basePort?: number
  buildOnStart?: boolean
  inheritHostApi?: boolean
  inheritHostModel?: boolean
  announceToAgent?: boolean
  enabled?: boolean
  readyTimeoutMs?: number
  stopTimeoutMs?: number
}

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 150

/** Model-facing announcement: plugin presence, capabilities, and limits. */
const GUIDANCE = [
  '本机已安装 dsh-dev-sandbox 插件（DSH 插件开发沙盒）：为插件开发者提供完全隔离的测试镜像。',
  '能力：一键启动独立的 DeepSeek Harness web 业务镜像（独立 DSH_HOME、独立端口、独立 web profile）。',
  '默认是标准纯净 profile；sandbox_start 的 profileMode=host-web 可镜像本机 Web profile 的 bundle、包链接和 Cordis patch，',
  '用于复现已安装插件之间的兼容问题，但不复制 session、storage、缓存或凭据。待测插件会覆盖镜像中的同名包。',
  '默认集成主机接口：注入主机的 DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL 并继承主机模型设置，沙盒可直接对话，不触碰开发本体。',
  '工具：sandbox_list 列出沙盒；sandbox_start 创建并启动（可带 pluginPath/port/build/inheritHostApi/inheritHostModel/profileMode）；',
  'sandbox_stop / sandbox_destroy / sandbox_logs / sandbox_build / sandbox_verify；GUI 侧边栏「沙盒」面板同样可操作。',
  '限制：沙盒进程真实占用端口与 CPU；销毁沙盒会删除其整个隔离目录；命令经宿主节点执行。',
  '用户提到「沙盒 / 测试镜像 / 业务镜像 / 隔离实例 / 不重启测试插件」时即指本插件，请据此协作。',
].join('')

/** Defaults applied to a partial config. */
function resolveConfig(config: Partial<DevSandboxConfig>): ManagerOptions & { announceToAgent: boolean; enabled: boolean } {
  const basePort = config.basePort ?? 4000
  const homeRoot = config.homeRoot !== undefined && config.homeRoot.trim() !== ''
    ? (config.homeRoot === '~' || config.homeRoot === '~/' || config.homeRoot === '~\\'
      ? homedir()
      : config.homeRoot.startsWith('~/') || config.homeRoot.startsWith('~\\')
        ? join(homedir(), config.homeRoot.slice(2))
        : config.homeRoot)
    : defaultHomeRoot()
  return {
    homeRoot,
    harnessRoot: config.harnessRoot,
    basePort: Math.max(1, Math.min(65535, basePort)),
    buildOnStart: config.buildOnStart === true,
    inheritHostApi: config.inheritHostApi !== false,
    inheritHostModel: config.inheritHostModel !== false,
    readyTimeoutMs: config.readyTimeoutMs ?? 90000,
    stopTimeoutMs: config.stopTimeoutMs ?? 10000,
    announceToAgent: config.announceToAgent !== false,
    enabled: config.enabled !== false,
  }
}

/**
 * Mount the dev-sandbox surfaces for one ordinary or Desktop Host generation.
 * @param ctx - host plugin context carrying webServer/tools/systemPrompt.
 * @param config - resolved plugin row config.
 * @param desktop - optional public Desktop capabilities for this generation.
 */
function mountSandboxSurfaces(
  ctx: Context,
  config: Partial<DevSandboxConfig>,
  desktop?: DesktopSandboxAdapter,
): () => void {
  let manager: SandboxManager | undefined
  let disposeSection: (() => void) | undefined
  let disposeRoutes: (() => void) | undefined
  let disposeTools: (() => void) | undefined

  const sync = (): void => {
    disposeSection?.()
    disposeSection = undefined
    disposeRoutes?.()
    disposeRoutes = undefined
    disposeTools?.()
    disposeTools = undefined
    manager?.dispose()
    manager = undefined
    const value = resolveConfig(config ?? {})
    if (!value.enabled) return
    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-dev-sandbox',
        order: SECTION_ORDER,
        text: GUIDANCE,
      })
    }
    manager = new SandboxManager({
      ...value,
      ...(desktop === undefined ? {} : {
        hostProfile: desktop.hostProfile,
        buildRunner: desktop.buildRunner,
      }),
    })
    disposeRoutes = ctx.effect(
      () => registerRoutes(ctx as unknown as { webServer: { register(route: unknown): () => void } }, manager!),
      'dsh-dev-sandbox: routes',
    )
    disposeTools = ctx.effect(
      () => {
        const disposers = sandboxTools(manager!).map(tool => ctx.tools.register(tool))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-dev-sandbox: tools',
    )
  }

  sync()
  return () => {
    disposeSection?.()
    disposeRoutes?.()
    disposeTools?.()
    manager?.dispose()
  }
}

/** Whether this Host generation is owned by DSH Desktop. */
function hasDesktopProfiles(ctx: Context): boolean {
  return (ctx as unknown as { get(name: string): unknown }).get('desktopProfiles') !== undefined
}

/**
 * Mount the dev-sandbox surfaces. Ordinary DSH keeps the existing manager,
 * while Desktop waits for its public package runner before activating the
 * optional adapter. Desktop capabilities never become a top-level injection,
 * so the package remains loadable in ordinary DSH.
 */
export function apply(ctx: Context, config: Partial<DevSandboxConfig>): void {
  if (!hasDesktopProfiles(ctx)) {
    ctx.effect(
      () => mountSandboxSurfaces(ctx, config),
      'dsh-dev-sandbox: ordinary host surfaces',
    )
    return
  }

  ctx.inject(['desktopPnpm'], (desktopCtx) => {
    const adapter = desktopSandboxAdapter(desktopCtx as Context)
    if (adapter === undefined) return
    return mountSandboxSurfaces(desktopCtx as Context, config, adapter)
  })
}

export default { name, apply, inject, Config }
