/**
 * HTTP surface of the dev-sandbox manager: `/api/dsh-dev-sandbox/*`.
 *
 * Loopback-only by construction (the web server binds 127.0.0.1 by default);
 * these routes start and stop local processes, so they must never be exposed
 * on an all-interfaces bind. Each handler returns JSON `{...}` or
 * `{error}` with a matching status code.
 * @module dsh-dev-sandbox/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { URL } from 'node:url'
import type { SandboxCreateOptions, SandboxManager } from './manager.ts'

/** Route prefix registered on the web server. */
export const ROUTES_PREFIX = '/api/dsh-dev-sandbox'

/** One JSON response. */
function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
  })
  res.end(payload)
}

/** Error text of an unknown thrown value. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read a JSON request body (1 MiB cap). */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1_000_000) {
        reject(new Error('request body too large (max 1 MiB)'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolveBody({})
        return
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/** Number or undefined from an unknown body field. */
function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined
}

/** String or undefined from an unknown body/query field. */
function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Boolean or undefined from an unknown body field. */
function boolField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** Dispatch one request under the prefix. */
async function dispatch(req: IncomingMessage, res: ServerResponse, manager: SandboxManager): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  // Normalize duplicate slashes: the browser half historically joined the
  // prefix with leading-slash actions, and a stray client must not 404.
  const path = url.pathname.replace(/\/{2,}/g, '/')
  if (!path.startsWith(`${ROUTES_PREFIX}/`)) {
    json(res, 404, { error: `unknown route ${path}` })
    return
  }
  const action = path.slice(ROUTES_PREFIX.length)
  const query = url.searchParams
  try {
    switch (action) {
      case '/list': {
        if (req.method !== 'GET') return method(res)
        json(res, 200, { sandboxes: manager.list() })
        return
      }
      case '/status': {
        if (req.method !== 'GET') return method(res)
        const name = stringField(query.get('name'))
        if (name === undefined) return bad(res, 'name is required')
        const sandbox = manager.get(name)
        if (sandbox === null) return json(res, 404, { error: `unknown sandbox ${JSON.stringify(name)}` })
        json(res, 200, { sandbox })
        return
      }
      case '/logs': {
        if (req.method !== 'GET') return method(res)
        const name = stringField(query.get('name'))
        if (name === undefined) return bad(res, 'name is required')
        const tail = Math.min(5000, Math.max(1, numberField(Number(query.get('tail'))) ?? 200))
        const lines = manager.logs(name, tail)
        if (lines === null) return json(res, 404, { error: `unknown sandbox ${JSON.stringify(name)}` })
        json(res, 200, { lines })
        return
      }
      case '/scan': {
        if (req.method !== 'GET') return method(res)
        const pathValue = stringField(query.get('path'))
        if (pathValue === undefined) return bad(res, 'path is required')
        json(res, 200, { scan: manager.scanPlugin(pathValue) })
        return
      }
      case '/create': {
        if (req.method !== 'POST') return method(res)
        const body = await readJsonBody(req)
        const name = stringField(body.name)
        if (name === undefined) return bad(res, 'name is required')
        // pluginPath is optional: absent/empty creates a plain mirror.
        const pluginPath = typeof body.pluginPath === 'string' && body.pluginPath.trim() !== ''
          ? body.pluginPath.trim()
          : undefined
        const opts: SandboxCreateOptions = {}
        const inheritApi = boolField(body.inheritHostApi)
        const inheritModel = boolField(body.inheritHostModel)
        const profileMode = stringField(body.profileMode)
        if (profileMode !== undefined && profileMode !== 'clean' && profileMode !== 'host-web') {
          return bad(res, 'profileMode must be "clean" or "host-web"')
        }
        if (inheritApi !== undefined) opts.inheritHostApi = inheritApi
        if (inheritModel !== undefined) opts.inheritHostModel = inheritModel
        if (profileMode !== undefined) opts.profileMode = profileMode
        json(res, 200, { sandbox: manager.create(name, pluginPath, opts) })
        return
      }
      case '/start': {
        if (req.method !== 'POST') return method(res)
        const body = await readJsonBody(req)
        const name = stringField(body.name)
        if (name === undefined) return bad(res, 'name is required')
        json(res, 200, { sandbox: await manager.start(name, numberField(body.port)) })
        return
      }
      case '/stop': {
        if (req.method !== 'POST') return method(res)
        const body = await readJsonBody(req)
        const name = stringField(body.name)
        if (name === undefined) return bad(res, 'name is required')
        await manager.stop(name)
        json(res, 200, { ok: true })
        return
      }
      case '/restart': {
        if (req.method !== 'POST') return method(res)
        const body = await readJsonBody(req)
        const name = stringField(body.name)
        if (name === undefined) return bad(res, 'name is required')
        await manager.stop(name)
        json(res, 200, { sandbox: await manager.start(name, numberField(body.port)) })
        return
      }
      case '/destroy': {
        if (req.method !== 'POST') return method(res)
        const body = await readJsonBody(req)
        const name = stringField(body.name)
        if (name === undefined) return bad(res, 'name is required')
        await manager.destroy(name)
        json(res, 200, { ok: true })
        return
      }
      case '/build': {
        if (req.method !== 'POST') return method(res)
        const body = await readJsonBody(req)
        const pluginPath = stringField(body.pluginPath)
        if (pluginPath === undefined) return bad(res, 'pluginPath is required')
        const code = manager.build(pluginPath)
        json(res, 200, { ok: code === 0, exitCode: code })
        return
      }
      default:
        json(res, 404, { error: `unknown action ${action}` })
    }
  } catch (error) {
    json(res, 500, { error: message(error) })
  }
}

function method(res: ServerResponse): void {
  json(res, 405, { error: 'method not allowed' })
}

function bad(res: ServerResponse, error: string): void {
  json(res, 400, { error })
}

/**
 * Register the route prefix on the web server.
 * @param ctx - host context carrying the webServer service.
 * @param manager - the sandbox manager the routes drive.
 * @returns the route disposer.
 */
export function registerRoutes(ctx: { webServer: { register(route: unknown): () => void } }, manager: SandboxManager): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: ROUTES_PREFIX,
    handler: (req: IncomingMessage, res: ServerResponse) => void dispatch(req, res, manager),
  })
}
