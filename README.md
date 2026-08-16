# @linxin666/dsh-dev-sandbox · DSH 插件开发沙盒

[![dsh-recommend](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fzp-home%2Fdsh-recommend%2Fmain%2Fdata%2Fbadges%2Fzp-home__dsh-dev-sandbox.certified.json)](https://github.com/zp-home/dsh-recommend)
[![dsh score](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fzp-home%2Fdsh-recommend%2Fmain%2Fdata%2Fbadges%2Fzp-home__dsh-dev-sandbox.json)](https://github.com/zp-home/dsh-recommend)
[![license](https://img.shields.io/github/license/zp-home/dsh-dev-sandbox?style=flat-square)](LICENSE)
[![topic dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-4D6BFE?style=flat-square)](https://github.com/topics/dsh-plugin)
[![stars](https://img.shields.io/github/stars/zp-home/dsh-dev-sandbox?style=flat-square)](https://github.com/zp-home/dsh-dev-sandbox)

> **English**: A developer sandbox for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness)
> plugins. One click spawns a fully **isolated** dsh web instance — its own `DSH_HOME`, its own port, its
> own profile — that auto-mounts the plugin you are developing, so plugin work (restarts, crashes, bad
> mounts) never touches — or breaks — the development instance. Mirrors can optionally inherit the host's
> `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL` and model settings, so you can chat with the mirror directly.
> Ship with a GUI panel (sidebar "沙盒") and agent tools (`sandbox_*`).

---

## 痛点与方案

**痛点**：直接在开发本体上测试插件很危险——反复重启、挂载坏掉的插件、改坏配置，都可能把开发实例搞坏，而修它又得靠别的 AI 来折腾。

**方案**：一键启动一个**独立的 DSH web 业务镜像**（自己的 `DSH_HOME`、自己的端口、自己的 profile），
自动把正在开发的插件挂载进去做兼容性测试。测试、重启、搞坏，都在沙盒里发生，开发本体毫发无伤。

## 能力

- **完全隔离**：每个沙盒 = 独立 `DSH_HOME`（默认 `~/.dsh-sandboxes/<name>`，含独立的
  sessions / storages / settings / profiles）+ 独立端口（默认从 4000 起自动分配）+ 标准 web profile
  （`dsh-base` + `dsh-web-app` + 待测插件）。销毁 = 删除整个隔离目录，零残留。
- **插件路径选填**：不填插件路径 = 纯净镜像（仅标准 web 环境），适合验证插件对原生 harness 的
  兼容性，或纯粹复现/排查问题。
- **挂载待测插件**：junction 把插件源码目录挂进沙盒 profile 的 `node_modules`，插件本体无需 pnpm
  安装；沙盒从**同一个 harness 检出**启动（`node --import tsx/esm apps/cli/src/bin.ts web --port N`），
  待测插件跑在与开发时完全相同的 harness 版本上。
- **集成主机接口（默认开启）**：
  - 注入宿主的 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`（先取宿主进程环境，再回退读宿主 home 的
    `.env` 与 `.credentials.yaml`），沙盒内直接就能与 DeepSeek 对话；
  - 首次启动把宿主 `settings.yaml` 复制进沙盒 home（模型/主题默认值与宿主一致）。
  - 面板勾选框「集成主机 API/模型配置」或按沙盒/全局配置可关闭。
- **双面操作**：
  - **GUI**：侧边栏「沙盒」入口 + 面板（创建/启动/停止/重启/销毁/日志/打开测试界面/插件扫描与构建）。
  - **Agent 工具**：`sandbox_list` / `sandbox_status` / `sandbox_start` / `sandbox_stop` /
    `sandbox_destroy` / `sandbox_logs` / `sandbox_build` —— 让开发本体里的 AI 直接驱动沙盒。
- **生命周期可靠**：状态持久化（`sandbox-state.json`），宿主重启后自动校正运行状态；进程退出自动
  标记；SIGTERM 优雅停止，超时强杀；沙盒可反复重启，状态保持。

## 安装

插件行通过 profile 的 `cordis.patch.yml` 挂载；**新增**插件行需要重启一次该实例（配置 HMR 只热更
已有行的配置）。装好之后，所有插件测试都在沙盒里进行，开发本体再也不用为测试重启。

### 方式 A：GitHub 安装（推荐）

```sh
# 在 harness 检出根目录（或任意目录）执行：
dsh plugin --profile web add github:zp-home/dsh-dev-sandbox
```

### 方式 B：本地源码热挂载（无需 pnpm）

```powershell
# 1. 构建（在插件目录，使用 harness 的 tsdown）
& E:\qwq\deepseek-harness\node_modules\.bin\tsdown.cmd -c E:\qwq\deepseek\dsh-dev-sandbox\tsdown.config.ts

# 2. junction 到开发 profile 的 node_modules
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\@linxin666\dsh-dev-sandbox" `
  -Target "E:\qwq\deepseek\dsh-dev-sandbox"

# 3. 在 profile 的 cordis.patch.yml 追加：
#    - insert:
#        - id: dev-sandbox
#          name: '@linxin666/dsh-dev-sandbox'
```

然后重启一次开发实例，刷新浏览器即可看到侧边栏「沙盒」。

## 使用

1. 刷新浏览器，侧边栏出现「沙盒」。
2. 填「插件路径」= 待测插件目录（含 package.json），点「扫描插件」看构建状态；
   未构建可点「构建」或勾选「启动前构建」。**留空插件路径** = 纯净镜像。
3. 勾选「集成主机 API/模型配置」（默认勾选）→ 沙盒可直接对话。
4. 「创建并启动」→ 面板出现实例卡片：状态 / 端口 / 打开链接 / 日志。
5. 让 AI 干活：对开发本体里的 agent 说「用沙盒测试 <插件> 的兼容性」，agent 会用
   `sandbox_start` 等工具驱动沙盒，例如：

   ```
   sandbox_start name=test-a pluginPath=E:\path\to\my-plugin build=true
   sandbox_logs name=test-a
   sandbox_stop name=test-a
   sandbox_destroy name=test-a
   ```

## 配置（插件行 config，均可选）

| 字段 | 默认 | 说明 |
|---|---|---|
| `homeRoot` | `~/.dsh-sandboxes` | 沙盒根目录（每个沙盒一个子目录 = 其 DSH_HOME） |
| `harnessRoot` | 自动探测 | dsh 源码检出根目录（含 `apps/cli/src/bin.ts`）；探测顺序：cwd → 插件位置 → `@deepseek-ai/dsh-app-boot` 解析路径 |
| `basePort` | `4000` | 沙盒端口分配起点 |
| `buildOnStart` | `false` | 每次启动前先跑插件的 build 脚本 |
| `inheritHostApi` | `true` | 注入宿主的 DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL 到沙盒 |
| `inheritHostModel` | `true` | 首次启动把宿主 settings.yaml 复制进沙盒 home |
| `announceToAgent` | `true` | 是否在系统提示中宣告本插件 |
| `enabled` | `true` | 总开关 |
| `readyTimeoutMs` | `90000` | 启动等待端口就绪超时 |
| `stopTimeoutMs` | `10000` | 停止时优雅退出等待，超时强杀 |

例：

```yaml
- insert:
    - id: dev-sandbox
      name: '@linxin666/dsh-dev-sandbox'
      config:
        basePort: 5000
        buildOnStart: true
        homeRoot: '~/my-sandboxes'
```

## 架构速览

```
src/
  index.ts       宿主插件入口（name/inject/Config/apply + 系统提示公告）
  harness.ts     定位 dsh 源码检出（cwd → 插件位置 → dsh-app-boot 解析）
  manager.ts     沙盒生命周期：隔离 home/profile/junction、进程、日志环形缓冲、状态持久化、
                 主机 API 环境注入、settings 继承
  routes.ts      /api/dsh-dev-sandbox/* HTTP 路由
  tools.ts       sandbox_* agent 工具（defineTool）
  client/        浏览器端：侧边栏入口 + 面板（纯 DOM，无 React 依赖）
```

沙盒启动命令等价于：`DSH_HOME=<sandboxHome> node --import tsx/esm <harness>/apps/cli/src/bin.ts web --port N`。

## 开发

```sh
# 构建（宿主端 lib/index.js + 浏览器端 lib/client.js）
pnpm run build        # 或使用 harness 的 tsdown：& <harness>/node_modules/.bin/tsdown.cmd -c tsdown.config.ts

# 类型检查（需先安装 devDependencies）
pnpm typecheck
```

## 说明与限制

- 沙盒是真实进程：占用端口与 CPU；`destroy` 会删除整个隔离目录，请先确认。
- 沙盒 web profile 是**标准** web（base + web-app），不含开发本体的自定义插件，适合验证插件对
  原生 harness 的兼容性；沙盒进程从当前 harness 检出启动，因此会继承该检出的源码状态。
- 待测插件若有运行时依赖，需能在其目录解析（其自身 node_modules / 其所在 workspace）。
- 本插件仅监听回环地址（web server 默认 127.0.0.1），路由无鉴权，请勿暴露到公网。
- 集成主机 API 会把宿主凭据注入沙盒进程环境；关闭 `inheritHostApi` 可让沙盒完全不带 key（但仍继承
  宿主进程环境变量，无法做到完美清洗）。

## 更新日志

### v0.1.0（2026-08-16）

- 首个版本：隔离镜像沙盒、插件路径选填（纯净镜像）、集成主机 API/模型、GUI 面板 + `sandbox_*`
  agent 工具、状态持久化与进程管理。

## 贡献

欢迎 PR / Issue。请先阅读 [awesome-dsh-plugin 的 contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)（本插件已提交收录于该精选列表数据源）。

## 免责声明

插件为第三方代码，安装即在本机以你的权限运行；本列表不构成安全背书。安装前请自行审查源码，并在
不存放密钥的环境中试用不熟悉的插件。
