# dsh-lan-status · LAN DSH 节点状态面板

> 只读的多节点 DSH 状态面板：一个协调者聚合，所有节点各自暴露 `/self`；不写任何 DSH 状态，不碰会话内容，不持有 token。

## 1. 它解决什么

四台机器上的 DSH web 实例各自为政时，只能逐个打开带 launch token 的 URL 才能知道：

- 哪些节点在线、跑的是哪个 DSH 版本；
- 每个节点有哪些**活着**的会话；
- 协调者的任务台账里哪些任务在跑、哪些刚完成/失败；
- 每个节点的入口地址。

本插件把上述信息汇总到一个静态页面（默认 `http://<coordinator>:3091/`），5 秒刷新。页面只读；入口链接仍需该节点自己的 launch token 才能打开。

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

  每个节点：node:http + 本机 node:os + ctx.agents.list()
  dsh-a 额外：读 ~/.dsh-lan-scheduler/state.json 的任务台账
```

- **没有 DSH client 半**：这是独立 HTTP 服务，不注册 `settings.section`，不依赖 `ctx.remote` 的 `/remote` namespace，也不需要重启/重扫 client graph。
- **协调者不递归调用自己**：`/status` 对本地节点直接用内存里的 `self`，只有远端才发 `/self`。
- **不读会话正文**：只列 `ctx.agents.list()` 的 session id/title/status/cwd；标题来自可选的 `sessionProjections`，取不到就留空。
- **任务只由协调者读**：agent 角色不读台账；`/self` 的 `tasks.total` 为 0。

## 3. 安装

### 3.1 复制并安装包

```bash
# 在目标节点上（包目录含 package.json / lib）
dsh plugin --profile lan add /path/to/plugin-lan-status
```

包没有 `dsh.bundle`，`plugin add` 只负责把 `@local/dsh-lan-status` 放进 profile 的 `node_modules` 与 `package.json`；**加载需要手写 profile patch**。

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
        dshVersion: 0.2.2-rc.3
```

### 3.4 重启与防火墙

- Linux：`systemctl --user restart dsh-lan-a`（B/C 同理）。
- Windows：重启计划任务 `DSH-LAN-D`，并放行入站 TCP 3091（另需已有的 3081 规则）。
- 验证：

```bash
curl -s http://127.0.0.1:3091/health
curl -s http://127.0.0.1:3091/self
curl -s http://192.168.3.23:3091/status | head -c 500
```

### 3.5 当前四节点部署（2026-11-20 实测）

| 节点 | 角色 | 状态端口 | 台账/任务 | 实测 |
|---|---|---|---|---|
| dsh-a `.23:3081` | coordinator | `:3091` | `~/.dsh-lan-scheduler/state.json` | `/health` 200，`/status` 聚合 4/4 |
| dsh-b `.23:3082` | agent | `:3092` | 本机独立台账 | `/health` 200，`/self` 200 |
| dsh-c `.21:3081` | agent | `:3091` | 本机独立台账 | `/health` 200，`/self` 200 |
| dsh-d `.24:3081` | agent | `:3091` | 本机独立台账 | `/health` 200，防火墙 3091 已放行 |

- 浏览器入口：`http://192.168.3.23:3091/`（A 的 `/status` 聚合页）。
- 实测：从 Windows 控制端四节点 `/health` 全 200；A `/status?refresh=1` 返回 `online=4/4`，`sessions=2`（活会话），HTML 200（8783 bytes）。
- B 与 A 同机，必须用 **3092** 区分；C/D 在各自机器上用 3091。

## 4. 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `instanceId` | `dsh` | 节点唯一 id；协调者的 `nodes` 用它匹配本地 self |
| `label` | `instanceId` | 面板显示名 |
| `role` | `agent` | `coordinator` 才提供 `/status` 与 `/` 面板 |
| `host` | `0.0.0.0` | 监听地址；只给本机看可改 `127.0.0.1` |
| `port` | `3091` | 面板/agent 端口 |
| `origin` | `''` | 该节点 DSH web 入口（含端口，不含 token） |
| `agentUrl` | `''` | 该节点本插件地址（协调者用它拼 `/self`） |
| `dshVersion` | `''` | 展示用；不探测，避免额外依赖 |
| `schedulerStateFile` | `''` | 仅协调者读；缺省不读任务 |
| `requestTimeoutMs` | `2500` | 聚合时单节点 `/self` 超时 |
| `cacheTtlMs` | `2000` | `/status` 聚合缓存；`?refresh=1` 绕过 |
| `nodes` | 内置 A/B/C/D | 仅协调者用；显式列出可避免部署地址漂移 |

## 5. HTTP 接口

| 方法 | 路径 | 角色 | 返回 |
|---|---|---|---|
| GET | `/health` | 全部 | `{ok, instanceId, role, pid, uptimeSec}` |
| GET | `/self` | 全部 | 节点属性、会话、任务（仅协调者有任务） |
| GET | `/status` | 仅协调者 | 聚合节点/会话/任务；agent 返回 404 `not-coordinator` |
| GET | `/` | 协调者 | 独立 HTML 面板；agent 返回一行文本说明 |
| GET | `/status?refresh=1` | 协调者 | 跳过 2s 缓存 |

只允许 `GET/HEAD`；其他方法 405。所有响应 `cache-control: no-store`，并带 `access-control-allow-origin: *`（只读、无凭据，供本机/局域网页面读取）。

## 6. 安全边界

- **只读**：没有修改 DSH 状态、没有写文件、没有工具注册。
- **无凭据**：不读取 `DSH_INTERCONNECT_TOKEN`、provider key、launch token；`origin` 只是 base URL，打开仍需该节点 token。
- **无认证**：面板本身不做登录；只应监听可信 LAN，不能暴露公网。若要跨网段，用防火墙白名单或反向代理加认证。
- **不读正文**：只展示会话标题/状态/cwd，不读消息内容。
- **任务摘要**：任务标题、结果 summary、lastError 来自协调者台账，可能含业务信息；台账本身应按 600/ACL 保护。

## 7. 本地验证

```bash
node --check lib/status.js lib/server.js lib/index.js
node --test tests/*.test.mjs
```

当前：9/9 pass。测试覆盖任务行/会话行、协调者 vs agent、离线节点聚合、HTTP 路由、HTML 自包含。

## 8. 已知限制

- 会话列表依赖 `ctx.agents.list()` 的运行时形状；若宿主版本改动字段，面板会降级为空列表/无标题，不会崩溃。
- 只展示**当前**会话与协调者台账的最近 12 条终态；没有历史数据库。
- 任务数据只来自 dsh-a 的台账；B/C/D 自己的调度台账不聚合（它们不是 active coordinator）。
- 面板 5 秒刷新，聚合缓存 2 秒；没有 WebSocket/SSE。
- `origin` 的 token 不拼接；点开入口仍需手工用该节点的 launch URL。

## 9. 文件地图

- `lib/status.js` — 纯数据构建（节点/会话/任务/HTML）。
- `lib/server.js` — `node:http` 路由、缓存、超时与错误处理。
- `lib/index.js` — DSH 插件入口：`inject=['agents']`，`ctx.effect` 管理 server 生命周期。
- `tests/status.test.mjs` — 纯函数测试。
- `tests/server.test.mjs` — 真实 HTTP 路由测试（端口 0）。
- `docs/00-立项报告.md` — 目标/非目标、架构、数据契约、验收。
