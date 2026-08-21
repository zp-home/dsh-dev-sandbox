import { NS } from './locales.ts'

export type SandboxSlotName = 'settings.section'

export interface SandboxSlotRegistration {
  readonly name: SandboxSlotName
  readonly id: 'sandbox'
  readonly order: 25
  readonly locale: typeof NS
  readonly label: () => string
}

export interface SandboxSlotRegistryContext {
  readonly slots: {
    inject(name: SandboxSlotName, callback: () => (() => void)): void
    register(registration: SandboxSlotRegistration, component: unknown): () => void
  }
}

/** Register the sandbox page immediately after Agent presets. */
export function registerSandboxSettingsSection(
  ctx: SandboxSlotRegistryContext,
  section: unknown,
  label: () => string,
): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'sandbox',
    order: 25,
    locale: NS,
    label,
  }, section))
}
