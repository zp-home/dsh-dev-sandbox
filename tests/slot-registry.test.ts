import assert from 'node:assert/strict'
import test from 'node:test'
import { registerSandboxSettingsSection, type SandboxSlotRegistration } from '../src/client/slot-registry.ts'

test('registers the sandbox page immediately after Agent presets', () => {
  const registrations: Array<{ registration: SandboxSlotRegistration; component: unknown }> = []
  const callbacks: Array<() => (() => void)> = []
  const context = {
    slots: {
      inject(_name: 'settings.section', callback: () => (() => void)) {
        callbacks.push(callback)
      },
      register(registration: SandboxSlotRegistration, component: unknown) {
        registrations.push({ registration, component })
        return () => {}
      },
    },
  }

  const section = Symbol('section')
  registerSandboxSettingsSection(context, section, () => 'Sandbox')
  assert.equal(callbacks.length, 1)
  for (const callback of callbacks) callback()

  assert.equal(registrations.length, 1)
  assert.equal(registrations[0]?.component, section)
  assert.equal(registrations[0]?.registration.name, 'settings.section')
  assert.equal(registrations[0]?.registration.id, 'sandbox')
  assert.equal(registrations[0]?.registration.order, 25)
  assert.equal(registrations[0]?.registration.locale, 'dsh-dev-sandbox')
  assert.equal(registrations[0]?.registration.label(), 'Sandbox')
})
