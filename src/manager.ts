/**
 * Sandbox lifecycle manager.
 *
 * A sandbox is one isolated dsh web instance:
 *   - its own `DSH_HOME` (`<homeRoot>/<name>`), so sessions, storages,
 *     settings, and profiles are completely separate from the development
 *     instance;
 *   - its own web profile (`<home>/profiles/web`) whose bundle stack is the
 *     stock `dsh-base` + `dsh-web-app` plus the plugin under development,
 *     mounted as a junction in the profile's node_modules (no pnpm run
 *     required for the plugin itself);
 *   - its own port (allocated from `basePort` upward), so it never collides
 *     with the dev server;
 *   - spawned from the same harness checkout, so the plugin under test runs
 *     against the exact harness revision the developer is working on.
 *
 * The manager owns process handles, per-sandbox ring-buffer logs plus a log
 * file, and a `sandbox-state.json` per sandbox so instances survive host
 * restarts (liveness is re-derived from the recorded pid/port).
 * @module dsh-dev-sandbox/manager
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { get } from 'node:http'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { resolveHarness } from './harness.ts'

/** Lifecycle status of one sandbox instance. */
export type SandboxStatus = 'stopped' | 'starting' | 'running' | 'exited' | 'error'

/** Durable per-sandbox state, persisted to `<home>/sandbox-state.json`. */
export interface SandboxState {
  name: string
  /** Absolute path of the plugin-under-test checkout. */
  pluginPath: string
  /** The plugin's package name (its loader row name). */
  pluginName: string
  /** Allocated listen port; 0 until the first start. */
  port: number
  /** Spawned process id; null when not running. */
  pid: number | null
  status: SandboxStatus
  /** Whether starts inject the host's DEEPSEEK_* API env into this sandbox. */
  inheritHostApi: boolean
  /** Whether a fresh home inherits the host's settings.yaml (model defaults). */
  inheritHostModel: boolean
  createdAt: string
  startedAt: string | null
  stoppedAt: string | null
  lastError: string | null
  /** The ready URL (`http://127.0.0.1:<port>`) when running. */
  url: string | null
}

/** Public list-row view of a sandbox. */
export interface SandboxSummary extends SandboxState {}

/** Resolved plugin-directory inspection (used by /scan and the GUI). */
export interface PluginScan {
  path: string
  name: string | null
  version: string | null
  /** The `dsh.bundle.patch` value, or null when the package declares no bundle. */
  bundlePatch: string | null
  hasBundle: boolean
  /** Whether the host half (`lib/index.js` per `main`) is built. */
  hostBuilt: boolean
  clientDeclared: boolean
  /** Whether the client half (`lib/client.js`) is built when a client is declared. */
  clientBuilt: boolean
  buildScript: string | null
  issues: string[]
}

/** Options the plugin row's resolved config feeds into the manager. */
export interface ManagerOptions {
  /** Absolute sandbox root directory (each sandbox is one subdirectory). */
  homeRoot: string
  /** Explicit harness root override (optional). */
  harnessRoot?: string
  /** First port tried when allocating a sandbox port. */
  basePort: number
  /** Whether `start` runs the plugin's build script first. */
  buildOnStart: boolean
  /** Whether starts inject the host's DEEPSEEK_* API env (key/base URL) into each sandbox. */
  inheritHostApi: boolean
  /** Whether a fresh sandbox home copies the host's settings.yaml (agent model defaults). */
  inheritHostModel: boolean
  /** How long `start` waits for the sandbox to answer on its port. */
  readyTimeoutMs: number
  /** How long `stop` waits for a graceful exit before force-killing. */
  stopTimeoutMs: number
}

/** Valid sandbox names: 1–32 chars, alphanumeric plus `_`/`-`, no dots. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

/** Profile root config, identical to what the launcher rewrites at boot. */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** Profile user patch layer template. */
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

/** pnpm settings profile plugins need (same as the launcher's initProfile). */
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/** Ring-buffer cap per sandbox log. */
const LOG_CAP = 2000

/** Delay helper. */
function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => { setTimeout(resolveDelay, ms) })
}

/** Whether a TCP port on loopback is currently free. */
function portFree(port: number): Promise<boolean> {
  return new Promise(resolveFree => {
    const server = createServer()
    server.once('error', () => resolveFree(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolveFree(true))
    })
  })
}

/** Whether something answers HTTP on the port (any response counts as listening). */
function portResponds(port: number): Promise<boolean> {
  return new Promise(done => {
    const req = get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, res => {
      res.resume()
      done(true)
    })
    req.on('timeout', () => { req.destroy(); done(false) })
    req.on('error', () => done(false))
  })
}

/** Error whose `message` is user-facing. */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxError'
  }
}

/**
 * Allocate a free port starting at `base`, probing upward.
 * @param base - first candidate port.
 * @returns a free loopback port.
 * @throws {SandboxError} when 1000 consecutive ports are all busy.
 */
async function findFreePort(base: number): Promise<number> {
  for (let port = base; port < base + 1000; port++) {
    if (await portFree(port)) return port
  }
  throw new SandboxError(`dsh-dev-sandbox: no free port in ${base}..${base + 999}`)
}

/** Read a sandbox's persisted state, or null when absent. */
function readStateFile(home: string): SandboxState | null {
  const file = join(home, 'sandbox-state.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SandboxState
  } catch {
    return null
  }
}

/**
 * The sandbox lifecycle manager: one instance per host process.
 */
export class SandboxManager {
  private readonly children = new Map<string, ChildProcess>()
  private readonly rings = new Map<string, string[]>()
  private readonly options: ManagerOptions
  private harness: HarnessInfo | undefined
  private harnessError: string | null = null

  constructor(options: ManagerOptions) {
    this.options = options
  }

  /**
   * Resolve the harness to boot sandboxes from, lazily and with caching.
   * Failure never blocks mounting — it becomes a per-start SandboxError.
   * @returns the resolved harness info.
   * @throws {SandboxError} when no harness checkout can be located.
   */
  private harnessInfo(): HarnessInfo {
    if (this.harnessError !== null) throw new SandboxError(this.harnessError)
    if (this.harness !== undefined) return this.harness
    try {
      this.harness = resolveHarness(this.options.harnessRoot)
      return this.harness
    } catch (error) {
      this.harnessError = error instanceof Error ? error.message : String(error)
      throw new SandboxError(this.harnessError)
    }
  }

  /**
   * Collect the host's DeepSeek API env for injection into a sandbox: the
   * process environment first (the host's own boot already folded in its
   * `.env` files), then the host home's `.env` and `.credentials.yaml`.
   * @returns a map of DEEPSEEK_* environment variables to set on the child.
   */
  private collectHostApiEnv(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_SEARCH_BASE_URL']) {
      const value = process.env[name] ?? this.readKeyValueFromHostHome(name)
      if (value !== undefined && value.trim() !== '') out[name] = value.trim()
    }
    return out
  }

  /**
   * Read one `NAME: value` / `NAME=value` entry from the host home's `.env`
   * and `.credentials.yaml` (the credential store the dev instance uses).
   * @param name - the variable name to look up.
   * @returns the value, or undefined when absent.
   */
  private readKeyValueFromHostHome(name: string): string | undefined {
    const home = resolveDshHome()
    for (const file of [join(home, '.env'), join(home, '.credentials.yaml')]) {
      if (!existsSync(file)) continue
      try {
        for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
          const trimmed = line.trim()
          if (trimmed === '' || trimmed.startsWith('#')) continue
          const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(.*)$/.exec(trimmed)
          if (match === null || match[1] !== name) continue
          return match[2].trim().replace(/^['"]|['"]$/g, '')
        }
      } catch {
        // Unreadable host credential files must never block starting a sandbox.
      }
    }
    return undefined
  }

  /**
   * Copy the host's settings.yaml into a sandbox home that has none yet, so
   * the mirror starts with the same agent model/theme defaults as the host.
   * @param home - the sandbox home (its DSH_HOME).
   */
  private inheritHostSettings(home: string): void {
    const settingsPath = join(home, 'settings.yaml')
    if (existsSync(settingsPath)) return
    const hostSettings = join(resolveDshHome(), 'settings.yaml')
    if (!existsSync(hostSettings)) return
    try {
      copyFileSync(hostSettings, settingsPath)
    } catch {
      // A settings copy failure is non-fatal: the sandbox still boots with defaults.
    }
  }

  /** Absolute DSH_HOME of a sandbox. */
  homeOf(name: string): string {
    return join(this.options.homeRoot, name)
  }

  /** Absolute path of a sandbox's log file. */
  logFileOf(name: string): string {
    return join(this.homeOf(name), 'sandbox.log')
  }

  // ------------------------------------------------------------------ state

  /** All known sandboxes, newest first, with liveness re-derived. */
  list(): SandboxSummary[] {
    if (!existsSync(this.options.homeRoot)) return []
    const summaries: SandboxSummary[] = []
    for (const entry of readdirSync(this.options.homeRoot)) {
      const home = join(this.options.homeRoot, entry)
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(home)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue
      const state = readStateFile(home)
      if (state === null) continue
      summaries.push(this.liveState(state))
    }
    return summaries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  /** One sandbox summary, or null when unknown. */
  get(name: string): SandboxSummary | null {
    const state = readStateFile(this.homeOf(name))
    return state === null ? null : this.liveState(state)
  }

  /** Re-derive status from the recorded pid/port when the state says running. */
  private liveState(state: SandboxState): SandboxSummary {
    if (state.status === 'running' || state.status === 'starting') {
      const alive = state.pid !== null && this.pidAlive(state.pid)
      if (!alive) {
        state = { ...state, status: 'exited', pid: null, url: null }
        this.writeState(state.name, state)
      }
    }
    return state
  }

  /** Whether a process id currently exists (signal 0 probe). */
  private pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /** Persist one sandbox's state file. */
  private writeState(name: string, state: SandboxState): void {
    writeFileSync(join(this.homeOf(name), 'sandbox-state.json'), JSON.stringify(state, null, 2) + '\n')
  }

  // ---------------------------------------------------------------- logs

  /** Append to a sandbox's ring buffer and log file. */
  private pushLog(name: string, chunk: string): void {
    const ring = this.rings.get(name) ?? []
    ring.push(chunk)
    while (ring.length > LOG_CAP) ring.shift()
    this.rings.set(name, ring)
    try {
      appendFileSync(this.logFileOf(name), chunk)
    } catch {
      // Logging must never break lifecycle operations.
    }
  }

  /**
   * Recent log lines for a sandbox.
   * @param name - sandbox name.
   * @param tail - how many trailing lines to return (default 200).
   * @returns the joined tail, or null when the sandbox is unknown.
   */
  logs(name: string, tail = 200): string | null {
    if (this.get(name) === null) return null
    const ring = this.rings.get(name) ?? []
    const joined = ring.join('')
    const lines = joined.split('\n')
    return lines.slice(Math.max(0, lines.length - tail)).join('\n')
  }

  // ------------------------------------------------------------- plugin

  /**
   * Inspect a plugin checkout: manifest facts, build state, and issues.
   * @param pluginPath - absolute path of the plugin package directory.
   * @returns the scan result.
   * @throws {SandboxError} when the directory has no package.json.
   */
  scanPlugin(pluginPath: string): PluginScan {
    const root = resolve(pluginPath)
    const manifestFile = join(root, 'package.json')
    if (!existsSync(manifestFile)) {
      throw new SandboxError(`dsh-dev-sandbox: ${root} has no package.json — not a plugin package`)
    }
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>
    } catch {
      throw new SandboxError(`dsh-dev-sandbox: ${manifestFile} is not valid JSON`)
    }
    const name = typeof manifest.name === 'string' ? manifest.name : null
    const version = typeof manifest.version === 'string' ? manifest.version : null
    const dsh = (manifest.dsh ?? {}) as Record<string, unknown>
    const bundle = (dsh.bundle ?? {}) as Record<string, unknown>
    const client = (dsh.client ?? {}) as Record<string, unknown>
    const bundlePatch = typeof bundle.patch === 'string' ? bundle.patch : null
    const hasBundle = bundlePatch !== null
    const main = typeof manifest.main === 'string' ? manifest.main : 'lib/index.js'
    const hostBuilt = existsSync(join(root, main))
    const clientDeclared = client.platform === 'web'
    const clientBuilt = existsSync(join(root, 'lib', 'client.js'))
    const scripts = (manifest.scripts ?? {}) as Record<string, unknown>
    const buildScript = typeof scripts.build === 'string' ? scripts.build : null
    const issues: string[] = []
    if (name === null) issues.push('package.json has no "name"')
    if (!hasBundle) issues.push('package.json declares no dsh.bundle.patch — the plugin will not mount as a profile layer')
    if (!hostBuilt) issues.push(`host half not built (${main} missing) — run the plugin's build script first`)
    if (clientDeclared && !clientBuilt) issues.push('dsh.client declares web platform but lib/client.js is missing — build the client half first')
    if (clientBuilt && !clientDeclared) issues.push('lib/client.js exists but dsh.client is not declared — the browser half will not load')
    return {
      path: root,
      name,
      version,
      bundlePatch,
      hasBundle,
      hostBuilt,
      clientDeclared,
      clientBuilt,
      buildScript,
      issues,
    }
  }

  /**
   * Run the plugin's build script in its checkout.
   * @param pluginPath - the plugin package directory.
   * @param pnpmPath - pnpm binary name/path (defaults to 'pnpm' on PATH).
   * @returns the build script's exit code.
   * @throws {SandboxError} when the package declares no build script or pnpm is missing.
   */
  build(pluginPath: string, pnpmPath = 'pnpm'): number {
    const scan = this.scanPlugin(pluginPath)
    if (scan.buildScript === null) {
      throw new SandboxError(`dsh-dev-sandbox: ${scan.name ?? pluginPath} declares no build script`)
    }
    const result = spawnSync(pnpmPath, ['run', 'build'], {
      cwd: scan.path,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (result.error !== undefined) {
      throw new SandboxError(`dsh-dev-sandbox: failed to run pnpm in ${scan.path}: ${result.error.message}`)
    }
    return result.status ?? 1
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * Create a sandbox (idempotent: an existing sandbox with the same plugin
   * path is reused). Writes the isolated home, profile, and — when a plugin
   * is given — the plugin junction. Without a plugin path the sandbox is a
   * plain mirror: the stock web profile only.
   * @param name - sandbox name (filesystem-safe identifier).
   * @param pluginPath - optional absolute path of the plugin under development.
   * @param opts - per-sandbox inheritance overrides (defaults come from the row config).
   * @returns the created sandbox summary.
   * @throws {SandboxError} on invalid names or unbuildable plugins.
   */
  create(
    name: string,
    pluginPath?: string,
    opts: { inheritHostApi?: boolean; inheritHostModel?: boolean } = {},
  ): SandboxSummary {
    if (!NAME_PATTERN.test(name)) {
      throw new SandboxError(
        `dsh-dev-sandbox: invalid sandbox name ${JSON.stringify(name)} — use 1-32 chars of [A-Za-z0-9_-]`,
      )
    }
    let pluginDir = ''
    let pluginName = ''
    let pluginVersion: string | null = null
    if (pluginPath !== undefined && pluginPath.trim() !== '') {
      const scan = this.scanPlugin(pluginPath)
      if (scan.name === null || scan.bundlePatch === null) {
        const issues = scan.issues.join('; ')
        throw new SandboxError(`dsh-dev-sandbox: ${pluginPath} is not a mountable dsh bundle — ${issues}`)
      }
      pluginDir = scan.path
      pluginName = scan.name
      pluginVersion = scan.version
    }
    const existing = this.get(name)
    if (existing !== null && resolve(existing.pluginPath) === resolve(pluginDir)) {
      return existing
    }
    const home = this.homeOf(name)
    const profileDir = join(home, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'cordis.yml'), PROFILE_ROOT_CONFIG)
    writeFileSync(join(profileDir, 'cordis.patch.yml'), PROFILE_PATCH_TEMPLATE)
    writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), PROFILE_PNPM_WORKSPACE)
    const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
    if (pluginName !== '') bundles.push(pluginName)
    const manifest = {
      name: 'dsh-profile-web',
      private: true,
      dsh: { profile: { bundles } },
      ...pluginName !== '' ? { dependencies: { [pluginName]: `link:${resolve(pluginDir)}` } } : {},
    }
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
    if (pluginName !== '') this.ensurePluginJunction(profileDir, pluginName, pluginDir)
    const now = new Date().toISOString()
    const state: SandboxState = {
      name,
      pluginPath: pluginDir,
      pluginName,
      port: 0,
      pid: null,
      status: 'stopped',
      inheritHostApi: opts.inheritHostApi ?? this.options.inheritHostApi,
      inheritHostModel: opts.inheritHostModel ?? this.options.inheritHostModel,
      createdAt: existing?.createdAt ?? now,
      startedAt: null,
      stoppedAt: null,
      lastError: null,
      url: null,
    }
    this.writeState(name, state)
    this.pushLog(
      name,
      pluginName === ''
        ? `[dsh-dev-sandbox] created home ${home} (plain mirror, no plugin)\n`
        : `[dsh-dev-sandbox] created home ${home} (plugin ${pluginName}@${pluginVersion ?? '?'})\n`,
    )
    return state
  }

  /** Junction `<profile>/node_modules/<pkg>` -> plugin checkout (scoped names nested). */
  private ensurePluginJunction(profileDir: string, packageName: string, target: string): void {
    const link = join(profileDir, 'node_modules', ...packageName.split('/'))
    mkdirSync(dirname(link), { recursive: true })
    if (existsSync(link)) {
      // On Windows a junction reports through lstat as a symbolic link; a real
      // directory is not a reparse point and is a genuine conflict.
      const isLink = lstatSync(link).isSymbolicLink()
      if (!isLink) {
        throw new SandboxError(
          `dsh-dev-sandbox: ${link} exists as a real directory; remove it or choose another sandbox name`,
        )
      }
      // Refresh a stale link to the current checkout path.
      rmSync(link, { recursive: true, force: true })
    }
    symlinkSync(target, link, 'junction')
  }

  /**
   * Start a sandbox: build first when configured, allocate a port, spawn the
   * isolated harness web process, and wait until it answers.
   * @param name - sandbox name.
   * @param port - explicit port override (otherwise allocated from basePort).
   * @returns the running summary.
   * @throws {SandboxError} when the sandbox is unknown or fails to become ready.
   */
  async start(name: string, port?: number): Promise<SandboxSummary> {
    let state = this.get(name)
    if (state === null) {
      throw new SandboxError(`dsh-dev-sandbox: unknown sandbox ${JSON.stringify(name)}`)
    }
    if (state.status === 'running' || state.status === 'starting') {
      return state
    }
    if (this.options.buildOnStart && state.pluginPath !== '') {
      try {
        this.build(state.pluginPath)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        state = this.mutateState(name, { status: 'error', lastError: message })
        throw error
      }
    }
    const allocated = port ?? await findFreePort(this.options.basePort)
    const spawnPort = port ?? allocated
    const { root, cliEntry, nodeExec } = this.harnessInfo()
    this.pushLog(name, `[dsh-dev-sandbox] starting on port ${spawnPort} (harness ${root})\n`)
    const home = this.homeOf(name)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_DEV_SANDBOX_NAME: name,
    }
    if (state.inheritHostApi) {
      Object.assign(env, this.collectHostApiEnv())
    }
    if (state.inheritHostModel) {
      this.inheritHostSettings(home)
    }
    const child = spawn(
      nodeExec,
      ['--import', 'tsx/esm', cliEntry, 'web', '--port', String(spawnPort)],
      {
        cwd: root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    this.children.set(name, child)
    const childPid = child.pid ?? null
    this.mutateState(name, {
      status: 'starting',
      pid: childPid,
      port: spawnPort,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      lastError: null,
      url: null,
    })
    child.stdout.on('data', (chunk: Buffer) => this.pushLog(name, chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => this.pushLog(name, chunk.toString()))
    child.on('exit', (code, signal) => {
      if (this.children.get(name) === child) this.children.delete(name)
      this.pushLog(name, `[dsh-dev-sandbox] process exited (code=${code} signal=${signal ?? 'none'})\n`)
      const current = readStateFile(home)
      if (current !== null && (current.status === 'running' || current.status === 'starting')) {
        this.mutateState(name, { status: 'exited', pid: null, url: null })
      }
    })
    try {
      await this.waitReady(spawnPort, this.options.readyTimeoutMs, () => {
        const current = this.children.get(name)
        return current === undefined || current.exitCode !== null
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.mutateState(name, { status: 'error', lastError: message })
      this.pushLog(name, `[dsh-dev-sandbox] start failed: ${message}\n`)
      throw error
    }
    return this.mutateState(name, {
      status: 'running',
      url: `http://127.0.0.1:${spawnPort}`,
      lastError: null,
    })
  }

  /** Poll until the sandbox answers on its port or the process dies. */
  private async waitReady(port: number, timeoutMs: number, isDead: () => boolean): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (isDead()) throw new SandboxError('dsh-dev-sandbox: sandbox process exited before becoming ready')
      if (await portResponds(port)) return
      await delay(500)
    }
    throw new SandboxError(`dsh-dev-sandbox: sandbox did not answer on port ${port} within ${timeoutMs}ms`)
  }

  /**
   * Stop a sandbox: SIGTERM, then force-kill after the stop timeout.
   * @param name - sandbox name.
   */
  async stop(name: string): Promise<void> {
    const state = this.get(name)
    if (state === null) {
      throw new SandboxError(`dsh-dev-sandbox: unknown sandbox ${JSON.stringify(name)}`)
    }
    if (state.status !== 'running' && state.status !== 'starting') {
      return
    }
    const child = this.children.get(name)
    if (child !== undefined && child.exitCode === null && child.pid !== undefined) {
      this.pushLog(name, '[dsh-dev-sandbox] stopping (SIGTERM)\n')
      child.kill('SIGTERM')
      const exited = await Promise.race([
        once(child, 'exit').then(() => true),
        delay(this.options.stopTimeoutMs).then(() => false),
      ])
      if (!exited) {
        this.pushLog(name, '[dsh-dev-sandbox] graceful stop timed out — force-killing\n')
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        } else {
          child.kill('SIGKILL')
        }
      }
    }
    this.children.delete(name)
    this.mutateState(name, { status: 'stopped', pid: null, url: null, stoppedAt: new Date().toISOString() })
    this.pushLog(name, '[dsh-dev-sandbox] stopped\n')
  }

  /** Stop and delete a sandbox's whole home directory. */
  async destroy(name: string): Promise<void> {
    await this.stop(name)
    const home = this.homeOf(name)
    if (existsSync(home)) rmSync(home, { recursive: true, force: true })
    this.rings.delete(name)
  }

  /** Patch one sandbox's persisted state and return the new summary. */
  private mutateState(name: string, patch: Partial<SandboxState>): SandboxSummary {
    const state = readStateFile(this.homeOf(name))
    if (state === null) throw new SandboxError(`dsh-dev-sandbox: unknown sandbox ${JSON.stringify(name)}`)
    const next = { ...state, ...patch }
    this.writeState(name, next)
    return next
  }

  /** Stop child processes on host teardown. */
  dispose(): void {
    for (const child of this.children.values()) {
      if (child.exitCode === null) child.kill('SIGTERM')
    }
    this.children.clear()
  }
}

/** Default sandbox root under the OS home. */
export function defaultHomeRoot(): string {
  return join(homedir(), '.dsh-sandboxes')
}
