import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { createServer } from "node:net";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { URL, fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/harness.ts
/**
* Locate the dsh installation the sandboxes boot from.
*
* A sandbox is a fresh DSH CLI process with its own `DSH_HOME`. Source
* checkouts use `node --import tsx/esm apps/cli/src/bin.ts web`; published npm
* installs use the compiled entry declared by `@deepseek-ai/dsh` instead. The
* harness is resolved lazily on first `start`, so a resolution failure never
* blocks the plugin from mounting — it surfaces as a per-request error.
* @module dsh-dev-sandbox/harness
*/
/** How far any discovery walk climbs looking for the checkout anchor. */
const MAX_UPSTEPS = 16;
/** Whether `dir` looks like a dsh source checkout (has the source CLI entry). */
function isCheckout(dir) {
	return existsSync(join(dir, "apps", "cli", "src", "bin.ts"));
}
/** Resolve the published CLI entry declared by an installed @deepseek-ai/dsh package. */
function installedCliEntry(dir) {
	const manifestFile = join(dir, "package.json");
	if (!existsSync(manifestFile)) return void 0;
	try {
		const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
		if (manifest.name !== "@deepseek-ai/dsh") return void 0;
		const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin !== null && typeof manifest.bin === "object" ? manifest.bin.dsh : void 0;
		if (typeof bin !== "string" || bin.trim() === "") return void 0;
		const entry = resolve(dir, bin);
		return existsSync(entry) ? entry : void 0;
	} catch {
		return;
	}
}
/** Return launch metadata for either a source checkout or published CLI root. */
function infoFor(dir) {
	const root = resolve(dir);
	if (isCheckout(root)) return {
		root,
		cliEntry: join(root, "apps", "cli", "src", "bin.ts"),
		nodeArgs: ["--import", "tsx/esm"],
		kind: "source",
		nodeExec: process.execPath
	};
	const cliEntry = installedCliEntry(root);
	if (cliEntry !== void 0) return {
		root,
		cliEntry,
		nodeArgs: [],
		kind: "installed",
		nodeExec: process.execPath
	};
}
/** Walk up from `start` (bounded) and return the first supported DSH root. */
function walkUp(start) {
	let dir = resolve(start);
	for (let step = 0; step < MAX_UPSTEPS; step++) {
		const info = infoFor(dir);
		if (info !== void 0) return info;
		const parent = resolve(dir, "..");
		if (parent === dir) return void 0;
		dir = parent;
	}
}
/** Find the sibling published CLI package from a package installed under node_modules. */
function siblingCliFromNodeModules(start) {
	let dir = resolve(start);
	for (let step = 0; step < MAX_UPSTEPS; step++) {
		if (basename(dir) === "node_modules") return infoFor(join(dir, "@deepseek-ai", "dsh"));
		const parent = resolve(dir, "..");
		if (parent === dir) return void 0;
		dir = parent;
	}
}
/**
* Resolve the harness root from an explicit config value or by discovery.
* @param configured - `harnessRoot` from the plugin config; a source checkout or installed CLI package root.
* @returns the selected DSH root, CLI entry, and node executable.
* @throws when neither the configured path nor discovery yields a supported CLI.
*/
function resolveHarness(configured) {
	if (configured !== void 0 && configured.trim() !== "") {
		const root = resolve(configured);
		const info = infoFor(root);
		if (info === void 0) throw new Error(`dsh-dev-sandbox: harnessRoot ${root} is not a dsh source checkout or installed @deepseek-ai/dsh package (expected apps/cli/src/bin.ts or package.json with a working dsh bin entry)`);
		return info;
	}
	const cwdInfo = walkUp(process.cwd());
	if (cwdInfo !== void 0) return cwdInfo;
	const argvInfo = process.argv[1] === void 0 ? void 0 : walkUp(dirname(process.argv[1]));
	if (argvInfo !== void 0) return argvInfo;
	if (import.meta.url.startsWith("file:")) {
		const ownInfo = walkUp(dirname(fileURLToPath(import.meta.url)));
		if (ownInfo !== void 0) return ownInfo;
	}
	try {
		const require = createRequire(import.meta.url);
		const installedInfo = infoFor(dirname(require.resolve("@deepseek-ai/dsh/package.json")));
		if (installedInfo !== void 0) return installedInfo;
		const bootPkg = require.resolve("@deepseek-ai/dsh-app-boot/package.json");
		const siblingInfo = siblingCliFromNodeModules(dirname(bootPkg));
		if (siblingInfo !== void 0) return siblingInfo;
		const bootInfo = walkUp(dirname(bootPkg));
		if (bootInfo !== void 0) return bootInfo;
	} catch {}
	throw new Error("dsh-dev-sandbox: cannot locate the dsh installation automatically. Set \"harnessRoot\" to a dsh source checkout or installed @deepseek-ai/dsh package directory.");
}
//#endregion
//#region src/manager.ts
/**
* Sandbox lifecycle manager.
*
* A sandbox is one isolated dsh web instance:
*   - its own `DSH_HOME` (`<homeRoot>/<name>`), so sessions, storages,
*     settings, and profiles are completely separate from the development
*     instance;
*   - its own web profile (`<home>/profiles/web`) whose bundle stack is the
*     stock `dsh-base` + `dsh-web-app` plus the plugin under development,
*     mounted as a junction in the profile's node_modules (no pnpm run
*     required for the plugin itself);
*   - its own port (allocated from `basePort` upward), so it never collides
*     with the dev server;
*   - spawned from the same harness checkout, so the plugin under test runs
*     against the exact harness revision the developer is working on.
*
* The manager owns process handles, per-sandbox ring-buffer logs plus a log
* file, and a `sandbox-state.json` per sandbox so instances survive host
* restarts (liveness is re-derived from the recorded pid/port).
* @module dsh-dev-sandbox/manager
*/
/** Valid sandbox names: 1–32 chars, alphanumeric plus `_`/`-`, no dots. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
/** Profile root config, identical to what the launcher rewrites at boot. */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`;
/** Profile user patch layer template. */
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`;
/** pnpm settings profile plugins need (same as the launcher's initProfile). */
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;
/** Ring-buffer cap per sandbox log. */
const LOG_CAP = 2e3;
/** Resource measurements are intentionally coarser than the UI's status polling. */
const RESOURCE_SAMPLE_INTERVAL_MS = 1e4;
/** Delay helper. */
function delay(ms) {
	return new Promise((resolveDelay) => {
		setTimeout(resolveDelay, ms);
	});
}
/** Whether a TCP port on loopback is currently free. */
function portFree(port) {
	return new Promise((resolveFree) => {
		const server = createServer();
		server.once("error", () => resolveFree(false));
		server.listen(port, "127.0.0.1", () => {
			server.close(() => resolveFree(true));
		});
	});
}
/** Whether something answers HTTP on the port (any response counts as listening). */
function portResponds(port) {
	return new Promise((done) => {
		const req = get({
			host: "127.0.0.1",
			port,
			path: "/",
			timeout: 2e3
		}, (res) => {
			res.resume();
			done(true);
		});
		req.on("timeout", () => {
			req.destroy();
			done(false);
		});
		req.on("error", () => done(false));
	});
}
/** Error whose `message` is user-facing. */
var SandboxError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "SandboxError";
	}
};
/**
* Allocate a free port starting at `base`, probing upward.
* @param base - first candidate port.
* @returns a free loopback port.
* @throws {SandboxError} when 1000 consecutive ports are all busy.
*/
async function findFreePort(base) {
	for (let port = base; port < base + 1e3; port++) if (await portFree(port)) return port;
	throw new SandboxError(`dsh-dev-sandbox: no free port in ${base}..${base + 999}`);
}
/** Read a sandbox's persisted state, or null when absent. */
function readStateFile(home) {
	const file = join(home, "sandbox-state.json");
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}
/** Treat state files written before profile modes existed as clean sandboxes. */
function profileModeOf(state) {
	return state.profileMode === "host-web" ? "host-web" : "clean";
}
/**
* The sandbox lifecycle manager: one instance per host process.
*/
var SandboxManager = class {
	children = /* @__PURE__ */ new Map();
	rings = /* @__PURE__ */ new Map();
	resourceCache = /* @__PURE__ */ new Map();
	options;
	verificationSequence = 0;
	harness;
	harnessError = null;
	constructor(options) {
		this.options = options;
	}
	/**
	* Resolve the harness to boot sandboxes from, lazily and with caching.
	* Failure never blocks mounting — it becomes a per-start SandboxError.
	* @returns the resolved harness info.
	* @throws {SandboxError} when no harness checkout can be located.
	*/
	harnessInfo() {
		if (this.harnessError !== null) throw new SandboxError(this.harnessError);
		if (this.harness !== void 0) return this.harness;
		try {
			this.harness = resolveHarness(this.options.harnessRoot);
			return this.harness;
		} catch (error) {
			this.harnessError = error instanceof Error ? error.message : String(error);
			throw new SandboxError(this.harnessError);
		}
	}
	/**
	* Collect the host's DeepSeek API env for injection into a sandbox: the
	* process environment first (the host's own boot already folded in its
	* `.env` files), then the host home's `.env` and `.credentials.yaml`.
	* @returns a map of DEEPSEEK_* environment variables to set on the child.
	*/
	collectHostApiEnv() {
		const out = {};
		for (const name of [
			"DEEPSEEK_API_KEY",
			"DEEPSEEK_BASE_URL",
			"DEEPSEEK_SEARCH_BASE_URL"
		]) {
			const value = process.env[name] ?? this.readKeyValueFromHostHome(name);
			if (value !== void 0 && value.trim() !== "") out[name] = value.trim();
		}
		return out;
	}
	/**
	* Read one `NAME: value` / `NAME=value` entry from the host home's `.env`
	* and `.credentials.yaml` (the credential store the dev instance uses).
	* @param name - the variable name to look up.
	* @returns the value, or undefined when absent.
	*/
	readKeyValueFromHostHome(name) {
		const home = resolveDshHome();
		for (const file of [join(home, ".env"), join(home, ".credentials.yaml")]) {
			if (!existsSync(file)) continue;
			try {
				for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
					const trimmed = line.trim();
					if (trimmed === "" || trimmed.startsWith("#")) continue;
					const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(.*)$/.exec(trimmed);
					if (match === null || match[1] !== name) continue;
					return match[2].trim().replace(/^['"]|['"]$/g, "");
				}
			} catch {}
		}
	}
	/**
	* Copy the host's settings.yaml into a sandbox home that has none yet, so
	* the mirror starts with the same agent model/theme defaults as the host.
	* @param home - the sandbox home (its DSH_HOME).
	*/
	inheritHostSettings(home) {
		const settingsPath = join(home, "settings.yaml");
		if (existsSync(settingsPath)) return;
		const hostSettings = join(resolveDshHome(), "settings.yaml");
		if (!existsSync(hostSettings)) return;
		try {
			copyFileSync(hostSettings, settingsPath);
		} catch {}
	}
	/** Absolute DSH_HOME of a sandbox. */
	homeOf(name) {
		return join(this.options.homeRoot, name);
	}
	/** Absolute path of a sandbox's log file. */
	logFileOf(name) {
		return join(this.homeOf(name), "sandbox.log");
	}
	/** All known sandboxes, newest first, with liveness and cached resources re-derived. */
	list() {
		if (!existsSync(this.options.homeRoot)) return [];
		const summaries = [];
		for (const entry of readdirSync(this.options.homeRoot)) {
			const home = join(this.options.homeRoot, entry);
			let stat;
			try {
				stat = statSync(home);
			} catch {
				continue;
			}
			if (!stat.isDirectory()) continue;
			const state = readStateFile(home);
			if (state === null) continue;
			summaries.push(this.withResourceUsage(this.liveState(state)));
		}
		return summaries.sort((a, b) => a.createdAt < b.createdAt ? 1 : -1);
	}
	/** One sandbox summary, or null when unknown. */
	get(name) {
		const state = readStateFile(this.homeOf(name));
		return state === null ? null : this.withResourceUsage(this.liveState(state));
	}
	/** Re-derive status from the recorded pid/port when the state says running. */
	liveState(state) {
		if (state.status === "running" || state.status === "starting") {
			if (!(state.pid !== null && this.pidAlive(state.pid))) {
				state = {
					...state,
					status: "exited",
					pid: null,
					url: null
				};
				this.resourceCache.delete(state.name);
				this.writeState(state.name, state);
			}
		}
		return state;
	}
	/** Attach a throttled process-memory and isolated-home storage sample. */
	withResourceUsage(state) {
		const now = Date.now();
		const cached = this.resourceCache.get(state.name);
		if (cached !== void 0 && cached.pid === state.pid && now - cached.sampledAt < RESOURCE_SAMPLE_INTERVAL_MS) return {
			...state,
			resourceUsage: cached.usage
		};
		const usage = {
			memoryBytes: state.pid === null ? null : this.processMemoryBytes(state.pid),
			storageBytes: this.isolatedStorageBytes(this.homeOf(state.name)),
			measuredAt: new Date(now).toISOString()
		};
		this.resourceCache.set(state.name, {
			pid: state.pid,
			sampledAt: now,
			usage
		});
		return {
			...state,
			resourceUsage: usage
		};
	}
	/** Working-set memory for one child process; null means the OS did not expose it. */
	processMemoryBytes(pid) {
		try {
			if (process.platform === "win32") {
				const result = spawnSync("powershell.exe", [
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`
				], {
					encoding: "utf8",
					windowsHide: true,
					timeout: 3e3
				});
				const value = Number(String(result.stdout).trim());
				return Number.isFinite(value) && value >= 0 ? value : null;
			}
			if (process.platform === "linux") {
				const status = readFileSync(`/proc/${pid}/status`, "utf8");
				const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
				return match === null ? null : Number(match[1]) * 1024;
			}
			const result = spawnSync("ps", [
				"-o",
				"rss=",
				"-p",
				String(pid)
			], {
				encoding: "utf8",
				timeout: 3e3
			});
			const value = Number(String(result.stdout).trim());
			return Number.isFinite(value) && value >= 0 ? value * 1024 : null;
		} catch {
			return null;
		}
	}
	/** Recursively count only files physically inside a sandbox home, never junction targets. */
	isolatedStorageBytes(root) {
		let total = 0;
		const visit = (directory) => {
			let entries;
			try {
				entries = readdirSync(directory);
			} catch {
				return;
			}
			for (const entry of entries) {
				const file = join(directory, entry);
				try {
					const stat = lstatSync(file);
					if (stat.isSymbolicLink()) continue;
					if (stat.isDirectory()) visit(file);
					else if (stat.isFile()) total += stat.size;
				} catch {}
			}
		};
		visit(root);
		return total;
	}
	/** Whether a process id currently exists (signal 0 probe). */
	pidAlive(pid) {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}
	/** Persist one sandbox's state file. */
	writeState(name, state) {
		writeFileSync(join(this.homeOf(name), "sandbox-state.json"), JSON.stringify(state, null, 2) + "\n");
	}
	/** Append to a sandbox's ring buffer and log file. */
	pushLog(name, chunk) {
		const ring = this.rings.get(name) ?? [];
		ring.push(chunk);
		while (ring.length > LOG_CAP) ring.shift();
		this.rings.set(name, ring);
		try {
			appendFileSync(this.logFileOf(name), chunk);
		} catch {}
	}
	/**
	* Recent log lines for a sandbox.
	* @param name - sandbox name.
	* @param tail - how many trailing lines to return (default 200).
	* @returns the joined tail, or null when the sandbox is unknown.
	*/
	logs(name, tail = 200) {
		if (this.get(name) === null) return null;
		const joined = (this.rings.get(name) ?? []).join("");
		const lines = (joined === "" && existsSync(this.logFileOf(name)) ? readFileSync(this.logFileOf(name), "utf8") : joined).split("\n");
		return lines.slice(Math.max(0, lines.length - tail)).join("\n");
	}
	/**
	* Inspect a plugin checkout: manifest facts, build state, and issues.
	* @param pluginPath - absolute path of the plugin package directory.
	* @returns the scan result.
	* @throws {SandboxError} when the directory has no package.json.
	*/
	scanPlugin(pluginPath) {
		const root = resolve(pluginPath);
		const manifestFile = join(root, "package.json");
		if (!existsSync(manifestFile)) throw new SandboxError(`dsh-dev-sandbox: ${root} has no package.json — not a plugin package`);
		let manifest;
		try {
			manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
		} catch {
			throw new SandboxError(`dsh-dev-sandbox: ${manifestFile} is not valid JSON`);
		}
		const name = typeof manifest.name === "string" ? manifest.name : null;
		const version = typeof manifest.version === "string" ? manifest.version : null;
		const dsh = manifest.dsh ?? {};
		const bundle = dsh.bundle ?? {};
		const client = dsh.client ?? {};
		const bundlePatch = typeof bundle.patch === "string" ? bundle.patch : null;
		const hasBundle = bundlePatch !== null;
		const main = typeof manifest.main === "string" ? manifest.main : "lib/index.js";
		const hostBuilt = existsSync(join(root, main));
		const clientDeclared = client.platform === "web";
		const clientBuilt = existsSync(join(root, "lib", "client.js"));
		const scripts = manifest.scripts ?? {};
		const buildScript = typeof scripts.build === "string" ? scripts.build : null;
		const issues = [];
		if (name === null) issues.push("package.json has no \"name\"");
		if (!hasBundle) issues.push("package.json declares no dsh.bundle.patch — the plugin will not mount as a profile layer");
		if (!hostBuilt) issues.push(`host half not built (${main} missing) — run the plugin's build script first`);
		if (clientDeclared && !clientBuilt) issues.push("dsh.client declares web platform but lib/client.js is missing — build the client half first");
		if (clientBuilt && !clientDeclared) issues.push("lib/client.js exists but dsh.client is not declared — the browser half will not load");
		return {
			path: root,
			name,
			version,
			bundlePatch,
			hasBundle,
			hostBuilt,
			clientDeclared,
			clientBuilt,
			buildScript,
			issues
		};
	}
	/** Discover mountable DSH bundles installed in the host's web profile. */
	hostWebPlugins() {
		const profileDir = join(resolveDshHome(), "profiles", "web");
		const manifestFile = join(profileDir, "package.json");
		if (!existsSync(manifestFile)) throw new SandboxError(`dsh-dev-sandbox: host web profile is missing ${manifestFile}`);
		let manifest;
		try {
			manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
		} catch {
			throw new SandboxError(`dsh-dev-sandbox: host web profile manifest is not valid JSON (${manifestFile})`);
		}
		const dsh = manifest.dsh;
		const profile = dsh !== null && typeof dsh === "object" && !Array.isArray(dsh) ? dsh.profile : void 0;
		const bundles = profile !== null && typeof profile === "object" && !Array.isArray(profile) ? profile.bundles : void 0;
		const enabled = new Set(Array.isArray(bundles) ? bundles.filter((name) => typeof name === "string") : []);
		const plugins = /* @__PURE__ */ new Map();
		const inspect = (path) => {
			try {
				const scan = this.scanPlugin(path);
				if (scan.name === null || !scan.hasBundle) return;
				plugins.set(scan.name, {
					name: scan.name,
					path: scan.path,
					version: scan.version,
					enabled: enabled.has(scan.name)
				});
			} catch {}
		};
		const nodeModules = join(profileDir, "node_modules");
		if (existsSync(nodeModules)) for (const entry of readdirSync(nodeModules)) {
			if (entry.startsWith(".")) continue;
			const path = join(nodeModules, entry);
			try {
				if (!statSync(path).isDirectory()) continue;
				if (entry.startsWith("@")) {
					for (const child of readdirSync(path)) if (!child.startsWith(".")) inspect(join(path, child));
				} else inspect(path);
			} catch {}
		}
		return Array.from(plugins.values()).sort((left, right) => {
			if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
			return left.name.localeCompare(right.name);
		});
	}
	/**
	* Run the plugin's build script in its checkout.
	* @param pluginPath - the plugin package directory.
	* @param pnpmPath - pnpm binary name/path (defaults to 'pnpm' on PATH).
	* @returns the build script's exit code.
	* @throws {SandboxError} when the package declares no build script or pnpm is missing.
	*/
	build(pluginPath, pnpmPath = "pnpm") {
		const scan = this.scanPlugin(pluginPath);
		if (scan.buildScript === null) throw new SandboxError(`dsh-dev-sandbox: ${scan.name ?? pluginPath} declares no build script`);
		const result = spawnSync(pnpmPath, ["run", "build"], {
			cwd: scan.path,
			stdio: "inherit",
			shell: process.platform === "win32"
		});
		if (result.error !== void 0) throw new SandboxError(`dsh-dev-sandbox: failed to run pnpm in ${scan.path}: ${result.error.message}`);
		return result.status ?? 1;
	}
	/**
	* Start a disposable local compatibility check. This never downloads a
	* plugin, never runs its build script, and deliberately withholds the
	* host's API credentials and model settings. It proves only that the
	* already-built local source can mount and bring a selected DSH web profile
	* to readiness; it is not an operating-system security sandbox.
	*/
	async verify(pluginPath, options = {}) {
		const checkedAt = (/* @__PURE__ */ new Date()).toISOString();
		const profileMode = options.profileMode ?? "clean";
		const scan = this.scanPlugin(pluginPath);
		const sourceFingerprint = createHash("sha256").update(readFileSync(join(scan.path, "package.json"), "utf8")).digest("hex");
		const kind = options.kind ?? (options.repository !== void 0 && options.commit !== void 0 ? "baseline-compatibility" : "local-compatibility");
		const publicationError = kind === "baseline-compatibility" && (profileMode !== "clean" || options.repository === void 0 || options.commit === void 0) ? "baseline-compatibility requires repository, commit, and profileMode=\"clean\"" : null;
		const base = {
			format: "dsh-plugin-verification/v1",
			kind,
			repository: options.repository ?? null,
			commit: options.commit ?? null,
			checkedAt,
			profileMode,
			plugin: {
				name: scan.name,
				version: scan.version,
				sourceFingerprint
			},
			scan
		};
		if (publicationError !== null || scan.issues.length > 0) return {
			...base,
			result: "failed",
			profileBundles: [],
			error: [publicationError, ...scan.issues].filter(Boolean).join("; "),
			logs: ""
		};
		const name = `verify-${Date.now().toString(36)}-${(++this.verificationSequence).toString(36)}`;
		let profileBundles = [];
		let error = null;
		let logs = "";
		try {
			profileBundles = this.create(name, scan.path, {
				inheritHostApi: false,
				inheritHostModel: false,
				profileMode
			}).profileBundles ?? [];
			await this.start(name, void 0, { build: false });
			logs = this.logs(name, 200) ?? "";
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
			logs = this.logs(name, 200) ?? "";
		} finally {
			try {
				await this.destroy(name);
			} catch (cleanupError) {
				const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
				error = error === null ? cleanupMessage : `${error}; cleanup: ${cleanupMessage}`;
			}
		}
		return {
			...base,
			result: error === null ? "passed" : "failed",
			profileBundles,
			error,
			logs
		};
	}
	/**
	* Create a sandbox (idempotent for the same plugin and profile mode). Each
	* profile is rebuilt inside the isolated home; host-web mode copies only
	* composition files and package links, never sessions, storage, or secrets.
	* @param name - sandbox name (filesystem-safe identifier).
	* @param pluginPath - optional absolute path of the plugin under development.
	* @param opts - per-sandbox inheritance and profile overrides.
	* @returns the created sandbox summary.
	* @throws {SandboxError} on invalid names or unbuildable plugins.
	*/
	create(name, pluginPath, opts = {}) {
		if (!NAME_PATTERN.test(name)) throw new SandboxError(`dsh-dev-sandbox: invalid sandbox name ${JSON.stringify(name)} — use 1-32 chars of [A-Za-z0-9_-]`);
		const profileMode = opts.profileMode ?? "clean";
		if (profileMode !== "clean" && profileMode !== "host-web") throw new SandboxError(`dsh-dev-sandbox: invalid profile mode ${JSON.stringify(profileMode)}`);
		let pluginDir = "";
		let pluginName = "";
		let pluginVersion = null;
		if (pluginPath !== void 0 && pluginPath.trim() !== "") {
			const scan = this.scanPlugin(pluginPath);
			if (scan.name === null || scan.bundlePatch === null) throw new SandboxError(`dsh-dev-sandbox: ${pluginPath} is not a mountable dsh bundle — ${scan.issues.join("; ")}`);
			pluginDir = scan.path;
			pluginName = scan.name;
			pluginVersion = scan.version;
		}
		const existing = this.get(name);
		if (existing !== null && resolve(existing.pluginPath) === resolve(pluginDir) && profileModeOf(existing) === profileMode) return existing;
		if (existing !== null && (existing.status === "running" || existing.status === "starting")) throw new SandboxError(`dsh-dev-sandbox: stop ${JSON.stringify(name)} before changing its plugin or profile mode`);
		const home = this.homeOf(name);
		const profileDir = join(home, "profiles", "web");
		if (existing !== null) rmSync(profileDir, {
			recursive: true,
			force: true
		});
		mkdirSync(profileDir, { recursive: true });
		const profile = profileMode === "host-web" ? this.mirrorHostWebProfile(profileDir, pluginName, pluginDir) : this.writeCleanProfile(profileDir, pluginName, pluginDir);
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const state = {
			name,
			pluginPath: pluginDir,
			pluginName,
			port: 0,
			pid: null,
			status: "stopped",
			inheritHostApi: opts.inheritHostApi ?? this.options.inheritHostApi,
			inheritHostModel: opts.inheritHostModel ?? this.options.inheritHostModel,
			profileMode,
			profileSource: profile.source,
			profileBundles: profile.bundles,
			createdAt: existing?.createdAt ?? now,
			startedAt: null,
			stoppedAt: null,
			lastError: null,
			url: null
		};
		this.writeState(name, state);
		const profileLabel = profileMode === "host-web" ? `host web profile (${profile.bundles.length} bundles)` : "clean web profile";
		this.pushLog(name, pluginName === "" ? `[dsh-dev-sandbox] created home ${home} (${profileLabel}, no plugin)\n` : `[dsh-dev-sandbox] created home ${home} (${profileLabel}, plugin ${pluginName}@${pluginVersion ?? "?"})\n`);
		return this.withResourceUsage(state);
	}
	/** Write the stock two-bundle profile and optionally mount the test plugin. */
	writeCleanProfile(profileDir, pluginName, pluginDir) {
		writeFileSync(join(profileDir, "cordis.yml"), PROFILE_ROOT_CONFIG);
		writeFileSync(join(profileDir, "cordis.patch.yml"), PROFILE_PATCH_TEMPLATE);
		writeFileSync(join(profileDir, "pnpm-workspace.yaml"), PROFILE_PNPM_WORKSPACE);
		const bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
		if (pluginName !== "") bundles.push(pluginName);
		const manifest = {
			name: "dsh-profile-web",
			private: true,
			dsh: { profile: { bundles } },
			...pluginName !== "" ? { dependencies: { [pluginName]: `link:${resolve(pluginDir)}` } } : {}
		};
		writeFileSync(join(profileDir, "package.json"), JSON.stringify(manifest, void 0, 2) + "\n");
		if (pluginName !== "") this.ensurePackageJunction(profileDir, pluginName, pluginDir);
		return {
			source: null,
			bundles
		};
	}
	/** Mirror the host web profile's composition into an isolated profile directory. */
	mirrorHostWebProfile(profileDir, pluginName, pluginDir) {
		const source = join(resolveDshHome(), "profiles", "web");
		const manifestFile = join(source, "package.json");
		if (!existsSync(manifestFile)) throw new SandboxError(`dsh-dev-sandbox: host web profile is missing ${manifestFile}`);
		let sourceManifest;
		try {
			sourceManifest = JSON.parse(readFileSync(manifestFile, "utf8"));
		} catch {
			throw new SandboxError(`dsh-dev-sandbox: host web profile manifest is not valid JSON (${manifestFile})`);
		}
		const sourceDsh = sourceManifest.dsh;
		const dsh = sourceDsh !== null && typeof sourceDsh === "object" && !Array.isArray(sourceDsh) ? sourceDsh : {};
		const sourceProfile = dsh.profile;
		const profile = sourceProfile !== null && typeof sourceProfile === "object" && !Array.isArray(sourceProfile) ? sourceProfile : {};
		const sourceBundles = profile.bundles;
		if (!Array.isArray(sourceBundles) || !sourceBundles.every((item) => typeof item === "string" && item !== "")) throw new SandboxError(`dsh-dev-sandbox: host web profile has no valid dsh.profile.bundles (${manifestFile})`);
		const bundles = [...sourceBundles];
		if (pluginName !== "" && !bundles.includes(pluginName)) bundles.push(pluginName);
		const sourceDependencies = sourceManifest.dependencies;
		const dependencies = sourceDependencies !== null && typeof sourceDependencies === "object" && !Array.isArray(sourceDependencies) ? { ...sourceDependencies } : {};
		if (pluginName !== "") dependencies[pluginName] = `link:${resolve(pluginDir)}`;
		const manifest = {
			...sourceManifest,
			dsh: {
				...dsh,
				profile: {
					...profile,
					bundles
				}
			},
			dependencies
		};
		for (const [file, fallback] of [
			["cordis.yml", PROFILE_ROOT_CONFIG],
			["cordis.patch.yml", PROFILE_PATCH_TEMPLATE],
			["pnpm-workspace.yaml", PROFILE_PNPM_WORKSPACE]
		]) {
			const sourceFile = join(source, file);
			if (existsSync(sourceFile)) copyFileSync(sourceFile, join(profileDir, file));
			else writeFileSync(join(profileDir, file), fallback);
		}
		writeFileSync(join(profileDir, "package.json"), JSON.stringify(manifest, void 0, 2) + "\n");
		this.mirrorHostPackages(source, profileDir, pluginName);
		if (pluginName !== "") this.ensurePackageJunction(profileDir, pluginName, pluginDir);
		return {
			source,
			bundles
		};
	}
	/** Link packages visible to the host profile without copying its package store. */
	mirrorHostPackages(sourceProfile, profileDir, excludedPackage) {
		const sourceModules = join(sourceProfile, "node_modules");
		if (!existsSync(sourceModules)) return;
		for (const entry of readdirSync(sourceModules)) {
			if (entry.startsWith(".")) continue;
			const sourceEntry = join(sourceModules, entry);
			let entryStat;
			try {
				entryStat = statSync(sourceEntry);
			} catch {
				continue;
			}
			if (!entryStat.isDirectory()) continue;
			if (entry.startsWith("@")) for (const child of readdirSync(sourceEntry)) {
				if (child.startsWith(".")) continue;
				const packageName = `${entry}/${child}`;
				const packagePath = join(sourceEntry, child);
				try {
					if (statSync(packagePath).isDirectory() && packageName !== excludedPackage) this.ensurePackageJunction(profileDir, packageName, packagePath);
				} catch {}
			}
			else if (entry !== excludedPackage) this.ensurePackageJunction(profileDir, entry, sourceEntry);
		}
	}
	/** Junction `<profile>/node_modules/<pkg>` to a host or test-plugin package. */
	ensurePackageJunction(profileDir, packageName, target) {
		const link = join(profileDir, "node_modules", ...packageName.split("/"));
		mkdirSync(dirname(link), { recursive: true });
		if (existsSync(link)) {
			if (!lstatSync(link).isSymbolicLink()) throw new SandboxError(`dsh-dev-sandbox: ${link} exists as a real directory; remove it or choose another sandbox name`);
			rmSync(link, {
				recursive: true,
				force: true
			});
		}
		symlinkSync(target, link, "junction");
	}
	/**
	* Start a sandbox: build first when configured, allocate a port, spawn the
	* isolated harness web process, and wait until it answers.
	* @param name - sandbox name.
	* @param port - explicit port override (otherwise allocated from basePort).
	* @returns the running summary.
	* @throws {SandboxError} when the sandbox is unknown or fails to become ready.
	*/
	async start(name, port, options = {}) {
		let state = this.get(name);
		if (state === null) throw new SandboxError(`dsh-dev-sandbox: unknown sandbox ${JSON.stringify(name)}`);
		if (state.status === "running" || state.status === "starting") return state;
		if ((options.build ?? this.options.buildOnStart) && state.pluginPath !== "") try {
			this.build(state.pluginPath);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			state = this.mutateState(name, {
				status: "error",
				lastError: message
			});
			throw error;
		}
		if (port !== void 0) {
			if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new SandboxError(`dsh-dev-sandbox: invalid port ${port}; use an integer in 1..65535`);
			if (!await portFree(port)) throw new SandboxError(`dsh-dev-sandbox: port ${port} is already in use`);
		}
		const spawnPort = port ?? await findFreePort(this.options.basePort);
		const { root, cliEntry, nodeArgs, nodeExec } = this.harnessInfo();
		this.pushLog(name, `[dsh-dev-sandbox] starting on port ${spawnPort} (harness ${root})\n`);
		const home = this.homeOf(name);
		const env = {
			...process.env,
			DSH_HOME: home,
			DSH_TELEMETRY_DISABLED: "1",
			DSH_DEV_SANDBOX_NAME: name
		};
		if (state.inheritHostApi) Object.assign(env, this.collectHostApiEnv());
		if (state.inheritHostModel) this.inheritHostSettings(home);
		const child = spawn(nodeExec, [
			...nodeArgs,
			cliEntry,
			"web",
			"--port",
			String(spawnPort)
		], {
			cwd: root,
			env,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		this.children.set(name, child);
		const childPid = child.pid ?? null;
		this.mutateState(name, {
			status: "starting",
			pid: childPid,
			port: spawnPort,
			startedAt: (/* @__PURE__ */ new Date()).toISOString(),
			stoppedAt: null,
			lastError: null,
			url: null
		});
		child.stdout.on("data", (chunk) => this.pushLog(name, chunk.toString()));
		child.stderr.on("data", (chunk) => this.pushLog(name, chunk.toString()));
		child.on("exit", (code, signal) => {
			if (this.children.get(name) === child) this.children.delete(name);
			this.pushLog(name, `[dsh-dev-sandbox] process exited (code=${code} signal=${signal ?? "none"})\n`);
			const current = readStateFile(home);
			if (current !== null && (current.status === "running" || current.status === "starting")) this.mutateState(name, {
				status: "exited",
				pid: null,
				url: null
			});
		});
		try {
			await this.waitReady(spawnPort, this.options.readyTimeoutMs, () => {
				const current = this.children.get(name);
				return current === void 0 || current.exitCode !== null;
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (childPid !== null) await this.terminateProcess(childPid, child);
			if (this.children.get(name) === child) this.children.delete(name);
			this.mutateState(name, {
				status: "error",
				pid: null,
				url: null,
				lastError: message
			});
			this.pushLog(name, `[dsh-dev-sandbox] start failed: ${message}\n`);
			throw error;
		}
		return this.mutateState(name, {
			status: "running",
			url: `http://127.0.0.1:${spawnPort}`,
			lastError: null
		});
	}
	/** Poll until the sandbox answers on its port or the process dies. */
	async waitReady(port, timeoutMs, isDead) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (isDead()) throw new SandboxError("dsh-dev-sandbox: sandbox process exited before becoming ready");
			if (await portResponds(port)) return;
			await delay(500);
		}
		throw new SandboxError(`dsh-dev-sandbox: sandbox did not answer on port ${port} within ${timeoutMs}ms`);
	}
	/** Wait for a process to exit without relying on an in-memory child handle. */
	async waitForExit(pid, timeoutMs) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (!this.pidAlive(pid)) return true;
			await delay(100);
		}
		return !this.pidAlive(pid);
	}
	/** Terminate a sandbox process, including one recovered from persisted state. */
	async terminateProcess(pid, child) {
		if (!this.pidAlive(pid)) return;
		try {
			if (child !== void 0 && child.exitCode === null) child.kill("SIGTERM");
			else process.kill(pid, "SIGTERM");
		} catch {}
		if (await this.waitForExit(pid, this.options.stopTimeoutMs)) return;
		if (process.platform === "win32") spawnSync("taskkill", [
			"/PID",
			String(pid),
			"/T",
			"/F"
		], {
			windowsHide: true,
			stdio: "ignore"
		});
		else try {
			process.kill(pid, "SIGKILL");
		} catch {}
		await this.waitForExit(pid, 3e3);
	}
	/**
	* Stop a sandbox: SIGTERM, then force-kill after the stop timeout.
	* @param name - sandbox name.
	*/
	async stop(name) {
		const state = this.get(name);
		if (state === null) throw new SandboxError(`dsh-dev-sandbox: unknown sandbox ${JSON.stringify(name)}`);
		if (state.pid === null) return;
		const child = this.children.get(name);
		this.pushLog(name, "[dsh-dev-sandbox] stopping (SIGTERM)\n");
		await this.terminateProcess(state.pid, child);
		this.children.delete(name);
		this.mutateState(name, {
			status: "stopped",
			pid: null,
			url: null,
			stoppedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
		this.pushLog(name, "[dsh-dev-sandbox] stopped\n");
	}
	/** Stop and delete a sandbox's whole home directory. */
	async destroy(name) {
		await this.stop(name);
		const home = this.homeOf(name);
		if (existsSync(home)) rmSync(home, {
			recursive: true,
			force: true
		});
		this.rings.delete(name);
		this.resourceCache.delete(name);
	}
	/** Patch one sandbox's persisted state and return the new summary. */
	mutateState(name, patch) {
		const state = readStateFile(this.homeOf(name));
		if (state === null) throw new SandboxError(`dsh-dev-sandbox: unknown sandbox ${JSON.stringify(name)}`);
		const next = {
			...state,
			...patch
		};
		this.writeState(name, next);
		this.resourceCache.delete(name);
		return this.withResourceUsage(next);
	}
	/** Stop child processes on host teardown. */
	dispose() {
		for (const child of this.children.values()) if (child.exitCode === null) child.kill("SIGTERM");
		this.children.clear();
	}
};
/** Default sandbox root under the OS home. */
function defaultHomeRoot() {
	return join(homedir(), ".dsh-sandboxes");
}
//#endregion
//#region src/verification.ts
function portableCompatibilityAttestation(verification) {
	return {
		format: verification.format,
		kind: verification.kind,
		repository: verification.repository,
		commit: verification.commit,
		checkedAt: verification.checkedAt,
		profileMode: verification.profileMode,
		result: verification.result,
		plugin: verification.plugin
	};
}
//#endregion
//#region src/routes.ts
/** Route prefix registered on the web server. */
const ROUTES_PREFIX = "/api/dsh-dev-sandbox";
/** One JSON response. */
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-cache"
	});
	res.end(payload);
}
/** Error text of an unknown thrown value. */
function message(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Whether a peer address belongs to this machine's loopback interface. */
function isLoopbackAddress(address) {
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
/** Read a JSON request body (1 MiB cap). */
function readJsonBody(req) {
	return new Promise((resolveBody, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > 1e6) {
				reject(/* @__PURE__ */ new Error("request body too large (max 1 MiB)"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (chunks.length === 0) {
				resolveBody({});
				return;
			}
			try {
				resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(/* @__PURE__ */ new Error("invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}
/** Number or undefined from an unknown body field. */
function numberField(value) {
	return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : void 0;
}
/** String or undefined from an unknown body/query field. */
function stringField(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
/** Boolean or undefined from an unknown body field. */
function boolField(value) {
	return typeof value === "boolean" ? value : void 0;
}
/** Dispatch one request under the prefix. */
async function dispatch(req, res, manager) {
	if (!isLoopbackAddress(req.socket.remoteAddress)) {
		json(res, 403, { error: "dsh-dev-sandbox routes accept loopback requests only" });
		return;
	}
	const url = new URL(req.url ?? "/", "http://localhost");
	const path = url.pathname.replace(/\/{2,}/g, "/");
	if (!path.startsWith(`/api/dsh-dev-sandbox/`)) {
		json(res, 404, { error: `unknown route ${path}` });
		return;
	}
	const action = path.slice(20);
	const query = url.searchParams;
	try {
		switch (action) {
			case "/list":
				if (req.method !== "GET") return method(res);
				json(res, 200, { sandboxes: manager.list() });
				return;
			case "/status": {
				if (req.method !== "GET") return method(res);
				const name = stringField(query.get("name"));
				if (name === void 0) return bad(res, "name is required");
				const sandbox = manager.get(name);
				if (sandbox === null) return json(res, 404, { error: `unknown sandbox ${JSON.stringify(name)}` });
				json(res, 200, { sandbox });
				return;
			}
			case "/logs": {
				if (req.method !== "GET") return method(res);
				const name = stringField(query.get("name"));
				if (name === void 0) return bad(res, "name is required");
				const tail = Math.min(5e3, Math.max(1, numberField(Number(query.get("tail"))) ?? 200));
				const lines = manager.logs(name, tail);
				if (lines === null) return json(res, 404, { error: `unknown sandbox ${JSON.stringify(name)}` });
				json(res, 200, { lines });
				return;
			}
			case "/scan": {
				if (req.method !== "GET") return method(res);
				const pathValue = stringField(query.get("path"));
				if (pathValue === void 0) return bad(res, "path is required");
				json(res, 200, { scan: manager.scanPlugin(pathValue) });
				return;
			}
			case "/host-plugins":
				if (req.method !== "GET") return method(res);
				json(res, 200, { plugins: manager.hostWebPlugins() });
				return;
			case "/verify": {
				if (req.method !== "POST") return method(res);
				const body = await readJsonBody(req);
				const pluginPath = stringField(body.pluginPath);
				if (pluginPath === void 0) return bad(res, "pluginPath is required");
				const profileMode = stringField(body.profileMode);
				if (profileMode !== void 0 && profileMode !== "clean" && profileMode !== "host-web") return bad(res, "profileMode must be \"clean\" or \"host-web\"");
				const repository = stringField(body.repository);
				if (repository !== void 0 && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return bad(res, "repository must be an owner/repo identifier");
				const commit = stringField(body.commit);
				if (commit !== void 0 && !/^[0-9a-f]{7,64}$/i.test(commit)) return bad(res, "commit must be a Git revision");
				const kind = stringField(body.kind);
				if (kind !== void 0 && kind !== "baseline-compatibility" && kind !== "local-compatibility") return bad(res, "kind must be \"baseline-compatibility\" or \"local-compatibility\"");
				const verification = await manager.verify(pluginPath, {
					...profileMode !== void 0 ? { profileMode } : {},
					...repository !== void 0 ? { repository } : {},
					...commit !== void 0 ? { commit } : {},
					...kind !== void 0 ? { kind } : {}
				});
				json(res, 200, {
					verification,
					attestation: portableCompatibilityAttestation(verification)
				});
				return;
			}
			case "/create": {
				if (req.method !== "POST") return method(res);
				const body = await readJsonBody(req);
				const name = stringField(body.name);
				if (name === void 0) return bad(res, "name is required");
				const pluginPath = typeof body.pluginPath === "string" && body.pluginPath.trim() !== "" ? body.pluginPath.trim() : void 0;
				const opts = {};
				const inheritApi = boolField(body.inheritHostApi);
				const inheritModel = boolField(body.inheritHostModel);
				const profileMode = stringField(body.profileMode);
				if (profileMode !== void 0 && profileMode !== "clean" && profileMode !== "host-web") return bad(res, "profileMode must be \"clean\" or \"host-web\"");
				if (inheritApi !== void 0) opts.inheritHostApi = inheritApi;
				if (inheritModel !== void 0) opts.inheritHostModel = inheritModel;
				if (profileMode !== void 0) opts.profileMode = profileMode;
				json(res, 200, { sandbox: manager.create(name, pluginPath, opts) });
				return;
			}
			case "/start": {
				if (req.method !== "POST") return method(res);
				const body = await readJsonBody(req);
				const name = stringField(body.name);
				if (name === void 0) return bad(res, "name is required");
				json(res, 200, { sandbox: await manager.start(name, numberField(body.port)) });
				return;
			}
			case "/stop": {
				if (req.method !== "POST") return method(res);
				const name = stringField((await readJsonBody(req)).name);
				if (name === void 0) return bad(res, "name is required");
				await manager.stop(name);
				json(res, 200, { ok: true });
				return;
			}
			case "/restart": {
				if (req.method !== "POST") return method(res);
				const body = await readJsonBody(req);
				const name = stringField(body.name);
				if (name === void 0) return bad(res, "name is required");
				await manager.stop(name);
				json(res, 200, { sandbox: await manager.start(name, numberField(body.port)) });
				return;
			}
			case "/destroy": {
				if (req.method !== "POST") return method(res);
				const name = stringField((await readJsonBody(req)).name);
				if (name === void 0) return bad(res, "name is required");
				await manager.destroy(name);
				json(res, 200, { ok: true });
				return;
			}
			case "/build": {
				if (req.method !== "POST") return method(res);
				const pluginPath = stringField((await readJsonBody(req)).pluginPath);
				if (pluginPath === void 0) return bad(res, "pluginPath is required");
				const code = manager.build(pluginPath);
				json(res, 200, {
					ok: code === 0,
					exitCode: code
				});
				return;
			}
			default: json(res, 404, { error: `unknown action ${action}` });
		}
	} catch (error) {
		json(res, 500, { error: message(error) });
	}
}
function method(res) {
	json(res, 405, { error: "method not allowed" });
}
function bad(res, error) {
	json(res, 400, { error });
}
/**
* Register the route prefix on the web server.
* @param ctx - host context carrying the webServer service.
* @param manager - the sandbox manager the routes drive.
* @returns the route disposer.
*/
function registerRoutes(ctx, manager) {
	return ctx.webServer.register({
		kind: "prefix",
		path: ROUTES_PREFIX,
		handler: (req, res) => void dispatch(req, res, manager)
	});
}
//#endregion
//#region src/tools.ts
/**
* Agent tools for driving dev sandboxes from inside the development
* instance: `sandbox_list/status/start/stop/destroy/logs/build`. These let
* the developer's own agent spin up the isolated mirror, install the plugin
* under development, and iterate on compatibility without ever touching the
* host instance.
* @module dsh-dev-sandbox/tools
*/
/** One text content block (the harness content-block vocabulary). */
function text(value) {
	return [{
		type: "text",
		text: value
	}];
}
/** Convert runtime state to the JSON shape declared by tool output schemas. */
function toolSandbox(sandbox) {
	return {
		name: sandbox.name,
		status: sandbox.status,
		port: sandbox.port,
		pluginName: sandbox.pluginName,
		pluginPath: sandbox.pluginPath,
		...sandbox.profileMode !== void 0 ? { profileMode: sandbox.profileMode } : {},
		...sandbox.url !== null ? { url: sandbox.url } : {},
		...sandbox.pid !== null ? { pid: sandbox.pid } : {},
		...sandbox.lastError !== null ? { lastError: sandbox.lastError } : {}
	};
}
/** Serialize a structured result crossing the harness tool boundary. */
function jsonRecord(value) {
	const parsed = JSON.parse(JSON.stringify(value));
	if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("dsh-dev-sandbox: expected a JSON object tool result");
	return parsed;
}
/** Compact one-line status of a sandbox. */
function renderSandbox(sandbox) {
	return [
		sandbox.name,
		sandbox.status,
		sandbox.profileMode ?? "clean",
		sandbox.port > 0 ? String(sandbox.port) : "-",
		sandbox.url ?? "-",
		sandbox.pluginName,
		sandbox.pluginPath
	].join(" | ");
}
/** Table of sandboxes. */
function renderSandboxes(sandboxes) {
	if (sandboxes.length === 0) return "no sandboxes";
	return [
		"name | status | profile | port | url | plugin | pluginPath",
		"--- | --- | --- | --- | --- | --- | ---",
		...sandboxes.map(renderSandbox)
	].join("\n");
}
/**
* Build the sandbox_* tool set for one manager.
* @param manager - the sandbox lifecycle manager.
* @returns registry-ready tool definitions.
*/
function sandboxTools(manager) {
	return [
		defineTool({
			name: "sandbox_list",
			description: "List isolated dsh dev sandboxes (name, status, port, url, plugin, pluginPath). Each sandbox is a separate DSH_HOME/web profile on its own port for testing plugins under development.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { sandboxes: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: {
									type: "string",
									required: true
								},
								status: {
									type: "string",
									required: true
								},
								port: {
									type: "integer",
									required: true
								},
								url: { type: "string" },
								pluginName: {
									type: "string",
									required: true
								},
								pluginPath: {
									type: "string",
									required: true
								},
								profileMode: { type: "string" },
								resourceUsage: {
									type: "object",
									additionalProperties: true,
									properties: {}
								},
								pid: { type: "integer" },
								lastError: { type: "string" }
							}
						}
					} }
				},
				render: (_args, value) => text(renderSandboxes(value.sandboxes ?? []))
			},
			async execute() {
				return { sandboxes: manager.list().map(toolSandbox) };
			}
		}),
		defineTool({
			name: "sandbox_status",
			description: "Show one dev sandbox's status and recent log tail.",
			parameters: { name: {
				type: "string",
				description: "Sandbox name."
			} },
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						sandbox: {
							type: "object",
							required: true,
							additionalProperties: true
						},
						logs: { type: "string" }
					}
				},
				render: (_args, value) => text(`status: ${JSON.stringify(value.sandbox, null, 2)}\n\nlogs:\n${value.logs ?? ""}`)
			},
			async execute(args) {
				if (args.name === void 0) throw new Error("name is required");
				const sandbox = manager.get(args.name);
				if (sandbox === null) throw new Error(`unknown sandbox ${JSON.stringify(args.name)}`);
				return {
					sandbox: jsonRecord(sandbox),
					logs: manager.logs(args.name, 60) ?? ""
				};
			}
		}),
		defineTool({
			name: "sandbox_start",
			description: "Start (creating when needed) an isolated dsh web sandbox mounting a plugin under development. Returns the sandbox with its ready URL. Optional port override; otherwise a free port is allocated from basePort.",
			parameters: {
				name: {
					type: "string",
					description: "Sandbox name (1-32 chars of [A-Za-z0-9_-])."
				},
				pluginPath: {
					type: "string",
					description: "Absolute path of the plugin-under-test checkout; optional (absent/empty = plain mirror without a plugin)."
				},
				port: {
					type: "integer",
					description: "Optional explicit port."
				},
				build: {
					type: "boolean",
					description: "Run the plugin's build script before starting."
				},
				inheritHostApi: {
					type: "boolean",
					description: "Inject the host's DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL into the sandbox (default: the row config value, true)."
				},
				inheritHostModel: {
					type: "boolean",
					description: "Copy the host's settings.yaml into a fresh sandbox home (default: the row config value, true)."
				},
				profileMode: {
					type: "string",
					description: "Profile composition: \"clean\" for stock dsh-base/web-app, or \"host-web\" to replay the local web profile in an isolated DSH_HOME."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { sandbox: {
						type: "object",
						required: true,
						additionalProperties: true
					} }
				},
				render: (_args, value) => text(`sandbox started:\n${JSON.stringify(value.sandbox, null, 2)}`)
			},
			async execute(args) {
				if (args.name === void 0) throw new Error("name is required");
				const profileMode = args.profileMode === void 0 ? void 0 : args.profileMode === "clean" || args.profileMode === "host-web" ? args.profileMode : (() => {
					throw new Error("profileMode must be \"clean\" or \"host-web\"");
				})();
				const existing = manager.get(args.name);
				if (existing === null) manager.create(args.name, args.pluginPath !== void 0 && args.pluginPath !== "" ? args.pluginPath : void 0, {
					...args.inheritHostApi !== void 0 ? { inheritHostApi: args.inheritHostApi } : {},
					...args.inheritHostModel !== void 0 ? { inheritHostModel: args.inheritHostModel } : {},
					...profileMode !== void 0 ? { profileMode } : {}
				});
				else if (profileMode !== void 0) manager.create(args.name, existing.pluginPath === "" ? void 0 : existing.pluginPath, { profileMode });
				if (args.build === true) {
					const state = manager.get(args.name);
					if (state !== null && state.pluginPath !== "") manager.build(state.pluginPath);
				}
				return { sandbox: jsonRecord(await manager.start(args.name, args.port)) };
			}
		}),
		defineTool({
			name: "sandbox_stop",
			description: "Stop a running dev sandbox (SIGTERM, then force-kill after a timeout). The sandbox and its isolated home remain for later restarts.",
			parameters: { name: {
				type: "string",
				description: "Sandbox name."
			} },
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { ok: {
						type: "boolean",
						required: true
					} }
				},
				render: (_args, value) => text(value.ok === true ? "sandbox stopped" : "sandbox stop returned an unexpected result")
			},
			async execute(args) {
				await manager.stop(args.name);
				return { ok: true };
			}
		}),
		defineTool({
			name: "sandbox_destroy",
			description: "Stop and permanently delete a dev sandbox (its whole isolated DSH_HOME directory).",
			parameters: { name: {
				type: "string",
				description: "Sandbox name."
			} },
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { ok: {
						type: "boolean",
						required: true
					} }
				},
				render: (_args, value) => text(value.ok === true ? "sandbox destroyed" : "sandbox destroy returned an unexpected result")
			},
			async execute(args) {
				await manager.destroy(args.name);
				return { ok: true };
			}
		}),
		defineTool({
			name: "sandbox_logs",
			description: "Show a dev sandbox's captured log tail.",
			parameters: {
				name: {
					type: "string",
					description: "Sandbox name."
				},
				tail: {
					type: "integer",
					description: "Number of trailing lines (default 200, max 5000)."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { lines: {
						type: "string",
						required: true
					} }
				},
				render: (_args, value) => text(value.lines ?? "")
			},
			async execute(args) {
				const lines = manager.logs(args.name, args.tail ?? 200);
				if (lines === null) throw new Error(`unknown sandbox ${JSON.stringify(args.name)}`);
				return { lines };
			}
		}),
		defineTool({
			name: "sandbox_verify",
			description: "Run a disposable local compatibility check for an already-built plugin source. It uses an isolated clean or host-web mirror, never downloads the plugin, never builds it, and does not inject host API credentials or settings.",
			parameters: {
				pluginPath: {
					type: "string",
					description: "Absolute path of the already-built local plugin package."
				},
				profileMode: {
					type: "string",
					enum: ["clean", "host-web"],
					description: "Compatibility target: clean stock profile or host-web local profile mirror."
				},
				repository: {
					type: "string",
					description: "Optional marketplace repository identity in owner/repo form."
				},
				commit: {
					type: "string",
					description: "Optional immutable Git revision for a publisher baseline receipt."
				},
				kind: {
					type: "string",
					enum: ["baseline-compatibility", "local-compatibility"],
					description: "Receipt intent. Baseline requires repository, commit, and clean profile."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						verification: {
							type: "object",
							required: true,
							additionalProperties: true
						},
						attestation: {
							type: "object",
							required: true,
							additionalProperties: true
						}
					}
				},
				render: (_args, value) => {
					const result = value.verification;
					return text(`local compatibility ${result.result ?? "unknown"} (${result.profileMode ?? "clean"})${result.error ? `: ${result.error}` : ""}`);
				}
			},
			async execute(args) {
				if (args.pluginPath === void 0) throw new Error("pluginPath is required");
				const verification = await manager.verify(args.pluginPath, {
					...args.profileMode !== void 0 ? { profileMode: args.profileMode } : {},
					...args.repository !== void 0 ? { repository: args.repository } : {},
					...args.commit !== void 0 ? { commit: args.commit } : {},
					...args.kind !== void 0 ? { kind: args.kind } : {}
				});
				return {
					verification: jsonRecord(verification),
					attestation: jsonRecord(portableCompatibilityAttestation(verification))
				};
			}
		}),
		defineTool({
			name: "sandbox_build",
			description: "Run the build script of a plugin checkout (pnpm run build) so its host/client halves are fresh before sandbox testing.",
			parameters: { pluginPath: {
				type: "string",
				description: "Absolute path of the plugin package directory."
			} },
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: {
							type: "boolean",
							required: true
						},
						exitCode: {
							type: "integer",
							required: true
						}
					}
				},
				render: (_args, value) => text(value.ok === true ? `build succeeded (exit ${value.exitCode})` : `build failed (exit ${value.exitCode})`)
			},
			async execute(args) {
				const exitCode = manager.build(args.pluginPath);
				return {
					ok: exitCode === 0,
					exitCode
				};
			}
		})
	];
}
//#endregion
//#region src/index.ts
/**
* @zp-home/dsh-dev-sandbox — DSH plugin developer sandbox.
*
* Host half: a lifecycle manager for isolated dsh web instances ("business
* mirrors"). Each sandbox gets its own DSH_HOME, its own web profile that
* mounts the plugin under development, and its own port, spawned from the
* same harness checkout — so plugin work never touches or breaks the
* development instance. The host half registers `/api/dsh-dev-sandbox/*`
* routes and the `sandbox_*` agent tools.
*
* The browser half (`./client`) renders a sidebar entry + panel for driving
* the sandboxes from the GUI.
* @module @zp-home/dsh-dev-sandbox
*/
/** Stable cordis plugin name. */
const name = "dev-sandbox";
/** Services required before the sandbox surfaces can mount. */
const inject = [
	"webServer",
	"tools",
	"systemPrompt"
];
/** Plugin row config, resolved by the loader's schema. */
const Config = z.object({
	/** Absolute sandbox root; each sandbox is one subdirectory (its DSH_HOME). */
	homeRoot: z.string().default("~/.dsh-sandboxes"),
	/** Optional absolute path of the dsh source checkout to boot sandboxes from. */
	harnessRoot: z.string(),
	/** First port tried when allocating a sandbox port. */
	basePort: z.natural().default(4e3),
	/** Run the plugin's build script before every start. */
	buildOnStart: z.boolean().default(false),
	/** Inject the host's DEEPSEEK_* API env (key/base URL) into each sandbox. */
	inheritHostApi: z.boolean().default(true),
	/** Copy the host's settings.yaml into a fresh sandbox home (model defaults). */
	inheritHostModel: z.boolean().default(true),
	/** Announce the plugin's presence and tools in the system prompt. */
	announceToAgent: z.boolean().default(true),
	/** Master switch; when false the plugin mounts nothing. */
	enabled: z.boolean().default(true),
	/** How long a start waits for the sandbox to answer on its port (ms). */
	readyTimeoutMs: z.natural().default(9e4),
	/** How long a stop waits for graceful exit before force-killing (ms). */
	stopTimeoutMs: z.natural().default(1e4)
});
/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 150;
/** Model-facing announcement: plugin presence, capabilities, and limits. */
const GUIDANCE = [
	"本机已安装 dsh-dev-sandbox 插件（DSH 插件开发沙盒）：为插件开发者提供完全隔离的测试镜像。",
	"能力：一键启动独立的 DeepSeek Harness web 业务镜像（独立 DSH_HOME、独立端口、独立 web profile）。",
	"默认是标准纯净 profile；sandbox_start 的 profileMode=host-web 可镜像本机 Web profile 的 bundle、包链接和 Cordis patch，",
	"用于复现已安装插件之间的兼容问题，但不复制 session、storage、缓存或凭据。待测插件会覆盖镜像中的同名包。",
	"默认集成主机接口：注入主机的 DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL 并继承主机模型设置，沙盒可直接对话，不触碰开发本体。",
	"工具：sandbox_list 列出沙盒；sandbox_start 创建并启动（可带 pluginPath/port/build/inheritHostApi/inheritHostModel/profileMode）；",
	"sandbox_stop / sandbox_destroy / sandbox_logs / sandbox_build / sandbox_verify；GUI 侧边栏「沙盒」面板同样可操作。",
	"限制：沙盒进程真实占用端口与 CPU；销毁沙盒会删除其整个隔离目录；命令经宿主节点执行。",
	"用户提到「沙盒 / 测试镜像 / 业务镜像 / 隔离实例 / 不重启测试插件」时即指本插件，请据此协作。"
].join("");
/** Defaults applied to a partial config. */
function resolveConfig(config) {
	const basePort = config.basePort ?? 4e3;
	return {
		homeRoot: config.homeRoot !== void 0 && config.homeRoot.trim() !== "" ? config.homeRoot === "~" || config.homeRoot === "~/" || config.homeRoot === "~\\" ? homedir() : config.homeRoot.startsWith("~/") || config.homeRoot.startsWith("~\\") ? join(homedir(), config.homeRoot.slice(2)) : config.homeRoot : defaultHomeRoot(),
		harnessRoot: config.harnessRoot,
		basePort: Math.max(1, Math.min(65535, basePort)),
		buildOnStart: config.buildOnStart === true,
		inheritHostApi: config.inheritHostApi !== false,
		inheritHostModel: config.inheritHostModel !== false,
		readyTimeoutMs: config.readyTimeoutMs ?? 9e4,
		stopTimeoutMs: config.stopTimeoutMs ?? 1e4,
		announceToAgent: config.announceToAgent !== false,
		enabled: config.enabled !== false
	};
}
/**
* Mount the dev-sandbox surfaces. Re-resolves the row config on every
* recomposition (like sibling plugins), so patch edits stay live.
* @param ctx - host plugin context carrying webServer/tools/systemPrompt.
* @param config - resolved plugin row config.
*/
function apply(ctx, config) {
	let manager;
	let disposeSection;
	let disposeRoutes;
	let disposeTools;
	const sync = () => {
		disposeSection?.();
		disposeSection = void 0;
		disposeRoutes?.();
		disposeRoutes = void 0;
		disposeTools?.();
		disposeTools = void 0;
		manager?.dispose();
		manager = void 0;
		const value = resolveConfig(config ?? {});
		if (!value.enabled) return;
		if (value.announceToAgent) disposeSection = ctx.systemPrompt.section({
			name: "plugin:dsh-dev-sandbox",
			order: SECTION_ORDER,
			text: GUIDANCE
		});
		manager = new SandboxManager(value);
		disposeRoutes = ctx.effect(() => registerRoutes(ctx, manager), "dsh-dev-sandbox: routes");
		disposeTools = ctx.effect(() => {
			const disposers = sandboxTools(manager).map((tool) => ctx.tools.register(tool));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "dsh-dev-sandbox: tools");
	};
	sync();
	ctx.effect(() => () => {
		disposeSection?.();
		disposeRoutes?.();
		disposeTools?.();
		manager?.dispose();
	}, "dsh-dev-sandbox: teardown");
}
var src_default = {
	name,
	apply,
	inject,
	Config
};
//#endregion
export { Config, apply, src_default as default, inject, name };

//# sourceMappingURL=index.js.map