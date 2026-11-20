# 02 · lan-status 可观测性与安全评审（v2 方案）

- 文档性质：评审 / 方案，不改代码；所有“建议”均与“已核验事实”分开标注。
- 评审对象：`D:\Codes\DSH小插件\plugin-lan-status` 0.1.0（四节点已部署）。
- 环境：DSH **0.2.2-rc.3**、Node **v24.22.3**；dsh-a `192.168.3.23:3081`（面板 3091，coordinator）、dsh-b `192.168.3.23:3082`（面板 3092）、dsh-c `192.168.3.21:3081`（面板 3091）、dsh-d `192.168.3.24:3081`（面板 3091）。
- 日期：2026-11-20。
- 相关文档：`README.md`、`AGENTS.md`、`docs/00-立项报告.md`。

---

## 0. 结论先行

1. **点击进入能做，但必须“先认证面板、再开代登录口”**。推荐方案是 **P1 节点本地 broker**：面板认证后，目标节点在服务端用 `ctx.connection.authenticatedUrl(origin)` 换一次性的带 token URL，服务端完成 `GET /` 的 cookie 交换，只把 DSH 的 `HttpOnly` 会话 cookie 回传给浏览器；launch token 不出节点进程、不进浏览器地址栏、不进日志。
2. **未认证的面板 + `/enter` = 整个 LAN 的 DSH 登录代发口**。当前面板无认证（`lib/server.js:18-45` 连 CORS 都是 `*`）。因此 **P0 只显示 base URL 与提示，不提供“点击即登录”**；P1 先补面板认证与节点间认证，再启用 broker。这是本文最重要的安全结论。
3. **不采用**：手动粘贴 token、SSH 隧道（用户明确不用）、把 `GET /connect?token=` 当 UI 入口、把 `authenticatedUrl()` 结果直接 `302` 给浏览器、把 token 写进 HTML/配置/日志。
4. **必须补的指标**：系统 CPU/内存/磁盘/负载、进程 RSS/CPU、DSH Web 可达性与 401/403 状态、会话数/明细、调度任务计数与台账新鲜度、interconnect peer link、每节点延迟/数据年龄/stale、节点身份与版本。现有 `/self` 只有 identity + 会话 + 任务，没有任何资源指标。
5. **历史趋势不落盘**：本插件定位是只读面板，不引入 DB、不写节点磁盘；P2 可做内存环形缓冲（重启即丢），不作为审计依据。
6. **最大风险**：无认证的 `/enter` 会把“能打开面板”降级为“能登录任意节点 DSH”；其次是 `dsh web` 默认把带 token 的 URL 打到 systemd/journal（`printUrl` 默认 true），token 可能已经进日志。

---

## 1. 现状核验（代码、源码与真机）

### 1.1 拓扑与数据流

| 节点 | DSH Web | 面板 | 角色 | 备注 |
|---|---|---|---|---|
| dsh-a | `http://192.168.3.23:3081` | `http://192.168.3.23:3091` | coordinator | 聚合 `/status`、出 HTML `/` |
| dsh-b | `http://192.168.3.23:3082` | `http://192.168.3.23:3092` | agent | 与 A 同机，端口必须错开 |
| dsh-c | `http://192.168.3.21:3081` | `http://192.168.3.21:3091` | agent | 跨机 |
| dsh-d | `http://192.168.3.24:3081` | `http://192.168.3.24:3091` | agent | 需防火墙放行 3091 |

数据流：浏览器 → A 的 `/`（HTML）→ 每 5 秒 `fetch('/status')` → A 并行 `GET 各节点 panelUrl + /self`（本节点直接复用本地 self，`lib/status.js:238-287`）→ A 汇总。`/self` 由每个节点的 `buildSelfStatus` 生成（`lib/status.js:147-173`），数据源为 `ctx.agents.list()`、A 的 `~/.dsh-lan-scheduler/state.json`、静态配置与 `node:os`。

### 1.2 已核验的实现事实

| 事实 | 证据 |
|---|---|
| 所有 JSON/文本响应都带 `cache-control: no-store` 与 `access-control-allow-origin: *` | `lib/server.js:18-45` |
| 配置默认 `host=0.0.0.0`、`port=3091`、`requestTimeoutMs=2500`、`cacheTtlMs=2000` | `lib/server.js:47-63` |
| 只缓存 `/status`；`/self` 每次现算 | `lib/server.js:79-86`、`:113-118` |
| `/status` 仅 coordinator，否则 404 `not-coordinator`；`?refresh=1` 清缓存 | `lib/server.js:120-132` |
| `/` 在 coordinator 出 HTML，在 agent 只出一行文本 | `lib/server.js:134-146` |
| 仅 GET/HEAD，其它 405；异常记 stack 并 500 | `lib/server.js:91-95`、`:149-153` |
| `/self` 的 node 字段：instanceId/label/role/origin/agentUrl/hostname/platform/arch/osRelease/nodeVersion/dshVersion/pid/uptimeSec/startedAt | `lib/status.js:147-173` |
| `/self` 的 sessions 来自 `ctx.agents.list()`，标题取 `sessionProjections`，缺失只丢标题 | `lib/status.js:107-141` |
| `/self` 的 tasks 来自 `state.tasks` 对象，running 全量、recent 终态最近 12 | `lib/status.js:60-99` |
| 聚合超时用 `requestTimeoutMs`；单节点失败置 `online:false,error`；顶层 `ok:true` | `lib/status.js:225-287` |
| HTML 内联 CSS/JS，5 秒轮询，`document.hidden` 暂停；入口链接直接 `href=n.origin` | `lib/status.js:301-461`、`:391-394`、`:458` |
| 无 CSP、无 `x-content-type-options`、无 `referrer-policy` | 真机响应头，见 1.3 |
| `agentUrl` 实际存的是**面板**地址（3091），不是 DSH agent 地址 | 四节点 `/self` 实测，见 1.3 |
| 启动失败只 `logger.error`，fiber 仍 active | `lib/index.js:38` 及 `server.start()` 调用处 |

### 1.3 真机探针（2026-11-20 22:54–22:55）

| 请求 | 结果 |
|---|---|
| `GET dsh-a:3091/self` | 200；`role=coordinator`；`origin=...:3081`；`agentUrl=...:3091`；`pid=20184`；`uptimeSec=1472`；`dshVersion=0.2.2-rc.3`；`sessions=[]`；`tasks={seq:40,total:14,running:[],recent:[...]}` |
| `GET dsh-b:3092/self` | 200；`origin=...:3082`；`agentUrl=...:3092`；`pid=20675`；`uptimeSec=1317`；tasks 空 |
| `GET dsh-c:3091/self` | 200；`origin=...:3081`；`agentUrl=...:3091`；`pid=16010`；`uptimeSec=1261`；hostname 同为 `OpenClawPotato`（不同机） |
| `GET dsh-d:3091/self` | **超时**（本次复核 D 离线） |
| `GET dsh-a:3091/status` | 200；10765 bytes；`summary={nodes:4,online:3,offline:1,sessions:0,runningTasks:0}`；D `online:false,error:"timeout",latencyMs:2500`；**总耗时 2561ms** |
| `GET dsh-a:3091/` | 200；8783 bytes；无 CSP、无 `x-content-type-options`、无 `referrer-policy` |

**实测结论**：部分失败已经可用（200 + `online:false`），但单个离线节点就把每次聚合拖到 2.5s，而 HTML 每 5s 轮询——一半时间在等超时；`/self` 无缓存；CORS 通配；无安全头。这些是第 3、5 节方案的直接依据。

### 1.4 关键缺陷/风险清单

| 级别 | 问题 | 影响 |
|---|---|---|
| P0 | `access-control-allow-origin: *` + 无认证 | 任意网页可跨站读取 LAN 面板 JSON（Drive-by 信息泄漏）；任务标题/摘要/cwd 可能含业务信息 |
| P0 | 无 CSP / 无 `frame-ancestors` | XSS 缓解缺失；面板可被 clickjacking 嵌入 |
| P0 | 无认证 | 任何 LAN 客户端可读全部节点元数据与任务摘要 |
| P1 | `/enter` 方案若先于面板认证上线 | 变成任意人可用的 DSH 登录代发口（见 4.3） |
| P1 | `dsh web` 默认打印 tokenized URL | token 可能进 systemd journal / 计划任务日志 / 终端历史 |
| P1 | 聚合超时 2500ms、无 stale/熔断/单飞 | 离线节点拖慢面板；多标签页放大请求；D 离线时 `/status` 2.5s |
| P1 | `agentUrl` 命名误导 | 实际是面板地址；运维改配置时容易把 DSH Web 端口填进去 |
| P1 | fetch 默认跟随重定向 | 节点 `/self` 若被劫持返回 302，A 会跟随到任意 URL（SSRF 面，当前配置固定、风险低） |
| P2 | 无历史、无 WS/SSE | 只能看瞬时；刷新 5s；不影响正确性 |
| P2 | 无节点身份/版本/资源指标 | “信息更细”无法满足 |

---

## 2. 数据契约 v2

### 2.1 设计原则

1. **加法兼容**：v1 的 `sessions` 是数组、`tasks` 是 `{seq,total,running,recent}`，v2 不改形状，只加字段；旧消费者不破。
2. **未知用 `null`，不用 0/空字符串冒充**：Windows 无 loadavg → `null`；首次 CPU 采样 → `null`；采集失败 → `null` + `errors[]`。
3. **每个数据块带自己的时间与来源**：`generatedAt` 是采集时间，`servedAt` 是响应时间；聚合节点另加 `receivedAt/ageMs/stale`。
4. **有界**：sessions ≤ 50、running ≤ 50、recent ≤ 20、errors ≤ 10、字符串截断；单响应 ≤ 64KB（超过置 `truncated:true`）。
5. **绝不包含 secret**：不输出 launch token、cookie、ticket、`authenticatedUrl()` 结果、DSH 凭据文件内容、完整 prompt/消息正文。
6. **平台差异显式化**：无 loadavg 就是 `null`，不伪造 0；磁盘按路径数组。

### 2.2 `GET /self` v2 示例

```json
{
  "schemaVersion": 2,
  "ok": true,
  "generatedAt": "2026-11-20T14:58:00.120Z",
  "servedAt": "2026-11-20T14:58:00.132Z",
  "node": {
    "instanceId": "dsh-a",
    "label": "dsh-a",
    "role": "coordinator",
    "hostname": "OpenClawPotato",
    "platform": "linux",
    "arch": "x64",
    "osRelease": "#142-Ubuntu SMP PREEMPT_DYNAMIC Wed Sep 2 14:24:27 UTC 2026",
    "osVersion": "Linux 6.8.0-xx-generic",
    "nodeVersion": "v24.22.3",
    "dshVersion": "0.2.2-rc.3",
    "pid": 20184,
    "uptimeSec": 1472,
    "startedAt": "2026-11-20T14:30:06.127Z",
    "startedAtSource": "process",
    "origin": "http://192.168.3.23:3081",
    "panelUrl": "http://192.168.3.23:3091",
    "agentUrl": "http://192.168.3.23:3091",
    "web": {
      "origin": "http://192.168.3.23:3081",
      "authority": "192.168.3.23:3081",
      "reachable": true,
      "status": 401,
      "auth": "token-required",
      "latencyMs": 2,
      "checkedAt": "2026-11-20T14:57:45.000Z",
      "error": null
    }
  },
  "process": {
    "pid": 20184,
    "uptimeSec": 1472,
    "startedAt": "2026-11-20T14:30:06.127Z",
    "rssBytes": 182345678,
    "heapUsedBytes": 45678901,
    "heapTotalBytes": 56789012,
    "externalBytes": 1234567,
    "cpuPct": 3.2,
    "cpuSeconds": 123.4
  },
  "system": {
    "uptimeSec": 187790,
    "cpu": {
      "model": "x86_64",
      "count": 16,
      "speedMHz": 2400,
      "usagePct": 12.5,
      "loadavg": [0.42, 0.31, 0.28],
      "loadPerCore": [0.026, 0.019, 0.018]
    },
    "memory": {
      "totalBytes": 16890716160,
      "freeBytes": 3787456512,
      "availableBytes": 8000000000,
      "usedPct": 52.6
    },
    "disks": [
      {
        "path": "/",
        "totalBytes": 105689907200,
        "freeBytes": 40265318400,
        "availableBytes": 39000000000,
        "usedPct": 63.1
      }
    ]
  },
  "sessions": [
    {
      "sessionId": "ses_xxx",
      "title": "LAN scheduler e2e",
      "titleTruncated": false,
      "status": "running",
      "cwd": "/home/user/project"
    }
  ],
  "sessionsMeta": {
    "source": "agents.list",
    "count": 1,
    "returned": 1,
    "truncated": false,
    "collectedAt": "2026-11-20T14:58:00.120Z"
  },
  "tasks": {
    "source": {
      "kind": "scheduler-state",
      "available": true,
      "file": "~/.dsh-lan-scheduler/state.json",
      "mtime": "2026-11-20T14:57:58.000Z",
      "ageMs": 2120,
      "parseOk": true,
      "error": null
    },
    "seq": 40,
    "total": 14,
    "counts": {
      "queued": 0,
      "dispatching": 0,
      "running": 0,
      "succeeded": 12,
      "failed": 1,
      "cancelled": 1,
      "other": 0
    },
    "running": [],
    "recent": []
  },
  "interconnect": {
    "available": true,
    "instanceId": "dsh-a",
    "peers": [
      {
        "instanceId": "dsh-b",
        "origin": "http://192.168.3.23:3082",
        "link": "up",
        "kind": "peer",
        "lastError": null
      }
    ],
    "counts": { "configured": 3, "up": 3, "down": 0 },
    "checkedAt": "2026-11-20T14:58:00.120Z",
    "error": null
  },
  "collection": {
    "startedAt": "2026-11-20T14:58:00.110Z",
    "tookMs": 7,
    "cached": false,
    "cacheAgeMs": 0,
    "collectorVersion": "0.2.0",
    "errors": [{ "scope": "disk:/data", "message": "EACCES" }],
    "degraded": ["disk:/data"]
  }
}
```

**字段约束说明**：

- `node.panelUrl` 是面板地址；`node.agentUrl` 保留为**兼容别名**，两者同值；文档/UI 不再把 `agentUrl` 叫“agent 地址”。
- `startedAtSource`：`process`（由 `Date.now() - process.uptime()*1000` 推算）或 `plugin`（插件 apply 时间）；v1 的 `startedAt` 语义模糊，v2 明确。
- `web.status`：探测 `GET origin/` 的 HTTP 状态；`401` 表示“需要 launch token”，这是**正常态**；`200` 表示无认证可进；`403` 表示 Host/Origin 栅栏拒绝（检查 trustedHosts）；`null` 表示未探测/不可达。
- `web.auth`：`token-required | open | rejected | unreachable | unknown`，仅用于展示，不代表已认证。
- `process.cpuPct`：两次 `process.cpuUsage()` 差 / 墙钟差 × 100，**可超过 100**（多核）；UI 显示为 `123% (1.2 core)`，不要截成 100。
- `system.cpu.usagePct`：`os.cpus()` 的 `times` 差分，0–100；首次采样为 `null`。
- `system.cpu.loadavg`：Windows 为 `null`；Linux 为 1/5/15 分钟负载；`loadPerCore` 同除核数。
- `system.memory.availableBytes`：Linux 优先读 `/proc/meminfo` 的 `MemAvailable`，失败回退 `os.freemem()`；Windows 用 `os.freemem()`。`usedPct = (total - available) / total × 100`。
- `disks[].usedPct = (total - available) / total × 100`；`availableBytes` 取 `statfs.bavail * bsize`，`freeBytes` 取 `bfree * bsize`；路径只来自配置，不接受远程输入。
- `tasks.source.file` 把 `$HOME` 替换为 `~`；不输出完整家目录。agent 节点不读台账：`source.kind="not-coordinator"`、`available:false`、`counts` 全 0。
- `interconnect.available=false` 表示 `ctx.get('interconnect')` 不存在；不要伪造 peers。只输出 `peers()` 的 `{instanceId,origin,link,kind,lastError}`，不输出 token 状态值或 hints。
- `collection.errors` 只放**本节点采集**错误；远端错误由 `/status` 的节点对象承载。

### 2.3 `GET /status` v2 示例

```json
{
  "schemaVersion": 2,
  "ok": true,
  "generatedAt": "2026-11-20T14:58:03.000Z",
  "servedAt": "2026-11-20T14:58:03.010Z",
  "partial": true,
  "summary": {
    "nodes": 4,
    "online": 3,
    "offline": 1,
    "stale": 0,
    "sessions": 0,
    "runningTasks": 0,
    "alerts": 1
  },
  "collection": {
    "startedAt": "2026-11-20T14:58:00.500Z",
    "tookMs": 2561,
    "cache": { "hit": false, "ageMs": 0, "ttlMs": 2000 },
    "counts": { "nodes": 4, "online": 3, "offline": 1, "stale": 0, "degraded": 1 },
    "errors": []
  },
  "nodes": [
    {
      "instanceId": "dsh-a",
      "label": "dsh-a",
      "role": "coordinator",
      "origin": "http://192.168.3.23:3081",
      "panelUrl": "http://192.168.3.23:3091",
      "agentUrl": "http://192.168.3.23:3091",
      "online": true,
      "latencyMs": 0,
      "receivedAt": "2026-11-20T14:58:03.000Z",
      "dataAsOf": "2026-11-20T14:58:03.000Z",
      "ageMs": 0,
      "stale": false,
      "partial": false,
      "error": null,
      "system": { "...": "同 /self" },
      "process": { "...": "同 /self" },
      "sessions": [],
      "sessionsMeta": { "count": 0, "returned": 0, "truncated": false },
      "tasks": { "...": "同 /self" },
      "web": { "...": "同 /self" },
      "interconnect": { "...": "同 /self" }
    },
    {
      "instanceId": "dsh-d",
      "label": "dsh-d",
      "role": "agent",
      "origin": "http://192.168.3.24:3081",
      "panelUrl": "http://192.168.3.24:3091",
      "agentUrl": "http://192.168.3.24:3091",
      "online": false,
      "latencyMs": 1200,
      "receivedAt": "2026-11-20T14:58:03.000Z",
      "dataAsOf": null,
      "ageMs": null,
      "stale": false,
      "partial": true,
      "error": "timeout",
      "errorCode": "ETIMEDOUT",
      "system": null,
      "process": null,
      "sessions": [],
      "tasks": null,
      "web": null,
      "interconnect": null
    }
  ],
  "sessions": [],
  "tasks": {
    "running": [],
    "recent": [],
    "counts": { "queued": 0, "running": 0, "succeeded": 12, "failed": 1, "cancelled": 1, "other": 0 }
  },
  "alerts": [
    {
      "level": "critical",
      "nodeId": "dsh-d",
      "code": "offline",
      "metric": "node.online",
      "value": false,
      "threshold": "3 consecutive failures",
      "message": "dsh-d 连续 3 次采集失败：timeout"
    }
  ]
}
```

**兼容性规则**：

| v1 字段 | v2 处理 |
|---|---|
| `node.agentUrl` | 保留，语义纠正为 panel URL；同时新增 `panelUrl` |
| `sessions`（数组） | 形状不变；新增 `sessionsMeta` |
| `tasks`（`{seq,total,running,recent}`） | 形状不变；新增 `counts`、`source` |
| `nodes[].online/latencyMs/error` | 保留；新增 `receivedAt/ageMs/stale/errorCode/dataAsOf` |
| 顶层 `summary` | 保留四键，新增 `stale/alerts` |
| `ok` | 部分失败仍 `true`；新增 `partial` 表达完整性 |
| 新增 | `schemaVersion`、`node.web`、`process`、`system`、`interconnect`、`collection`、`alerts` |

### 2.4 字段可采性/成本/刷新表

| 数据块 | 字段 | 可采性 | 采集成本 | 刷新/缓存 | 失败处理 |
|---|---|---|---|---|---|
| 身份 | instanceId/label/role/hostname/platform/arch/osRelease/osVersion/nodeVersion/dshVersion/pid/uptime | `node:os` + config；`dshVersion` 目前仅 config | 极低（一次 `os.*`） | 30s 或启动时 | 缺省 `null`，不阻塞 |
| 进程 | rss/heap/external/cpuPct/cpuSeconds | `process.memoryUsage()` / `process.cpuUsage()` 差分 | 低（微秒级） | 5s；首次 CPU `null` | `cpuPct:null` + error |
| 系统 CPU | usagePct/loadavg/loadPerCore | `os.cpus()` 差分；`os.loadavg()` | 中（核数×times） | 5s | Windows loadavg `null` |
| 系统内存 | total/free/available/usedPct | `os.totalmem/freemem`；Linux `/proc/meminfo` | 低（Windows）；一次文件读（Linux） | 5s | 回退 free |
| 磁盘 | total/free/available/usedPct | `fs.statfsSync(path)`（Node 24 实测 Windows/Linux 可用） | 低（syscall） | 30s | 每路径独立 error |
| 会话 | sessionId/title/status/cwd | `ctx.agents.list()` + `sessionProjections.snapshot` | 中（agent 数量线性；投影可能较重） | 2s；≤50 条 | 投影失败只丢 title |
| 任务 | seq/total/counts/running/recent/source | 仅 coordinator 读 `state.json` | 中（整文件 JSON.parse；文件可能变大） | 2s + mtime/size 缓存 | 坏 JSON → `available:false` + error |
| interconnect | peers/link/counts | `ctx.get('interconnect')?.peers()` | 低 | 5s | 服务缺席 `available:false` |
| Web 可达性 | status/auth/latency | 本机 `GET origin/`，`redirect:'manual'` | 低（1 请求） | 30s | `unreachable`，不重试 |
| 聚合 | online/latency/age/stale | A 并行 fetch | 网络 | 2s 缓存；单节点 1200ms 超时 | 200 + `online:false` |

**采样实现建议**：

- CPU 差分需要模块级上次采样（`prevCpus`、`prevProcessCpu`、`prevAt`）；首次返回 `null`，不返回 0。
- 磁盘路径配置 `diskPaths`；默认 Linux `["/"]`、Windows `[path.parse(process.cwd()).root]`；每路径 30s 缓存。
- 台账按 `mtimeMs + size` 缓存，文件 >5MB 拒绝解析并 `degraded`；不要每次 `/self` 都 `readFileSync`。
- `web` 探针不要发送 cookie、不要跟随重定向、不要读 body；只取状态码与耗时。
- 所有时间戳用 ISO 8601 UTC；聚合节点用**本地时钟**计算 `ageMs`，远程时钟偏移只影响 `generatedAt` 展示，不参与 stale 判定；若 `|remote - local| > 5s` 加 `clockSkewSuspected:true`。

### 2.5 部分失败与状态语义

| 状态 | 条件 | 表现 |
|---|---|---|
| `online` | 本次抓取成功且 `ageMs ≤ staleAfterMs`（默认 30s） | 正常数据 |
| `stale` | 最近一次成功在 30s–5min 内，本次失败 | 保留上次数据，`online:false, stale:true, dataAsOf` 有值 |
| `offline` | 从未成功或上次成功 >5min，或连续 3 次失败 | `online:false, stale:false, dataAsOf:null`，只保留配置元数据 |
| `degraded` | 节点自身 `collection.degraded` 非空 | `online:true`，`partial:true`，`alerts` 有条目 |
| `partial`（顶层） | 任一节点非 online 或 degraded | `ok:true`，`partial:true`；HTTP 仍 200 |

**不要**因为一个节点离线返回 500；HTML 要能显示“3/4 在线 + 最后更新时间 + 离线节点卡片”。

---

## 3. 可观测性设计

### 3.1 每节点指标清单

| 类别 | 指标 | 用途 |
|---|---|---|
| 存活 | `/health` 200、`pid`、`uptimeSec` | 区分“进程挂了”与“网络不通” |
| 身份 | instanceId/label/role/hostname/platform/arch | 面板分组、去重、平台差异提示 |
| 版本 | DSH 版本、Node 版本、osRelease | 漂移检测（四节点应一致） |
| 资源 | CPU%、load/core、内存 used%、磁盘 used%、进程 RSS/CPU | 判断“面板慢”是网络还是节点过载 |
| 会话 | 活会话数、明细、标题截断 | 回答“这个节点现在在干什么” |
| 调度 | queued/running/succeeded/failed/cancelled 计数、台账 mtime/age、解析状态 | 回答“队列堵没堵、台账新不新” |
| 互联 | interconnect peers up/down、lastError | 区分“DSH 挂了”与“节点间链路挂了” |
| 人机界面 | web origin、401/403/200、延迟、最后探测时间 | “连接”列 + 点击进入的前置信息 |
| 新鲜度 | `generatedAt/receivedAt/ageMs/stale/latencyMs` | 防止把旧数据当实时 |
| 自身 | `collection.tookMs/cached/errors` | 面板自身健康 |

### 3.2 面板自身开销预算

| 项 | 目标 | 说明 |
|---|---|---|
| A 进程额外 CPU | < 1%（4 节点、5s 轮询） | 4 节点 × 12 次/分 = 48 请求/分，网络与 JSON 解析为主 |
| A 进程额外 RSS | < 5MB | 缓存 4 份 self + 最近一次聚合；不做历史 |
| 单次 `/status` | P95 < 800ms（全部在线）；P99 < 2s（含离线） | 超时 1200ms/节点、总 deadline 2500ms |
| 单次 `/self` | P95 < 50ms | 资源采样缓存；台账 mtime 缓存 |
| 浏览器轮询 | 5s；页面隐藏暂停；连续失败退避到 30s | 现有 `document.hidden` 逻辑保留 |
| 响应大小 | `/self` ≤ 16KB；`/status` ≤ 64KB（4 节点） | 超限截断 sessions/recent，置 `truncated` |

**避免面板拖垮节点**：

- 不在 `/self` 里做重活：不扫目录、不读 prompt/消息正文、不跑子进程、不调用 LLM。
- `ctx.agents.list()` 只读内存；`sessionProjections.snapshot` 按 agent 逐个取，限制 50 条；超过只计数。
- 台账只读 coordinator，agents 不读；读取按 mtime/size 缓存，坏文件不反复 parse。
- 磁盘/内存等系统采样按 TTL 缓存；CPU 差分只保留上一次样本，不做时间序列。
- A 对远端 `/self` 用 **单飞 + 并发上限**（建议 8），避免多个浏览器标签放大；`/status` 2s 缓存保留，但缓存键要含 `refresh` 语义。
- 面板 HTML 不做自动播放/大图/第三方字体；内联 CSS/JS，零外部依赖。

### 3.3 历史趋势：建议不持久化（明确）

**结论：v2 不做历史库。** 理由：

1. 本插件定位只读、无凭据、零写盘；引入 SQLite/JSONL 会带来磁盘增长、清理、备份、损坏恢复与隐私留存问题。
2. 任务标题/摘要/cwd 已可能含业务信息，历史化会放大泄漏面与保留期风险。
3. 调度层已有 append-only journal（`plugin-lan-scheduler`），审计应看那边；状态面板不做第二份台账。
4. 资源趋势的价值低于成本；4 节点规模用当前值 + 阈值足够。

**P2 可选**：内存环形缓冲（每节点 60 点 × 5s ≈ 5 分钟），只存 CPU/内存/磁盘/延迟，重启即丢；用于 sparkline，不作为告警/审计依据。若要做，必须给 `maxPoints`、`maxNodes` 上限，且不落盘。

### 3.4 告警阈值（只做面板视觉，不做通知）

| 指标 | warn | critical | 持续 | 说明 |
|---|---|---|---|---|
| 节点在线 | 1 次失败 | 连续 3 次失败 / 5min 无成功 | 3 次采样 | 离线卡片 + 最后成功时间 |
| 采集延迟 | > 500ms | > 1500ms | 3 次 | 与节点离线区分 |
| 数据年龄 | > 30s | > 5min | 即时 | `stale` 标记 |
| CPU used | > 80% | > 95% | 3 次采样 | 系统级；进程 CPU 单独显示 |
| 内存 used | > 85% | > 95% | 3 次采样 | 用 available 计算 |
| 磁盘 used | > 85% | > 95% | 每路径 | 按 `disks[]` 逐项 |
| load/core | > 1.5 | > 2.5 | 3 次采样 | 仅 Linux；Windows 不显示 |
| 进程 RSS | > 1GB | > 2GB | 3 次采样 | 可配置；DSH 大内存属正常时调高 |
| 台账年龄 | > 60s | > 5min | 即时 | coordinator 专用；agent 不适用 |
| running 任务 | > 0 且最老 > 30min | > 0 且最老 > 2h | 即时 | 防止卡死任务 |
| interconnect down | 任一 peer down | 全部 down | 3 次采样 | 需要 `available:true` |
| Web 探测 | 403 或不可达 | 连续 3 次不可达 | 3 次 | 401 是正常态，不告警 |
| 版本漂移 | 任一节点 DSH/Node 与 A 不同 | — | 启动/30s | 只提示，不阻断 |

**告警不做**：不发邮件/webhook/IM；不自动重启/摘流；不写 DSH 状态。面板只显示颜色、徽标、`alerts[]`。需要通知时 P2 接外部监控，不放进本插件。

---

## 4. 安全评审与“点击进入”方案

### 4.1 资产与威胁模型

| 资产 | 位置 | 泄漏后果 |
|---|---|---|
| 面板 JSON/HTML | A:3091（LAN 明文） | 节点拓扑、会话标题、任务摘要、cwd、资源信息 |
| DSH Web UI | 各节点 :3081/3082 | 完全控制该 DSH 实例（会话、工具、文件） |
| launch token | 各 DSH 进程内存；启动时打印 | 可换 DSH 会话 cookie；进程重启才轮换 |
| DSH 会话 cookie | 浏览器 | 30 天有效、HttpOnly、SameSite=Strict；无 logout |
| 面板入口 ticket | 浏览器 URL/网络 | 30s 内可换一次 DSH cookie |
| 入口签名密钥 | 节点 env / 600/ACL 文件 | 可伪造 ticket；必须可轮换 |

**威胁**：LAN 内任意主机/被攻陷的办公机；用户浏览的恶意网页（CORS `*` 可直接读面板）；clickjacking；日志/历史泄漏 token；CSRF 触发 `/enter`；SSRF 借 A 打内网；DoS 拖慢 A。

### 4.2 当前无认证面板的风险（必须先处理）

1. **跨站读取**：`access-control-allow-origin: *` 允许任意网页 `fetch('http://192.168.3.23:3091/status')` 并读 JSON。即使没有 CORS，攻击者也可诱导用户直接访问（信息展示），但 `*` 让**静默 exfiltration** 成为可能。
2. **任务内容泄漏**：`taskRow` 带 `title/summary/lastError`（截断 240），可能含业务信息；`cwd` 暴露目录结构。
3. **clickjacking**：无 `frame-ancestors`，可被嵌入透明 iframe 诱导点击（未来 `/enter` 更危险）。
4. **无审计**：谁看过、谁点过 `/enter` 都没有记录；至少要有访问日志（脱敏）与失败计数。

**最小修复（P0）**：去掉默认 `ACAO:*`（同源 HTML 不需要 CORS；外部消费者用 `allowedOrigins` 白名单）；加 `CSP`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`frame-ancestors 'none'`；`/status` 限流；日志不记 query。

### 4.3 点击进入：5 种方案对比

| # | 方案 | 做法 | token 去向 | 安全 | 体验 | 成本 | 结论 |
|---|---|---|---|---|---|---|---|
| A | base URL + 提示 | 面板只显示 `origin`，点击新开；提示“需该节点 launch token，使用启动 URL/书签” | 用户自己的启动 URL/书签；面板不接触 | 高（不新增泄漏面） | 差（大概率 401） | 0 | **P0 采用** |
| B | 节点本地 broker | 面板认证后，目标节点服务端 `authenticatedUrl()` → 服务端 `GET /` 换 cookie → 回传 `Set-Cookie` | 只在目标节点进程内存；浏览器只拿 HttpOnly cookie | 中高（依赖面板认证 + ticket + HTTPS 若 TLS） | 好（一次点击进 UI） | 中 | **P1 推荐** |
| C | 反向代理 + SSO + cookie 注入 | Nginx/OpenResty/NJS 做 TLS、SSO，服务端换 token 并注入 cookie | 代理进程内存 | 高（TLS+SSO，零信任可用） | 最好 | 高（代理配置、WS、cookie Path、trustedHosts） | **P2** |
| D | 用户手动粘贴 token | 输入框收 token，前端拼 `?token=` | 进 DOM、history、可能日志 | 低 | 差 | 低 | **拒绝** |
| E | SSH 隧道 | 本地端口转发到节点 | 仍需 token；隧道另有权限 | 中（取决于 SSH 管控） | 差 | 中 | **拒绝**（用户明确不用） |
| F | `/connect?token=` 当 UI 入口 | 直接跳 `/connect` | 进 URL | 低且语义错误（API-only，302 到 `./api/remote.mux`） | 不可用 | 低 | **拒绝** |

**为什么不选 D/E/F**：

- D：token 进浏览器地址栏/历史的瞬间就违反“token 不进前端”；XSS/截图/录屏都会带走。
- E：用户明确不用；且隧道不解决 token 本身，仍要分发/粘贴。
- F：源码核验 `/connect` 是 API 入口（`browser-auth.ts:314+`、`README.zh.md:51`），创建 owner Peer 并 302 到 `api/remote.mux`，不是浏览器 UI 登录；`interactions` 默认 `none`。

### 4.4 推荐方案 B：节点本地 broker（P1）

#### 4.4.1 前置条件（硬门槛）

**面板认证必须先于 broker 上线**。否则任何人访问 A 的 `/enter?node=c` 就能拿到 C 的 DSH cookie。建议顺序：

1. A 的 `/`、`/status` 加认证（HTTP Basic over TLS，或强随机口令 + LAN ACL）。
2. A→B/C/D 的 `/self` 加节点间认证（`X-Lan-Status-Token` 共享头，或 IP allowlist），避免任意 LAN 主机读元数据。
3. 目标节点 `/enter` 只接受**有效 ticket**（下面），不接受匿名。
4. 全部节点 `printUrl:false`，并清理已有 journal 中的旧 token（重启后旧 token 失效）。

#### 4.4.2 交互序列

```text
浏览器 ──(已登录面板, POST /enter?node=c, CSRF/同源校验)──> A:3091
A      ──(HMAC ticket: v1|dsh-c|exp|nonce, 30s)──> 303 Location: http://192.168.3.21:3091/enter?ticket=...
浏览器 ──(GET /enter?ticket=...)──> C:3091
C      ──(校验 ticket: HMAC/target/exp/nonce/时钟)──> ctx.connection.authenticatedUrl("http://192.168.3.21:3081")
C      ──(服务端 GET tokenizedUrl, redirect:'manual', Host=C authority)──> C:3081
C:3081 ──(303 + Set-Cookie: dsh-auth-...=...; HttpOnly; SameSite=Strict)──> C
C      ──(302 Location: http://192.168.3.21:3081/, 原样回传 Set-Cookie)──> 浏览器
浏览器 ──(GET /, 带 HttpOnly cookie)──> C:3081  → DSH UI
```

**关键点**：

- `authenticatedUrl(baseUrl)` 的源码语义是“把**本进程**的 fresh token 加到普通 Web URL 上”（`rpc.ts:268-273`，实现 `browser-auth.ts:244-248`）。它只能在**目标节点进程内**调用；A 不能替 C 生成。
- 服务端 `fetch(tokenizedUrl, { redirect: 'manual' })` 拿到 303 与 `Set-Cookie`；用 `response.headers.getSetCookie()` 逐条读取，**不要**用逗号切分（cookie 的 `Expires` 含逗号）。
- 只回传 `Set-Cookie`，**不**回传 `Location` 里的 token；最终 302 到干净的 `http://host:3081/`。浏览器历史/地址栏不出现 token。
- cookie 是 **host-only**（无 `Domain`）、`Path=/`、`HttpOnly`、`SameSite=Strict`、30 天；cookie 按 **host** 匹配、**忽略端口**，所以：
  - A/B 同机：B 的 broker 在 `.23:3092` 设 cookie，浏览器访问 `.23:3082` 会带上；可行。
  - C/D 跨机：必须由 C/D 自己的 broker 设 cookie；A 不能给 `.21`/`.24` 设 cookie。
- **HTTP/HTTPS 必须同 scheme**：DSH 监听器是 HTTPS 时 cookie 带 `Secure`，broker 面板也必须是 HTTPS（证书受信），否则浏览器不会在 HTTP 上接受 `Secure` cookie；HTTP cookie 也不能通过 TLS 监听器的 audience 校验（`README.zh.md:45`）。
- 当前四节点是 **HTTP LAN 直连**，方案 B 可用；若将来上 TLS，跳到方案 C 或先给面板也上 TLS。

#### 4.4.3 ticket 设计（防止“任意人让 A 代签”）

| 项 | 设计 |
|---|---|
| 格式 | `v1.<targetNodeId>.<expEpochSec>.<nonce>.<hmacBase64url>` |
| 签名 | HMAC-SHA256，密钥按目标节点分（`entrySecrets: {dsh-b: ..., dsh-c: ..., dsh-d: ...}`），不共享全局密钥；带 `kid` 便于轮换 |
| TTL | 30s；允许 ±5s 时钟偏移 |
| 绑定 | `targetNodeId` 必须等于校验节点；`nonce` 单次使用，校验节点缓存到过期（上限 4096，LRU） |
| 传输 | 仅 query（一次性、短命）；`Referrer-Policy: no-referrer`；访问日志**不记 query**；不写 DSH 日志 |
| 防 CSRF | A 的 `/enter` 用 POST + `Origin`/`Sec-Fetch-Site` 同源校验 + 面板会话的 CSRF token；拒绝跨站 |
| 限流 | `/enter` 每 IP 5 次/分；失败计数；连续失败临时封禁 |
| 轮换 | 密钥只从 env 或 600/ACL 文件读；轮换时新旧 `kid` 并存一个 TTL 窗口；绝不入库/入仓库 |

**注意**：ticket 只证明“A 在用户通过面板认证后同意代签”，**不能替代面板认证**；如果 A 的 `/enter` 匿名可调，ticket 毫无意义。

#### 4.4.4 broker 的失败模式

| 情况 | 行为 |
|---|---|
| `connection` 服务不存在 | `/enter` 501 `entry-unavailable`，UI 隐藏按钮；记录一次 error（不含 token） |
| `authenticatedUrl` 抛错 | 502 `entry-failed`；不显示内部错误细节 |
| DSH 返回 401/403 | 502 + `dsh-rejected`；提示检查 trustedHosts/Host |
| DSH 返回 200 但无 Set-Cookie | 502 + `no-session-cookie`；说明 DSH 版本/行为变化 |
| ticket 过期/重放/目标不符 | 401 `invalid-ticket`；不泄漏具体原因给浏览器（日志记 code） |
| 网络超时 | 504 `entry-timeout`；3s 超时 |
| 浏览器不接受 cookie | 302 到 `/` 后仍 401；提示“浏览器拒绝 cookie/HTTPS 不匹配” |

### 4.5 安全红线（必须写进代码评审清单）

1. 不把 `authenticatedUrl()` 的返回值写日志、写 HTML、写 JSON、写配置、写错误信息。
2. 不把 launch token 放进 URL 后 `302` 给浏览器；broker 只回传 `Set-Cookie`。
3. 不在前端保存/输入/拼接 token；不提供“粘贴 token”输入框。
4. 不设置 `Domain` cookie；不跨 host 共享 DSH cookie。
5. 不用 `NODE_TLS_REJECT_UNAUTHORIZED=0` 或全局关闭证书校验；自签证书用显式 CA。
6. 不把 `entrySecrets`/面板口令写进仓库、`cordis.patch.yml` 明文、README 示例；只 env 或 600/ACL 文件。
7. 访问日志不记 `token`/`ticket`/`cookie`；错误栈不回显 query。
8. `printUrl:false` 必须在四个节点生效；若 journal 已有旧 token，重启轮换并清理。
9. `/enter` 必须 POST + 同源校验 + 面板认证；`GET` 只用于目标节点带 ticket 的 exchange，且 ticket 单次。
10. 不把 `/connect` 当 UI；不把 `api/remote.mux` 暴露给浏览器当入口。

### 4.6 安全响应头建议

| 头 | 值 | 说明 |
|---|---|---|
| `Content-Security-Policy` | `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-<random>'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` | 内联脚本改 nonce；P0 可先 `'unsafe-inline'`，P1 收紧 |
| `X-Content-Type-Options` | `nosniff` | 防 MIME 嗅探 |
| `Referrer-Policy` | `no-referrer` | 防 ticket/token 经 Referer 外泄 |
| `X-Frame-Options` | `DENY` | 老浏览器兜底；与 `frame-ancestors` 并用 |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | 最小权限 |
| `Cache-Control` | `no-store` | 已有，保留 |
| `Strict-Transport-Security` | 仅 TLS 时 `max-age=31536000` | 上 TLS 后再加 |

### 4.7 隐私与日志

- 任务 `title/summary/lastError` 截断（120/240/240）保留；**不读** prompt、消息正文、工具入参/出参。
- `cwd` 可显示；若担心目录名泄漏，P2 提供 `maskCwd`（只显示 basename）。
- 访问日志：`ts method path(status) ip latency`，`path` 去掉 query；`/enter` 只记 `nodeId` 与结果码，不记 ticket。
- 保留期：面板不落盘；进程日志按 systemd/计划任务现有策略，建议 7 天；安全事件单独审计。

---

## 5. 性能与可靠性

### 5.1 N 节点聚合

| 项 | 建议 |
|---|---|
| 并发 | 远端请求并发上限 8；4 节点全并行；>8 节点分批 |
| 单节点超时 | **1200ms**（当前 2500ms 过大；D 离线时 2.5s 拖垮轮询） |
| 总 deadline | 2500ms；超时节点置 `timeout`，仍返回 200 |
| 缓存 | `/status` 2s（保留）；`/self` 1s；系统指标 5s；磁盘 30s；web 探针 30s |
| 单飞 | 同一时刻只允许一个聚合法；其余请求等同一个 Promise |
| 陈旧 | 每节点保留最近一次成功 self 5min；30s 后标 `stale`，5min 后清空 |
| 熔断 | 连续 3 次失败 → 30s 内不再请求（返回 offline + 上次数据/元数据）；成功 1 次复位 |
| 重试 | 请求内不重试；下一轮轮询自然重试；`?refresh=1` 也不得绕过熔断 |
| 去重 | 按 `instanceId` 去重；重复/空 ID 配置校验失败 |
| 递归 | agent 的 `/status` 仍 404；A 只抓 `/self`，不抓远端 `/status` |

### 5.2 失败矩阵

| 失败 | 判定 | 展示 | 是否影响其它节点 |
|---|---|---|---|
| 连接拒绝 | `ECONNREFUSED` | offline + 原因 | 否 |
| 超时 | `AbortError/TimeoutError` | offline + latency=timeout | 否 |
| DNS 失败 | `ENOTFOUND` | offline + 原因 | 否 |
| TLS 失败 | 证书/协议错误 | offline + `tls-error` | 否 |
| HTTP 5xx | 状态码 | offline + `http-500` | 否 |
| 非 JSON | content-type/parse | offline + `bad-json` | 否 |
| 字段缺失 | schema 校验 | online + `partial` + alerts | 否 |
| 重复 instanceId | 配置校验 | 启动即拒绝/标红 | 是（配置错误） |
| 时钟偏移 | `|remote-local|>5s` | 显示 `clockSkewSuspected` | 否 |
| A 自身异常 | try/catch | `/status` 200 + 自身节点 error；不 500 整页 | 是（面板自身） |

### 5.3 防 SSRF / 防重定向

- `agentUrl` 只来自静态配置；校验：`http:`/`https:`、无 userinfo、无 query/hash、host 非空；推荐 IP 字面量或固定主机名。
- `fetch(agentUrl + '/self', { redirect: 'error' })`；若必须跟随，校验最终 `response.url` 的 origin 与配置一致。
- 响应大小上限 512KB；`content-type` 必须含 `application/json`；超限/类型错直接失败。
- 不把远端返回的 URL 作为下一次 fetch 目标；`node.web.origin` 只用于**本机**探针，不用于聚合抓取。
- P2 可选：配置 `allowedCidrs`，只允许 RFC1918/链路本地；默认不启用，避免误伤。

### 5.4 CORS / 限流 / HTTP 加固

| 项 | 建议 |
|---|---|
| CORS | 默认**不发** `ACAO`；需要跨源时配置 `allowedOrigins`，回显精确 origin + `Vary: Origin`；禁止 `*` 与凭据同用 |
| 限流 | 每 IP 令牌桶：`/status` 12/min、`/self` 60/min、`/enter` 5/min、`/` 30/min；超限 429 + `Retry-After` |
| `?refresh=1` | 每 IP 1/s；且不清熔断 |
| 方法 | 仅 GET/HEAD；`/enter` 用 POST；其它 405 |
| 超时 | `server.requestTimeout=10000`、`headersTimeout=5000`、`keepAliveTimeout=65000` |
| 体积 | 请求体上限 16KB（`/enter` 只有表单）；无 body 的路由直接拒绝 |
| 绑定 | 默认 `0.0.0.0` 是 LAN 需求；若只本机看，改 `127.0.0.1`（但四节点聚合需要 LAN） |
| 防火墙 | 3091/3092 仅放行 LAN 网段；D 的 3091 已放行，别忘 B 的 3092 |

### 5.5 Windows / Linux 差异

| 项 | Linux | Windows |
|---|---|---|
| loadavg | `os.loadavg()` 有效 | 返回 `[0,0,0]`，**必须置 null** |
| 磁盘根 | `/`、挂载点 | `C:\`、`D:\`；`statfsSync` 可用（Node 24 实测） |
| 内存 available | `/proc/meminfo MemAvailable` 更准 | `os.freemem()` |
| 服务管理 | systemd user service（journal 会收 stdout） | 计划任务（stdout 可能进文件/事件） |
| token 日志风险 | `dsh web` 打印 URL → journal | 计划任务输出重定向 → 文件 |
| 路径 | `/`、`~` | `\`、盘符；展示统一 `/` 或平台原生 |
| 防火墙 | nftables/ufw | Windows Firewall 入站规则 |
| 信号/关闭 | SIGTERM | 无 SIGTERM；靠 DSH effect/进程退出 |
| Node | v24.22.3 | 同左（四节点应一致） |
| 容器 | cgroup 限制下 `os.totalmem` 可能看宿主 | 不适用；如容器化需注明 |

### 5.6 面板自身可观测性

`/health` 建议加：

```json
{
  "ok": true,
  "instanceId": "dsh-a",
  "role": "coordinator",
  "pid": 20184,
  "uptimeSec": 1472,
  "lastAggregateAt": "2026-11-20T14:58:03.000Z",
  "lastAggregateMs": 2561,
  "cacheAgeMs": 0,
  "nodesOnline": 3,
  "nodesTotal": 4
}
```

`/status.collection` 暴露 `tookMs/cache/errors`；不要新增独立 metrics 端口，避免再开一个攻击面。

---

## 6. 实施优先级与验收

### 6.1 P0（必须，1–2 天，先做）

| # | 内容 | 验收 |
|---|---|---|
| P0-1 | v2 加法 schema：`node.web`、`process`、`system`、`sessionsMeta`、`tasks.counts/source`、`interconnect`、`collection`、`summary.stale/alerts`、`schemaVersion` | 四节点 `/self` 均含字段；Windows/Linux 缺省为 `null`；v1 字段不破；单测/契约测试通过 |
| P0-2 | 资源采集：CPU 差分、内存 available、磁盘 statfs、loadavg（Win null）、进程 RSS/CPU | 真机四节点有数值；首次样本 null；无异常日志 |
| P0-3 | DSH Web 探测：每 30s `GET origin/`，记录 401/403/200/latency | A/B/C 显示 `token-required`；D 离线显示 `unreachable` |
| P0-4 | 聚合加固：单节点 1200ms、总 deadline 2.5s、单飞、stale 30s/5min、熔断 3 次 | D 离线时 `/status` < 2s；连续失败后 30s 不再打 D；恢复后自动 online |
| P0-5 | 安全头 + CORS：默认不发 `ACAO`；CSP/nosniff/referrer/frame-ancestors | 浏览器响应头齐全；跨源 `fetch` 读不到 JSON（默认）；同源 HTML 正常 |
| P0-6 | 配置校验与命名：`panelUrl` 新增、`agentUrl` 兼容；重复 instanceId/非法 URL 拒绝 | 错配置启动即报错；README 更新（P0 文档可后补） |
| P0-7 | UI：节点卡片显示 CPU/内存/磁盘/负载/延迟/年龄/Web 状态；离线/stale 徽标；5s 轮询 + 隐藏暂停 + 失败退避 | 4 节点截图；D 离线卡片可见；移动端不横向溢出 |
| P0-8 | 回归：现有 9/9 + 新增契约/聚合/安全头测试；不引入 token | `node --test` 全绿；grep 代码无 token 字段 |

**P0 明确不做**：`/enter`、任何 token 交换、历史库、TLS 终止、告警通知。

### 6.2 P1（应该，3–5 天，前置 P0）

| # | 内容 | 验收 |
|---|---|---|
| P1-1 | 面板认证：A 的 `/`、`/status` 加 Basic（HTTPS 或 LAN ACL）；节点间 `/self` 共享头/IP allowlist | 未认证 `/status` 401；错误口令 401；正确口令 200；日志无口令 |
| P1-2 | 目标节点 `/enter` broker：`ctx.connection.authenticatedUrl()` + 服务端 `GET /` + Set-Cookie 回传 | 点击进入 DSH UI；地址栏/history 无 `token=`；DevTools 只见最终 `http://host:3081/` |
| P1-3 | ticket：HMAC-SHA256、30s、单次 nonce、target 绑定、`kid` 轮换 | 过期/重放/错 target 均 401；日志无 ticket；跨节点 C/D 可用 |
| P1-4 | `/enter` POST + 同源/CSRF + 限流 5/min | 跨站 POST 被拒；超限 429 |
| P1-5 | token 卫生：四节点 `printUrl:false`；journal/日志巡检；错误路径不回显 token | `grep -R "token="` 日志为空（历史旧日志清理/轮换后）；重启旧 token 失效 |
| P1-6 | 失败模式与 UI：`entry-unavailable/failed/timeout` 提示；不显示内部错误 | 停 DSH/断网/删 ticket 三种场景有明确提示 |
| P1-7 | 四节点 E2E 矩阵 | A/B（同机）、A/C、A/D、C/D 全部可进；A 不能替 C 设 cookie 的负例被记录 |

**P1 硬门槛**：P1-1 未过，P1-2 不得上线。验收必须包含“匿名 `/enter` 返回 401”的负例。

### 6.3 P2（可选）

| # | 内容 | 说明 |
|---|---|---|
| P2-1 | 反向代理 TLS + SSO + cookie 注入 | 跨网/零信任；需处理 WebSocket、cookie Path、trustedHosts |
| P2-2 | 内存环形趋势（60 点，不落盘） | sparkline；重启即丢 |
| P2-3 | 告警通知（webhook/IM） | 独立监控，不放进本插件 |
| P2-4 | 多 coordinator / 层级聚合 | 当前只有 A；避免递归 |
| P2-5 | IPv6、gzip、event loop lag、mTLS | 按需 |
| P2-6 | 上游 DSH 提供“一次性浏览器会话”API | 替代 broker 的长期正解；先提 feature request |

### 6.4 验收总表（建议）

| 类别 | 用例 | 期望 |
|---|---|---|
| 契约 | v1 消费者读 v2 `/self` | 旧字段存在、类型不变 |
| 契约 | 四节点 `/self` schema | 必填字段齐全；未知 `null` |
| 聚合 | D 离线 | 200，online 3/4，<2s，D 卡片 offline |
| 聚合 | 两节点离线 | 200，online 2/4，<2.5s |
| 聚合 | 恢复 | 下一轮自动 online，熔断复位 |
| 资源 | Windows loadavg | `null`，UI 不显示 0 |
| 安全 | 跨源 fetch | 默认被 CORS 拒 |
| 安全 | 匿名 `/status`（P1） | 401 |
| 进入 | P1 broker | 无 token 入浏览器；cookie HttpOnly |
| 进入 | ticket 重放 | 401；日志无 ticket |
| 进入 | DSH 重启 | 旧 cookie/ticket 失效；新流程成功 |
| 日志 | `grep token=` | 无 |
| 兼容 | B 同机 3092 | A/B 均可进；不串端口 |
| 浏览器 | Edge/Chrome/Firefox | 布局/刷新/cookie 正常 |

---

## 7. 开放问题（需要用户/lead 决策）

1. **面板认证方式**：Basic over TLS / 单一口令 cookie / 现有 SSO？没有 TLS 时 Basic 口令明文过 LAN，是否接受（当前 LAN 明文）？
2. **谁可以点“进入”**：所有能看面板的人，还是仅管理员？是否需要按节点授权？
3. **是否接受 broker 的风险**：P1 的信任边界是“面板认证 + ticket + LAN”；若要求零信任，直接走 P2 代理，不做 broker。
4. **DSH 是否上 TLS**：上 TLS 后 broker 面板也必须 TLS；否则只能 P2 代理。当前四节点 HTTP。
5. **`/self` 是否加认证**：A 聚合需要凭据；IP allowlist 还是共享头？共享头放哪（env/600）？
6. **`printUrl` 是否已在四节点关闭**：需逐个检查 systemd unit/计划任务；若未关，token 可能已在 journal。
7. **历史趋势**：确认“不落盘”是否满足需求；若不满足，P2 内存环形还是外部 Prometheus？
8. **D 当前离线**：是计划内还是故障？验收前需恢复，否则 P0 的“4/4”只能以 3/4 验收。
9. **`agentUrl` 改名**：是否有外部脚本依赖；建议保留别名并文档标注 deprecated。

---

## 8. 附录

### 8.1 证据索引

| 主题 | 路径 | 关键行 |
|---|---|---|
| 面板路由/头/缓存 | `plugin-lan-status/lib/server.js` | 18-45、47-63、79-86、113-132、134-146、160-178 |
| 数据构建/聚合/HTML | `plugin-lan-status/lib/status.js` | 60-99、107-141、147-173、238-287、301-461、391-394、458 |
| 入口 | `plugin-lan-status/lib/index.js` | 全文 38 行 |
| v1 契约/安全/验收 | `plugin-lan-status/docs/00-立项报告.md` | 全文 |
| WebServer 无服务器级认证 | `...\@deepseek-ai\dsh-host-webserver\README.zh.md` | 131-133；39（host 规则）；59-63（路由） |
| launch token / cookie / 栅栏 | `...\@deepseek-ai\dsh-client-connection\README.zh.md` | 41、43、45、47、49、51、80-83 |
| `authenticatedUrl` | `...\dsh-client-connection\src\rpc.ts` | 268-273；实现 `browser-auth.ts:244-248` |
| `authorizeIndex` | `...\dsh-client-connection\src\browser-auth.ts` | 263-305 |
| cookie 属性 | `...\src\browser-auth.ts` | 116-140 |
| 服务名/注入 | `...\src\rpc-host.ts`、`src/index.ts` | 92（`connection`）、141-165 |
| `/connect` API-only | `...\README.zh.md`、`browser-auth.ts` | 51；314+ |
| 启动打印 token | `...\@deepseek-ai\dsh-web-app\README.zh.md` | 57-60、69-71、83、87 |
| 反代要求 | `...\dsh\docs\user\guide\public-deployments.zh.md` | 17-21、25、31、35、37 |
| web-server 子系统 | `...\dsh\docs\subsystems\web-server.zh.md` | 178-179、187-197、203-205 |
| interconnect | `plugin-lan-scheduler/lib/index.js`；`tmp/interconnect-lab/.../dsh-interconnect/lib/index.js` | 14、48、736；1208-1214、1221-1270 |
| 真机探针 | 本文 1.3 | 2026-11-20 22:54–22:55 |

### 8.2 v1 → v2 字段映射（节选）

| v1 | v2 | 备注 |
|---|---|---|
| `node.agentUrl` | `node.panelUrl` + `node.agentUrl` | 别名保留；语义纠正 |
| `node.uptimeSec` | `node.uptimeSec` + `process.uptimeSec` | 进程 uptime 明确 |
| `node.startedAt` | `node.startedAt` + `startedAtSource` | 来源明确 |
| `sessions[]` | `sessions[]` + `sessionsMeta` | 形状不变 |
| `tasks.seq/total/running/recent` | 同左 + `counts/source` | 形状不变 |
| `summary` | 同左 + `stale/alerts` | 兼容 |
| 无 | `node.web` | 人机界面连接 |
| 无 | `system/process/interconnect/collection` | 新增 |

### 8.3 配置建议（示意，键名以实现为准）

```yaml
lanStatus:
  instanceId: dsh-a
  label: dsh-a
  role: coordinator
  host: 0.0.0.0
  port: 3091
  origin: http://192.168.3.23:3081
  dshVersion: 0.2.2-rc.3
  requestTimeoutMs: 1200
  overallTimeoutMs: 2500
  cacheTtlMs: 2000
  selfCacheTtlMs: 1000
  staleAfterMs: 30000
  staleKeepMs: 300000
  circuitFailures: 3
  circuitCooldownMs: 30000
  sessionsLimit: 50
  recentTasksLimit: 20
  responseMaxBytes: 65536
  diskPaths: ["/"]
  webProbe:
    enabled: true
    intervalMs: 30000
    timeoutMs: 2000
  panelAuth:
    mode: basic        # basic | token | none
    # 口令只从 env/600 文件注入，不写这里
  entry:
    enabled: false     # P0 必须 false；P1 面板认证通过后 true
    ticketTtlSec: 30
    # entrySecrets 只从 env/600 文件注入
  nodes:
    - instanceId: dsh-a
      role: coordinator
      origin: http://192.168.3.23:3081
      panelUrl: http://192.168.3.23:3091
    - instanceId: dsh-b
      role: agent
      origin: http://192.168.3.23:3082
      panelUrl: http://192.168.3.23:3092
    - instanceId: dsh-c
      role: agent
      origin: http://192.168.3.21:3081
      panelUrl: http://192.168.3.21:3091
    - instanceId: dsh-d
      role: agent
      origin: http://192.168.3.24:3081
      panelUrl: http://192.168.3.24:3091
```

### 8.4 手工验证命令

```bash
# 单节点（LAN 内）
curl -s http://192.168.3.23:3091/health | jq .
curl -s http://192.168.3.23:3091/self | jq '.schemaVersion,.node.web,.system.cpu.loadavg'
# 聚合（A）
curl -s -w '\n%{time_total}s\n' http://192.168.3.23:3091/status | jq '.summary,.partial'
curl -s -D - -o /dev/null http://192.168.3.23:3091/ | grep -iE 'content-security|x-content|referrer|frame'
# 跨源（浏览器 console；P0 应被 CORS 拒）
fetch('http://192.168.3.23:3091/status').then(r=>r.json()).then(console.log).catch(console.error)
# P1 匿名负例
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://192.168.3.23:3091/enter -d 'node=dsh-c'
```

### 8.5 术语

- **launch token**：DSH 每个进程启动时生成的一次性浏览器登录令牌（32 字节随机，base64url）。
- **DSH 会话 cookie**：`dsh-auth-<sha256(authority)>`，HMAC 签名，HttpOnly/SameSite=Strict，默认 30 天。
- **broker**：本文建议的节点侧受控登录代发服务；只在节点进程内处理 token。
- **ticket**：A 向目标节点签发的短命 HMAC 凭证，证明“面板认证后同意进入”；不是 launch token。
- **stale**：最近一次成功数据仍在保留窗口内，但本次采集失败。

---

### 最后一句

**P0 的安全底线是“不代登录”**；**P1 的点击进入不是不能做，而是必须和面板认证一起做**。先把 v2 指标、聚合韧性与安全头落地，再在认证之后讨论 broker；否则“更方便”会直接变成“更危险”。
