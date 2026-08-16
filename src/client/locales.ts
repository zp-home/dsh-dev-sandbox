/**
 * Locale dictionaries for the dev-sandbox panel. Picked by the document
 * language at call time (task-board/ssh precedent); registered on the locale
 * service so other surfaces can reuse the namespace.
 * @module dsh-dev-sandbox/client/locales
 */

export const NS = 'dsh-dev-sandbox'

export const zh = {
  'entry.label': '沙盒',
  'entry.tooltip': 'DSH 插件开发沙盒：启动隔离测试镜像',
  'panel.title': '插件开发沙盒',
  'panel.subtitle': '隔离的业务镜像实例，不触碰开发本体',
  'common.refresh': '刷新',
  'common.close': '关闭',
  'common.busy': '处理中…',
  'common.error': '错误：{error}',
  'common.empty': '暂无沙盒。填写下方插件路径，创建并启动第一个测试镜像。',
  'common.loading': '加载中…',
  'create.title': '新建测试镜像',
  'create.name': '名称',
  'create.name.ph': '如 test-my-plugin',
  'create.plugin': '插件路径（可选）',
  'create.plugin.ph': '可选；留空 = 纯净镜像（仅标准 web 环境）',
  'create.port': '端口（留空自动分配）',
  'create.build': '启动前先构建插件',
  'create.inherit': '集成主机 API/模型配置（注入 DEEPSEEK key/baseURL，继承模型设置）',
  'create.submit': '创建并启动',
  'create.scan': '扫描插件',
  'scan.title': '插件检查',
  'scan.ok': '可以挂载',
  'scan.issues': '问题：',
  'scan.noScript': '无 build 脚本',
  'list.title': '实例列表',
  'list.status.stopped': '已停止',
  'list.status.starting': '启动中',
  'list.status.running': '运行中',
  'list.status.exited': '已退出',
  'list.status.error': '错误',
  'list.open': '打开',
  'list.start': '启动',
  'list.stop': '停止',
  'list.restart': '重启',
  'list.destroy': '销毁',
  'list.destroy.confirm': '确认销毁沙盒 {name}？其隔离目录将被删除。',
  'list.logs': '日志',
  'list.port': '端口',
  'list.plugin': '插件',
  'logs.title': '日志：{name}',
  'logs.refresh': '刷新日志',
}

export const en: Record<keyof typeof zh, string> = {
  'entry.label': 'Sandbox',
  'entry.tooltip': 'DSH plugin dev sandbox: launch isolated test instances',
  'panel.title': 'Plugin Dev Sandbox',
  'panel.subtitle': 'Isolated mirror instances — never touches the dev host',
  'common.refresh': 'Refresh',
  'common.close': 'Close',
  'common.busy': 'Working…',
  'common.error': 'Error: {error}',
  'common.empty': 'No sandboxes yet. Fill in a plugin path below to create and start the first mirror.',
  'common.loading': 'Loading…',
  'create.title': 'New test instance',
  'create.name': 'Name',
  'create.name.ph': 'e.g. test-my-plugin',
  'create.plugin': 'Plugin path (optional)',
  'create.plugin.ph': 'Optional; leave empty for a plain mirror (stock web env only)',
  'create.port': 'Port (empty = auto)',
  'create.build': 'Build the plugin before starting',
  'create.inherit': 'Inherit host API/model config (inject DEEPSEEK key/baseURL, copy model settings)',
  'create.submit': 'Create & start',
  'create.scan': 'Scan plugin',
  'scan.title': 'Plugin check',
  'scan.ok': 'Mountable',
  'scan.issues': 'Issues: ',
  'scan.noScript': 'No build script',
  'list.title': 'Instances',
  'list.status.stopped': 'stopped',
  'list.status.starting': 'starting',
  'list.status.running': 'running',
  'list.status.exited': 'exited',
  'list.status.error': 'error',
  'list.open': 'Open',
  'list.start': 'Start',
  'list.stop': 'Stop',
  'list.restart': 'Restart',
  'list.destroy': 'Destroy',
  'list.destroy.confirm': 'Destroy sandbox {name}? Its isolated directory will be deleted.',
  'list.logs': 'Logs',
  'list.port': 'Port',
  'list.plugin': 'Plugin',
  'logs.title': 'Logs: {name}',
  'logs.refresh': 'Refresh logs',
}

/** Tiny interpolation: {name} -> value. */
function interpolate(text: string, values: Record<string, string | number> | undefined): string {
  if (values === undefined) return text
  let out = text
  for (const [key, value] of Object.entries(values)) out = out.replaceAll(`{${key}}`, String(value))
  return out
}

/** Active dictionary, picked by the document language at call time. */
export function dictionary(): Record<string, string> {
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : 'zh'
  return lang.toLowerCase().startsWith('en') ? { ...en } : { ...zh }
}

/**
 * Translate a key with optional {name} template params (current language).
 * @param key - dictionary key.
 * @param values - optional interpolation values.
 * @returns the translated string (the key itself when missing).
 */
export function tt(key: string, values?: Record<string, string | number>): string {
  return interpolate(dictionary()[key] ?? key, values)
}
