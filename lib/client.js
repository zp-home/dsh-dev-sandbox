window.__ModuleLoader__.load({
	id: "@zp-home/dsh-dev-sandbox",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region src/client/api.ts
		/** API error carrying the route's JSON error message. */
		var SandboxApiError = class extends Error {
			constructor(message) {
				super(message);
				this.name = "SandboxApiError";
			}
		};
		/** Parse a JSON response or throw a SandboxApiError. */
		async function readJson(response) {
			let body;
			try {
				body = await response.json();
			} catch {
				throw new SandboxApiError(`HTTP ${response.status} from ${response.url}`);
			}
			if (!response.ok) {
				const message = body?.error;
				throw new SandboxApiError(typeof message === "string" ? message : `HTTP ${response.status}`);
			}
			return body;
		}
		/** The route family. */
		var SandboxApi = class SandboxApi {
			/** Join the route prefix with one action path (actions may carry a leading slash). */
			static route(action) {
				return `/api/dsh-dev-sandbox/${action.replace(/^\/+/, "")}`;
			}
			async post(action, body) {
				return readJson(await fetch(SandboxApi.route(action), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body)
				}));
			}
			async get(action, query) {
				const params = new URLSearchParams();
				for (const [key, value] of Object.entries(query)) params.set(key, String(value));
				const separator = params.toString() === "" ? "" : "?";
				return readJson(await fetch(`${SandboxApi.route(action)}${separator}${params.toString()}`));
			}
			/** All known sandboxes. */
			list() {
				return this.get("/list", {});
			}
			/** One sandbox's status. */
			status(name) {
				return this.get("/status", { name });
			}
			/** A sandbox's log tail. */
			logs(name, tail = 200) {
				return this.get("/logs", {
					name,
					tail
				});
			}
			/** Inspect a plugin checkout. */
			scan(path) {
				return this.get("/scan", { path });
			}
			/** Mountable DSH bundles discovered in the host's current web profile. */
			hostPlugins() {
				return this.get("/host-plugins", {});
			}
			/** Verify an already-built local plugin without inheriting host credentials or settings. */
			verify(pluginPath, opts = {}) {
				return this.post("/verify", {
					pluginPath,
					...opts.repository !== void 0 ? { repository: opts.repository } : {},
					...opts.commit !== void 0 ? { commit: opts.commit } : {},
					...opts.profileMode !== void 0 ? { profileMode: opts.profileMode } : {}
				});
			}
			/** Create a sandbox. `pluginPath` is optional: absent creates a plain mirror. */
			create(name, pluginPath, opts = {}) {
				return this.post("/create", {
					name,
					...pluginPath !== void 0 && pluginPath !== "" ? { pluginPath } : {},
					...opts.inheritHostApi !== void 0 ? { inheritHostApi: opts.inheritHostApi } : {},
					...opts.inheritHostModel !== void 0 ? { inheritHostModel: opts.inheritHostModel } : {},
					...opts.profileMode !== void 0 ? { profileMode: opts.profileMode } : {}
				});
			}
			/** Start a sandbox (explicit port optional). */
			start(name, port) {
				return this.post("/start", {
					name,
					...port !== void 0 ? { port } : {}
				});
			}
			/** Stop a sandbox. */
			stop(name) {
				return this.post("/stop", { name });
			}
			/** Restart a sandbox. */
			restart(name, port) {
				return this.post("/restart", {
					name,
					...port !== void 0 ? { port } : {}
				});
			}
			/** Destroy a sandbox (deletes its isolated home). */
			destroy(name) {
				return this.post("/destroy", { name });
			}
			/** Run the plugin's build script. */
			build(pluginPath) {
				return this.post("/build", { pluginPath });
			}
		};
		//#endregion
		//#region src/client/locales.ts
		/**
		* Locale dictionaries for the dev-sandbox panel. Picked by the document
		* language at call time (task-board/ssh precedent); registered on the locale
		* service so other surfaces can reuse the namespace.
		* @module dsh-dev-sandbox/client/locales
		*/
		const NS = "dsh-dev-sandbox";
		const zh = {
			"entry.label": "沙盒",
			"entry.tooltip": "DSH 插件开发沙盒：启动隔离测试镜像",
			"panel.title": "插件开发沙盒",
			"panel.subtitle": "隔离的业务镜像实例，不触碰开发本体",
			"common.refresh": "刷新",
			"common.close": "关闭",
			"common.busy": "处理中…",
			"common.error": "错误：{error}",
			"common.empty": "暂无沙盒。填写下方插件路径，创建并启动第一个测试镜像。",
			"common.loading": "加载中…",
			"create.title": "新建测试镜像",
			"create.name": "名称",
			"create.name.ph": "如 test-my-plugin",
			"create.name.required": "请填写实例名称。",
			"create.name.invalid": "名称只能使用 1–32 位英文字母、数字、下划线或短横线，且必须以字母或数字开头。",
			"create.plugin": "插件路径（可选）",
			"create.plugin.ph": "可选；留空 = 纯净镜像（仅标准 web 环境）",
			"create.hostPlugin": "本机已安装插件（可选）",
			"create.hostPlugin.manual": "手动填写插件路径",
			"create.hostPlugin.loading": "正在读取本机插件…",
			"create.hostPlugin.empty": "未发现可挂载的本机插件",
			"create.hostPlugin.enabled": "当前 Profile 已启用",
			"create.hostPlugin.unavailable": "本机插件列表不可用；请重启当前 DSH Web 进程后重试。",
			"create.port": "端口（留空自动分配）",
			"create.build": "启动前先构建插件",
			"create.inherit": "集成主机 API/模型配置（注入 DEEPSEEK key/baseURL，继承模型设置）",
			"create.profileMirror": "镜像本机 Web Profile（复制插件组合与 Cordis 配置；不复制会话或凭据）",
			"create.submit": "创建并启动",
			"create.scan": "扫描插件",
			"scan.title": "插件检查",
			"scan.pathRequired": "请先填写待测插件路径。",
			"scan.ok": "可以挂载",
			"scan.issues": "问题：",
			"scan.noScript": "无 build 脚本",
			"list.title": "实例列表",
			"list.status.stopped": "已停止",
			"list.status.starting": "启动中",
			"list.status.running": "运行中",
			"list.status.exited": "已退出",
			"list.status.error": "错误",
			"list.open": "打开",
			"list.start": "启动",
			"list.stop": "停止",
			"list.restart": "重启",
			"list.destroy": "销毁",
			"list.destroy.confirm": "确认销毁沙盒 {name}？其隔离目录将被删除。",
			"list.logs": "日志",
			"list.port": "端口",
			"list.plugin": "插件",
			"list.profile": "配置",
			"list.profile.clean": "标准 Web",
			"list.profile.host-web": "本机 Web 镜像",
			"list.bundles": "{count} 个 bundle",
			"list.more": "更多配置",
			"list.pluginPath": "插件路径",
			"list.profileSource": "Profile 来源",
			"list.bundleList": "Bundle 清单",
			"list.inheritApi": "主机 API",
			"list.inheritModel": "模型设置",
			"list.enabled": "已继承",
			"list.disabled": "未继承",
			"list.pid": "进程 PID",
			"list.started": "启动时间",
			"list.stopped": "停止时间",
			"list.lastError": "最近错误",
			"list.memory": "内存",
			"list.storage": "存储",
			"list.measured": "资源采样",
			"list.plainMirror": "纯净镜像",
			"list.created": "创建",
			"list.runtime": "运行时长",
			"list.lastRun": "最近运行",
			"time.day": "{value}天",
			"time.hour": "{value}小时",
			"time.minute": "{value}分",
			"time.second": "{value}秒",
			"logs.title": "日志：{name}",
			"logs.refresh": "刷新日志"
		};
		const en = {
			"entry.label": "Sandbox",
			"entry.tooltip": "DSH plugin dev sandbox: launch isolated test instances",
			"panel.title": "Plugin Dev Sandbox",
			"panel.subtitle": "Isolated mirror instances — never touches the dev host",
			"common.refresh": "Refresh",
			"common.close": "Close",
			"common.busy": "Working…",
			"common.error": "Error: {error}",
			"common.empty": "No sandboxes yet. Fill in a plugin path below to create and start the first mirror.",
			"common.loading": "Loading…",
			"create.title": "New test instance",
			"create.name": "Name",
			"create.name.ph": "e.g. test-my-plugin",
			"create.name.required": "Enter an instance name.",
			"create.name.invalid": "Use 1–32 letters, numbers, underscores, or hyphens; the first character must be a letter or number.",
			"create.plugin": "Plugin path (optional)",
			"create.plugin.ph": "Optional; leave empty for a plain mirror (stock web env only)",
			"create.hostPlugin": "Installed local plugin (optional)",
			"create.hostPlugin.manual": "Enter a plugin path manually",
			"create.hostPlugin.loading": "Loading local plugins…",
			"create.hostPlugin.empty": "No mountable local plugins found",
			"create.hostPlugin.enabled": "Enabled in current profile",
			"create.hostPlugin.unavailable": "Local plugin list is unavailable; restart the current DSH Web process and try again.",
			"create.port": "Port (empty = auto)",
			"create.build": "Build the plugin before starting",
			"create.inherit": "Inherit host API/model config (inject DEEPSEEK key/baseURL, copy model settings)",
			"create.profileMirror": "Mirror local Web profile (copy plugin composition and Cordis config; never sessions or credentials)",
			"create.submit": "Create & start",
			"create.scan": "Scan plugin",
			"scan.title": "Plugin check",
			"scan.pathRequired": "Enter the plugin path before scanning.",
			"scan.ok": "Mountable",
			"scan.issues": "Issues: ",
			"scan.noScript": "No build script",
			"list.title": "Instances",
			"list.status.stopped": "stopped",
			"list.status.starting": "starting",
			"list.status.running": "running",
			"list.status.exited": "exited",
			"list.status.error": "error",
			"list.open": "Open",
			"list.start": "Start",
			"list.stop": "Stop",
			"list.restart": "Restart",
			"list.destroy": "Destroy",
			"list.destroy.confirm": "Destroy sandbox {name}? Its isolated directory will be deleted.",
			"list.logs": "Logs",
			"list.port": "Port",
			"list.plugin": "Plugin",
			"list.profile": "Profile",
			"list.profile.clean": "Stock web",
			"list.profile.host-web": "Local web mirror",
			"list.bundles": "{count} bundles",
			"list.more": "More configuration",
			"list.pluginPath": "Plugin path",
			"list.profileSource": "Profile source",
			"list.bundleList": "Bundle list",
			"list.inheritApi": "Host API",
			"list.inheritModel": "Model settings",
			"list.enabled": "Inherited",
			"list.disabled": "Not inherited",
			"list.pid": "Process PID",
			"list.started": "Started",
			"list.stopped": "Stopped",
			"list.lastError": "Last error",
			"list.memory": "Memory",
			"list.storage": "Storage",
			"list.measured": "Resource sample",
			"list.plainMirror": "Plain mirror",
			"list.created": "Created",
			"list.runtime": "Uptime",
			"list.lastRun": "Last run",
			"time.day": "{value}d",
			"time.hour": "{value}h",
			"time.minute": "{value}m",
			"time.second": "{value}s",
			"logs.title": "Logs: {name}",
			"logs.refresh": "Refresh logs"
		};
		/** Tiny interpolation: {name} -> value. */
		function interpolate(text, values) {
			if (values === void 0) return text;
			let out = text;
			for (const [key, value] of Object.entries(values)) out = out.replaceAll(`{${key}}`, String(value));
			return out;
		}
		/** Active dictionary, picked by the document language at call time. */
		function dictionary() {
			return (typeof document !== "undefined" ? document.documentElement.lang : "zh").toLowerCase().startsWith("en") ? { ...en } : { ...zh };
		}
		/**
		* Translate a key with optional {name} template params (current language).
		* @param key - dictionary key.
		* @param values - optional interpolation values.
		* @returns the translated string (the key itself when missing).
		*/
		function tt(key, values) {
			return interpolate(dictionary()[key] ?? key, values);
		}
		//#endregion
		//#region src/client/panel.ts
		/** Create the open/close controller. */
		function createPanelController() {
			let panelOpen = false;
			const listeners = /* @__PURE__ */ new Set();
			const notify = () => {
				for (const listener of listeners) listener();
			};
			return {
				open() {
					if (panelOpen) return;
					panelOpen = true;
					notify();
				},
				close() {
					if (!panelOpen) return;
					panelOpen = false;
					notify();
				},
				toggle() {
					panelOpen = !panelOpen;
					notify();
				},
				getSnapshot() {
					return { panelOpen };
				},
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				}
			};
		}
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
.dshsb-details{border-top:1px solid var(--dshsb-border,rgba(0,0,0,.1));padding-top:7px;font-size:11px}
.dshsb-details>summary{cursor:pointer;opacity:.78;user-select:none}
.dshsb-details>summary:hover{opacity:1}
.dshsb-detail-grid{display:grid;grid-template-columns:minmax(88px,auto) minmax(0,1fr);gap:5px 10px;margin-top:8px;word-break:break-all}
.dshsb-detail-label{opacity:.65}
.dshsb-detail-value{min-width:0}
.dshsb-detail-error{color:var(--dshsb-danger,#dc2626)}
.dshsb-actions{display:flex;flex-wrap:wrap;gap:6px}
.dshsb-url{color:var(--dshsb-accent,#2563eb);text-decoration:none}
.dshsb-field{display:flex;flex-direction:column;gap:3px}
.dshsb-field label{font-size:11px;opacity:.75}
.dshsb-field input,.dshsb-field select{width:100%;border:1px solid var(--dshsb-border,rgba(0,0,0,.2));background:transparent;color:inherit;border-radius:6px;padding:5px 8px;font:inherit}
.dshsb-field input:focus,.dshsb-field select:focus{outline:2px solid var(--dshsb-accent,#2563eb);outline-offset:-1px;border-color:transparent}
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
`;
		/** Ensure the plugin's stylesheet is injected once. */
		function ensureStyles() {
			if (document.querySelector("style[data-plugin-css=\"dsh-dev-sandbox/panel.css\"]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-dev-sandbox";
			tag.dataset.pluginCss = "dsh-dev-sandbox/panel.css";
			tag.textContent = PANEL_CSS;
			document.head.appendChild(tag);
		}
		/** Create an element with props/children. */
		function el(tag, props = {}, ...children) {
			const node = document.createElement(tag);
			for (const [key, value] of Object.entries(props)) {
				if (value === void 0 || value === null || value === false) continue;
				if (key === "class") node.className = String(value);
				else if (key === "dataset") Object.assign(node.dataset, value);
				else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
				else if (key === "value") node.value = String(value);
				else node.setAttribute(key, String(value));
			}
			for (const child of children) {
				if (child === void 0 || child === null) continue;
				node.append(typeof child === "string" ? document.createTextNode(child) : child);
			}
			return node;
		}
		const ICON_SANDBOX = "<svg viewBox=\"0 0 16 16\" width=\"14\" height=\"14\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M8 1.5l5.5 3v7L8 14.5 2.5 11.5v-7z\"/><path d=\"M2.8 4.6L8 7.4l5.2-2.8\"/><path d=\"M8 7.5v6.8\"/></svg>";
		const ICON_REFRESH = "<svg viewBox=\"0 0 16 16\" width=\"13\" height=\"13\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M13.5 8a5.5 5.5 0 1 1-1.6-3.9\"/><path d=\"M13.5 1.8v2.7h-2.7\"/></svg>";
		const ICON_CLOSE = "<svg viewBox=\"0 0 16 16\" width=\"13\" height=\"13\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.4\" stroke-linecap=\"round\" aria-hidden=\"true\"><path d=\"M3.5 3.5l9 9M12.5 3.5l-9 9\"/></svg>";
		const ICON_OPEN = "<svg viewBox=\"0 0 16 16\" width=\"12\" height=\"12\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M6.5 2.5H3a.5.5 0 0 0-.5.5v10a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5V9.5\"/><path d=\"M9 2.5h4.5V7\"/><path d=\"M13.5 2.5L7 9\"/></svg>";
		/** Render an inline SVG icon string as a real element (never as text). */
		function icon(svg, className) {
			const span = document.createElement("span");
			if (className !== void 0) span.className = className;
			span.innerHTML = svg;
			return span;
		}
		const STATUS_KEYS = {
			stopped: "list.status.stopped",
			starting: "list.status.starting",
			running: "list.status.running",
			exited: "list.status.exited",
			error: "list.status.error"
		};
		const AUTO_REFRESH_MS = 3e3;
		const SANDBOX_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
		function activeStatus(status) {
			return status === "running" || status === "starting";
		}
		function formatDateTime(value) {
			const timestamp = Date.parse(value);
			if (Number.isNaN(timestamp)) return "—";
			const locale = document.documentElement.lang || void 0;
			return new Intl.DateTimeFormat(locale, {
				dateStyle: "medium",
				timeStyle: "medium"
			}).format(new Date(timestamp));
		}
		function formatBytes(value) {
			if (value === null || !Number.isFinite(value) || value < 0) return "—";
			const units = [
				"B",
				"KB",
				"MB",
				"GB",
				"TB"
			];
			let amount = value;
			let unit = 0;
			while (amount >= 1024 && unit < units.length - 1) {
				amount /= 1024;
				unit++;
			}
			const digits = unit > 0 && amount < 10 ? 1 : 0;
			return `${amount.toFixed(digits)} ${units[unit]}`;
		}
		function formatDuration(startedAt, stoppedAt, status) {
			const started = Date.parse(startedAt);
			if (Number.isNaN(started)) return "—";
			const stopped = stoppedAt === null ? NaN : Date.parse(stoppedAt);
			const endsNow = activeStatus(status) || Number.isNaN(stopped);
			let seconds = Math.max(0, Math.floor(((endsNow ? Date.now() : stopped) - started) / 1e3));
			const days = Math.floor(seconds / 86400);
			seconds %= 86400;
			const hours = Math.floor(seconds / 3600);
			seconds %= 3600;
			const minutes = Math.floor(seconds / 60);
			seconds %= 60;
			const parts = [];
			if (days > 0) parts.push(tt("time.day", { value: days }));
			if (hours > 0 || parts.length > 0) parts.push(tt("time.hour", { value: hours }));
			if (minutes > 0 || parts.length > 0) parts.push(tt("time.minute", { value: minutes }));
			parts.push(tt("time.second", { value: seconds }));
			return parts.join(" ");
		}
		function runtimeText(startedAt, stoppedAt, status) {
			return `${activeStatus(status) ? tt("list.runtime") : tt("list.lastRun")}: ${formatDuration(startedAt, stoppedAt, status)}`;
		}
		/**
		* Build the panel element and its interaction wiring.
		* @param api - the route client.
		* @param controller - open/close controller (panel element toggling).
		* @param disposeRef - receives the panel's disposer.
		* @returns the panel root element.
		*/
		function createPanel(api, controller, disposeRef) {
			ensureStyles();
			const state = {
				sandboxes: [],
				error: null,
				refreshError: null,
				scan: null,
				scanError: null,
				hostPlugins: null,
				hostPluginsError: null,
				logName: null,
				logLines: "",
				creating: false,
				busy: {},
				detailsOpen: {}
			};
			const nameInput = el("input", {
				type: "text",
				placeholder: tt("create.name.ph")
			});
			const pluginInput = el("input", {
				type: "text",
				placeholder: tt("create.plugin.ph")
			});
			const hostPluginSelect = el("select");
			const portInput = el("input", {
				type: "text",
				placeholder: "4000"
			});
			const buildCheck = el("input", { type: "checkbox" });
			buildCheck.checked = false;
			const inheritCheck = el("input", { type: "checkbox" });
			inheritCheck.checked = true;
			const mirrorCheck = el("input", { type: "checkbox" });
			mirrorCheck.checked = false;
			hostPluginSelect.addEventListener("change", () => {
				if (hostPluginSelect.value === "") return;
				pluginInput.value = hostPluginSelect.value;
				state.scan = null;
				state.scanError = null;
				renderScan();
			});
			const body = el("div", { class: "dshsb-body" });
			const errorSlot = el("div");
			const formSlot = el("div");
			const scanSlot = el("div");
			const listSlot = el("div", { "aria-live": "polite" });
			const logSlot = el("div");
			body.append(errorSlot, formSlot, scanSlot, listSlot, logSlot);
			const renderError = () => {
				errorSlot.replaceChildren();
				const error = state.error ?? state.refreshError;
				if (error !== null) errorSlot.append(el("div", { class: "dshsb-error-box" }, error));
			};
			const renderForm = () => {
				formSlot.replaceChildren(createFormSection());
			};
			const renderScan = () => {
				scanSlot.replaceChildren();
				if (state.scan !== null) scanSlot.append(scanSection(state.scan));
				if (state.scanError !== null) scanSlot.append(el("div", { class: "dshsb-error-box" }, state.scanError));
			};
			const renderHostPluginOptions = () => {
				const selectedPath = pluginInput.value.trim();
				hostPluginSelect.replaceChildren(el("option", { value: "" }, tt("create.hostPlugin.manual")));
				if (state.hostPlugins === null) {
					hostPluginSelect.append(el("option", {
						value: "",
						disabled: true
					}, tt("create.hostPlugin.loading")));
					hostPluginSelect.disabled = true;
					return;
				}
				hostPluginSelect.disabled = false;
				if (state.hostPlugins.length === 0) {
					hostPluginSelect.append(el("option", {
						value: "",
						disabled: true
					}, tt("create.hostPlugin.empty")));
					return;
				}
				for (const plugin of state.hostPlugins) {
					const version = plugin.version === null ? "" : ` · v${plugin.version}`;
					const enabled = plugin.enabled ? ` · ${tt("create.hostPlugin.enabled")}` : "";
					hostPluginSelect.append(el("option", { value: plugin.path }, `${plugin.name}${version}${enabled}`));
				}
				if (state.hostPlugins.some((plugin) => plugin.path === selectedPath)) hostPluginSelect.value = selectedPath;
			};
			const renderList = () => {
				listSlot.replaceChildren(listSection());
			};
			const renderLogs = () => {
				logSlot.replaceChildren();
				if (state.logName !== null) logSlot.append(logSection(state.logName));
			};
			/** Re-render all stateful sections after an explicit user action. */
			const render = () => {
				renderError();
				renderForm();
				renderScan();
				renderList();
				renderLogs();
			};
			/** Update polling-driven status without replacing form controls mid-edit. */
			const renderRefreshed = () => {
				renderError();
				renderList();
			};
			/** The create/build form section. */
			const createFormSection = () => {
				const section = el("section", { class: "dshsb-card" });
				section.append(el("h4", {}, tt("create.title")));
				section.append(el("div", { class: "dshsb-field" }, el("label", {}, tt("create.name")), nameInput));
				section.append(el("div", { class: "dshsb-field" }, el("label", {}, tt("create.plugin")), pluginInput));
				renderHostPluginOptions();
				section.append(el("div", { class: "dshsb-field" }, el("label", {}, tt("create.hostPlugin")), hostPluginSelect));
				if (state.hostPluginsError !== null) section.append(el("div", { class: "dshsb-error-box" }, state.hostPluginsError));
				section.append(el("div", { class: "dshsb-field" }, el("label", {}, tt("create.port")), portInput));
				section.append(el("label", { class: "dshsb-check" }, buildCheck, tt("create.build")));
				section.append(el("label", { class: "dshsb-check" }, inheritCheck, tt("create.inherit")));
				section.append(el("label", { class: "dshsb-check" }, mirrorCheck, tt("create.profileMirror")));
				const row = el("div", { class: "dshsb-actions" });
				const submit = el("button", {
					class: "dshsb-btn dshsb-primary",
					disabled: state.creating,
					onclick: () => {
						onCreate();
					}
				}, state.creating ? tt("common.busy") : tt("create.submit"));
				const scanBtn = el("button", {
					class: "dshsb-btn",
					onclick: () => {
						onScan();
					}
				}, tt("create.scan"));
				row.append(submit, scanBtn);
				section.append(row);
				return section;
			};
			/** The scan-result section. */
			const scanSection = (scan) => {
				const box = el("div", { class: "dshsb-scan" });
				box.append(el("strong", {}, `${tt("scan.title")} — ${scan.name ?? scan.path}`));
				box.append(el("span", {}, `version: ${scan.version ?? "-"}  ·  bundle: ${scan.hasBundle ? scan.bundlePatch : "✗"}`));
				box.append(el("span", {}, `host built: ${scan.hostBuilt ? "✓" : "✗"}  ·  client built: ${scan.clientBuilt ? "✓" : scan.clientDeclared ? "✗" : "—"}`));
				if (scan.issues.length > 0) for (const issue of scan.issues) box.append(el("span", { class: "dshsb-warn" }, `⚠ ${issue}`));
				else box.append(el("span", { class: "dshsb-ok" }, `✓ ${tt("scan.ok")}`));
				return box;
			};
			/** The sandbox list section. */
			const listSection = () => {
				const section = el("section", { class: "dshsb-card" });
				section.append(el("h4", {}, tt("list.title")));
				if (state.sandboxes.length === 0) {
					section.append(el("div", { class: "dshsb-empty" }, tt("common.empty")));
					return section;
				}
				for (const sandbox of state.sandboxes) section.append(sandboxCard(sandbox));
				return section;
			};
			/** One sandbox card. */
			const sandboxCard = (sandbox) => {
				const card = el("div", { class: "dshsb-card" });
				const badge = el("span", { class: `dshsb-badge dshsb-${sandbox.status}` }, tt(STATUS_KEYS[sandbox.status] ?? sandbox.status));
				card.append(el("h4", {}, sandbox.name, badge));
				const meta = el("div", { class: "dshsb-meta" });
				const profileMode = sandbox.profileMode === "host-web" ? "host-web" : "clean";
				const pluginLabel = sandbox.pluginName === "" ? tt("list.plainMirror") : sandbox.pluginName;
				meta.append(el("span", {}, `${tt("list.port")}: ${sandbox.port > 0 ? sandbox.port : "—"}`));
				meta.append(el("span", {}, `${tt("list.plugin")}: ${pluginLabel}`));
				meta.append(el("span", {}, `${tt("list.profile")}: ${tt(`list.profile.${profileMode}`)}`));
				if (sandbox.resourceUsage !== void 0) {
					meta.append(el("span", {}, `${tt("list.memory")}: ${formatBytes(sandbox.resourceUsage.memoryBytes)}`));
					meta.append(el("span", {}, `${tt("list.storage")}: ${formatBytes(sandbox.resourceUsage.storageBytes)}`));
				}
				if (sandbox.startedAt !== null) meta.append(el("span", { dataset: {
					dshsbRuntimeStarted: sandbox.startedAt,
					dshsbRuntimeStopped: sandbox.stoppedAt ?? "",
					dshsbRuntimeStatus: sandbox.status
				} }, runtimeText(sandbox.startedAt, sandbox.stoppedAt, sandbox.status)));
				card.append(meta);
				if (sandbox.status === "running" && sandbox.url !== null) {
					const link = el("a", {
						class: "dshsb-url",
						href: sandbox.url,
						target: "_blank",
						rel: "noreferrer"
					});
					link.append(icon(ICON_OPEN), document.createTextNode(` ${sandbox.url}`));
					card.append(link);
				}
				const details = el("details", { class: "dshsb-details" });
				details.open = state.detailsOpen[sandbox.name] === true;
				details.append(el("summary", {}, tt("list.more")));
				const detailGrid = el("div", { class: "dshsb-detail-grid" });
				const addDetail = (label, value, className) => {
					detailGrid.append(el("span", { class: "dshsb-detail-label" }, label), el("span", { class: className === void 0 ? "dshsb-detail-value" : `dshsb-detail-value ${className}` }, value));
				};
				addDetail(tt("list.pluginPath"), sandbox.pluginPath === "" ? tt("list.plainMirror") : sandbox.pluginPath);
				addDetail(tt("list.profileSource"), sandbox.profileSource ?? "—");
				addDetail(tt("list.bundleList"), sandbox.profileBundles?.join(", ") || "—");
				addDetail(tt("list.inheritApi"), sandbox.inheritHostApi ? tt("list.enabled") : tt("list.disabled"));
				addDetail(tt("list.inheritModel"), sandbox.inheritHostModel ? tt("list.enabled") : tt("list.disabled"));
				addDetail(tt("list.pid"), sandbox.pid === null ? "—" : String(sandbox.pid));
				if (sandbox.resourceUsage !== void 0) {
					addDetail(tt("list.memory"), formatBytes(sandbox.resourceUsage.memoryBytes));
					addDetail(tt("list.storage"), formatBytes(sandbox.resourceUsage.storageBytes));
					addDetail(tt("list.measured"), formatDateTime(sandbox.resourceUsage.measuredAt));
				}
				addDetail(tt("list.created"), formatDateTime(sandbox.createdAt));
				if (sandbox.startedAt !== null) addDetail(tt("list.started"), formatDateTime(sandbox.startedAt));
				if (sandbox.stoppedAt !== null) addDetail(tt("list.stopped"), formatDateTime(sandbox.stoppedAt));
				if (sandbox.lastError !== null) addDetail(tt("list.lastError"), sandbox.lastError, "dshsb-detail-error");
				details.append(detailGrid);
				details.addEventListener("toggle", () => {
					state.detailsOpen[sandbox.name] = details.open;
				});
				card.append(details);
				const actions = el("div", { class: "dshsb-actions" });
				const busy = state.busy[sandbox.name] === true;
				if (sandbox.status === "running" || sandbox.status === "starting") {
					actions.append(actionButton("list.stop", () => {
						onAction("stop", sandbox);
					}, busy));
					actions.append(actionButton("list.restart", () => {
						onAction("restart", sandbox);
					}, busy));
				} else actions.append(actionButton("list.start", () => {
					onAction("start", sandbox);
				}, busy));
				actions.append(actionButton("list.destroy", () => {
					onAction("destroy", sandbox);
				}, busy));
				actions.append(actionButton("list.logs", () => {
					onLogs(sandbox.name);
				}, busy));
				card.append(actions);
				return card;
			};
			/** Update only active uptime labels so polling never interrupts form editing. */
			const updateRuntimeLabels = () => {
				for (const node of listSlot.querySelectorAll("[data-dshsb-runtime-started]")) {
					const startedAt = node.dataset.dshsbRuntimeStarted;
					const stoppedAt = node.dataset.dshsbRuntimeStopped || null;
					const status = node.dataset.dshsbRuntimeStatus;
					if (startedAt === void 0 || status !== "running" && status !== "starting") continue;
					node.textContent = runtimeText(startedAt, stoppedAt, status);
				}
			};
			const actionButton = (labelKey, handler, disabled) => el("button", {
				class: "dshsb-btn",
				disabled,
				onclick: handler
			}, tt(labelKey));
			/** The log viewer section. */
			const logSection = (name) => {
				const section = el("section", { class: "dshsb-card" });
				const refresh = el("button", {
					class: "dshsb-btn",
					onclick: () => {
						onLogs(name);
					}
				}, tt("logs.refresh"));
				section.append(el("h4", {}, tt("logs.title", { name }), el("span", { class: "dshsb-spacer" }), refresh));
				section.append(el("pre", { class: "dshsb-logs" }, state.logLines || tt("common.loading")));
				return section;
			};
			let hostPluginsInFlight = null;
			/** Load mountable DSH bundles from the host web profile for the picker. */
			const loadHostPlugins = () => {
				if (hostPluginsInFlight !== null) return hostPluginsInFlight;
				const request = (async () => {
					try {
						const { plugins } = await api.hostPlugins();
						state.hostPlugins = plugins;
						state.hostPluginsError = null;
					} catch {
						state.hostPlugins = [];
						state.hostPluginsError = tt("create.hostPlugin.unavailable");
					}
					renderForm();
				})();
				hostPluginsInFlight = request;
				request.finally(() => {
					if (hostPluginsInFlight === request) hostPluginsInFlight = null;
				});
				return request;
			};
			/** Create (when missing) and start the sandbox from the form. */
			const onCreate = async () => {
				const name = nameInput.value.trim();
				const pluginPath = pluginInput.value.trim();
				if (name === "") {
					state.error = tt("create.name.required");
					render();
					nameInput.focus();
					return;
				}
				if (!SANDBOX_NAME_PATTERN.test(name)) {
					state.error = tt("create.name.invalid");
					render();
					nameInput.focus();
					return;
				}
				state.creating = true;
				state.error = null;
				render();
				try {
					if (buildCheck.checked && pluginPath !== "") await api.build(pluginPath);
					await api.create(name, pluginPath === "" ? void 0 : pluginPath, {
						inheritHostApi: inheritCheck.checked,
						inheritHostModel: inheritCheck.checked,
						profileMode: mirrorCheck.checked ? "host-web" : "clean"
					});
					const port = portInput.value.trim() === "" ? void 0 : Number(portInput.value.trim());
					await api.start(name, Number.isFinite(port) ? port : void 0);
				} catch (error) {
					state.error = tt("common.error", { error: String(error.message ?? error) });
				} finally {
					state.creating = false;
					renderForm();
					await refresh(true);
				}
			};
			/** Scan the plugin path from the form. */
			const onScan = async () => {
				const pluginPath = pluginInput.value.trim();
				state.scan = null;
				state.scanError = null;
				render();
				if (pluginPath === "") {
					state.scanError = tt("scan.pathRequired");
					render();
					pluginInput.focus();
					return;
				}
				try {
					const { scan } = await api.scan(pluginPath);
					state.scan = scan;
				} catch (error) {
					state.scanError = tt("common.error", { error: String(error.message ?? error) });
				}
				render();
			};
			/** Run a lifecycle action on one sandbox. */
			const onAction = async (kind, sandbox) => {
				if (kind === "destroy" && !window.confirm(tt("list.destroy.confirm", { name: sandbox.name }))) return;
				state.busy[sandbox.name] = true;
				state.error = null;
				render();
				try {
					if (kind === "start") await api.start(sandbox.name);
					else if (kind === "stop") await api.stop(sandbox.name);
					else if (kind === "restart") await api.restart(sandbox.name);
					else await api.destroy(sandbox.name);
				} catch (error) {
					state.error = tt("common.error", { error: String(error.message ?? error) });
				} finally {
					delete state.busy[sandbox.name];
					await refresh(true);
				}
			};
			/** Load (or collapse) a sandbox's logs. */
			const onLogs = async (name) => {
				if (state.logName === name) {
					state.logName = null;
					state.logLines = "";
					render();
					return;
				}
				state.logName = name;
				state.logLines = "";
				render();
				try {
					const { lines } = await api.logs(name, 300);
					state.logLines = lines;
				} catch (error) {
					state.logLines = tt("common.error", { error: String(error.message ?? error) });
				}
				render();
			};
			let refreshInFlight = null;
			/** Re-fetch the sandbox list without overlapping polling requests. */
			const refresh = (afterCurrent = false) => {
				if (refreshInFlight !== null) return afterCurrent ? refreshInFlight.then(() => refresh()) : refreshInFlight;
				const request = (async () => {
					try {
						const { sandboxes } = await api.list();
						state.sandboxes = sandboxes;
						const names = new Set(sandboxes.map((sandbox) => sandbox.name));
						for (const name of Object.keys(state.detailsOpen)) if (!names.has(name)) delete state.detailsOpen[name];
						state.refreshError = null;
					} catch (error) {
						state.refreshError = tt("common.error", { error: String(error.message ?? error) });
					}
					renderRefreshed();
				})();
				refreshInFlight = request;
				request.finally(() => {
					if (refreshInFlight === request) refreshInFlight = null;
				});
				return request;
			};
			const root = el("aside", {
				class: "dshsb-panel",
				"aria-label": tt("panel.title")
			});
			const head = el("div", { class: "dshsb-head" });
			const titleBox = el("div", {});
			titleBox.append(el("h3", {}, tt("panel.title")));
			titleBox.append(el("div", { class: "dshsb-sub" }, tt("panel.subtitle")));
			head.append(titleBox, el("span", { class: "dshsb-spacer" }));
			head.append(el("button", {
				class: "dshsb-btn",
				title: tt("common.refresh"),
				onclick: () => {
					refresh();
				}
			}, icon(ICON_REFRESH)));
			head.append(el("button", {
				class: "dshsb-btn",
				title: tt("common.close"),
				onclick: () => controller.close()
			}, icon(ICON_CLOSE)));
			root.append(head, body);
			const unsubscribe = controller.subscribe(() => {
				root.classList.toggle("dshsb-open", controller.getSnapshot().panelOpen);
				if (controller.getSnapshot().panelOpen) {
					refresh();
					loadHostPlugins();
				}
			});
			const refreshVisiblePanel = () => {
				if (!controller.getSnapshot().panelOpen || document.visibilityState !== "visible") return;
				refresh();
			};
			const autoRefreshTimer = window.setInterval(refreshVisiblePanel, AUTO_REFRESH_MS);
			const runtimeTimer = window.setInterval(() => {
				if (controller.getSnapshot().panelOpen && document.visibilityState === "visible") updateRuntimeLabels();
			}, 1e3);
			const onVisibilityChange = () => {
				if (document.visibilityState === "visible") refreshVisiblePanel();
			};
			document.addEventListener("visibilitychange", onVisibilityChange);
			render();
			disposeRef.current = () => {
				window.clearInterval(autoRefreshTimer);
				window.clearInterval(runtimeTimer);
				document.removeEventListener("visibilitychange", onVisibilityChange);
				unsubscribe();
				root.remove();
			};
			return root;
		}
		/** Find the sidebar shell root element, or undefined while not yet mounted. */
		function sidebarRoot() {
			const column = document.querySelector("[data-pane=\"sidebar\"], [class*=\"sidebarCol\"]");
			if (column === null) return void 0;
			return column.querySelector("[class*=\"logoRow\"]")?.parentElement ?? column.firstElementChild ?? void 0;
		}
		/** The New Session button: nested in the logo row on current shells, a direct child on legacy shells. */
		function newSessionButton(root) {
			const nested = root.querySelector("button[class*=\"newSession\"]");
			if (nested !== null) return nested;
			for (const child of root.children) if (child.tagName === "BUTTON") return child;
		}
		/** Build the sidebar entry button. */
		function createEntry(controller) {
			const entry = el("button", {
				type: "button",
				class: "dshsb-entry",
				dataset: { dshDevSandboxEntry: "" },
				title: tt("entry.tooltip"),
				onclick: () => controller.toggle()
			});
			entry.append(icon(ICON_SANDBOX, "dshsb-entry-icon"), el("span", { class: "dshsb-entry-label" }, tt("entry.label")));
			return entry;
		}
		/** Re-insert the entry after the New Session row (before the browser region). */
		function placeEntry(root, entry) {
			const button = newSessionButton(root);
			if (button === void 0) return false;
			if (entry.parentElement !== root) {
				const row = button.closest("[class*=\"logoRow\"]");
				const base = row !== null && row.parentElement === root ? row : button;
				const family = Array.from(root.children).filter((child) => child instanceof HTMLElement && child.matches("[data-dsh-dev-sandbox-entry], [data-dsh-taskboard-entry], [data-dsh-ssh-entry]"));
				const anchor = family.length > 0 ? family[family.length - 1].nextElementSibling : base.nextElementSibling;
				root.insertBefore(entry, anchor);
			}
			return true;
		}
		/**
		* Mount the sidebar entry, waiting for the shell to render and self-healing
		* on later React re-renders.
		* @param controller - the panel controller the entry toggles.
		* @returns disposer removing the entry and its observers.
		*/
		function mountSidebarEntry(controller) {
			ensureStyles();
			const entry = createEntry(controller);
			let root;
			let placed = false;
			let waitObserver;
			let rootObserver;
			const tryPlace = () => {
				if (root !== void 0 && !root.isConnected) {
					rootObserver?.disconnect();
					root = void 0;
					placed = false;
				}
				if (placed) {
					if (document.body.contains(entry)) return;
					rootObserver?.disconnect();
					root = void 0;
					placed = false;
				}
				root ??= sidebarRoot();
				if (root === void 0) return;
				placed = placeEntry(root, entry);
				if (placed) {
					rootObserver?.disconnect();
					rootObserver = new MutationObserver(() => {
						if (root === void 0 || !root.isConnected) {
							placed = false;
							tryPlace();
							return;
						}
						if (!root.contains(entry)) placed = placeEntry(root, entry);
					});
					rootObserver.observe(root, {
						childList: true,
						subtree: true
					});
				}
			};
			const syncActive = () => {
				if (controller.getSnapshot().panelOpen) entry.dataset.active = "true";
				else delete entry.dataset.active;
			};
			const unsubscribe = controller.subscribe(syncActive);
			syncActive();
			waitObserver = new MutationObserver(() => tryPlace());
			waitObserver.observe(document.body, {
				childList: true,
				subtree: true
			});
			tryPlace();
			return () => {
				waitObserver?.disconnect();
				rootObserver?.disconnect();
				unsubscribe();
				entry.remove();
			};
		}
		/**
		* Mount the panel overlay into the document.
		* @param api - the route client.
		* @param controller - the panel controller.
		* @returns disposer removing the panel.
		*/
		function mountPanel(api, controller) {
			const disposeRef = { current: null };
			const root = createPanel(api, controller, disposeRef);
			document.body.appendChild(root);
			return () => {
				disposeRef.current?.();
			};
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* Browser half of @zp-home/dsh-dev-sandbox: mounts the sidebar entry and
		* the sandbox panel in the web GUI. Exports the cordis client-plugin contract
		* (`apply` + `inject`) handed to `window.__ModuleLoader__.load`.
		* @module dsh-dev-sandbox/client
		*/
		/** Required services (fiber inject waiting — the runtime must be up first). */
		const inject = ["slots", "locale"];
		/**
		* Mount the dev-sandbox panel.
		* @param ctx - client root context (locale service).
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-dev-sandbox: dictionaries");
			const controller = createPanelController();
			const api = new SandboxApi();
			const disposers = [];
			try {
				disposers.push(mountSidebarEntry(controller));
				disposers.push(mountPanel(api, controller));
			} catch (error) {
				console.warn("[dsh-dev-sandbox] mount failed:", error);
			}
			ctx.effect(() => () => {
				for (const dispose of disposers.splice(0)) dispose();
			}, "dsh-dev-sandbox: ui mounts");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map