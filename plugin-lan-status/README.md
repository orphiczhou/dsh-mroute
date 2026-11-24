# dsh-lan-status · LAN DSH 节点状态面板

> 只读的多节点 DSH 状态面板：一个协调者聚合，所有节点各自暴露 `/self`；不写任何 DSH 状态，不碰会话内容，不持有 token。
>
> 版本 **0.3.0**（2026-11-23）：新增 DSH client 半与同源 `/lan-status/` 代理，左侧 dock 出现“LAN 状态”入口，点击在 DSH 主面板内嵌 iframe 显示值班台；A 与本地 desktop 已实测。此前 0.2.1 的独立 HTTP 面板、可信 LAN 网关直链与四节点 4/4 仍然保留。

## 1. 它解决什么

四台机器上的 DSH web 实例各自为政时，只能逐个打开带 launch token 的 URL 才能知道：

- 哪些节点在线、跑的是哪个 DSH 版本；
- 每个节点有哪些**活着**的会话；
- 协调者的任务台账里哪些任务在跑、哪些刚完成/失败；
- 每个节点的入口地址。

本插件把上述信息汇总到一个值班台页面（默认 `http://<coordinator>:3091/`），5 秒刷新：

- 顶部健康横幅 + 5 个舰队 KPI（在线、当前会话、运行任务、最近失败、平均延迟）；
- 四列节点卡（主机/系统/CPU/内存/磁盘/负载/角色/延迟/DSH 版本）；
- 详情抽屉（概览、会话、任务、原始 JSON）；
- 节点入口直链：指向 `entryUrl`（`plugin-lan-trust` 网关，A/B/C/D 的 3095/3096），浏览器自动登录，不再输入 token；
- 全宽任务表、探针链路、深/浅主题、搜索。
- **DSH 左侧 dock 入口**：注册 `sidebar.panellist` 的 `LAN 状态` 图标与 `main` 的 `lan-status` 面板；点击后在 DSH 主面板内嵌同源 `/lan-status/` iframe，不需要另开浏览器标签。

页面只读；面板本身不持有、不拼接、不转发 launch token。入口由节点本地网关完成 `token → cookie` 交换；网关仍只在可信 CIDR 内可用，DSH 原生 3081 仍需 token。

**远端节点是 `dsh web`，不是 desktop**：A/B/C/D 都是 `dsh --profile lan ... web` 形式的 headless web 实例；本机 Windows 桌面 GUI 只是控制端。

## 2. 架构

```text
                 GET /status（聚合，2s 缓存）
 浏览器 ────────────────────────────────► dsh-a（coordinator，:3091）
                                              │  GET /self
                    ┌─────────────────────────┼─────────────────────────┐
                    ▼                         ▼                         ▼
              dsh-b :3092              dsh-c :3091              dsh-d :3091
              （agent）                 （agent）                 （agent）

  每个节点：node:http + lib/system.js（node:os/CPU 两采样/磁盘）+ ctx.agents.list()
  dsh-a 额外：读 ~/.dsh-lan-scheduler/state.json 的任务台账
```

- **Host 半 + Client 半**：Host 半仍可独立跑 `node:http` 值班台（`serve: true`）；Client 半注册 `sidebar.panellist` 的 `lan-status` 图标与 `main` 的 `lan-status` 面板，并在 DSH 自己的 web server 上注册同源 `/lan-status/*` 代理到 `panelUrl`。这样 iframe 与 DSH 同源，CSP 只需 `frame-ancestors 'self'`。
- **协调者不递归调用自己**：`/status` 对本地节点直接用内存里的 `self`，只有远端才发 `/self`。
- **不读会话正文**：只列 `ctx.agents.list()` 的 session id/title/status/cwd；标题来自可选的 `sessionProjections`，取不到就留空。
- **任务只由协调者读**：agent 角色不读台账；`/self` 的 `tasks.total` 为 0。
- **本地 client 可只做壳**：本地 desktop 可用 `serve: false` + `panelUrl` 指向 A 的 3091，由本地 DSH 代理到 A；不需要在本地再跑一份采集服务。

## 3. 安装

### 3.1 复制并安装包

```bash
# 在目标节点上（包目录含 package.json / lib / client.js / cordis.patch.yml）
dsh plugin --profile lan add /path/to/plugin-lan-status
```

包 0.3.0 已带 `dsh.bundle.patch` 与 `dsh.client`，作为 **bundle** 安装（如 `plugin_manager install_bundle`）时会自动插入 `cordis.patch.yml` 的默认行；用 `dsh plugin add` 作为普通依赖安装时不会自动加载 patch，仍需按 3.2/3.3 手写 profile patch（远端 A/B/C/D 即这种形态）。

本地 desktop 推荐直接装 bundle：

```powershell
plugin_manager install_bundle target=file:C:/path/to/local-dsh-lan-status-0.3.0.tgz
```

默认 `cordis.patch.yml` 是 `serve: false` + `panelUrl: http://192.168.3.23:3091`，即本地只提供 client 壳与同源代理，不重复采集。

### 3.2 协调者 patch

`$DSH_HOME/profiles/lan/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: lan-status
      name: '@local/dsh-lan-status'
      config:
        instanceId: dsh-a
        label: dsh-a
        role: coordinator
        host: 0.0.0.0
        port: 3091
        origin: http://192.168.3.23:3081
        agentUrl: http://192.168.3.23:3091
        panelUrl: http://192.168.3.23:3091
        dshVersion: 0.2.2-rc.3
        schedulerStateFile: /home/orphic/.dsh-lan-scheduler/state.json
        requestTimeoutMs: 2500
        nodes:
          - { instanceId: dsh-a, label: dsh-a, role: coordinator, origin: 'http://192.168.3.23:3081', agentUrl: 'http://192.168.3.23:3091' }
          - { instanceId: dsh-b, label: dsh-b, role: agent, origin: 'http://192.168.3.23:3082', agentUrl: 'http://192.168.3.23:3092' }
          - { instanceId: dsh-c, label: dsh-c, role: agent, origin: 'http://192.168.3.21:3081', agentUrl: 'http://192.168.3.21:3091' }
          - { instanceId: dsh-d, label: dsh-d, role: agent, origin: 'http://192.168.3.24:3081', agentUrl: 'http://192.168.3.24:3091' }
```

### 3.3 agent patch

B/C/D 各写自己的 `instanceId/origin/agentUrl`，`role: agent`，不要写 `nodes`：

```yaml
- insert:
    - id: lan-status
      name: '@local/dsh-lan-status'
      config:
        instanceId: dsh-b
        label: dsh-b
        role: agent
        host: 0.0.0.0
        port: 3092
        origin: http://192.168.3.23:3082
        agentUrl: http://192.168.3.23:3092
        panelUrl: http://192.168.3.23:3091
        dshVersion: 0.2.2-rc.3
```

### 3.4 重启与防火墙

- Linux：`systemctl --user restart dsh-lan-a`（B/C 同理）。
- Windows：重启计划任务 `DSH-LAN-D`，并放行入站 TCP 3091（另需已有的 3081 规则）。
- Client 半需要 DSH 重启/重扫 client graph 后才会出现在左侧 dock；页面刷新不够。`plugin_manager` 安装 bundle 后若当前页未出现，刷新一次或重启 DSH。
- 验证：

```bash
curl -s http://127.0.0.1:3091/health
curl -s http://127.0.0.1:3091/self
curl -s http://192.168.3.23:3091/status | head -c 500
curl -s http://192.168.3.23:3081/lan-status/health   # 同源代理（DSH web 端口）
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.3.23:3081/lan-status/
```

在 DSH UI 左侧 dock 点击“LAN 状态”，应切到 `main` 的 `lan-status` 面板并加载同源 iframe；A 实测 iframe 标题为 `LAN DSH · 节点状态`，4 张节点卡、5 个 KPI。

### 3.5 当前四节点部署（2026-11-20 实测）

| 节点 | 角色 | 状态端口 | 台账/任务 | 实测 |
|---|---|---|---|---|
| dsh-a `.23:3081` | coordinator | `:3091` | `~/.dsh-lan-scheduler/state.json` | `/health` 200，`/status` 聚合 4/4 |
| dsh-b `.23:3082` | agent | `:3092` | 本机独立台账 | `/health` 200，`/self` 200 |
| dsh-c `.21:3081` | agent | `:3091` | 本机独立台账 | `/health` 200，`/self` 200 |
| dsh-d `.24:3081` | agent | `:3091` | 本机独立台账 | `/health` 200，防火墙 3091 已放行 |

- 浏览器入口：`http://192.168.3.23:3091/`（A 的 `/status` 聚合页）。
- 2026-11-20 23:25 v2 实测：四节点 `/health` 全 200；A `/status?refresh=1` 返回 `summary={nodes:4,online:4,offline:0,sessions:0,runningTasks:0,totalTasks:14}`；四节点 `system` 均上报（A CPU 0.3/MEM 54.3/DISK 80.3，B 0.2/54.1/80.3，C 0.1/58.2/54.6，D 1.2/64.8/85.3）。
- `sessions=0` 是 `ctx.agents.list()` 只列活 agent 的真实结果（四实例重启后无活会话）；面板文案是“当前会话/活跃 agent”。
- 截图：`D:\Codes\DSH小插件\tmp\lan-status-v2.png`（1440×1200，4/4、四卡资源条、探针链路、全宽任务表）。
- B 与 A 同机，必须用 **3092** 区分；C/D 在各自机器上用 3091。
- **0.3.0 client 实测（2026-11-23）**：A（`http://192.168.3.23:3095/`）左侧 dock 出现 `LAN 状态`，点击后 iframe `http://192.168.3.23:3081/lan-status/` 加载成功，4/4、5 KPI、平均延迟 5ms，截图 `tmp/lan-status-in-dsh.png`；本地 desktop 经 `plugin_manager` 安装后，client `Slots` 查询显示 `sidebar.panellist` 的 `lan-status` 与 `main` 的 `lan-status` 均 active，本地 `/lan-status/health` 200。

## 4. 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `instanceId` | `dsh` | 节点唯一 id；协调者的 `nodes` 用它匹配本地 self |
| `label` | `instanceId` | 面板显示名 |
| `role` | `agent` | `coordinator` 才提供 `/status` 与 `/` 面板 |
| `host` | `0.0.0.0` | 监听地址；只给本机看可改 `127.0.0.1` |
| `port` | `3091` | 面板/agent 端口 |
| `serve` | `true` | 是否启动独立 `node:http` 值班台；本地只做 client 壳时可设 `false` |
| `panelUrl` | `''` | client iframe 的同源代理目标（协调者面板地址）；为空则不注册 `/lan-status/*` |
| `origin` | `''` | 该节点 DSH web 入口（含端口，不含 token） |
| `entryUrl` | `''` | 该节点 `plugin-lan-trust` 网关地址（A 3095、B 3096、C/D 3095）；为空时退回 `origin` |
| `agentUrl` | `''` | 该节点本插件地址（协调者用它拼 `/self`） |
| `dshVersion` | `''` | 展示用；不探测，避免额外依赖 |
| `schedulerStateFile` | `''` | 仅协调者读；缺省不读任务 |
| `requestTimeoutMs` | `2500` | 聚合时单节点 `/self` 超时 |
| `cacheTtlMs` | `2000` | `/status` 聚合缓存；`?refresh=1` 绕过 |
| `panelTitle` | `LAN DSH · 节点状态` | 页面标题 |
| `nodes` | 内置 A/B/C/D | 仅协调者用；显式列出可避免部署地址漂移 |

## 5. HTTP 接口

| 方法 | 路径 | 角色 | 返回 |
|---|---|---|---|
| GET | `/health` | 全部 | `{ok, instanceId, role, pid, uptimeSec}` |
| GET | `/self` | 全部 | 节点属性、会话、任务（仅协调者有任务） |
| GET | `/status` | 仅协调者 | 聚合节点/会话/任务；agent 返回 404 `not-coordinator` |
| GET | `/` | 协调者 | 独立 HTML 面板；agent 返回一行文本说明 |
| GET | `/status?refresh=1` | 协调者 | 跳过 2s 缓存 |
| GET/HEAD | `/lan-status/*` | 全部（DSH web server） | 同源代理到 `panelUrl`；供 client iframe 使用 |

只允许 `GET/HEAD`；其他方法 405。所有响应 `cache-control: no-store`。v2 起**不再发 `access-control-allow-origin: *`**；v0.3.0 起 CSP 为 `frame-ancestors 'self'`、`x-frame-options: SAMEORIGIN`（同源 iframe 需要），仍保留 `referrer-policy: no-referrer`、`x-content-type-options: nosniff`、`permissions-policy`。不再提供 `/open/:id` 或服务端 token 302；入口按钮直接打开节点 `entryUrl`（lan-trust 网关），网关自动换 cookie。

## 6. 安全边界

- **只读**：没有修改 DSH 状态、没有写文件、没有工具注册。
- **无凭据**：不读取 `DSH_INTERCONNECT_TOKEN`、provider key、launch token；面板只持有 `entryUrl`/`origin`，不拼接 token。
- **入口不经过面板**：入口按钮直接打开 `entryUrl`；节点本地的 `plugin-lan-trust` 网关在服务端完成 `token → cookie` 交换，token 不进入面板 URL、日志或 HTML。网关的安全边界见 `plugin-lan-trust/README.md`（允许网段内即 owner，禁止公网/反代）。
- **无认证**：面板本身不做登录；只应监听可信 LAN，不能暴露公网。若要跨网段，用防火墙白名单或反向代理加认证。
- **响应头收紧**：CSP、`frame-ancestors 'self'`、`x-frame-options: SAMEORIGIN`、`referrer-policy: no-referrer`、`nosniff`；不再发 `ACAO:*`，避免任意网页跨站读取 `/status`。同源代理 `/lan-status/*` 只允许 DSH 自己的页面 iframe，不允许外部站点嵌入。
- **不读正文**：只展示会话标题/状态/cwd，不读消息内容。
- **任务摘要**：任务标题、结果 summary、lastError 来自协调者台账，可能含业务信息；台账本身应按 600/ACL 保护。

## 7. 本地验证

```bash
node --check lib/status.js lib/server.js lib/index.js
node --test tests/*.test.mjs
```

当前：9/9 pass。测试覆盖任务行/会话行、协调者 vs agent、离线节点聚合、HTTP 路由、CSP/安全头、HTML 自包含。

## 8. 已知限制

- 会话列表依赖 `ctx.agents.list()` 的运行时形状；若宿主版本改动字段，面板会降级为空列表/无标题，不会崩溃。
- 只展示**当前**会话与协调者台账的最近 12 条终态；没有历史数据库。
- 任务数据只来自 dsh-a 的台账；B/C/D 自己的调度台账不聚合（它们不是 active coordinator）。
- 面板 5 秒刷新，聚合缓存 2 秒；没有 WebSocket/SSE。
- `origin`/`entryUrl` 不拼接 token；入口按钮直接打开网关，不再要求用户粘贴 token。DSH 原生 3081 仍要 token；网关是新增的无 token 入口。
- 面板无认证；CSP/CORS 只降低浏览器侧风险，不能替代网络隔离。
- 资源指标是采样点（CPU 首次可能为 null），不是历史趋势；D 离线时聚合会等满单节点超时（默认 2500ms）。

## 9. 文件地图

- `lib/status.js` — 纯数据构建（节点/会话/任务/`renderPanelHtml`）。
- `lib/system.js` — 本机系统指标采集（CPU 两采样、内存、磁盘、负载、uptime、版本）。
- `lib/server.js` — `node:http` 路由、缓存、超时、安全头与错误处理。
- `lib/index.js` — DSH 插件入口：`inject=['agents']`，`ctx.effect` 管理 server 生命周期；`serve:false` 时只注册代理。
- `lib/panel-proxy.js` — `/lan-status/*` 同源代理（透传 query、剥前缀、502 处理）。
- `client.js` — DSH client 半：`sidebar.panellist` 图标 + `main` 面板（iframe `/lan-status/`）。
- `lib/ui.html` — 单文件值班台（内联 CSS/JS，无构建）。
- `cordis.patch.yml` — bundle 默认配置（`serve:false` + `panelUrl`）。
- `tests/status.test.mjs` — 纯函数测试。
- `tests/server.test.mjs` — 真实 HTTP 路由测试（端口 0）。
- `docs/00-立项报告.md` — 目标/非目标、架构、数据契约、验收。
- `docs/01-redesign-ux.md`、`docs/02-observability-security.md` — 专家设计/安全评审。
