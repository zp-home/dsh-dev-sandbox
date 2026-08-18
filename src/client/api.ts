/**
 * Browser-side API client for the /api/dsh-dev-sandbox route family. The
 * only data path the panel uses — plain fetch, same origin.
 * @module dsh-dev-sandbox/client/api
 */

/** Sandbox list-row view (mirrors the host SandboxSummary). */
export type SandboxProfileMode = 'clean' | 'host-web'

export interface SandboxResourceUsage {
  memoryBytes: number | null
  storageBytes: number
  measuredAt: string
}

export interface SandboxSummary {
  name: string
  status: 'stopped' | 'starting' | 'running' | 'exited' | 'error'
  port: number
  url: string | null
  pluginName: string
  pluginPath: string
  inheritHostApi: boolean
  inheritHostModel: boolean
  profileMode?: SandboxProfileMode
  profileSource?: string | null
  profileBundles?: string[]
  resourceUsage?: SandboxResourceUsage
  pid: number | null
  createdAt: string
  startedAt: string | null
  stoppedAt: string | null
  lastError: string | null
}

/** Plugin-directory inspection result. */
export interface PluginScan {
  path: string
  name: string | null
  version: string | null
  bundlePatch: string | null
  hasBundle: boolean
  hostBuilt: boolean
  clientDeclared: boolean
  clientBuilt: boolean
  buildScript: string | null
  issues: string[]
}

/** API error carrying the route's JSON error message. */
export class SandboxApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxApiError'
  }
}

/** Parse a JSON response or throw a SandboxApiError. */
async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new SandboxApiError(`HTTP ${response.status} from ${response.url}`)
  }
  if (!response.ok) {
    const message = (body as { error?: unknown } | null)?.error
    throw new SandboxApiError(typeof message === 'string' ? message : `HTTP ${response.status}`)
  }
  return body as T
}

/** The route family. */
export class SandboxApi {
  /** Join the route prefix with one action path (actions may carry a leading slash). */
  private static route(action: string): string {
    return `/api/dsh-dev-sandbox/${action.replace(/^\/+/, '')}`
  }

  private async post<T>(action: string, body: unknown): Promise<T> {
    const response = await fetch(SandboxApi.route(action), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return readJson<T>(response)
  }

  private async get<T>(action: string, query: Record<string, string | number>): Promise<T> {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) params.set(key, String(value))
    const separator = params.toString() === '' ? '' : '?'
    const response = await fetch(`${SandboxApi.route(action)}${separator}${params.toString()}`)
    return readJson<T>(response)
  }

  /** All known sandboxes. */
  list(): Promise<{ sandboxes: SandboxSummary[] }> {
    return this.get('/list', {})
  }

  /** One sandbox's status. */
  status(name: string): Promise<{ sandbox: SandboxSummary }> {
    return this.get('/status', { name })
  }

  /** A sandbox's log tail. */
  logs(name: string, tail = 200): Promise<{ lines: string }> {
    return this.get('/logs', { name, tail })
  }

  /** Inspect a plugin checkout. */
  scan(path: string): Promise<{ scan: PluginScan }> {
    return this.get('/scan', { path })
  }

  /** Create a sandbox. `pluginPath` is optional: absent creates a plain mirror. */
  create(
    name: string,
    pluginPath?: string,
    opts: { inheritHostApi?: boolean; inheritHostModel?: boolean; profileMode?: SandboxProfileMode } = {},
  ): Promise<{ sandbox: SandboxSummary }> {
    return this.post('/create', {
      name,
      ...pluginPath !== undefined && pluginPath !== '' ? { pluginPath } : {},
      ...opts.inheritHostApi !== undefined ? { inheritHostApi: opts.inheritHostApi } : {},
      ...opts.inheritHostModel !== undefined ? { inheritHostModel: opts.inheritHostModel } : {},
      ...opts.profileMode !== undefined ? { profileMode: opts.profileMode } : {},
    })
  }

  /** Start a sandbox (explicit port optional). */
  start(name: string, port?: number): Promise<{ sandbox: SandboxSummary }> {
    return this.post('/start', { name, ...port !== undefined ? { port } : {} })
  }

  /** Stop a sandbox. */
  stop(name: string): Promise<{ ok: boolean }> {
    return this.post('/stop', { name })
  }

  /** Restart a sandbox. */
  restart(name: string, port?: number): Promise<{ sandbox: SandboxSummary }> {
    return this.post('/restart', { name, ...port !== undefined ? { port } : {} })
  }

  /** Destroy a sandbox (deletes its isolated home). */
  destroy(name: string): Promise<{ ok: boolean }> {
    return this.post('/destroy', { name })
  }

  /** Run the plugin's build script. */
  build(pluginPath: string): Promise<{ ok: boolean; exitCode: number }> {
    return this.post('/build', { pluginPath })
  }
}
