import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { SandboxLocaleKey } from './locales.ts'

/**
 * Public shell slots used by this external plugin. They are repeated here so
 * the plugin typechecks independently of whether the host publishes its
 * internal slot-contract declaration files through the client entry point.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-dev-sandbox': SandboxLocaleKey
  }

  interface SlotMap {
    'settings.section': {
      kind: 'list'
      scope: 'root'
      owner: { close: () => void }
    }
  }
}

export {}
