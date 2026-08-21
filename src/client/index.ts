/**
 * Browser half of @zp-home/dsh-dev-sandbox: registers the sandbox workbench
 * as a first-class page in the Desktop Settings navigation.
 * @module dsh-dev-sandbox/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from './contracts.ts'
import { NS, tt, zh, en } from './locales.ts'
import { SandboxSettingsSection } from './SandboxSettingsSection.tsx'
import { registerSandboxSettingsSection, type SandboxSlotRegistryContext } from './slot-registry.ts'

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'locale']

/**
 * Register the dev-sandbox Settings page.
 * @param ctx - client root context (locale service).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const disposeZh = ctx.locale.register(NS, 'zh', zh)
    const disposeEn = ctx.locale.register(NS, 'en', en)
    return () => {
      disposeEn()
      disposeZh()
    }
  }, 'dsh-dev-sandbox: dictionaries')
  registerSandboxSettingsSection(
    ctx as unknown as SandboxSlotRegistryContext,
    SandboxSettingsSection,
    () => tt('entry.label'),
  )
}
