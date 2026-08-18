import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { resolveHarness } from '../src/harness.ts'
import { isLoopbackAddress } from '../src/routes.ts'

function fixture(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-dev-sandbox-'))
}

function writeFile(path: string, content = ''): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

test('resolves a source checkout harness', () => {
  const root = fixture()
  try {
    writeFile(join(root, 'apps', 'cli', 'src', 'bin.ts'))
    const harness = resolveHarness(root)
    assert.equal(harness.kind, 'source')
    assert.equal(harness.root, root)
    assert.equal(harness.cliEntry, join(root, 'apps', 'cli', 'src', 'bin.ts'))
    assert.deepEqual(harness.nodeArgs, ['--import', 'tsx/esm'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolves a published DSH CLI package', () => {
  const root = fixture()
  try {
    writeFile(join(root, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      bin: { dsh: 'lib/bin.js' },
    }))
    writeFile(join(root, 'lib', 'bin.js'))
    const harness = resolveHarness(root)
    assert.equal(harness.kind, 'installed')
    assert.equal(harness.root, root)
    assert.equal(harness.cliEntry, join(root, 'lib', 'bin.js'))
    assert.deepEqual(harness.nodeArgs, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a harness root without a supported CLI entry', () => {
  const root = fixture()
  try {
    assert.throws(() => resolveHarness(root), /not a dsh source checkout or installed @deepseek-ai\/dsh package/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('accepts loopback addresses and rejects remote peers', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('192.168.1.5'), false)
  assert.equal(isLoopbackAddress(undefined), false)
})
