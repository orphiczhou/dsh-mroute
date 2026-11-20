# 01 — 薄调度层正确性深化（失败模型 / 不变量 / 验证计划）

> 状态：设计冻结草案（2026-11-20）。范围锁定为现有 9 个 `sched_*` 工具、单协调者、JSON 台账；
> **不新增** DAG、文件传输、UI、多协调者、抢占。目标不是“功能更多”，而是“部分失败下可验证”。

## 1. 基线证据（Phase 0）

原始材料，不引用 README/汇报：

- `dsh-a:~/.dsh-lan-scheduler/state.json`：`seq=14`，6 个 worker，9 个 task；含
  `t-mwovxtr3-5`/`t-mwovyrsb-6` 的截断 prompt、`t-mwow5ebk-10` 的 cancel、
  `t-mwowacha-12` 的 Windows sandbox 失败、`t-mwow229w-8` 的 3 次重试，以及成功任务
  `t-mwow229w-8`、`t-mwovzopg-7`、`t-mwow516f-9`、`t-mwowf6nd-14`。
- `plugin-lan-scheduler/lib/scheduler.js`（530 行）与 `lib/index.js`。
- 现行测试 `tests/scheduler.test.mjs`（197 行，9/9 通过，仅 happy path + 简单重试）。

当前实现已确认的缺口：

1. `save()` 用临时文件 + rename，但没有 `fsync`；崩溃可能丢最后一次提交。
2. 状态是单个可变 JSON 快照；没有 append-only journal；`load()` 解析失败会**从空状态开始**。
3. `dispatch()` 先写 `dispatching` 并 `save()`，再 `await interconnect.send()`；若在两者之间崩溃，
   `dispatching` 永远不被 `tick()` 处理（tick 只扫 `running`/`dispatched`）。
4. `ingest()` 不校验 worker / attempt / 租约；租约过期重派后，旧 worker 的迟到回执仍可把任务标成
   `succeeded`。没有 fencing token。
5. `ingest()` 对 terminal 任务只返回 duplicate；对“已重派但尚未 terminal”的任务没有陈旧回执保护。
6. `tick()` 没有互斥；两个并发 `sched_tick` 可能同时派发同一任务。`inFlight` 只在进程内、不持久化。
7. `submit()` 成功后没有强制 `fsync`；`nextAttemptAt` 成功后未清空（原始 state 中可见残留）。
8. `sched_ingest` 的 `text` 没有输入大小上限（只截断 summary/error）；journal 也没有上限/轮转。
9. 没有“从 journal 重建状态并与快照比对”的检查器，也没有独立审计材料。

## 2. 失败模型

| 编号 | 失败 | 触发点 | 期望 |
|---|---|---|---|
| F1 | 协调者进程崩溃 | `submit` 返回前/后、`dispatch` 写盘后/发送前/发送后、`ingest` 写盘前/后 | 已 accepted 的任务不丢；可恢复；不产生两次完成 |
| F2 | 发送成功但回执丢失 | 网络/worker 崩溃 | 租约到期后重派；旧 token 回执被拒 |
| F3 | worker 执行成功但回执丢失 | 同上 | 至少一次执行；旧回执不能完成已重派任务 |
| F4 | 重复/乱序回执 | 重试、重复投递 | 幂等；terminal 后不再改变结果 |
| F5 | 租约过期后旧 worker 迟到 | 长任务/时钟 | fencing token 拒绝陈旧完成 |
| F6 | 并发 `sched_tick` / 并发写 | 两个工具调用 | 单写者串行化；同一任务最多一个有效租约 |
| F7 | 时钟回拨/前跳 | 租约计算 | 使用墙钟 `Date.now()`；NTP 回拨/前跳会改变租约长度。当前不实现单调时钟，属已知限制 |
| F8 | 写盘中断/半行 journal | 崩溃/断电 | 最后无换行 tail 可截断；mid-file 坏行拒绝加载并保留 `.corrupt-*` 备份 |
| F9 | 畸形/超大回执 | 恶意/异常 worker | 超大回执 `reply-too-large`；畸形/未知 status `invalid-status`；均不改变台账 |

## 3. 不变量（必须逐条给证据）

- **I1 持久性**：`sched_submit` 返回 `ok:true` 后，任务在 journal 中已持久化；协调者崩溃重启后仍存在。
- **I2 单一有效租约**：每个 task 的当前 `attempt` 最多一个 `leaseToken` 有效；旧 token 的完成事件被拒绝。
- **I3 完成幂等**：terminal 状态不可逆；同一 task 的重复/重放完成事件不改变结果，不产生第二次“完成”。
- **I4 陈旧回执拒绝**：`ingest` 必须匹配 `taskId + attempt + leaseToken`；不匹配返回
  `stale-lease`/`attempt-mismatch`，且不改变状态。
- **I5 重放等价**：`replay(journal)` 得到的状态与同 seq 的 `state.json` 快照一致（允许派生的 `updatedAt` 等字段有明确规则）。
- **I6 崩溃恢复**：`dispatching` 在重启后必须被收敛（重派或失败），不能永久悬挂；`running` 租约到期必须重派或失败。
- **I7 串行化（实现口径）**：没有通用 AsyncMutex；依赖 JS 单线程事件循环，所有状态变更同步完成后再进入下一个 `await`，并用 `tick` 单飞、`inFlight` 集合、send 返回后重读状态（`superseded`）覆盖关键交错。跨方法任意并发的压力测试未做，属已知限制。
- **I8 有界性（部分实现）**：prompt 256 KiB、回执 1 MiB、summary 16 KiB 有上限；journal 与任务数量**没有**上限，长期运行需监控/轮转，属已知缺口。
- **I9 审计可校验（部分实现）**：journal 每条记录有 `seq` 与 sha256 链；`verify()` 可比对 replay 与内存状态；独立 `check.mjs` 只重算 hash 链与关键字段，不独立实现完整 reducer。

## 4. 明确不保证（必须写进 README/skill）

- **不保证 exactly-once 副作用**：在“发送成功但回执丢失/崩溃”场景下，worker 可能执行两次；
  fencing 只保证最多一次**被接受的完成**，不保证外部副作用只发生一次。worker 必须按 `task_id`
  做幂等（或由任务自身提供幂等键）。
- **不保证恶意 worker 不执行旧消息**：调度器只能拒绝陈旧回执，不能阻止旧 worker 已经执行的副作用。
- **不保证跨机时钟同步**：租约使用协调者**墙钟** `Date.now()`；NTP 回拨/前跳会改变租约长度，当前未实现单调时钟。worker 侧时间不参与租约判定。
- **不保证 journal 无限保留**：当前为薄层，journal 轮转/压缩是后续工作；在此之前需监控大小。

> 因此原 prompt 中“同一任务不会被两个 worker 同时执行”必须改成：
> **“同一任务不会被两个 worker 同时*完成*；旧 worker 的副作用由 worker 幂等约束兜底。”**
> 这是本设计最重要的边界声明。

## 5. 状态机

```
queued --dispatch-started--> dispatching --delivered--> running --succeeded--> succeeded
   ^                              |                         |
   |                              +--not-delivered---------> queued (retry)
   |                              +--crash-recovery--------> queued (new attempt/token)
   |                                                        +--failed--> failed
   |                                                        +--lease-expired--> queued (retry)
   +--cancel-------------------------------------------------+--> cancelled
```

- `dispatching` 是“已持久化派发意图、尚未确认投递”的中间态；重启后必须收敛，不得永久停留。
- `running` 才有 `leaseUntil`；`queued`/terminal 清空租约。
- 每次真正派发递增 `attempt`，生成新的 `leaseToken`；旧 token 永久失效。
- `cancel` 是终态；之后任何回执只返回 duplicate/stale，不改变结果。

## 6. Journal 设计

文件：`~/.dsh-lan-scheduler/journal.jsonl`（与 `state.json` 同目录）。

每条事件（单行 JSON）：

```json
{"v":1,"seq":15,"at":"...","type":"dispatch-started","taskId":"t-...","attempt":2,
 "leaseToken":"...","workerId":"w-2","instanceId":"dsh-a","sessionId":"...","prev":"<hash|null>","hash":"..."}
```

事件类型（最小集）：

- `worker-registered` / `worker-updated` / `worker-removed`
- `task-submitted`（含完整 prompt 与 dedupeKey）
- `dispatch-started`（含 attempt、leaseToken、worker、目标 session）
- `dispatch-delivered` / `dispatch-failed`
- `lease-expired`
- `task-succeeded` / `task-failed` / `task-cancelled`
- `snapshot`（可选，记录快照覆盖到的 seq）

写入规则：

1. 先 append + `fsync` journal，再应用到内存，再写快照；
2. `state.json` 是派生缓存，**没有 `lastSeq`**；加载时优先重放**全部** journal 事件，state 仅用于 journal 为空时 bootstrap；
3. journal 最后一行不完整（无换行）时截断这些 tail 字节；**mid-file 坏行/链错误/空行拒绝加载**，先把原文件复制为 `.corrupt-*`，不自动截断；
4. `hash = sha256(prev + canonical(event_without_hash))`，用于检测篡改/缺口；
5. `state.json.tmp` 写入后 `fsync` 文件，再 rename；POSIX 上再 `fsync` 目录（Windows 上目录 fsync 被跳过，属已知限制）；`state.json` 的 `0o600` 在 Windows 上不生效，依赖父目录 ACL。

## 7. Fencing 协议

- `buildTaskMessage(task)` 增加：
  - `attempt`
  - `lease_token`
  - `task_id`
  - 明确的回执契约：回执 JSON 必须包含 `task_id`、`attempt`、`lease_token`、`status`。
- `sched_ingest` 参数增加 `attempt`、`lease_token`；工具 schema 仍保持 9 个工具，不新增工具。
- 接受条件：
  - task 存在且非 terminal；
  - `attempt === task.attempts`；
  - `lease_token === task.leaseToken`；
  - 任务处于 `dispatching` 或 `running`（`ACTIVE`），且当前有 leaseToken。
- 拒绝原因（实现顺序）：`reply-too-large` → `task-id-required` → `task-not-found` → `task-not-active:<status>` → `attempt-required` → `attempt-mismatch` → `lease-token-required` → `stale-lease` → `invalid-status`。
- terminal 任务的重复回执返回 `{ok:true, duplicate:true}`，不改变结果。
- 兼容：新派发一律要求 token；无 token 的旧回执只会在 task 没有 token 时被接受（当前代码对活跃任务要求 token）。

## 8. 并发与恢复（实现口径）

- **没有 AsyncMutex**。所有 `registerWorker`/`submit`/`cancel` 状态变更在进入下一个 `await` 前同步完成；`dispatch` 在 `await send` 前只做同步段，send 返回后**重读任务**并校验 `status===dispatching && leaseToken===本次token`，否则返回 `superseded`。
- `tick` 用 `tickPromise` 单飞：并发 `tick()` 返回同一个 promise；`_tick` 内逐个 `await dispatch`，`inFlight` 集合阻止同一 task 重入。
- 这是“事件循环原子段 + 单飞 + 写后重读”，**不是**通用互斥；跨方法任意交错/未来新增 `await` 可能引入竞态，属已知限制。
- `load()` 后执行 `recoverDispatching()`：把已 journal、且不在 `inFlight` 的 `dispatching` 任务用 `dispatch-failed` + `retryOutcome` 重新入队（`lastError='recovered-dispatch'`），旧 token 失效。
- `running` 且 `leaseUntil <= now` → `lease-expired` 重派/失败；`running` 且未过期 → 等待回执/到期；`queued` 且 `nextAttemptAt` 已过 → 等 tick。
- `dispatch-delivered` 清空 `nextAttemptAt`；terminal 清空 `leaseToken`/`leaseUntil`/`nextAttemptAt`。
- 租约为**墙钟** `Date.now()`，没有单调时钟；NTP 回拨/前跳会改变租约长度。

## 9. 测试矩阵（已实现 / 计划中）

### 已实现（`tests/`，23/23）

- replay：完整 journal round-trip；state.json 损坏后从 journal 恢复；截断 tail；hash 篡改检测。
- journal 野坏：mid-file 坏行拒绝 load、保留原文件并写 `.corrupt-*` 备份。
- crash window：`dispatch-started` 后崩溃，重启重入队。
- duplicate/stale：缺 attempt、缺 token、错 token、旧 token、terminal 重复。
- concurrent tick：`Promise.all([tick(), tick()])` 只产生一次派发；完成先于 send 返回的 `superseded`。
- bounds：超大 reply 拒绝；prompt 上限。
- liveness：队头无可派 worker 时跳过，后续任务仍可派；send 超时回到 queued。
- malformed：非 JSON/未知 status 返回 `invalid-status`，台账不变。
- 构造器：stateFile 与 journalFile 同路径拒绝。

### 计划中/未实现（不要当成已覆盖）

- 随机事件序列/属性测试（fast-check）。
- 在 `dispatch` 每个写盘点注入异常；逐写盘点崩溃。
- 队列/任务数量上限；journal 轮转。
- 单调时钟/时钟回拨测试。
- 四节点 SIGKILL / 真实网络分区 / pcap / 时钟漂移矩阵。

### 真实四节点故障注入（`tests/fault/`，8/8）

| 场景 | 方法 | 观察 |
|---|---|---|
| F1 crash-before-send | 写 `dispatch-started` 后不发送，重启 | 任务重入队 |
| F2 delivery-response-lost | send 成功但回执丢失 | 租约到期重派；旧回执拒绝 |
| F3 partition-retry | send 失败/超时 | 有限重试后 queued/failed |
| F4 stale-reply | 旧 attempt/token 回执 | `stale-lease`，状态不变 |
| F5 malformed | 非 JSON/未知 status | `invalid-status`，台账不变 |
| F6 oversized | 1 MiB+1 字节 | `reply-too-large`，台账不变 |
| F7 concurrent-tick | 同时两次 tick | 单次派发 |
| F8 journal-corruption | 截断 tail + 损坏 state.json | 截断尾行、state 从 journal 恢复 |

真实环境只做了“dsh-d 进程被杀后重派”和“带 token 回执”两条烟雾；**不是断电测试，也没有 raw state/journal 归档**。四节点全矩阵仍属计划中。

## 10. 实施顺序（逐阶段验收）

1. **P1 设计冻结**：本文档 + 失败模型/不变量评审（当前）。
2. **P2 Journal + replay + verifier**：先让现有行为可重放；测试通过后再改语义。
3. **P3 Fencing + 幂等 ingest**：新字段、拒绝原因、worker 契约更新、测试。
4. **P4 崩溃恢复 + 单飞**：recoverDispatching、tick 单飞、inFlight、send 后重读、fsync；不做通用 mutex。
5. **P5 故障注入**：确定性 harness → 四节点真实矩阵；修到全绿。
6. **P6 独立审计**：审计员只看 raw artifacts；输出 verdict；残 risks 写入 README/skill。

## 11. 验收证据（最终）

- `docs/01-correctness.md`（本文件）+ 代码 diff；
- `tests/` 单测/属性测试输出；
- `tests/fault/` 脚本与运行日志；
- `raw-evidence/`：state、journal、journalctl、session records、pcap（按需）；
- 独立审计 verdict；
- README/skill 的“明确不保证”章节。

## 12. 实施状态（2026-11-20）

### P2 — journal + replay（完成）

- `lib/scheduler.js` 默认 journal：`state.json` 同目录 `.journal.jsonl`。
- `appendEvent()`：单行 JSON、`fsync`、sha256(prev + stable body) 链。
- `commit()`：先 journal，后 `applyEvent`，再原子写 `state.json`（tmp + fsync + rename）。
- `readJournal()`：校验 seq/prev/hash，截断不完整尾行；坏行保留备份并拒绝其后事件。
- `load()`：journal 优先；无 journal 时把现有 state 写成 `snapshot` 事件；state 损坏时从 journal 恢复。
- `verify()`：replay 与内存状态逐字段比对；`tests/journal.test.mjs` 覆盖 round-trip、state 损坏、截断尾行、hash 篡改。

### P3 — fencing + 幂等 ingest（完成）

- 每次 `dispatch-started` 生成 `lt-<uuid>` 租约 token，写入 task 与任务信封。
- 任务信封回执契约包含 `task_id`、`attempt`、`lease_token`、`status`、`summary`、`files`、`error`。
- `ingest()` 对活跃任务强制校验：
  - 缺 attempt → `attempt-required`；
  - attempt 不等 → `attempt-mismatch`；
  - 缺 token → `lease-token-required`；
  - token 不等 → `stale-lease`；
  - 已终态 → `{duplicate:true}`（不二次写入）。
- `sched_ingest` schema 增加 `attempt` / `lease_token`；索引层把 `lease_token` 映射为内部 `leaseToken`。
- 旧任务信封被重派后，旧 token 被拒；worker 仍须按 task_id 幂等，调度器不承诺副作用 exactly-once。
- `tests/scheduler.test.mjs` 覆盖缺 token、错 token、旧 attempt、重派后旧 token、终态重复。

### P4 — 崩溃恢复 + 单飞（完成，非 mutex）

- `load()` 与每次 `tick()` 开头调用 `recoverDispatching()`：把已 journal 的 `dispatching` 任务重新入队（`recovered-dispatch`），旧 token 失效；`inFlight` 中的任务不回收。
- `tick()` 单飞：并发调用共享同一个 promise，不会双重派发。
- `dispatch()` 在 send 返回后重新读取任务；若已被完成/取消/重派（status 或 leaseToken 变化），返回 `superseded`，不覆盖终态。
- `tick()` 租约判定改为 `Number.isFinite(lease)`，不再把 epoch 0 当作“无租约”。
- 测试：崩溃窗口重入队、并发 tick、完成先于 send 返回的竞态。

### 当前测试

`node --test tests/*.test.mjs` → **23/23 pass**（journal 5 + plugin 1 + scheduler 17）。新增：mid-file corruption 拒绝 load、tick 跳过不可派队头、send 超时、invalid-status、state/journal 同路径拒绝。

### P5 — 故障注入（确定性绿灯 + 进程被杀烟雾）

- `tests/fault/run.mjs`：在 scheduler/transport 边界注入 8 类故障，每个场景落 `tests/fault/artifacts/<stamp>/` 原始 journal/state + `fault-report.json`：
  - F1 crash after `dispatch-started` / before send → 重启后重入队；
  - F2 delivery response lost → 重派使用新 token；
  - F3 两次 `ECONNREFUSED` → 重试预算与 backoff；
  - F4 租约过期 → 旧 token `stale-lease`，新 token 接受；
  - F5 畸形回执 → `invalid-status`，任务保持 running，台账不变；
  - F6 1 MiB+ 回执 → `reply-too-large`，任务不变；
  - F7 并发 tick → 单飞、只发一次；
  - F8 `state.json` 损坏 + journal 截断尾行 → replay 存活。
- `tests/fault/check.mjs`：不 import scheduler 的 replay 代码，独立重算 journal hash 链与 artifact 断言；最近一次 `audit: PASS`，8/8 场景。
- 真实环境烟雾（2026-11-20）：
  - dsh-d **进程被 `Stop-Process` 杀掉**（不是断电）后，A 向 dsh-d 提交任务返回 `unreachable`、任务 `queued` + `nextAttemptAt`；重启 dsh-d 后自动 tick 重派为 `running`，随后 `sched_cancel` 收口。
  - 新代码在 dsh-a 上实跑：`sched_submit` 生成 `attempt=1` + `lt-...` token；worker 回执经 `sched_ingest` 带 token 接受，任务 `succeeded`。
- 说明：确定性 harness 是边界级故障，不是四节点 SIGKILL/分区全矩阵；真实环境只做了**进程被杀**重派与带 token 回执两条，没有 raw state/journal 归档；剩余矩阵（真实断电、网络分区、pcap、时钟漂移）仍属计划中。

### P6 — 独立审计与修复（进行中）

- 审计报告：`docs/03-independent-audit.md`，verdict **PASS-WITH-FINDINGS**（Blocker 0 / Major 8 / Minor 15）。
- 已修：MAJOR-01（mid-file 坏行拒绝 load + `.corrupt-*` 备份，只截断 tail）、MAJOR-04（tick 跳过不可派队头）、MAJOR-05（send 超时 `send-timeout`）、MAJOR-06（未知 status → `invalid-status`，不改台账）、MAJOR-02/03/07/08（文档改为实现事实：无通用 mutex、墙钟租约、进程被杀非断电、测试矩阵拆“已实现/计划中”）。
- 复跑：`node --test tests/*.test.mjs` 23/23；`node tests/fault/run.mjs` 8/8；`node tests/fault/check.mjs` PASS。
- 仍需：独立复审修复后的代码/文档；补 raw evidence 或明确标注叙述性证据；把 Minor 清单中未修的项挂 backlog。


