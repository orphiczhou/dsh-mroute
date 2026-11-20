---
name: lan-scheduler
description: "DSH 局域网薄任务调度层（@local/dsh-lan-scheduler）的使用说明：四台 DSH 通过 dsh-interconnect 组成消息网，协调者用 sched_* 工具登记 worker、投递任务、跟踪状态、吸收 worker 的 JSON 回执并重试。触发词：局域网调度、LAN 调度、sched_submit、sched_ingest、worker 登记、任务台账、跨机派活、dsh-lan-scheduler。"
---

# LAN Scheduler 使用说明

> 一个**薄**任务层：JSON 台账 + 租约 + 重试 + 审计，跑在协调者 DSH 的插件里；
> 投递复用 `dsh-interconnect`，不新开端口、不跑模型、不做 DAG/优先级队列。
> 目标是把“跨机会话消息”升级成“可追踪、可重试、可审计的任务”。

## 1. 拓扑与角色

```
协调者 DSH（装 @local/dsh-lan-scheduler，例如 dsh-a .23:3081）
  │ sched_submit → interconnect.send(followup, resume)
  ▼
worker DSH（dsh-b / dsh-c / dsh-d，各自一个常驻会话）
  │ 执行任务；完成后 interconnect_reply 一次
  ▼
协调者收到回执文本 → sched_ingest → 台账 succeeded/failed
```

- **协调者**是 dispatching 的那台；只有它需要装插件。
- **worker** 是每台 DSH 上一个**活会话**（session id），不需要装调度插件，但必须能调用
  `interconnect_reply`，且该 DSH 的 `interconnect` 配置里能看到协调者实例。
- 同机多实例也可当 worker；协调者给自己派活时，优先在 `interconnect.peers` 写**固定 LAN origin**，
  例如 `dsh-a: http://192.168.3.23:3081`。**不要依赖 `self`**：`self` 会解析成
  `http://127.0.0.1:<port>`，若 DSH 的 `--host` 绑定的是具体 LAN IP，loopback 未监听，link 永远 down
  （实测 `connect ECONNREFUSED 127.0.0.1:3081`）。只有 web server 确实监听 loopback 时 `self` 才可用。
- OpenClaw 不在本调度层内；它是另一条 ACP 旁路，别把两者混在一个任务里。

## 2. 协调者标准流程（5 步）

### 2.1 登记 worker

```text
sched_worker_register { instanceId: "dsh-b", sessionId: "session-...", label: ".23 构建 worker" }
```

- `instanceId` 必须是 `interconnect_peers` 里显示 up 的实例。
- `sessionId` 必须是该实例上**活着的**会话；用 `interconnect_list` 找。
- 同一 `(instanceId, sessionId)` 幂等；`maxConcurrent` 默认 1。

### 2.2 投递任务

```text
sched_submit {
  title: "构建并测试",
  prompt: "在 /home/orphic/work 下执行 …；把结果写到 …；只做这一件事。",
  priority: 0,
  targetInstanceId: "dsh-b"   // 可选；不填则自动挑空闲 worker
}
```

- `prompt` 必须**自包含**：worker 看不到你的上下文。写清工作目录、验收标准、产物路径、禁止事项。
- 返回值有 `task.id`、`status`、`dispatch`。`dispatch.ok=false` 且 `reason=no-idle-worker` 时任务仍在
  `queued`，等 worker 空出来由 tick 自动派；不要重复 submit，用 `sched_status` 看。
- 想保证幂等就带 `dedupeKey`；活跃重复会复用原任务。
- 单条 `prompt` 上限 256 KiB；超过就拆任务，不要把大文件塞进 prompt。

### 2.3 跟踪

```text
sched_status { taskId: "t-..." }        // 单任务全量（prompt/attempts/worker/result）
sched_list   { status: "queued,running" } // 最近任务
sched_stats  {}                          // 计数与空闲 worker
```

状态机：`queued → dispatching → running → succeeded|failed`，另有 `cancelled`。
传输失败会 `queued` 重试（30s×attempt 线性退避，封顶 5min，最多 `maxAttempts` 次，默认 3）；
单次 `interconnect.send` 超过 `dispatchTimeoutMs`（默认 15s）记 `send-timeout` 并回 queued。
`running` 超过 30 分钟租约会自动回收重派。

### 2.4 吸收 worker 回执（关键最后一跳）

worker 的回复会作为一条新消息到达协调者会话。把**原始回复文本**交给：

```text
sched_ingest { text: "worker 回复的原文，含 {...} JSON", attempt: 1, lease_token: "lt-..." }
```

- 工具提取第一个平衡的 JSON 对象，读 `task_id` / `attempt` / `lease_token` / `status` / `summary` / `files` / `error`。
- 也可以显式传 `{ taskId, status, summary, files, error, attempt, lease_token }`，不依赖解析。
- **活任务必须带匹配的 `attempt` 和 `lease_token`**（二者来自派发信封）。缺 / 旧会返回 `attempt-required`、`lease-token-required`、`attempt-mismatch` 或 `stale-lease`，台账不变。
- 已终态任务重复 ingest 会返回 `duplicate:true`，不会覆盖结果。
- 非 JSON 或 `status` 不在 `succeeded|success|failed` 时返回 `invalid-status`，任务保持 running，台账不变；
  不要靠猜 status 强行收口。
- 若 worker 回执格式坏了，`sched_ingest` 返回 `task-id-required`；用 `sched_status` 找到 taskId 后
  显式传 `taskId + attempt + lease_token + status + summary` 补救。

### 2.5 失败与取消

```text
sched_cancel { taskId: "t-...", reason: "需求取消" }
sched_tick   {}     // 手动触发一次：过期租约、到点重试、派 queued
```

- 取消不会强杀对端已开始的回合；它只是把台账置终态，并忽略后续回执。
- 自动 tick 每 15 秒一次；`sched_tick` 用于测试或立即补派。
- 对端离线导致的 `unreachable` 会按退避重试；长期离线时任务保持 queued，不会丢。

## 3. worker 侧协议（收到 `[LAN-SCHED TASK v1]` 的 agent 照做）

1. 只执行 `--- TASK ---` 下面的内容；不要向协调者反问（除非任务明确要求澄清）。
2. 用自己可用的工具完成；工作目录、产物路径以任务文本为准。
3. 完成后**只调用一次** `interconnect_reply`，参数 `text` 是**纯 JSON**：

```json
{"task_id":"t-...","attempt":1,"lease_token":"lt-...","status":"succeeded","summary":"做了什么、验收结果","files":["/abs/path"],"error":null}
```

失败时：

```json
{"task_id":"t-...","attempt":1,"lease_token":"lt-...","status":"failed","summary":"尝试了什么","files":[],"error":"具体失败原因"}
```

4. **不要**调用 `wait_agent` 等协调者；不要发多条回复；不要在 JSON 外包解释文字。
   多轮讨论用 `interconnect_send` 另开任务，不要污染回执。
5. 任务太大/被阻塞：报告 `failed` + 原因，让协调者拆小，不要静默超时。

## 4. 工具速查

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `sched_worker_register` | 登记活会话为 worker | `instanceId`, `sessionId`, `label?`, `maxConcurrent?` |
| `sched_worker_list` | 看 worker 与忙碌数 | `status?` |
| `sched_submit` | 建任务并尝试投递 | `prompt`（必填）, `title?`, `priority?`, `targetInstanceId?`, `targetWorkerId?`, `dedupeKey?`, `maxAttempts?` |
| `sched_status` | 单任务详情 | `taskId` |
| `sched_list` | 任务列表 | `status?`, `limit?` |
| `sched_ingest` | 吸收 worker 回执 | `text?` 或 `taskId+status`；`attempt?`, `lease_token?`, `summary?`, `files?`, `error?` |
| `sched_tick` | 立即跑一轮调度 | 无 |
| `sched_cancel` | 取消任务 | `taskId`, `reason?` |
| `sched_stats` | 台账统计 | 无 |

## 5. 示例：跨机派一个构建任务

```text
# 1) 确认链路
interconnect_peers                     # dsh-b/dsh-c/dsh-d 全 up
interconnect_list { instanceId: "dsh-b" }   # 找到活会话 session-b

# 2) 登记
sched_worker_register { instanceId: "dsh-b", sessionId: "session-b", label: ".23 build" }

# 3) 派活
sched_submit {
  title: "构建 plugin-x",
  prompt: "cd /home/orphic/work/plugin-x && npm test。通过后把摘要写到 /tmp/plugin-x-result.txt。不要改源码。",
  targetInstanceId: "dsh-b",
  dedupeKey: "build-plugin-x-20261120"
}
# → task.id = t-...

# 4) worker 完成后，协调者会话收到 JSON；吸收
sched_ingest { text: "<worker 原文>", attempt: 1, lease_token: "lt-..." }
sched_status { taskId: "t-..." }
```

## 6. 边界与已知限制

- **at-least-once**：租约过期会重派，worker 可能收到重复任务；任务应尽量幂等，或在 prompt 里要求
  “先检查产物是否已存在，存在则直接回报”。回执必须带当前 `attempt`/`lease_token`，旧回执会被拒。
- **副作用不保证 exactly-once**：调度器只保证“最多一个完成被接受”；worker 自己按 `task_id` 幂等。
- **journal**：`.journal.jsonl` 是 source of truth，`state.json` 是派生缓存；崩溃后自动重放，未完成的
  `dispatching` 任务重新入队（旧回执由 token 拒绝）。mid-file 坏行会拒绝加载并备份 `.corrupt-*`；
  只自动截断末尾无换行 tail。
- **并发/时钟限制**：没有通用 AsyncMutex，靠事件循环同步段 + `tick` 单飞 + `inFlight` + send 后重读；
  租约用墙钟 `Date.now()`，NTP 跳变会影响租约。单协调者假设。
- **容量限制**：journal 和任务数量无上限；prompt 256 KiB、回执 1 MiB 有上限。需要长期运行要监控/轮转。
- **没有 DAG/依赖图/优先级抢占**：`priority` 只影响 queued 的排序；不做任务依赖。需要流水线就拆成
  多个 submit，由协调者按顺序驱动。
- **没有强杀**：cancel 只改台账；对端正在跑的回合继续。
- **文件不自动搬运**：任务产物需 worker 自己写到共享路径/本机路径并在 `files` 回报；跨机取文件
  走 dsh-mesh 的文件分块或另建同步任务，本层不内置。
- **安全**：依赖 `dsh-interconnect` 的共享 token；LAN 明文 HTTP/WS，仅限可信网段。token 不当参数、
  不写日志、不进 prompt；台账文件在 Linux 上默认 0600，Windows 上 0600 不生效，需用 ACL 限制。
- **单协调者**：当前设计是单写者台账；不要在两台机器同时装同一份 stateFile 并同时调度。
- **模型回合计费**：投递 `resume:true` 会唤醒离线 worker 并产生一次模型回合；批量派活前先确认
  worker 在线和额度。

## 7. 安装与文件位置

- 插件包：`@local/dsh-lan-scheduler`（本工作区 `plugin-lan-scheduler/`）。
- 协调者 profile 的 `cordis.patch.yml` 需要 `insert` 一行 `id: lan-scheduler` + `name: '@local/dsh-lan-scheduler'`。
- 台账默认：`$DSH_HOME/../.dsh-lan-scheduler/state.json` 由 `os.homedir()` 决定，通常是
  `~/.dsh-lan-scheduler/state.json`；可用 `DSH_LAN_SCHEDULER_STATE` 覆盖。
- 本 skill 放到各 DSH 的 `$DSH_HOME/skills/lan-scheduler/SKILL.md`，新会话启动后可见。

### 7.1 多节点发布（2026-11-20）

调度插件本身也可以装到每个 DSH 节点，让每台都有 9 个 `sched_*` 工具；但**台账是每实例独立的**，不是共享数据库。

- 同一台机器多实例（如 dsh-a / dsh-b）必须用 `DSH_LAN_SCHEDULER_STATE` 指向不同文件，否则两个协调者会写同一份台账：
  - dsh-a：`$HOME/.dsh-lan-scheduler/state.json`（默认即可）
  - dsh-b：`$HOME/.dsh-lan-scheduler-b/state.json`（同机，必须显式设置）
  - dsh-c：`$HOME/.dsh-lan-scheduler/state.json`（不同机器，默认即可）
  - dsh-d：`C:\Users\User\.dsh-lan-scheduler\state.json`（不同机器，默认即可）
- 生产约定：**dsh-a 是 active coordinator**；其他节点的工具面用于本地查看/备用，不要同时向同一组 worker 提交，避免多写者。
- 单节点安装（`<node>` 为对应 DSH_HOME）：
  ```bash
  export DSH_HOME=/home/orphic/.dsh-lan-<node>
  export PATH="$HOME/.local/pnpm/bin:$HOME/.local/node24/bin:$PATH"
  dsh plugin --profile lan add /home/orphic/dsh-lan-scheduler
  ```
  Windows 用 `dsh.cmd plugin --profile lan add C:\Users\User\dsh-lan-scheduler`，并同样设 `DSH_HOME`；远程执行多行 PowerShell 用 `powershell -NoProfile -EncodedCommand <base64 UTF-16LE>`，否则环境变量赋值会被引号/解析破坏，插件会误装进默认 `.dsh`。
- 安装后必须重启该实例；`dsh --profile lan --dump-config | grep -A2 lan-scheduler` 应看到 `- id: lan-scheduler`。
- **改 Linux 服务脚本要保留可执行位**：用 `{ ... } > run.sh.new; mv run.sh.new run.sh` 会丢 `+x`，systemd 报 `status=203/EXEC`；改完 `chmod 755 run.sh` 再 `systemctl --user restart`。
- skill 只是说明文档，**不会**因为插件安装而自动分发；四个 DSH_HOME 的 `skills/lan-scheduler/SKILL.md` 要单独同步（本仓库脚本可用 `sha256sum` 校验）。


## 8. Windows worker 准备（.24 实测）

- **TEMP/TMP 必须在 workspace 之外**。DSH 的 Windows ACL sandbox 会报：
  `sandbox-local: windows-acl temp root must be outside the workspace: workspace=C:\Users\User; temp=C:\Users\User\AppData\Local\Temp`。
  在启动脚本里设 `$env:TEMP = 'C:\Windows\Temp'`、`$env:TMP = 'C:\Windows\Temp'`，重启 DSH 进程；
  否则该会话里**所有** `pwsh` 调用都会在命令执行前失败（不是命令写错）。
- 给 worker 会话的 standing rule 要明确：用 `pwsh` 的 `workdir`（例如 `C:\Users\User`），**不要**传
  `sandbox_permissions`；不要请求 `danger-full-access`。PowerShell 里取 UTC 用
  `(Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')`，`date -u` 不是 PowerShell 语法。
- SSH 会话里用 `powershell -NoProfile -EncodedCommand <base64 UTF-16LE>` 执行多行脚本，避免引号被吞。

## 9. 四节点实测记录（2026-11-20）

协调者 `dsh-a`（`.23:3081`）装调度插件；四个 worker 会话分别登记，`sched_submit` 各派一个
`RUN_PROBE`，全部 `succeeded`：

| 节点 | worker / session | task | 结果摘要 |
|---|---|---|---|
| dsh-a | `w-2` / `session-50fb5586-149f-492d-bfd6-f5f0d88a5fac` | `t-mwow229w-8` | `hostname=OpenClawPotato`, UTC `11:22:51` |
| dsh-b | `w-1` / `session-b96c2512-52b5-45a8-9e65-00f0c56d962d` | `t-mwovzopg-7` | `hostname=OpenClawPotato`, UTC `11:19:27` |
| dsh-c | `w-3` / `session-b0651849-aa7c-43f4-ae46-949d3ff6231b` | `t-mwow516f-9` | `hostname=OpenClawPotato`, UTC `11:23:36` |
| dsh-d | `w-13` / `session-8a0ef5a5-e0ba-4d2e-891f-db737f4d8adf` | `t-mwowf6nd-14` | `hostname=DESKTOP-G65JU1V`, UTC `11:31:31` |

- `state.json` 里还留有早期 `probe-b`/`probe-b2` 失败任务、A 的 `unreachable` 重试任务、以及被取消的
  `probe-d`（旧 worker 的 `pwsh` 被 sandbox 拦住）——这些是调试痕迹，不影响新任务；生产使用前可备份
  后清空 state 重新登记。
- 关键教训：`DSH_HOME` 漏设会退回默认 profile（无 peers）；长多步 prompt 会被截断，登记/派活要
  **一次一个动作**；`self` 在 LAN IP 绑定下不可用，用固定 origin。

### 9.1 多节点发布后的组网 E2E（2026-11-20 晚）

插件已装到四个实例，dsh-a 作为唯一 active coordinator；B 用独立台账 `~/.dsh-lan-scheduler-b/state.json`，
C/D 用各自默认路径。由 dsh-a 新协调者会话 `session-b911ca40-b324-4085-90d4-a051d8c13db9` 连续提交，
四单均 `attempts=1`、`succeeded`：

| 节点 | worker | task | 结果摘要 |
|---|---|---|---|
| dsh-b | `w-1` | `t-mwp1kdiz-25` | `hostname=OpenClawPotato`, UTC `13:55:31` |
| dsh-c | `w-3` | `t-mwp1l21c-29` | `hostname=OpenClawPotato`, UTC `13:56:03` |
| dsh-d | `w-13` | `t-mwp1ljr2-33` | `hostname=DESKTOP-G65JU1V`, UTC `13:56:27` |
| dsh-a | `w-2` | `t-mwp1m06j-37` | `hostname=OpenClawPotato`, UTC `13:56:46` |

B/C/D 各自 `sched_stats` 返回 `tasks:0`、`seq:0`，说明工具面已加载且台账独立。组网步骤就是：
每节点装插件→重启→确认 `--dump-config` 有 `lan-scheduler`→只让 dsh-a 提交→用 `sched_status`/state 核对
四单终态。
