# E2E 验证记录

本插件在开发过程中完成的全链路验证（Windows / Node 24 / dsh 源码检出）：

## 隔离镜像生命周期（以插件自身为待测插件）

1. `POST /api/dsh-dev-sandbox/create {name, pluginPath}` → 沙盒 home 建立：
   `~/.dsh-sandboxes/<name>/`，profile `profiles/web/package.json` 的 bundles =
   `dsh-base` + `dsh-web-app` + 待测插件，插件以 junction 挂入 profile 的 node_modules。
2. `POST /start` → 分配空闲端口（basePort 起），spawn
   `node --import tsx/esm <harness>/apps/cli/src/bin.ts web --port N`，轮询就绪后 status=running。
3. 沙盒内验证：web root 200；`/api/dsh-dev-sandbox/list` 可用（插件在沙盒内也挂载成功——
   狗粮验证整条链路）；`/plugins/@zp-home/dsh-dev-sandbox/client.js` 200（客户端 bundle 正常服务）。
4. `POST /stop` → 端口关闭；再次 `POST /start` → 重新运行（重启稳定性）。
5. `POST /destroy` → 整个隔离目录删除，`/list` 为空。

## 纯净镜像（不填插件路径）

- `POST /create {name}`（无 pluginPath）→ profile bundles 仅 `dsh-base` + `dsh-web-app`，无 junction；
  启动后 web root 200。

## 集成主机接口

- 在宿主 home 放置 `.credentials.yaml`（`DEEPSEEK_API_KEY: ...`）与 `settings.yaml` 后启动沙盒：
  - 沙盒 home 出现复制来的 `settings.yaml`（`agent-default-model` 与宿主一致）；
  - 沙盒内 `POST /api/credentials.describe` 返回 `DEEPSEEK_API_KEY: {configured: true, source: 'env'}`，
    证明宿主凭据已注入沙盒进程环境，沙盒可直接对话。

## 已知边界

- 新增插件行（含本插件自身）在运行实例上不热挂载：配置 HMR 只热更已有行的配置，需要重启一次该实例。
- 沙盒继承宿主进程环境变量（`...process.env`），关闭 `inheritHostApi` 只能保证显式注入的 DEEPSEEK_*
  缺失，无法完美清洗进程环境。
