/**
 * Agent tools for driving dev sandboxes from inside the development
 * instance: `sandbox_list/status/start/stop/destroy/logs/build`. These let
 * the developer's own agent spin up the isolated mirror, install the plugin
 * under development, and iterate on compatibility without ever touching the
 * host instance.
 * @module dsh-dev-sandbox/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SandboxManager, SandboxSummary } from './manager.ts'

/** One text content block (the harness content-block vocabulary). */
function text(value: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: value }]
}

type JsonValue = boolean | number | string | null | JsonValue[] | { [key: string]: JsonValue }

type ToolSandbox = {
  name: string
  status: string
  port: number
  pluginName: string
  pluginPath: string
  profileMode?: string
  url?: string
  pid?: number
  lastError?: string
}

/** Convert runtime state to the JSON shape declared by tool output schemas. */
function toolSandbox(sandbox: SandboxSummary): ToolSandbox {
  return {
    name: sandbox.name,
    status: sandbox.status,
    port: sandbox.port,
    pluginName: sandbox.pluginName,
    pluginPath: sandbox.pluginPath,
    ...sandbox.profileMode !== undefined ? { profileMode: sandbox.profileMode } : {},
    ...sandbox.url !== null ? { url: sandbox.url } : {},
    ...sandbox.pid !== null ? { pid: sandbox.pid } : {},
    ...sandbox.lastError !== null ? { lastError: sandbox.lastError } : {},
  }
}

/** Serialize a structured result crossing the harness tool boundary. */
function jsonRecord(value: unknown): { [key: string]: JsonValue } {
  const parsed: unknown = JSON.parse(JSON.stringify(value))
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('dsh-dev-sandbox: expected a JSON object tool result')
  }
  return parsed as { [key: string]: JsonValue }
}

/** Compact one-line status of a sandbox. */
function renderSandbox(sandbox: ToolSandbox): string {
  return [
    sandbox.name,
    sandbox.status,
    sandbox.profileMode ?? 'clean',
    sandbox.port > 0 ? String(sandbox.port) : '-',
    sandbox.url ?? '-',
    sandbox.pluginName,
    sandbox.pluginPath,
  ].join(' | ')
}

/** Table of sandboxes. */
function renderSandboxes(sandboxes: ToolSandbox[]): string {
  if (sandboxes.length === 0) return 'no sandboxes'
  return [
    'name | status | profile | port | url | plugin | pluginPath',
    '--- | --- | --- | --- | --- | --- | ---',
    ...sandboxes.map(renderSandbox),
  ].join('\n')
}

/**
 * Build the sandbox_* tool set for one manager.
 * @param manager - the sandbox lifecycle manager.
 * @returns registry-ready tool definitions.
 */
export function sandboxTools(manager: SandboxManager): ReturnType<typeof defineTool>[] {
  return [
    defineTool({
      name: 'sandbox_list',
      description: 'List isolated dsh dev sandboxes (name, status, port, url, plugin, pluginPath). Each sandbox is a separate DSH_HOME/web profile on its own port for testing plugins under development.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sandboxes: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  status: { type: 'string', required: true },
                  port: { type: 'integer', required: true },
                  url: { type: 'string' },
                  pluginName: { type: 'string', required: true },
                  pluginPath: { type: 'string', required: true },
                  profileMode: { type: 'string' },
                  resourceUsage: { type: 'object', additionalProperties: true, properties: {} },
                  pid: { type: 'integer' },
                  lastError: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => text(renderSandboxes(value.sandboxes ?? [])),
      },
      async execute() {
        return { sandboxes: manager.list().map(toolSandbox) }
      },
    }),
    defineTool({
      name: 'sandbox_status',
      description: 'Show one dev sandbox\'s status and recent log tail.',
      parameters: {
        name: { type: 'string', description: 'Sandbox name.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sandbox: { type: 'object', required: true, additionalProperties: true },
            logs: { type: 'string' },
          },
        },
        render: (_args, value) => text(`status: ${JSON.stringify(value.sandbox, null, 2)}\n\nlogs:\n${value.logs ?? ''}`),
      },
      async execute(args: { name?: string }) {
        if (args.name === undefined) throw new Error('name is required')
        const sandbox = manager.get(args.name)
        if (sandbox === null) throw new Error(`unknown sandbox ${JSON.stringify(args.name)}`)
        return { sandbox: jsonRecord(sandbox), logs: manager.logs(args.name, 60) ?? '' }
      },
    }),
    defineTool({
      name: 'sandbox_start',
      description: 'Start (creating when needed) an isolated dsh web sandbox mounting a plugin under development. Returns the sandbox with its ready URL. Optional port override; otherwise a free port is allocated from basePort.',
      parameters: {
        name: { type: 'string', description: 'Sandbox name (1-32 chars of [A-Za-z0-9_-]).' },
        pluginPath: { type: 'string', description: 'Absolute path of the plugin-under-test checkout; optional (absent/empty = plain mirror without a plugin).' },
        port: { type: 'integer', description: 'Optional explicit port.' },
        build: { type: 'boolean', description: 'Run the plugin\'s build script before starting.' },
        inheritHostApi: { type: 'boolean', description: 'Inject the host\'s DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL into the sandbox (default: the row config value, true).' },
        inheritHostModel: { type: 'boolean', description: 'Copy the host\'s settings.yaml into a fresh sandbox home (default: the row config value, true).' },
        profileMode: { type: 'string', description: 'Profile composition: "clean" for stock dsh-base/web-app, or "host-web" to replay the local web profile in an isolated DSH_HOME.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sandbox: { type: 'object', required: true, additionalProperties: true },
          },
        },
        render: (_args, value) => text(`sandbox started:\n${JSON.stringify(value.sandbox, null, 2)}`),
      },
      async execute(args: {
        name?: string
        pluginPath?: string
        port?: number
        build?: boolean
        inheritHostApi?: boolean
        inheritHostModel?: boolean
        profileMode?: string
      }) {
        if (args.name === undefined) throw new Error('name is required')
        const profileMode = args.profileMode === undefined
          ? undefined
          : args.profileMode === 'clean' || args.profileMode === 'host-web'
            ? args.profileMode
            : (() => { throw new Error('profileMode must be "clean" or "host-web"') })()
        const existing = manager.get(args.name)
        if (existing === null) {
          manager.create(args.name, args.pluginPath !== undefined && args.pluginPath !== '' ? args.pluginPath : undefined, {
            ...args.inheritHostApi !== undefined ? { inheritHostApi: args.inheritHostApi } : {},
            ...args.inheritHostModel !== undefined ? { inheritHostModel: args.inheritHostModel } : {},
            ...profileMode !== undefined ? { profileMode } : {},
          })
        } else if (profileMode !== undefined) {
          manager.create(args.name, existing.pluginPath === '' ? undefined : existing.pluginPath, { profileMode })
        }
        if (args.build === true) {
          const state = manager.get(args.name)
          if (state !== null && state.pluginPath !== '') manager.build(state.pluginPath)
        }
        const sandbox = await manager.start(args.name, args.port)
        return { sandbox: jsonRecord(sandbox) }
      },
    }),
    defineTool({
      name: 'sandbox_stop',
      description: 'Stop a running dev sandbox (SIGTERM, then force-kill after a timeout). The sandbox and its isolated home remain for later restarts.',
      parameters: {
        name: { type: 'string', description: 'Sandbox name.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => text(value.ok === true ? 'sandbox stopped' : 'sandbox stop returned an unexpected result'),
      },
      async execute(args: { name: string }) {
        await manager.stop(args.name)
        return { ok: true }
      },
    }),
    defineTool({
      name: 'sandbox_destroy',
      description: 'Stop and permanently delete a dev sandbox (its whole isolated DSH_HOME directory).',
      parameters: {
        name: { type: 'string', description: 'Sandbox name.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => text(value.ok === true ? 'sandbox destroyed' : 'sandbox destroy returned an unexpected result'),
      },
      async execute(args: { name: string }) {
        await manager.destroy(args.name)
        return { ok: true }
      },
    }),
    defineTool({
      name: 'sandbox_logs',
      description: 'Show a dev sandbox\'s captured log tail.',
      parameters: {
        name: { type: 'string', description: 'Sandbox name.' },
        tail: { type: 'integer', description: 'Number of trailing lines (default 200, max 5000).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            lines: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(value.lines ?? ''),
      },
      async execute(args: { name: string; tail?: number }) {
        const lines = manager.logs(args.name, args.tail ?? 200)
        if (lines === null) throw new Error(`unknown sandbox ${JSON.stringify(args.name)}`)
        return { lines }
      },
    }),
    defineTool({
      name: 'sandbox_verify',
      description: 'Run a disposable local compatibility check for an already-built plugin source. It uses an isolated clean or host-web mirror, never downloads the plugin, never builds it, and does not inject host API credentials or settings.',
      parameters: {
        pluginPath: { type: 'string', description: 'Absolute path of the already-built local plugin package.' },
        profileMode: { type: 'string', enum: ['clean', 'host-web'], description: 'Compatibility target: clean stock profile or host-web local profile mirror.' },
        repository: { type: 'string', description: 'Optional marketplace repository identity in owner/repo form for the local receipt.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            verification: { type: 'object', required: true, additionalProperties: true },
          },
        },
        render: (_args, value) => {
          const result = value.verification as { result?: string; profileMode?: string; error?: string | null }
          return text(`local compatibility ${result.result ?? 'unknown'} (${result.profileMode ?? 'clean'})${result.error ? `: ${result.error}` : ''}`)
        },
      },
      async execute(args: { pluginPath?: string; profileMode?: 'clean' | 'host-web'; repository?: string }) {
        if (args.pluginPath === undefined) throw new Error('pluginPath is required')
        return {
          verification: jsonRecord(await manager.verify(args.pluginPath, {
            ...args.profileMode !== undefined ? { profileMode: args.profileMode } : {},
            ...args.repository !== undefined ? { repository: args.repository } : {},
          })),
        }
      },
    }),
    defineTool({
      name: 'sandbox_build',
      description: 'Run the build script of a plugin checkout (pnpm run build) so its host/client halves are fresh before sandbox testing.',
      parameters: {
        pluginPath: { type: 'string', description: 'Absolute path of the plugin package directory.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            exitCode: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => text(value.ok === true ? `build succeeded (exit ${value.exitCode})` : `build failed (exit ${value.exitCode})`),
      },
      async execute(args: { pluginPath: string }) {
        const exitCode = manager.build(args.pluginPath)
        return { ok: exitCode === 0, exitCode }
      },
    }),
  ]
}
