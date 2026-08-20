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
import { createHash } from 'node:crypto'
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
import { resolveHarness, type HarnessInfo } from './harness.ts'

/** Lifecycle status of one sandbox instance. */
export type SandboxStatus = 'stopped' | 'starting' | 'running' | 'exited' | 'error'

/** Profile composition used by the isolated sandbox. */
export type SandboxProfileMode = 'clean' | 'host-web'

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
  /** `clean` for the stock web profile; `host-web` for an isolated local profile replay. */
  profileMode?: SandboxProfileMode
  /** The profile directory mirrored into this sandbox, when profileMode is host-web. */
  profileSource?: string | null
  /** Snapshot of bundle names selected for this sandbox profile. */
  profileBundles?: string[]
  createdAt: string
  startedAt: string | null
  stoppedAt: string | null
  lastError: string | null
  /** The ready URL (`http://127.0.0.1:<port>`) when running. */
  url: string | null
}

/** Dynamic resource measurements for the isolated sandbox home and process. */
export interface SandboxResourceUsage {
  /** Child process working-set memory, or null when no process can be measured. */
  memoryBytes: number | null
  /** Bytes occupied by the sandbox home, excluding all junction/symlink targets. */
  storageBytes: number
  /** ISO timestamp when the cached sample was last refreshed. */
  measuredAt: string
}

/** Public list-row view of a sandbox. */
export interface SandboxSummary extends SandboxState {
  resourceUsage: SandboxResourceUsage
}

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

/** One locally installed DSH bundle available as a sandbox test-plugin target. */
export interface HostProfilePlugin {
  name: string
  path: string
  version: string | null
  /** Whether this package appears in the host web profile's bundle roster. */
  enabled: boolean
}

/** Options the plugin row's resolved config feeds into the manager. */
export interface SandboxCreateOptions {
  inheritHostApi?: boolean
  inheritHostModel?: boolean
  /** Mirror the host's web profile into the isolated home. */
  profileMode?: SandboxProfileMode
}

/** Immutable source profile selected by a Desktop Host generation. */
export interface SandboxHostProfile {
  readonly name: string
  readonly dir: string
}

/** Optional Desktop-owned package runner for builds from a plugin checkout. */
export interface SandboxBuildRunner {
  build(pluginPath: string, signal?: AbortSignal): Promise<number>
}

/** Options and public receipt for a one-shot local compatibility check. */
export interface SandboxVerificationOptions {
  /** Repository identity supplied by the marketplace, if known. */
  repository?: string
  /** Immutable source revision when the receipt will be published. */
  commit?: string
  /** Explicit publication or local-only receipt intent. */
  kind?: 'baseline-compatibility' | 'local-compatibility'
  /** Test against the stock profile or the current local web composition. */
  profileMode?: SandboxProfileMode
}

export interface SandboxCompatibilityVerification {
  format: 'dsh-plugin-verification/v1'
  kind: 'baseline-compatibility' | 'local-compatibility'
  repository: string | null
  commit: string | null
  checkedAt: string
  profileMode: SandboxProfileMode
  result: 'passed' | 'failed'
  plugin: { name: string | null; version: string | null; sourceFingerprint: string }
  scan: PluginScan
  profileBundles: string[]
  error: string | null
  logs: string
}

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
  /** Desktop-selected profile to mirror instead of assuming the ordinary web profile. */
  hostProfile?: SandboxHostProfile
  /** Desktop-managed package runner for explicit build requests. */
  buildRunner?: SandboxBuildRunner
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

/** Resource measurements are intentionally coarser than the UI's status polling. */
const RESOURCE_SAMPLE_INTERVAL_MS = 10_000

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

/** Treat state files written before profile modes existed as clean sandboxes. */
function profileModeOf(state: SandboxState): SandboxProfileMode {
  return state.profileMode === 'host-web' ? 'host-web' : 'clean'
}

/**
 * The sandbox lifecycle manager: one instance per host process.
 */
export class SandboxManager {
  private readonly children = new Map<string, ChildProcess>()
  private readonly rings = new Map<string, string[]>()
  private readonly resourceCache = new Map<string, { pid: number | null; sampledAt: number; usage: SandboxResourceUsage }>()
  private readonly buildControllers = new Set<AbortController>()
  private readonly activeBuilds = new Set<Promise<number>>()
  private readonly options: ManagerOptions
  private verificationSequence = 0
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

  /** All known sandboxes, newest first, with liveness and cached resources re-derived. */
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
      summaries.push(this.withResourceUsage(this.liveState(state)))
    }
    return summaries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  /** One sandbox summary, or null when unknown. */
  get(name: string): SandboxSummary | null {
    const state = readStateFile(this.homeOf(name))
    return state === null ? null : this.withResourceUsage(this.liveState(state))
  }

  /** Re-derive status from the recorded pid/port when the state says running. */
  private liveState(state: SandboxState): SandboxState {
    if (state.status === 'running' || state.status === 'starting') {
      const alive = state.pid !== null && this.pidAlive(state.pid)
      if (!alive) {
        state = { ...state, status: 'exited', pid: null, url: null }
        this.resourceCache.delete(state.name)
        this.writeState(state.name, state)
      }
    }
    return state
  }

  /** Attach a throttled process-memory and isolated-home storage sample. */
  private withResourceUsage(state: SandboxState): SandboxSummary {
    const now = Date.now()
    const cached = this.resourceCache.get(state.name)
    if (cached !== undefined && cached.pid === state.pid && now - cached.sampledAt < RESOURCE_SAMPLE_INTERVAL_MS) {
      return { ...state, resourceUsage: cached.usage }
    }
    const usage: SandboxResourceUsage = {
      memoryBytes: state.pid === null ? null : this.processMemoryBytes(state.pid),
      storageBytes: this.isolatedStorageBytes(this.homeOf(state.name)),
      measuredAt: new Date(now).toISOString(),
    }
    this.resourceCache.set(state.name, { pid: state.pid, sampledAt: now, usage })
    return { ...state, resourceUsage: usage }
  }

  /** Working-set memory for one child process; null means the OS did not expose it. */
  private processMemoryBytes(pid: number): number | null {
    try {
      if (process.platform === 'win32') {
        const result = spawnSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`],
          { encoding: 'utf8', windowsHide: true, timeout: 3000 },
        )
        const value = Number(String(result.stdout).trim())
        return Number.isFinite(value) && value >= 0 ? value : null
      }
      if (process.platform === 'linux') {
        const status = readFileSync(`/proc/${pid}/status`, 'utf8')
        const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
        return match === null ? null : Number(match[1]) * 1024
      }
      const result = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 })
      const value = Number(String(result.stdout).trim())
      return Number.isFinite(value) && value >= 0 ? value * 1024 : null
    } catch {
      return null
    }
  }

  /** Recursively count only files physically inside a sandbox home, never junction targets. */
  private isolatedStorageBytes(root: string): number {
    let total = 0
    const visit = (directory: string): void => {
      let entries: string[]
      try {
        entries = readdirSync(directory)
      } catch {
        return
      }
      for (const entry of entries) {
        const file = join(directory, entry)
        try {
          const stat = lstatSync(file)
          if (stat.isSymbolicLink()) continue
          if (stat.isDirectory()) visit(file)
          else if (stat.isFile()) total += stat.size
        } catch {
          // Files may disappear while a sandbox is writing logs or state.
        }
      }
    }
    visit(root)
    return total
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
    const joined = (this.rings.get(name) ?? []).join('')
    const source = joined === '' && existsSync(this.logFileOf(name))
      ? readFileSync(this.logFileOf(name), 'utf8')
      : joined
    const lines = source.split('\n')
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

  /** Source profile for host-web mirroring and the local bundle picker. */
  private hostProfileDir(): string {
    return this.options.hostProfile?.dir ?? join(resolveDshHome(), 'profiles', 'web')
  }

  /** Discover mountable DSH bundles installed in the active host profile. */
  hostWebPlugins(): HostProfilePlugin[] {
    const profileDir = this.hostProfileDir()
    const manifestFile = join(profileDir, 'package.json')
    if (!existsSync(manifestFile)) {
      throw new SandboxError(`dsh-dev-sandbox: host profile is missing ${manifestFile}`)
    }
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>
    } catch {
      throw new SandboxError(`dsh-dev-sandbox: host profile manifest is not valid JSON (${manifestFile})`)
    }
    const dsh = manifest.dsh
    const profile = dsh !== null && typeof dsh === 'object' && !Array.isArray(dsh)
      ? (dsh as Record<string, unknown>).profile
      : undefined
    const bundles = profile !== null && typeof profile === 'object' && !Array.isArray(profile)
      ? (profile as Record<string, unknown>).bundles
      : undefined
    const enabled = new Set(Array.isArray(bundles) ? bundles.filter((name): name is string => typeof name === 'string') : [])
    const plugins = new Map<string, HostProfilePlugin>()
    const inspect = (path: string): void => {
      try {
        const scan = this.scanPlugin(path)
        if (scan.name === null || !scan.hasBundle) return
        plugins.set(scan.name, {
          name: scan.name,
          path: scan.path,
          version: scan.version,
          enabled: enabled.has(scan.name),
        })
      } catch {
        // Ordinary dependencies and transient package-manager entries are ignored.
      }
    }
    const nodeModules = join(profileDir, 'node_modules')
    if (existsSync(nodeModules)) {
      for (const entry of readdirSync(nodeModules)) {
        if (entry.startsWith('.')) continue
        const path = join(nodeModules, entry)
        try {
          if (!statSync(path).isDirectory()) continue
          if (entry.startsWith('@')) {
            for (const child of readdirSync(path)) {
              if (!child.startsWith('.')) inspect(join(path, child))
            }
          } else {
            inspect(path)
          }
        } catch {
          // A host profile may be updating while this list is being read.
        }
      }
    }
    return Array.from(plugins.values()).sort((left, right) => {
      if (left.enabled !== right.enabled) return left.enabled ? -1 : 1
      return left.name.localeCompare(right.name)
    })
  }

  /**
   * Run the plugin's build script in its checkout.
   *
   * Desktop generations receive a public desktopPnpm-backed runner, while
   * ordinary DSH retains the existing local pnpm fallback.
   * @param pluginPath - the plugin package directory.
   * @param pnpmPath - pnpm binary name/path (defaults to 'pnpm' on PATH).
   * @param signal - cancellation owned by the current Host generation.
   * @returns the build script's exit code.
   * @throws {SandboxError} when the package declares no build script or pnpm is missing.
   */
  async build(pluginPath: string, pnpmPath = 'pnpm', signal?: AbortSignal): Promise<number> {
    const scan = this.scanPlugin(pluginPath)
    if (scan.buildScript === null) {
      throw new SandboxError(`dsh-dev-sandbox: ${scan.name ?? pluginPath} declares no build script`)
    }
    const runner = this.options.buildRunner
    if (runner !== undefined) {
      const controller = new AbortController()
      this.buildControllers.add(controller)
      const buildSignal = signal === undefined
        ? controller.signal
        : AbortSignal.any([signal, controller.signal])
      let build: Promise<number>
      try {
        build = runner.build(scan.path, buildSignal)
      } catch (error) {
        this.buildControllers.delete(controller)
        throw error
      }
      this.activeBuilds.add(build)
      try {
        return await build
      } finally {
        this.activeBuilds.delete(build)
        this.buildControllers.delete(controller)
      }
    }
    signal?.throwIfAborted()
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

  /**
   * Start a disposable local compatibility check. This never downloads a
   * plugin, never runs its build script, and deliberately withholds the
   * host's API credentials and model settings. It proves only that the
   * already-built local source can mount and bring a selected DSH web profile
   * to readiness; it is not an operating-system security sandbox.
   */
  async verify(pluginPath: string, options: SandboxVerificationOptions = {}): Promise<SandboxCompatibilityVerification> {
    const checkedAt = new Date().toISOString()
    const profileMode = options.profileMode ?? 'clean'
    const scan = this.scanPlugin(pluginPath)
    const sourceFingerprint = createHash('sha256')
      .update(readFileSync(join(scan.path, 'package.json'), 'utf8'))
      .digest('hex')
    const kind: SandboxCompatibilityVerification['kind'] = options.kind
      ?? (options.repository !== undefined && options.commit !== undefined ? 'baseline-compatibility' : 'local-compatibility')
    const publicationError = kind === 'baseline-compatibility'
      && (profileMode !== 'clean' || options.repository === undefined || options.commit === undefined)
      ? 'baseline-compatibility requires repository, commit, and profileMode="clean"'
      : null
    const base = {
      format: 'dsh-plugin-verification/v1' as const,
      kind,
      repository: options.repository ?? null,
      commit: options.commit ?? null,
      checkedAt,
      profileMode,
      plugin: { name: scan.name, version: scan.version, sourceFingerprint },
      scan,
    }
    if (publicationError !== null || scan.issues.length > 0) {
      return {
        ...base,
        result: 'failed',
        profileBundles: [],
        error: [publicationError, ...scan.issues].filter(Boolean).join('; '),
        logs: '',
      }
    }

    const name = `verify-${Date.now().toString(36)}-${(++this.verificationSequence).toString(36)}`
    let profileBundles: string[] = []
    let error: string | null = null
    let logs = ''
    try {
      const created = this.create(name, scan.path, {
        inheritHostApi: false,
        inheritHostModel: false,
        profileMode,
      })
      profileBundles = created.profileBundles ?? []
      // Explicit false prevents the host's optional buildOnStart setting from
      // executing an untrusted package lifecycle during a market check.
      await this.start(name, undefined, { build: false })
      logs = this.logs(name, 200) ?? ''
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
      logs = this.logs(name, 200) ?? ''
    } finally {
      try {
        await this.destroy(name)
      } catch (cleanupError) {
        const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        error = error === null ? cleanupMessage : `${error}; cleanup: ${cleanupMessage}`
      }
    }
    return {
      ...base,
      result: error === null ? 'passed' : 'failed',
      profileBundles,
      error,
      logs,
    }
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * Create a sandbox (idempotent for the same plugin and profile mode). Each
   * profile is rebuilt inside the isolated home; host-web mode copies only
   * composition files and package links, never sessions, storage, or secrets.
   * @param name - sandbox name (filesystem-safe identifier).
   * @param pluginPath - optional absolute path of the plugin under development.
   * @param opts - per-sandbox inheritance and profile overrides.
   * @returns the created sandbox summary.
   * @throws {SandboxError} on invalid names or unbuildable plugins.
   */
  create(name: string, pluginPath?: string, opts: SandboxCreateOptions = {}): SandboxSummary {
    if (!NAME_PATTERN.test(name)) {
      throw new SandboxError(
        `dsh-dev-sandbox: invalid sandbox name ${JSON.stringify(name)} — use 1-32 chars of [A-Za-z0-9_-]`,
      )
    }
    const profileMode = opts.profileMode ?? 'clean'
    if (profileMode !== 'clean' && profileMode !== 'host-web') {
      throw new SandboxError(`dsh-dev-sandbox: invalid profile mode ${JSON.stringify(profileMode)}`)
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
    const unchanged = existing !== null
      && resolve(existing.pluginPath) === resolve(pluginDir)
      && profileModeOf(existing) === profileMode
    if (unchanged) return existing
    if (existing !== null && (existing.status === 'running' || existing.status === 'starting')) {
      throw new SandboxError(`dsh-dev-sandbox: stop ${JSON.stringify(name)} before changing its plugin or profile mode`)
    }
    const home = this.homeOf(name)
    const profileDir = join(home, 'profiles', 'web')
    if (existing !== null) rmSync(profileDir, { recursive: true, force: true })
    mkdirSync(profileDir, { recursive: true })
    const profile = profileMode === 'host-web'
      ? this.mirrorHostProfile(profileDir, pluginName, pluginDir)
      : this.writeCleanProfile(profileDir, pluginName, pluginDir)
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
      profileMode,
      profileSource: profile.source,
      profileBundles: profile.bundles,
      createdAt: existing?.createdAt ?? now,
      startedAt: null,
      stoppedAt: null,
      lastError: null,
      url: null,
    }
    this.writeState(name, state)
    const profileLabel = profileMode === 'host-web'
      ? `host web profile (${profile.bundles.length} bundles)`
      : 'clean web profile'
    this.pushLog(
      name,
      pluginName === ''
        ? `[dsh-dev-sandbox] created home ${home} (${profileLabel}, no plugin)\n`
        : `[dsh-dev-sandbox] created home ${home} (${profileLabel}, plugin ${pluginName}@${pluginVersion ?? '?'})\n`,
    )
    return this.withResourceUsage(state)
  }

  /** Write the stock two-bundle profile and optionally mount the test plugin. */
  private writeCleanProfile(profileDir: string, pluginName: string, pluginDir: string): { source: null; bundles: string[] } {
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
    if (pluginName !== '') this.ensurePackageJunction(profileDir, pluginName, pluginDir)
    return { source: null, bundles }
  }

  /** Mirror the active host profile's composition into an isolated profile directory. */
  private mirrorHostProfile(profileDir: string, pluginName: string, pluginDir: string): { source: string; bundles: string[] } {
    const source = this.hostProfileDir()
    const manifestFile = join(source, 'package.json')
    if (!existsSync(manifestFile)) {
      throw new SandboxError(`dsh-dev-sandbox: host profile is missing ${manifestFile}`)
    }
    let sourceManifest: Record<string, unknown>
    try {
      sourceManifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>
    } catch {
      throw new SandboxError(`dsh-dev-sandbox: host profile manifest is not valid JSON (${manifestFile})`)
    }
    const sourceDsh = sourceManifest.dsh
    const dsh = sourceDsh !== null && typeof sourceDsh === 'object' && !Array.isArray(sourceDsh)
      ? sourceDsh as Record<string, unknown>
      : {}
    const sourceProfile = dsh.profile
    const profile = sourceProfile !== null && typeof sourceProfile === 'object' && !Array.isArray(sourceProfile)
      ? sourceProfile as Record<string, unknown>
      : {}
    const sourceBundles = profile.bundles
    if (!Array.isArray(sourceBundles) || !sourceBundles.every(item => typeof item === 'string' && item !== '')) {
      throw new SandboxError(`dsh-dev-sandbox: host web profile has no valid dsh.profile.bundles (${manifestFile})`)
    }
    const bundles = [...sourceBundles]
    if (pluginName !== '' && !bundles.includes(pluginName)) bundles.push(pluginName)
    const sourceDependencies = sourceManifest.dependencies
    const dependencies = sourceDependencies !== null && typeof sourceDependencies === 'object' && !Array.isArray(sourceDependencies)
      ? { ...sourceDependencies as Record<string, unknown> }
      : {}
    if (pluginName !== '') dependencies[pluginName] = `link:${resolve(pluginDir)}`
    const manifest = {
      ...sourceManifest,
      dsh: { ...dsh, profile: { ...profile, bundles } },
      dependencies,
    }
    for (const [file, fallback] of [
      ['cordis.yml', PROFILE_ROOT_CONFIG],
      ['cordis.patch.yml', PROFILE_PATCH_TEMPLATE],
      ['pnpm-workspace.yaml', PROFILE_PNPM_WORKSPACE],
    ] as const) {
      const sourceFile = join(source, file)
      if (existsSync(sourceFile)) copyFileSync(sourceFile, join(profileDir, file))
      else writeFileSync(join(profileDir, file), fallback)
    }
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
    this.mirrorHostPackages(source, profileDir, pluginName)
    if (pluginName !== '') this.ensurePackageJunction(profileDir, pluginName, pluginDir)
    return { source, bundles }
  }

  /** Link packages visible to the host profile without copying its package store. */
  private mirrorHostPackages(sourceProfile: string, profileDir: string, excludedPackage: string): void {
    const sourceModules = join(sourceProfile, 'node_modules')
    if (!existsSync(sourceModules)) return
    for (const entry of readdirSync(sourceModules)) {
      if (entry.startsWith('.')) continue
      const sourceEntry = join(sourceModules, entry)
      let entryStat: ReturnType<typeof statSync>
      try {
        entryStat = statSync(sourceEntry)
      } catch {
        continue
      }
      if (!entryStat.isDirectory()) continue
      if (entry.startsWith('@')) {
        for (const child of readdirSync(sourceEntry)) {
          if (child.startsWith('.')) continue
          const packageName = `${entry}/${child}`
          const packagePath = join(sourceEntry, child)
          try {
            if (statSync(packagePath).isDirectory() && packageName !== excludedPackage) {
              this.ensurePackageJunction(profileDir, packageName, packagePath)
            }
          } catch {
            // A package disappearing during a profile update is simply skipped.
          }
        }
      } else if (entry !== excludedPackage) {
        this.ensurePackageJunction(profileDir, entry, sourceEntry)
      }
    }
  }

  /** Junction `<profile>/node_modules/<pkg>` to a host or test-plugin package. */
  private ensurePackageJunction(profileDir: string, packageName: string, target: string): void {
    const link = join(profileDir, 'node_modules', ...packageName.split('/'))
    mkdirSync(dirname(link), { recursive: true })
    if (existsSync(link)) {
      const isLink = lstatSync(link).isSymbolicLink()
      if (!isLink) {
        throw new SandboxError(
          `dsh-dev-sandbox: ${link} exists as a real directory; remove it or choose another sandbox name`,
        )
      }
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
  async start(name: string, port?: number, options: { build?: boolean } = {}): Promise<SandboxSummary> {
    let state = this.get(name)
    if (state === null) {
      throw new SandboxError(`dsh-dev-sandbox: unknown sandbox ${JSON.stringify(name)}`)
    }
    if (state.status === 'running' || state.status === 'starting') {
      return state
    }
    if ((options.build ?? this.options.buildOnStart) && state.pluginPath !== '') {
      try {
        const exitCode = await this.build(state.pluginPath)
        if (exitCode !== 0) {
          throw new SandboxError(`dsh-dev-sandbox: build failed with exit code ${exitCode}`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        state = this.mutateState(name, { status: 'error', lastError: message })
        throw error
      }
    }
    if (port !== undefined) {
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new SandboxError(`dsh-dev-sandbox: invalid port ${port}; use an integer in 1..65535`)
      }
      if (!await portFree(port)) {
        throw new SandboxError(`dsh-dev-sandbox: port ${port} is already in use`)
      }
    }
    const spawnPort = port ?? await findFreePort(this.options.basePort)
    const { root, cliEntry, nodeArgs, nodeExec } = this.harnessInfo()
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
      [...nodeArgs, cliEntry, 'web', '--port', String(spawnPort)],
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
      if (childPid !== null) await this.terminateProcess(childPid, child)
      if (this.children.get(name) === child) this.children.delete(name)
      this.mutateState(name, { status: 'error', pid: null, url: null, lastError: message })
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

  /** Wait for a process to exit without relying on an in-memory child handle. */
  private async waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this.pidAlive(pid)) return true
      await delay(100)
    }
    return !this.pidAlive(pid)
  }

  /** Terminate a sandbox process, including one recovered from persisted state. */
  private async terminateProcess(pid: number, child?: ChildProcess): Promise<void> {
    if (!this.pidAlive(pid)) return
    try {
      if (child !== undefined && child.exitCode === null) child.kill('SIGTERM')
      else process.kill(pid, 'SIGTERM')
    } catch {
      // The process can exit between the liveness probe and the termination signal.
    }
    if (await this.waitForExit(pid, this.options.stopTimeoutMs)) return
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      try { process.kill(pid, 'SIGKILL') } catch { /* Process exited concurrently. */ }
    }
    await this.waitForExit(pid, 3000)
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
    if (state.pid === null) return
    const child = this.children.get(name)
    this.pushLog(name, '[dsh-dev-sandbox] stopping (SIGTERM)\n')
    await this.terminateProcess(state.pid, child)
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
    this.resourceCache.delete(name)
  }

  /** Patch one sandbox's persisted state and return the new summary. */
  private mutateState(name: string, patch: Partial<SandboxState>): SandboxSummary {
    const state = readStateFile(this.homeOf(name))
    if (state === null) throw new SandboxError(`dsh-dev-sandbox: unknown sandbox ${JSON.stringify(name)}`)
    const next = { ...state, ...patch }
    this.writeState(name, next)
    this.resourceCache.delete(name)
    return this.withResourceUsage(next)
  }

  /** Stop owned processes and await cancelled Desktop-managed builds on Host teardown. */
  async dispose(): Promise<void> {
    const builds = Array.from(this.activeBuilds)
    for (const controller of this.buildControllers) controller.abort()
    for (const child of this.children.values()) {
      if (child.exitCode === null) child.kill('SIGTERM')
    }
    this.children.clear()
    await Promise.allSettled(builds)
    this.buildControllers.clear()
  }
}

/** Default sandbox root under the OS home. */
export function defaultHomeRoot(): string {
  return join(homedir(), '.dsh-sandboxes')
}
