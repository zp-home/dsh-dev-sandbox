import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { desktopSandboxAdapter } from '../src/desktop.ts'
import { apply } from '../src/index.ts'
import { SandboxManager } from '../src/manager.ts'

function fixture(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-dev-sandbox-desktop-'))
}

function writeFile(path: string, content = ''): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function writePlugin(root: string, name = '@example/test-plugin'): string {
  const plugin = join(root, 'plugin')
  writeFile(join(plugin, 'package.json'), JSON.stringify({
    name,
    main: 'lib/index.js',
    scripts: { build: 'node -e ""' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFile(join(plugin, 'lib', 'index.js'))
  writeFile(join(plugin, 'cordis.patch.yml'), '[]\n')
  return plugin
}

function manager(root: string, options: Partial<ConstructorParameters<typeof SandboxManager>[0]> = {}): SandboxManager {
  return new SandboxManager({
    homeRoot: join(root, 'sandboxes'),
    basePort: 4700,
    buildOnStart: false,
    inheritHostApi: false,
    inheritHostModel: false,
    readyTimeoutMs: 1_000,
    stopTimeoutMs: 1_000,
    ...options,
  })
}

function context(services: Record<string, unknown>): Context {
  return {
    get(name: string): unknown {
      return services[name]
    },
  } as unknown as Context
}

test('adapts the Desktop profile and runs builds through desktopPnpm', async () => {
  const root = fixture()
  try {
    const plugin = writePlugin(root)
    const calls: Array<{ args: readonly string[]; signal: AbortSignal | undefined }> = []
    let stdoutDrained = false
    let stderrDrained = false
    const adapter = desktopSandboxAdapter(context({
      desktopProfiles: { current: { name: 'desktop', dir: join(root, 'profile') } },
      desktopPnpm: {
        run(args: readonly string[], signal?: AbortSignal) {
          calls.push({ args, signal })
          return {
            stdout: { resume: () => { stdoutDrained = true } },
            stderr: { resume: () => { stderrDrained = true } },
            done: Promise.resolve({ exitCode: 0, signal: null }),
            cancel() {},
          }
        },
      },
    }))
    assert.ok(adapter)
    assert.deepEqual(adapter.hostProfile, { name: 'desktop', dir: join(root, 'profile') })
    assert.equal(await adapter.buildRunner.build(plugin), 0)
    assert.deepEqual(calls[0]?.args, ['--dir', plugin, 'run', 'build'])
    assert.ok(calls[0]?.signal instanceof AbortSignal)
    assert.equal(stdoutDrained, true)
    assert.equal(stderrDrained, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('requires both documented Desktop services before adapting', () => {
  const root = fixture()
  try {
    assert.equal(desktopSandboxAdapter(context({
      desktopProfiles: { current: { name: 'desktop', dir: root } },
    })), undefined)
    assert.equal(desktopSandboxAdapter(context({
      desktopPnpm: { run() {} },
    })), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('mirrors the Desktop-selected profile instead of assuming profiles/web', async () => {
  const root = fixture()
  try {
    const sourceProfile = join(root, 'selected-profile')
    writeFile(join(sourceProfile, 'package.json'), JSON.stringify({
      name: 'selected-profile',
      private: true,
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@example/desktop-only'],
        },
      },
    }))
    writeFile(join(sourceProfile, 'cordis.yml'), '[]\n')
    writeFile(join(sourceProfile, 'cordis.patch.yml'), '[]\n')
    const plugin = writePlugin(root)
    const sandbox = manager(root, {
      hostProfile: { name: 'desktop', dir: sourceProfile },
    })
    const created = sandbox.create('desktop-mirror', plugin, { profileMode: 'host-web' })
    assert.equal(created.profileSource, sourceProfile)
    assert.deepEqual(created.profileBundles, [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@example/desktop-only',
      '@example/test-plugin',
    ])
    const manifest = JSON.parse(readFileSync(join(root, 'sandboxes', 'desktop-mirror', 'profiles', 'web', 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    assert.deepEqual(manifest.dsh.profile.bundles, created.profileBundles)
    await sandbox.destroy('desktop-mirror')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cancels a Desktop-managed build when its Host generation disposes', async () => {
  const root = fixture()
  try {
    const plugin = writePlugin(root)
    let observed: AbortSignal | undefined
    const sandbox = manager(root, {
      buildRunner: {
        build(_pluginPath, signal) {
          observed = signal
          return new Promise(resolve => {
            signal?.addEventListener('abort', () => resolve(1), { once: true })
          })
        },
      },
    })
    const build = sandbox.build(plugin)
    sandbox.dispose()
    assert.equal(await build, 1)
    assert.equal(observed?.aborted, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

type Cleanup = () => void

interface Injection {
  readonly names: readonly string[]
  readonly callback: (ctx: Context) => void | Cleanup
  active: boolean
  cleanup?: Cleanup
}

function lifecycleHarness(): {
  readonly context: Context
  provide(name: string, value: unknown): void
  remove(name: string): void
  dispose(): void
  counts(): { routes: number; routeDisposals: number; tools: number; toolDisposals: number }
} {
  const values = new Map<string, unknown>()
  const injections: Injection[] = []
  const effects = new Set<Cleanup>()
  let routes = 0
  let routeDisposals = 0
  let tools = 0
  let toolDisposals = 0
  let context: Context

  const activate = (injection: Injection): void => {
    if (injection.active || !injection.names.every(name => values.has(name))) return
    injection.cleanup = injection.callback(context)
    injection.active = true
  }
  context = {
    get(name: string): unknown {
      return values.get(name)
    },
    effect(callback: () => void | Cleanup): Cleanup {
      const cleanup = callback()
      if (typeof cleanup !== 'function') return () => {}
      effects.add(cleanup)
      return () => {
        if (effects.delete(cleanup)) cleanup()
      }
    },
    inject(names: readonly string[], callback: (ctx: Context) => void | Cleanup): void {
      const injection: Injection = { names, callback, active: false }
      injections.push(injection)
      activate(injection)
    },
    webServer: {
      register(): Cleanup {
        routes++
        return () => { routeDisposals++ }
      },
    },
    tools: {
      register(): Cleanup {
        tools++
        return () => { toolDisposals++ }
      },
    },
    systemPrompt: {
      section(): Cleanup {
        return () => {}
      },
    },
  } as unknown as Context

  return {
    context,
    provide(name: string, value: unknown): void {
      values.set(name, value)
      for (const injection of injections) activate(injection)
    },
    remove(name: string): void {
      values.delete(name)
      for (const injection of injections) {
        if (!injection.active || !injection.names.includes(name)) continue
        injection.cleanup?.()
        injection.cleanup = undefined
        injection.active = false
      }
    },
    dispose(): void {
      for (const injection of injections.toReversed()) {
        injection.cleanup?.()
        injection.cleanup = undefined
        injection.active = false
      }
      for (const cleanup of Array.from(effects).reverse()) cleanup()
      effects.clear()
    },
    counts() {
      return { routes, routeDisposals, tools, toolDisposals }
    },
  }
}

test('waits for desktopPnpm and unloads Desktop surfaces with its generation', () => {
  const root = fixture()
  try {
    const harness = lifecycleHarness()
    harness.provide('desktopProfiles', { current: { name: 'desktop', dir: root } })
    apply(harness.context, { announceToAgent: false })
    assert.deepEqual(harness.counts(), {
      routes: 0,
      routeDisposals: 0,
      tools: 0,
      toolDisposals: 0,
    })

    harness.provide('desktopPnpm', { run() { throw new Error('build runner was not expected') } })
    const mounted = harness.counts()
    assert.equal(mounted.routes, 1)
    assert.ok(mounted.tools > 0)

    harness.remove('desktopPnpm')
    const disposed = harness.counts()
    assert.equal(disposed.routeDisposals, 1)
    assert.equal(disposed.toolDisposals, mounted.tools)
    harness.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
