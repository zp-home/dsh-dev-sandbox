/**
 * Browser half of @zp-home/dsh-dev-sandbox: mounts the sidebar entry and
 * the sandbox panel in the web GUI. Exports the cordis client-plugin contract
 * (`apply` + `inject`) handed to `window.__ModuleLoader__.load`.
 * @module dsh-dev-sandbox/client
 */

import { SandboxApi } from './api.ts'
import { NS, zh, en } from './locales.ts'
import { createPanelController, mountPanel, mountSidebarEntry } from './panel.ts'

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'locale']

/**
 * Mount the dev-sandbox panel.
 * @param ctx - client root context (locale service).
 */
export function apply(ctx: {
  effect(fn: () => (() => void) | void, label?: string): () => void
  locale: { register(namespace: string, dictionaries: Record<string, Record<string, string>>): void }
}): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-dev-sandbox: dictionaries')

  const controller = createPanelController()
  const api = new SandboxApi()
  const disposers: Array<() => void> = []
  try {
    disposers.push(mountSidebarEntry(controller))
    disposers.push(mountPanel(api, controller))
  } catch (error) {
    console.warn('[dsh-dev-sandbox] mount failed:', error)
  }
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'dsh-dev-sandbox: ui mounts')
}
