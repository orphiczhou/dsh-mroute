# LAN Scheduler · DSH 局域网薄任务调度层

`@local/dsh-lan-scheduler` 0.1.1 —— 把 `dsh-interconnect` 的“会话消息”升级成可追踪、可重试、可审计的任务。

> 状态：2026-11-20 四节点（.23 A/B、.21 C、.24 D）实测通过；单元测试 23/23。P6 独立审计 PASS-WITH-FINDINGS（0 blocker / 8 major / 15 minor），major 已修或已降级文档声明。
> 定位：**薄层**，不是完整工作流引擎；不做 DAG、不做抢占、不搬文件、不跑模型。

## 1. 它解决什么

`dsh-interconnect` 让两个 DSH 会话可以互发消息，但没有“任务”语义：谁派的、派给谁、做到哪、失败怎么重试、结果在哪。  
本插件在**协调者** DSH 上维护一份 JSON 台账，用 `sched_*` 工具完成：

- worker 登记（instanceId + 活会话 sessionId）
- 任务提交、优先级排序、空闲派发
- 租约 / 超时回收 / 退避重试 / 取消
- worker 回执 JSON 的解析与落账
- 状态查询与统计

投递仍走 `ctx.interconnect.send()`（followup + resume），不新开端口，不写第二套网络协议。

## 2. 安装

```bash
# 在协调者的 profile 里
dsh plugin --profile lan add /path/to/plugin-lan-scheduler
```

`package.json` 的 `dsh.bundle.patch` 会挂上 `cordis.patch.yml`：

```yaml
- insert:
    - id: lan-scheduler
      name: '@local/dsh-lan-scheduler'
```

协调者的 `interconnect.peers` 必须能看到所有 worker 实例。**同机自派**时不要用 `self`（在 LAN IP 绑定时会解析到未监听的 127.0.0.1），直接写固定 origin：

```yaml
peers:
  dsh-a: http://192.168.3.23:3081
```

可选配置：

| 键 | 默认 | 说明 |
|---|---|---|
| `stateFile` | `~/.dsh-lan-scheduler/state.json` | 台账路径；也可用 `DSH_LAN_SCHEDULER_STATE` |
| `instanceId` | 从 interconnect 推断 | 本协调者 id |
| `leaseMs` | 30 min | running 任务租约 |
| `maxAttempts` | 3 | 传输失败重试预算 |
| `dispatchTimeoutMs` | 15000 | 单次 interconnect.send 超时；超时记 `send-timeout` 并回 queued |

## 3. 工具速查

| 工具 | 用途 |
|---|---|
| `sched_worker_register` | 登记活会话为 worker（同 instanceId+sessionId 幂等） |
| `sched_worker_list` | 看 worker 与忙碌数 |
| `sched_submit` | 建任务并尝试投递；无空闲 worker 时保持 queued |
| `sched_status` | 单任务全量 |
| `sched_list` | 最近任务 + 统计 |
| `sched_ingest` | 吸收 worker 回执 JSON；活任务必须带 `attempt` + `lease_token` |
| `sched_tick` | 手动跑一轮：恢复中断派发、过期租约、重试、派 queued |
| `sched_cancel` | 取消 queued/running（不强杀对端回合） |
| `sched_stats` | 计数与空闲 worker |

## 4. 标准流程

1. `interconnect_peers` 确认链路 up。
2. `interconnect_list { instanceId }` 找对端**活会话**。
3. `sched_worker_register { instanceId, sessionId, label }`。
4. `sched_submit { title, prompt, targetInstanceId? }`；`prompt` 必须自包含。
5. worker 完成后 `interconnect_reply` 一次，正文是含 `task_id`、`attempt`、`lease_token`、`status`、`summary`、`files`、`error` 的纯 JSON。
6. 协调者把回执原文交给 `sched_ingest { text, attempt, lease_token }`；文本里已带这两个字段时可只传 `text`。旧 attempt/token 会返回 `stale-lease` 等拒绝原因，不改变台账。

worker 侧协议与更多示例见 skill：`skills/lan-scheduler/SKILL.md`。

## 5. 状态机与边界

`queued → dispatching → running → succeeded | failed`，另有 `cancelled`。  
传输失败回到 `queued`，退避为 `30s × attempt`、封顶 5min（线性，不是指数）；`running` 超过租约回收重派。

### 持久化与 fencing

- source of truth 是同目录 `.journal.jsonl`：每行一个事件，带 `seq`、`prev`、`hash`（sha256 链）；每个事件先 `fsync` 再应用。
- `state.json` 是派生缓存，原子写（tmp + fsync + rename）；损坏时从 journal 重放恢复。
- journal 末尾无换行的 torn tail 会被截断；**mid-file 坏行/链错误拒绝加载**，原文件复制为 `.corrupt-*` 后抛错，不自动丢后续事件。
- 每次派发生成一次性 `lease_token`；回执必须带匹配的 `attempt` + `lease_token`。重派后旧 token 被拒（`stale-lease`），已完成任务重复回执返回 `duplicate:true`；未知/畸形 status 返回 `invalid-status`，台账不变。
- 启动/每次 tick 会把 journal 中未完成的 `dispatching` 任务重新入队（`recovered-dispatch`），旧回执由 token 拒绝。
- 明确不保证：worker 副作用 exactly-once；worker 必须自己按 `task_id` 幂等。调度器只保证“最多一个完成被接受”。
- 已知限制：没有通用 AsyncMutex（靠事件循环同步段 + tick 单飞 + inFlight + send 后重读）；租约用墙钟 `Date.now()`，NTP 跳变会影响租约；journal/任务数量无上限，需监控或后续轮转。

明确不做：

- DAG / 依赖图 / 优先级抢占（`priority` 只排 queued）
- 强杀对端已开始的回合
- 文件搬运（worker 用 `files` 回报路径；跨机传输另走 dsh-mesh）
- 多协调者共享同一台账（单写者）

## 6. 实测（2026-11-20）

四节点各派一个 `RUN_PROBE`，全部 succeeded：

| 节点 | task | 结果 |
|---|---|---|
| dsh-a `.23:3081` | `t-mwow229w-8` | `OpenClawPotato`, UTC 11:22:51 |
| dsh-b `.23:3082` | `t-mwovzopg-7` | `OpenClawPotato`, UTC 11:19:27 |
| dsh-c `.21:3081` | `t-mwow516f-9` | `OpenClawPotato`, UTC 11:23:36 |
| dsh-d `.24:3081` | `t-mwowf6nd-14` | `DESKTOP-G65JU1V`, UTC 11:31:31 |

单元测试：`node --test tests/*.test.mjs` → 23/23（含 journal/fencing/恢复/并发/send 超时/invalid-status/超限回执）。
故障注入：`node tests/fault/run.mjs && node tests/fault/check.mjs` → 8/8 场景，独立 hash 链审计 PASS。
真实烟雾：dsh-d **进程被杀**后任务 `unreachable` → 重启后自动重派；新代码带 `attempt`/`lease_token` 回执在 dsh-a 实跑成功。该烟雾无 raw state/journal 归档，属叙述性证据；不是断电测试。

### 6.1 多节点发布与组网 E2E（2026-11-20 晚）

插件已发布到四个 DSH 实例；**只有 dsh-a 作为 active coordinator**，B/C/D 只保留工具面与各自独立的空台账，避免多协调者写同一台账：

| 实例 | 安装位置 | 台账 |
|---|---|---|
| dsh-a `.23:3081` | `/home/orphic/dsh-lan-scheduler` | `~/.dsh-lan-scheduler/state.json` |
| dsh-b `.23:3082` | 同机同包，profile `.dsh-lan-b` | `~/.dsh-lan-scheduler-b/state.json`（`DSH_LAN_SCHEDULER_STATE` 分离） |
| dsh-c `.21:3081` | `/home/orphic/dsh-lan-scheduler` | `~/.dsh-lan-scheduler/state.json` |
| dsh-d `.24:3081` | `C:\Users\User\dsh-lan-scheduler` | `C:\Users\User\.dsh-lan-scheduler\state.json` |

由 dsh-a 的新协调者会话 `session-b911ca40-b324-4085-90d4-a051d8c13db9` 连续提交，四单均 `attempts=1`、`succeeded`：

| 节点 | task | 结果 |
|---|---|---|
| dsh-b `w-1` | `t-mwp1kdiz-25` | `hostname=OpenClawPotato`, UTC 13:55:31 |
| dsh-c `w-3` | `t-mwp1l21c-29` | `hostname=OpenClawPotato`, UTC 13:56:03 |
| dsh-d `w-13` | `t-mwp1ljr2-33` | `hostname=DESKTOP-G65JU1V`, UTC 13:56:27 |
| dsh-a `w-2` | `t-mwp1m06j-37` | `hostname=OpenClawPotato`, UTC 13:56:46 |

B/C/D 的 `sched_stats` 工具面 smoke 也各自返回 `tasks:0`、`seq:0`，台账路径分别为 `.dsh-lan-scheduler-b`、`.dsh-lan-scheduler`、`.dsh-lan-scheduler`（Windows）。skill 已同步到四节点，15593 字节（sha256 `3b6c4950…`）。

## 7. 已知坑

- **`self` 路由**：只有 web server 真监听 loopback 时可用；绑定具体 LAN IP 时必须写固定 origin。
- **Windows sandbox TEMP**：`.24` 的 `TEMP/TMP` 在 workspace 内会触发
  `windows-acl temp root must be outside the workspace`；启动脚本设 `C:\Windows\temp` 并重启。
- **长 prompt 截断**：驱动 agent 时不要把多步清单塞进一次 `session/prompt`；一次一个动作。
- **worker 需要 standing rule**：让 worker 知道收到 `[LAN-SCHED TASK v1]` 后用工具执行并
  `interconnect_reply`，不要 `wait_agent`。
- `state.json` 是派生缓存，`.journal.jsonl` 才是 source of truth；换协调者或清库前两者一起备份。
- **多节点发布**：每节点可装插件，但只让一个节点当 active coordinator；同机多实例必须用 `DSH_LAN_SCHEDULER_STATE` 分台账（dsh-b 即 `~/.dsh-lan-scheduler-b/state.json`）。
- **Linux 服务脚本改完要 `chmod 755`**：用 `{...}>run.sh.new; mv` 重写 `run.sh` 会丢可执行位，systemd 报 `status=203/EXEC`。
- **Windows 远程装插件必须显式 `DSH_HOME`**：用 `powershell -EncodedCommand` 设置环境变量后再 `dsh.cmd plugin --profile lan add`，否则会误装进默认 `C:\Users\User\.dsh`，`.dsh-lan-d` 的 `--dump-config` 不会出现 `lan-scheduler`。

## 8. 文档

- 插件级坑：`AGENTS.md`
- 立项/设计：`docs/00-立项报告.md`
- 正确性模型：`docs/01-correctness.md`
- 故障注入证据：`docs/02-fault-injection.md`
- 使用说明 skill：`skills/lan-scheduler/SKILL.md`
- 四机 LAN 环境：工作区 `docs/briefs/lan-collaboration-followup-20261120.md`

## 9. 许可

MIT；无第三方运行依赖。`dsh-interconnect` 是外部前提，不随本包分发。
