# 局域网多机 DSH 协作 · 阶段性结案报告

- 日期：2026-11-24
- 范围：`192.168.3.21` / `192.168.3.23` / `192.168.3.24` 上的 4 个 DSH web 实例，以及配套的调度、状态面板、可信入口与模型渠道
- 结论：**消息互通、薄任务调度、只读状态面板、可信 LAN 免 token 入口四条链路均已落地并实测；项目可阶段性结案，进入“运营 + 增强”阶段。**
- 项目解说页：[`reports/lan-collaboration-2026-11-24.html`](../../reports/lan-collaboration-2026-11-24.html)

## 1. 结案摘要

本阶段把“几台机器各跑一个 DSH，彼此只能人工登录”推进到“四个 DSH 实例可以互相唤醒、派任务、看状态、免 token 进入”的最小闭环：

| 能力 | 实现 | 当前状态 |
|---|---|---|
| 会话消息互通 | `dsh-interconnect@0.17.0`，WebSocket `/interconnect/link` | ✅ A/B/C/D 双向实测 |
| 薄任务调度 | `plugin-lan-scheduler` 0.1.1，9 个 `sched_*` 工具 + JSONL journal | ✅ 四节点各派一单成功；23/23 单测 + 8/8 故障注入；审计/复审 PASS |
| 只读状态面板 | `plugin-lan-status` 0.3.0，Host 值班台 + Client dock 入口 | ✅ A 与本地 desktop 视觉验证；B/C/D 已部署、代理 200 |
| 可信 LAN 免 token | `plugin-lan-trust` 0.1.0，网关 `token → cookie` | ✅ 四节点 302+cookie；浏览器实测 |
| 多模型渠道 | 7 个 provider 下发四节点 | ✅ catalog 与真实调用均通过；2 个不可用模型已下架 |
| 磁盘/常驻 | systemd + Windows 计划任务 + watchdog | ✅ 三机磁盘释放；D 掉线自愈 |

本阶段**不包含**：DAG/依赖图、抢占、跨机文件传输成品、多协调者共享台账、Windows 桌面版修复。它们是下一阶段增强项，不是本阶段验收阻塞。

## 2. 最终拓扑

| 实例 | 机器 | DSH Web | 状态面板 | 免 token 入口 | 角色 |
|---|---|---|---|---|---|
| `dsh-a` | `.23` Ubuntu 24.04.1 | `192.168.3.23:3081` | `:3091` | `:3095` | coordinator |
| `dsh-b` | `.23` 同机 | `192.168.3.23:3082` | `:3092` | `:3096` | agent |
| `dsh-c` | `.21` Ubuntu 24.04.1 | `192.168.3.21:3081` | `:3091` | `:3095` | agent |
| `dsh-d` | `.24` Windows 10 | `192.168.3.24:3081` | `:3091` | `:3095` | agent |

- 四实例均为 `dsh web`（headless CLI），不是 desktop；本机 Windows 桌面 GUI 只是控制端。
- `.21/.23` 由 systemd 用户服务常驻（`Linger=yes`）；`.24` 由计划任务 `DSH-LAN-D` 常驻，另有 `DSH-LAN-Watchdog` 每 5 分钟检查 3081，缺失则拉起。
- 当前按用户要求走**局域网直连，不用 SSH 隧道**；全链路明文 HTTP/WS，仅适用于可信网段。

## 3. 四条链路的验收证据

### 3.1 消息互通

- `dsh-interconnect@0.17.0`，共享 `DSH_INTERCONNECT_TOKEN`；四实例 peers 全 up。
- 已实测：同机 A↔B、跨机 C→A→C、D→A→D、D→C→D 双向往返。
- 证据：`docs/briefs/lan-dsh-interconnect-test.md` §1、§5.4、§5.5。

### 3.2 薄任务调度

- `plugin-lan-scheduler` 0.1.1，协调者 dsh-a 上 9 个工具：worker 登记/列表、提交/状态/列表、回执、tick、取消、统计。
- 持久化：`.journal.jsonl` 为 source of truth（fsync + sha256 链），`state.json` 为派生缓存；启动时重放 journal，mid-file 坏行拒绝 load 并备份 `.corrupt-*`。
- 可靠性：dispatch 崩溃重入队、attempt + lease token fencing、tick 单飞、`superseded` 竞态保护、send 超时、invalid-status 拒绝、回执大小上限。
- 验收：单测 **23/23**；故障注入 **8/8** + 独立 hash 链审计 PASS；P6 独立审计 PASS-WITH-FINDINGS（0 blocker / 8 major / 15 minor），major 已修或降级文档，复审 `docs/04-audit-recheck.md` PASS。
- 组网 E2E：dsh-a 协调者会话 `session-b911ca40-b324-4085-90d4-a051d8c13db9` 连续提交四单，全部 `attempts=1`、`succeeded`：
  - B `t-mwp1kdiz-25`、C `t-mwp1l21c-29`、D `t-mwp1ljr2-33`、A `t-mwp1m06j-37`。
- 边界：单协调者、单台账；无 DAG/抢占/文件传输；worker 副作用不保证 exactly-once，worker 需按 `task_id` 幂等。

### 3.3 状态面板

- `plugin-lan-status` 0.3.0：
  - Host 半：每节点 `node:http` 只读服务，agent 暴露 `/self`，coordinator 聚合 `/status` 与单文件值班台 `/`。
  - Client 半：注册 `sidebar.panellist` 的 `LAN 状态` 图标与 `main` 的 `lan-status` 面板；DSH web server 注册同源 `/lan-status/*` 代理，iframe 显示值班台。
- A `/status?refresh=1` 聚合 `nodes=4 online=4 offline=0`；四节点系统指标（CPU/内存/磁盘/负载/uptime）均上报。
- A 与本地 desktop 已视觉验证 dock 入口；B/C/D 已部署 0.3.0、`/lan-status/health` 与 `/lan-status/` 均 200，未逐台浏览器点开 dock。
- 单测 **9/9**；CSP 改 `frame-ancestors 'self'` / `X-Frame-Options: SAMEORIGIN`，无 `ACAO:*`，无 `/open` 服务端 token 302。
- 限制：面板无认证；只列活会话（`ctx.agents.list()`）；任务只读 coordinator 台账。

### 3.4 可信 LAN 免 token 入口

- `plugin-lan-trust` 0.1.0：DSH 启动时捕获 launch token（仅内存），网关在服务端完成 `token → dsh-auth cookie` 交换，浏览器最终落在干净 DSH URL，token 不出现在 URL/HTML/JS。
- 四节点网关：A `3095`、B `3096`、C `3095`、D `3095`；四节点均返回 302 + `set-cookie`，浏览器可进入 `DeepSeek Harness` 工作区页。
- 安全边界：只接受配置 CIDR 内的直接 socket 来源；allowlist 内 = owner 权限；不支持反代/XFF；DSH 原生 3081 仍要 token。
- 单测 **16/16**；非信任源 403 仅有单测覆盖，端到端因本机无第二网段未做。

### 3.5 模型渠道

- 四节点从“仅 DeepSeek 官方”补齐为 7 个 provider：`deepseek-official`、`opencode-go`、`zai-coding-cn`、`xiaomi`、`giteeinter`、`proma`、`opencodegosota`。
- 四节点 `session/modelCatalog` 均 `routableProviders=7`、`failures=[]`；凭据在各自 DSH_HOME `.credentials.yaml`（A/B/C 600，D 仅 User ACL），不入库/不进日志。
- 真实调用：四节点 `zai-coding-cn/glm-5.3-flash` 均返回 `OK`；A 另验 `opencode-go/qwen3.8-flash`、`xiaomi/mimo-v2.6-flash`、`giteeinter/GLM-5.3-Flash` 均 `OK`。
- `glmflash-free` 未下发：baseURL 是本机 `127.0.0.1:8484` 代理，远端不可达。
- 用户确认不可用的 `proma/gpt-6.1-terra-1` 与 `opencodegosota/qwen3.8-max` 已从四节点与本机桌面删除；proma/opencodegosota 各保留 5 个模型，`qwen3.8-max-0902` 保留。

### 3.6 磁盘与常驻

| 机器 | 清理前 | 清理后 | 主要动作 |
|---|---|---|---|
| `.23` | 5.7G free / 79% | **6.29G free / 77.4%** | npm cache 599M→101M；删 7 个 disabled snap revisions |
| `.21` | 53G free / 53% | **53.2G free / 53.7%** | npm cache 662M→63M；journal 释放 390.6M |
| `.24` C: | 2.95G free | **4.55G free / 85.5%** | 7 个旧安装包移到 `D:\Archive\Downloads`（未删除） |

- 实际清理由 lead 通过 SSH 直接执行；调度器里的 disk 任务因 worker 沙箱审批未完成，不能当作清理证据。
- `.24` 新增 `DSH-LAN-Watchdog`，解决“任务 Ready 但 3081 无监听”的掉线无自愈问题。
- `DISM /Online /Cleanup-Image /AnalyzeComponentStore` 在 `.24` 报 `0x80040154 没有注册类`，WinSxS 清理未做。

## 4. 关键设计与坑

1. **`self` 在 LAN IP 绑定下不可用**：`dsh-interconnect` 的 `self` 哨兵解析到 `127.0.0.1:<port>`，DSH 绑 LAN IP 时未监听；同机 peer 必须写固定 origin（如 `http://192.168.3.23:3081`）。
2. **DSH worker 的沙箱不能做宿主级清理**：`sudo` 被 `no_new_privs` 阻止，workspace 外写被拒；宿主级操作应由 lead 直连 SSH，或给专用受控执行面。
3. **长 prompt 截断**：把多步清单塞进一次 `session/prompt` 会被截断；登记/派活一次一个动作。
4. **Windows 远程装插件必须显式 `DSH_HOME`**：否则误装默认 `.dsh`；用 `powershell -EncodedCommand` 设置环境变量后执行 `dsh.cmd`。
5. **B 的 `run.sh` 重写丢可执行位**：`{...}>new; mv` 会导致 systemd `203/EXEC`，改完 `chmod 755`。
6. **面板同源 iframe**：client 半必须通过 `/lan-status/*` 同源代理，不能跨端口直连；CSP 改 `frame-ancestors 'self'` / `SAMEORIGIN`，否则空白。
7. **网关不碰 DSH 认证**：DSH 没有 `noAuth`/`trustedNetworks`；`trustedHosts` 只放宽 Host/Origin。网关只做 token→cookie 交换，3081 仍保留 token。
8. **Windows 桌面版单列**：`@deepseek-ai/dsh-desktop 0.2.2-rc.5` 安装完整，host ready URL 303 正常，但 shell `authenticateWebHost` fetch 报 `ECONNRESET`，无窗口；清 userData、清 Cookie、no-sandbox、代理排查均无效，判断为桌面壳/loopback fetch 兼容问题，未修复。

## 5. 已知限制与残留

| 项 | 状态 | 说明 |
|---|---|---|
| 非信任源 403 端到端 | ⚠️ 仅单测 | 本机无第二网段；建议后续在隔离 VLAN 验证 |
| B/C/D dock 视觉 | ⚠️ 未逐台点开 | 包/配置/代理 200；A 与本地已视觉验证 |
| 面板认证 | ⚠️ 无 | 面板只读且不持有 token；LAN 内可访问 |
| 可信网关安全边界 | ⚠️ allowlist=owner | 只允许直连可信 CIDR；不能暴露公网/反代 |
| Windows 桌面版 | ❌ 未修复 | 已提供 LAN 快捷方式作为替代入口 |
| 调度层能力 | ⚠️ 薄层 | 无 DAG/抢占/文件传输/多协调者共享台账 |
| 调度器 journal/队列上限 | ⚠️ 未做 | 需监控或后续轮转 |
| 模型渠道 | ✅ 7 provider | 2 个不可用模型已下架；桌面 GUI 需重启刷新选择器 |

## 6. 下一阶段建议

1. **运营化**：把 A 的 coordinator 作为唯一任务入口；B/C/D 只保留 worker 工具面；为 journal/台账加轮转与监控。
2. **补任务层**：任务依赖/DAG、抢占、文件清单与跨机传输，优先做“最小可用”而不是完整工作流引擎。
3. **补安全**：面板级认证、网关速率限制、非信任 VLAN 的 403 实测；如跨不可信网络，再上 TLS/WireGuard。
4. **Windows 桌面版**：单独立项，抓 shell fetch 的具体 URL/headers，或等上游修复；当前以 LAN 网关入口为准。
5. **文档与 skill**：把 `lan-scheduler`、`lan-status`、`lan-trust` 的安装/回滚/端口表继续收敛到各插件 `README`/`AGENTS`，避免只存在于会话记录。

## 7. 证据索引

- 连通/安装/常驻：`docs/briefs/lan-dsh-interconnect-test.md`
- 四项跟进与调度增补：`docs/briefs/lan-collaboration-followup-20261120.md`
- 调度器：`plugin-lan-scheduler/README.md`、`docs/00`–`docs/04`、`skills/lan-scheduler/SKILL.md`
- 状态面板：`plugin-lan-status/README.md`、`AGENTS.md`、`docs/00`–`docs/02`
- 可信网关：`plugin-lan-trust/README.md`、`AGENTS.md`、`docs/00`
- 模型渠道：`docs/briefs/lan-llm-channels-20261122.md`
- OpenClaw ACP：`docs/briefs/openclaw-dsh-integration-assessment.md` §7
- mesh 评估：`docs/briefs/dsh-mesh-capability-assessment.md`

## 8. 版本与复现

```text
DSH                    0.2.2-rc.3
dsh-interconnect       0.17.0
plugin-lan-scheduler   0.1.1
plugin-lan-status      0.3.0
plugin-lan-trust       0.1.0
Node (Linux)           v24.22.3
Node (Windows)         v24.13.0
```

复现入口：

```bash
# 调度器
cd plugin-lan-scheduler && node --test tests/*.test.mjs
node tests/fault/run.mjs && node tests/fault/check.mjs

# 状态面板
cd plugin-lan-status && node --test tests/*.test.mjs

# 可信网关
cd plugin-lan-trust && node --test tests/*.test.mjs
```

---

**结案判定**：本阶段目标“四台 DSH 从各自为政到可互通、可派活、可观测、可免 token 进入”已达成；剩余项均为增强或独立缺陷，不阻塞本阶段收口。
