/**
 * Dev-sandbox panel UI: a right-edge overlay panel plus a sidebar entry,
 * both pure DOM (no React), mirroring the proven mounting approach of the
 * sibling web-ui plugins. The panel lists sandboxes, creates/starts/stops/
 * restarts/destroys them, and shows captured logs.
 * @module dsh-dev-sandbox/client/panel
 */

import { SandboxApi, type PluginScan, type SandboxSummary } from './api.ts'
import { tt } from './locales.ts'

/** Panel open/close state holder with subscribers (for the sidebar entry). */
export interface PanelController {
  open(): void
  close(): void
  toggle(): void
  getSnapshot(): { panelOpen: boolean }
  subscribe(listener: () => void): () => void
}

/** Create the open/close controller. */
export function createPanelController(): PanelController {
  let panelOpen = false
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of listeners) listener() }
  return {
    open() {
      if (panelOpen) return
      panelOpen = true
      notify()
    },
    close() {
      if (!panelOpen) return
      panelOpen = false
      notify()
    },
    toggle() {
      panelOpen = !panelOpen
      notify()
    },
    getSnapshot() {
      return { panelOpen }
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

// ---------------------------------------------------------------- styles

const PANEL_CSS = `
.dshsb-panel{position:fixed;top:0;right:0;bottom:0;width:460px;max-width:94vw;z-index:10000;display:flex;flex-direction:column;background:var(--dshsb-bg,#ffffff);color:var(--dshsb-fg,#1f2328);border-left:1px solid var(--dshsb-border,rgba(0,0,0,.14));box-shadow:-8px 0 28px rgba(0,0,0,.16);font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;transform:translateX(105%);transition:transform .18s ease;overflow:hidden}
.dshsb-panel.dshsb-open{transform:translateX(0)}
.dshsb-panel *{box-sizing:border-box}
.dshsb-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dshsb-border,rgba(0,0,0,.1));flex:none}
.dshsb-head h3{margin:0;font-size:14px;font-weight:600}
.dshsb-head .dshsb-sub{font-size:11px;opacity:.65}
.dshsb-head .dshsb-spacer{flex:1}
.dshsb-btn{border:1px solid var(--dshsb-border,rgba(0,0,0,.18));background:transparent;color:inherit;border-radius:6px;padding:4px 10px;font:inherit;cursor:pointer}
.dshsb-btn:hover{background:rgba(127,127,127,.12)}
.dshsb-btn:disabled{opacity:.5;cursor:default}
.dshsb-btn.dshsb-primary{background:var(--dshsb-accent,#2563eb);border-color:transparent;color:#fff}
.dshsb-btn.dshsb-danger{border-color:rgba(220,38,38,.5);color:var(--dshsb-danger,#dc2626)}
.dshsb-body{flex:1;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:14px}
.dshsb-card{border:1px solid var(--dshsb-border,rgba(0,0,0,.12));border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.dshsb-card h4{margin:0;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px}
.dshsb-badge{font-size:10px;padding:1px 7px;border-radius:99px;text-transform:uppercase;letter-spacing:.4px}
.dshsb-badge.dshsb-stopped{background:rgba(127,127,127,.15);color:inherit}
.dshsb-badge.dshsb-starting{background:rgba(234,179,8,.18);color:#a16207}
.dshsb-badge.dshsb-running{background:rgba(22,163,74,.16);color:#15803d}
.dshsb-badge.dshsb-exited{background:rgba(127,127,127,.15);color:inherit}
.dshsb-badge.dshsb-error{background:rgba(220,38,38,.14);color:#dc2626}
.dshsb-meta{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;opacity:.75}
.dshsb-actions{display:flex;flex-wrap:wrap;gap:6px}
.dshsb-url{color:var(--dshsb-accent,#2563eb);text-decoration:none}
.dshsb-field{display:flex;flex-direction:column;gap:3px}
.dshsb-field label{font-size:11px;opacity:.75}
.dshsb-field input{border:1px solid var(--dshsb-border,rgba(0,0,0,.2));background:transparent;color:inherit;border-radius:6px;padding:5px 8px;font:inherit}
.dshsb-field input:focus{outline:2px solid var(--dshsb-accent,#2563eb);outline-offset:-1px;border-color:transparent}
.dshsb-check{display:flex;align-items:center;gap:6px;font-size:12px}
.dshsb-error-box{border:1px solid rgba(220,38,38,.4);background:rgba(220,38,38,.06);color:var(--dshsb-danger,#dc2626);border-radius:8px;padding:8px 10px;font-size:12px;white-space:pre-wrap;word-break:break-all}
.dshsb-scan{border:1px solid var(--dshsb-border,rgba(0,0,0,.12));border-radius:8px;padding:8px 10px;font-size:12px;display:flex;flex-direction:column;gap:4px}
.dshsb-scan .dshsb-ok{color:#15803d}
.dshsb-scan .dshsb-warn{color:#a16207}
.dshsb-logs{background:rgba(0,0,0,.06);border-radius:8px;padding:8px 10px;font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow:auto;margin:0}
.dshsb-empty{opacity:.6;font-size:12px;padding:4px 0}
.dshsb-entry{display:flex;align-items:center;gap:8px;width:100%;padding:7px 12px;border:none;background:transparent;color:inherit;cursor:pointer;font:inherit;text-align:left;border-radius:6px}
.dshsb-entry:hover{background:rgba(127,127,127,.12)}
.dshsb-entry[data-active="true"]{background:rgba(127,127,127,.2)}
.dshsb-entry-icon{display:inline-flex;width:18px;height:18px;flex:none}
.dshsb-entry-label{font-size:13px}
@media (prefers-color-scheme: dark){
.dshsb-panel{--dshsb-bg:#1f2226;--dshsb-fg:#e6e6e6;--dshsb-border:rgba(255,255,255,.14);--dshsb-accent:#60a5fa;--dshsb-danger:#f87171}
.dshsb-logs{background:rgba(255,255,255,.07)}
.dshsb-badge.dshsb-starting{color:#fbbf24}
.dshsb-badge.dshsb-running{color:#4ade80}
.dshsb-badge.dshsb-error{color:#f87171}
}
`

/** Ensure the plugin's stylesheet is injected once. */
function ensureStyles(): void {
  if (document.querySelector('style[data-plugin-css="dsh-dev-sandbox/panel.css"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-dev-sandbox'
  tag.dataset.pluginCss = 'dsh-dev-sandbox/panel.css'
  tag.textContent = PANEL_CSS
  document.head.appendChild(tag)
}

// ------------------------------------------------------------- elements

/** Create an element with props/children. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Array<HTMLElement | Text | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = String(value)
    else if (key === 'dataset') Object.assign(node.dataset, value as Record<string, string>)
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    } else if (key === 'value') {
      (node as HTMLInputElement).value = String(value)
    } else {
      node.setAttribute(key, String(value))
    }
  }
  for (const child of children) {
    if (child === undefined || child === null) continue
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

// ---------------------------------------------------------------- icons

const ICON_SANDBOX = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.5l5.5 3v7L8 14.5 2.5 11.5v-7z"/><path d="M2.8 4.6L8 7.4l5.2-2.8"/><path d="M8 7.5v6.8"/></svg>'

const ICON_REFRESH = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 1.8v2.7h-2.7"/></svg>'

const ICON_CLOSE = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>'

const ICON_OPEN = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 2.5H3a.5.5 0 0 0-.5.5v10a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5V9.5"/><path d="M9 2.5h4.5V7"/><path d="M13.5 2.5L7 9"/></svg>'

/** Render an inline SVG icon string as a real element (never as text). */
function icon(svg: string, className?: string): HTMLSpanElement {
  const span = document.createElement('span')
  if (className !== undefined) span.className = className
  span.innerHTML = svg
  return span
}

// ---------------------------------------------------------------- panel

interface PanelState {
  sandboxes: SandboxSummary[]
  error: string | null
  scan: PluginScan | null
  scanError: string | null
  logName: string | null
  logLines: string
  creating: boolean
  busy: Record<string, boolean>
}

const STATUS_KEYS: Record<string, string> = {
  stopped: 'list.status.stopped',
  starting: 'list.status.starting',
  running: 'list.status.running',
  exited: 'list.status.exited',
  error: 'list.status.error',
}

/**
 * Build the panel element and its interaction wiring.
 * @param api - the route client.
 * @param controller - open/close controller (panel element toggling).
 * @param disposeRef - receives the panel's disposer.
 * @returns the panel root element.
 */
export function createPanel(
  api: SandboxApi,
  controller: PanelController,
  disposeRef: { current: (() => void) | null },
): HTMLElement {
  ensureStyles()
  const state: PanelState = {
    sandboxes: [],
    error: null,
    scan: null,
    scanError: null,
    logName: null,
    logLines: '',
    creating: false,
    busy: {},
  }

  const nameInput = el('input', { type: 'text', placeholder: tt('create.name.ph') })
  const pluginInput = el('input', { type: 'text', placeholder: tt('create.plugin.ph') })
  const portInput = el('input', { type: 'text', placeholder: '4000' })
  const buildCheck = el('input', { type: 'checkbox' }) as HTMLInputElement
  buildCheck.checked = false
  const inheritCheck = el('input', { type: 'checkbox' }) as HTMLInputElement
  inheritCheck.checked = true
  const body = el('div', { class: 'dshsb-body' })

  /** Re-render the whole body from state. */
  const render = (): void => {
    body.replaceChildren()
    if (state.error !== null) {
      body.append(el('div', { class: 'dshsb-error-box' }, state.error))
    }
    body.append(createFormSection())
    if (state.scan !== null) body.append(scanSection(state.scan))
    if (state.scanError !== null) body.append(el('div', { class: 'dshsb-error-box' }, state.scanError))
    body.append(listSection())
    if (state.logName !== null) body.append(logSection(state.logName))
  }

  /** The create/build form section. */
  const createFormSection = (): HTMLElement => {
    const section = el('section', { class: 'dshsb-card' })
    section.append(el('h4', {}, tt('create.title')))
    section.append(el('div', { class: 'dshsb-field' }, el('label', {}, tt('create.name')), nameInput))
    section.append(el('div', { class: 'dshsb-field' }, el('label', {}, tt('create.plugin')), pluginInput))
    section.append(el('div', { class: 'dshsb-field' }, el('label', {}, tt('create.port')), portInput))
    section.append(el('label', { class: 'dshsb-check' }, buildCheck, tt('create.build')))
    section.append(el('label', { class: 'dshsb-check' }, inheritCheck, tt('create.inherit')))
    const row = el('div', { class: 'dshsb-actions' })
    const submit = el('button', {
      class: 'dshsb-btn dshsb-primary',
      disabled: state.creating,
      onclick: () => { void onCreate() },
    }, state.creating ? tt('common.busy') : tt('create.submit'))
    const scanBtn = el('button', {
      class: 'dshsb-btn',
      onclick: () => { void onScan() },
    }, tt('create.scan'))
    row.append(submit, scanBtn)
    section.append(row)
    return section
  }

  /** The scan-result section. */
  const scanSection = (scan: PluginScan): HTMLElement => {
    const box = el('div', { class: 'dshsb-scan' })
    box.append(el('strong', {}, `${tt('scan.title')} — ${scan.name ?? scan.path}`))
    box.append(el('span', {}, `version: ${scan.version ?? '-'}  ·  bundle: ${scan.hasBundle ? scan.bundlePatch : '✗'}`))
    box.append(el('span', {}, `host built: ${scan.hostBuilt ? '✓' : '✗'}  ·  client built: ${scan.clientBuilt ? '✓' : scan.clientDeclared ? '✗' : '—'}`))
    if (scan.issues.length > 0) {
      for (const issue of scan.issues) box.append(el('span', { class: 'dshsb-warn' }, `⚠ ${issue}`))
    } else {
      box.append(el('span', { class: 'dshsb-ok' }, `✓ ${tt('scan.ok')}`))
    }
    return box
  }

  /** The sandbox list section. */
  const listSection = (): HTMLElement => {
    const section = el('section', { class: 'dshsb-card' })
    section.append(el('h4', {}, tt('list.title')))
    if (state.sandboxes.length === 0) {
      section.append(el('div', { class: 'dshsb-empty' }, tt('common.empty')))
      return section
    }
    for (const sandbox of state.sandboxes) {
      section.append(sandboxCard(sandbox))
    }
    return section
  }

  /** One sandbox card. */
  const sandboxCard = (sandbox: SandboxSummary): HTMLElement => {
    const card = el('div', { class: 'dshsb-card' })
    const badge = el('span', { class: `dshsb-badge dshsb-${sandbox.status}` }, tt(STATUS_KEYS[sandbox.status] ?? sandbox.status))
    card.append(el('h4', {}, sandbox.name, badge))
    const meta = el('div', { class: 'dshsb-meta' })
    meta.append(el('span', {}, `${tt('list.port')}: ${sandbox.port > 0 ? sandbox.port : '—'}`))
    meta.append(el('span', {}, `${tt('list.plugin')}: ${sandbox.pluginName}`))
    if (sandbox.lastError !== null) meta.append(el('span', {}, sandbox.lastError))
    card.append(meta)
    card.append(el('div', { class: 'dshsb-meta', style: 'word-break:break-all' }, sandbox.pluginPath))
    if (sandbox.status === 'running' && sandbox.url !== null) {
      const link = el('a', { class: 'dshsb-url', href: sandbox.url, target: '_blank', rel: 'noreferrer' })
      link.append(icon(ICON_OPEN), document.createTextNode(` ${sandbox.url}`))
      card.append(link)
    }
    const actions = el('div', { class: 'dshsb-actions' })
    const busy = state.busy[sandbox.name] === true
    if (sandbox.status === 'running' || sandbox.status === 'starting') {
      actions.append(actionButton('list.stop', () => { void onAction('stop', sandbox) }, busy))
      actions.append(actionButton('list.restart', () => { void onAction('restart', sandbox) }, busy))
    } else {
      actions.append(actionButton('list.start', () => { void onAction('start', sandbox) }, busy))
    }
    actions.append(actionButton('list.destroy', () => { void onAction('destroy', sandbox) }, busy))
    actions.append(actionButton('list.logs', () => { void onLogs(sandbox.name) }, busy))
    card.append(actions)
    return card
  }

  const actionButton = (labelKey: string, handler: () => void, disabled: boolean): HTMLButtonElement =>
    el('button', { class: 'dshsb-btn', disabled, onclick: handler }, tt(labelKey))

  /** The log viewer section. */
  const logSection = (name: string): HTMLElement => {
    const section = el('section', { class: 'dshsb-card' })
    const refresh = el('button', { class: 'dshsb-btn', onclick: () => { void onLogs(name) } }, tt('logs.refresh'))
    section.append(el('h4', {}, tt('logs.title', { name }), el('span', { class: 'dshsb-spacer' }), refresh))
    section.append(el('pre', { class: 'dshsb-logs' }, state.logLines || tt('common.loading')))
    return section
  }

  // ------------------------------------------------------------ actions

  /** Create (when missing) and start the sandbox from the form. */
  const onCreate = async (): Promise<void> => {
    const name = nameInput.value.trim()
    const pluginPath = pluginInput.value.trim()
    if (name === '') {
      state.error = tt('common.error', { error: 'name is required' })
      render()
      return
    }
    state.creating = true
    state.error = null
    render()
    try {
      const existing = state.sandboxes.find(item => item.name === name)
      if (existing === undefined) {
        await api.create(name, pluginPath === '' ? undefined : pluginPath, {
          inheritHostApi: inheritCheck.checked,
          inheritHostModel: inheritCheck.checked,
        })
      }
      const port = portInput.value.trim() === '' ? undefined : Number(portInput.value.trim())
      await api.start(name, Number.isFinite(port) ? port : undefined)
      if (buildCheck.checked && pluginPath !== '') await api.build(pluginPath)
    } catch (error) {
      state.error = tt('common.error', { error: String((error as Error).message ?? error) })
    } finally {
      state.creating = false
      await refresh()
    }
  }

  /** Scan the plugin path from the form. */
  const onScan = async (): Promise<void> => {
    const pluginPath = pluginInput.value.trim()
    state.scan = null
    state.scanError = null
    render()
    if (pluginPath === '') {
      state.scanError = tt('common.error', { error: 'pluginPath is required' })
      render()
      return
    }
    try {
      const { scan } = await api.scan(pluginPath)
      state.scan = scan
    } catch (error) {
      state.scanError = tt('common.error', { error: String((error as Error).message ?? error) })
    }
    render()
  }

  /** Run a lifecycle action on one sandbox. */
  const onAction = async (kind: 'start' | 'stop' | 'restart' | 'destroy', sandbox: SandboxSummary): Promise<void> => {
    if (kind === 'destroy' && !window.confirm(tt('list.destroy.confirm', { name: sandbox.name }))) return
    state.busy[sandbox.name] = true
    state.error = null
    render()
    try {
      if (kind === 'start') await api.start(sandbox.name)
      else if (kind === 'stop') await api.stop(sandbox.name)
      else if (kind === 'restart') await api.restart(sandbox.name)
      else await api.destroy(sandbox.name)
    } catch (error) {
      state.error = tt('common.error', { error: String((error as Error).message ?? error) })
    } finally {
      delete state.busy[sandbox.name]
      await refresh()
    }
  }

  /** Load (or collapse) a sandbox's logs. */
  const onLogs = async (name: string): Promise<void> => {
    if (state.logName === name) {
      state.logName = null
      state.logLines = ''
      render()
      return
    }
    state.logName = name
    state.logLines = ''
    render()
    try {
      const { lines } = await api.logs(name, 300)
      state.logLines = lines
    } catch (error) {
      state.logLines = tt('common.error', { error: String((error as Error).message ?? error) })
    }
    render()
  }

  /** Re-fetch the sandbox list and re-render. */
  const refresh = async (): Promise<void> => {
    try {
      const { sandboxes } = await api.list()
      state.sandboxes = sandboxes
      state.error = null
    } catch (error) {
      state.error = tt('common.error', { error: String((error as Error).message ?? error) })
    }
    render()
  }

  // ------------------------------------------------------------- mount

  const root = el('aside', { class: 'dshsb-panel', 'aria-label': tt('panel.title') })
  const head = el('div', { class: 'dshsb-head' })
  const titleBox = el('div', {})
  titleBox.append(el('h3', {}, tt('panel.title')))
  titleBox.append(el('div', { class: 'dshsb-sub' }, tt('panel.subtitle')))
  head.append(titleBox, el('span', { class: 'dshsb-spacer' }))
  head.append(el('button', { class: 'dshsb-btn', title: tt('common.refresh'), onclick: () => { void refresh() } }, icon(ICON_REFRESH)))
  head.append(el('button', { class: 'dshsb-btn', title: tt('common.close'), onclick: () => controller.close() }, icon(ICON_CLOSE)))
  root.append(head, body)
  const unsubscribe = controller.subscribe(() => {
    root.classList.toggle('dshsb-open', controller.getSnapshot().panelOpen)
    if (controller.getSnapshot().panelOpen) void refresh()
  })
  // Initial paint so the panel is laid out before first open.
  render()
  disposeRef.current = () => {
    unsubscribe()
    root.remove()
  }
  return root
}

// ------------------------------------------------------- sidebar entry

/** Find the sidebar shell root element, or undefined while not yet mounted. */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  const logoRow = column.querySelector('[class*="logoRow"]')
  return logoRow?.parentElement ?? (column.firstElementChild as HTMLElement | null) ?? undefined
}

/** The New Session button: nested in the logo row on current shells, a direct child on legacy shells. */
function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  return undefined
}

/** Build the sidebar entry button. */
function createEntry(controller: PanelController): HTMLButtonElement {
  const entry = el('button', {
    type: 'button',
    class: 'dshsb-entry',
    dataset: { dshDevSandboxEntry: '' },
    title: tt('entry.tooltip'),
    onclick: () => controller.toggle(),
  })
  entry.append(
    icon(ICON_SANDBOX, 'dshsb-entry-icon'),
    el('span', { class: 'dshsb-entry-label' }, tt('entry.label')),
  )
  return entry
}

/** Re-insert the entry after the New Session row (before the browser region). */
function placeEntry(root: HTMLElement, entry: HTMLButtonElement): boolean {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement !== root) {
    const row = button.closest('[class*="logoRow"]')
    const base = row !== null && row.parentElement === root ? row : button
    const family = Array.from(root.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement
        && child.matches('[data-dsh-dev-sandbox-entry], [data-dsh-taskboard-entry], [data-dsh-ssh-entry]'),
    )
    const anchor = family.length > 0 ? family[family.length - 1].nextElementSibling : base.nextElementSibling
    root.insertBefore(entry, anchor)
  }
  return true
}

/**
 * Mount the sidebar entry, waiting for the shell to render and self-healing
 * on later React re-renders.
 * @param controller - the panel controller the entry toggles.
 * @returns disposer removing the entry and its observers.
 */
export function mountSidebarEntry(controller: PanelController): () => void {
  ensureStyles()
  const entry = createEntry(controller)
  let root: HTMLElement | undefined
  let placed = false
  let waitObserver: MutationObserver | undefined
  let rootObserver: MutationObserver | undefined

  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) {
      rootObserver?.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver?.disconnect()
      root = undefined
      placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = placeEntry(root, entry)
    if (placed) {
      rootObserver?.disconnect()
      rootObserver = new MutationObserver(() => {
        if (root === undefined || !root.isConnected) {
          placed = false
          tryPlace()
          return
        }
        if (!root.contains(entry)) placed = placeEntry(root, entry)
      })
      rootObserver.observe(root, { childList: true, subtree: true })
    }
  }

  const syncActive = (): void => {
    if (controller.getSnapshot().panelOpen) entry.dataset.active = 'true'
    else delete entry.dataset.active
  }
  const unsubscribe = controller.subscribe(syncActive)
  syncActive()
  waitObserver = new MutationObserver(() => tryPlace())
  waitObserver.observe(document.body, { childList: true, subtree: true })
  tryPlace()

  return () => {
    waitObserver?.disconnect()
    rootObserver?.disconnect()
    unsubscribe()
    entry.remove()
  }
}

/**
 * Mount the panel overlay into the document.
 * @param api - the route client.
 * @param controller - the panel controller.
 * @returns disposer removing the panel.
 */
export function mountPanel(api: SandboxApi, controller: PanelController): () => void {
  const disposeRef: { current: (() => void) | null } = { current: null }
  const root = createPanel(api, controller, disposeRef)
  document.body.appendChild(root)
  return () => { disposeRef.current?.() }
}
