import { useEffect, useRef } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SandboxApi } from './api.ts'
import { tt } from './locales.ts'
import { mountSettingsPanel } from './panel.ts'

export type SandboxSettingsSectionProps = PropsRuntime<'settings.section'>

/** Settings content page for managing isolated plugin-development sandboxes. */
export function SandboxSettingsSection(_props: SandboxSettingsSectionProps) {
  const host = useRef<HTMLElement>(null)

  useEffect(() => {
    if (host.current === null) return
    return mountSettingsPanel(new SandboxApi(), host.current)
  }, [])

  return <section ref={host} className="dshsb-settings-host" aria-label={tt('panel.title')} />
}
