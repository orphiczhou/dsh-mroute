# 04 · 独立复审：P6 审计 Major 修复与文档声明核验

- 复审对象：`docs/03-independent-audit.md`（PASS-WITH-FINDINGS，0 blocker / 8 major / 15 minor）之后开发者宣称的修复——MAJOR-01/04/05/06 代码修复，MAJOR-02/03/07/08 文档改为实现事实。
- 复审员：独立复审会话（audit-recheck，只读；未参与实现与修复）。
- 日期：2026-11-20。方式：必读文件通读 + 基线命令复跑 + 三个自建临时探针（坏 journal / torn tail / failed 收口，探针在 `%TEMP%`，用后已删）。
- 未修改：`lib/`、`tests/`、`docs/01-03`、README、SKILL、AGENTS。本文件是唯一新增仓库文件（另：复跑 `tests/fault/run.mjs` 产生新 artifact 目录 `2026-11-20T13-30-30-502Z/` 并重写 `tests/fault/fault-report.json`，属命令生成物）。

## 0. Verdict

**PASS**（修复真实、文档与实现一致；残留 3 个新 minor，均为文档措辞级别，不阻断）。

| 审计 major | 复审结论 |
|---|---|
| MAJOR-01 | **fixed** |
| MAJOR-02 | **doc-corrected** |
| MAJOR-03 | **doc-corrected** |
| MAJOR-04 | **fixed** |
| MAJOR-05 | **fixed** |
| MAJOR-06 | **fixed** |
| MAJOR-07 | **doc-corrected** |
| MAJOR-08 | **doc-corrected** |

## 1. 逐项结论与证据

### MAJOR-01 — journal 坏行恢复（fixed）

代码：`lib/scheduler.js:352-362` 对 `journal.error`（mid-file 坏 JSON/坏事件/空行/seq gap/hash mismatch/首事件 prev 非 null）先 `copyFileSync` 为 `.journal.jsonl.corrupt-<ts>` 再抛错拒绝 load，不截断；`lib/scheduler.js:363-370` 只对**末尾无换行 tail** `truncateSync`；`appendEvent`（`:498-513`）追加前校验最后字节是 `\n`，堵住 MINOR-02 的 torn-tail-继续-append 窗口。校验器 `readJournal`（`:431-496`）mid-file 全部 `fail()` 拒绝。

官方测试：`tests/journal.test.mjs:103-118`（mid-file 坏行 throws / 原文件不变 / `.corrupt-` 备份存在）、`:75-87`（torn tail 截断后 replay 存活）。

我的独立探针（临时 journal，2 任务、第 2 行改坏 JSON）：
- `load()` 抛 `[lan-scheduler] journal corruption: bad json: ... at line 2; backup: ...\journal.jsonl.corrupt-<ts>; refusing to truncate mid-file data`；
- 原文件逐字节不变；目录出现 `journal.jsonl.corrupt-<ts>`；
- 干净目录追加无换行片段 `{"v":1,"seq":999` 后 reload：任务存活、`verify().ok===true`、文件尾恢复 `\n`。

### MAJOR-04 — tick 队头饿死（fixed）

代码：`lib/scheduler.js:914-919` 队头 `selectWorker` 为 null 时 push `not-dispatched`/`no-idle-worker` 后 **`continue`**，不再 `break`。测试：`tests/scheduler.test.mjs:337-346`「tick skips an unsatisfiable head task instead of starving later tasks」——blocked（targetInstanceId=dsh-x）保持 queued，runnable 派为 running，actions 带 `no-idle-worker`。该测试在本次 23/23 复跑中通过。

### MAJOR-05 — send 无超时（fixed）

代码：`lib/scheduler.js:734-751` `_sendWithTimeout` 用 `Promise.race` + 15s（可配 `dispatchTimeoutMs`，`:338`）计时器，超时 reject `Error('send-timeout')` 带 `code='send-timeout'`；`:812-821` catch 分支按 `retryOutcome` 提交 `dispatch-failed`（reason=`send-timeout`，回 queued/failed）；`:822-824` `finally { inFlight.delete }` 保证释放。测试：`tests/scheduler.test.mjs:348-358`（never-settling send → `reason='send-timeout'`、status=queued、`lastError='send-timeout'`、`inFlight.has===false`）。README §2 亦登记 `dispatchTimeoutMs` 默认 15000。

### MAJOR-06 — 畸形/未知回执 fail-closed（fixed）

代码：`lib/scheduler.js:858-861` status 闭集 `['succeeded','success','failed']`，其余（含非 JSON 文本解析为 null）返回 `{ok:false, reason:'invalid-status'}`，**不提交任何事件**，台账不变。测试：`tests/scheduler.test.mjs:360-375`（`text:'not-json at all'` → `invalid-status`、status 仍 running、result 仍 null）；故障注入 F5（`tests/fault/run.mjs:236-259`）同断言。docs/01 F9（`:43`）已同步为「畸形/未知 status `invalid-status`；均不改变台账」。

**failed 正常收口**（我的探针）：带匹配 attempt/token、`status:'failed', error:'worker gave up'` → `ok:true`、任务 `failed`、`result.error='worker gave up'`、`verify().ok===true`。

### MAJOR-02 — AsyncMutex 声明（doc-corrected，与实现一致）

`lib/scheduler.js`、`lib/index.js` grep `AsyncMutex` 均 0 处。文档已改为实现口径：`docs/01-correctness.md:54`（I7「没有通用 AsyncMutex；依赖事件循环…已知限制」）、`:134-142`（§8 实现口径全段）；`README.md:91`、`skills/lan-scheduler/SKILL.md:169-170`、插件 `AGENTS.md` §2 同步。代码事实：`scheduler.js:326-327` 仅 `inFlight`/`tickPromise`；dispatch send 后重读 + `superseded`（`:790-793,804-807,813-816`）；tick 单飞（`:890-896`）。

### MAJOR-03 — 单调时钟声明（doc-corrected，与实现一致）

代码确是墙钟：`lib/scheduler.js:325` `now = () => Date.now()`。文档已降级：`docs/01:41`（F7「使用墙钟 `Date.now()`…当前不实现单调时钟，属已知限制」）、`:64`、`:142`；README/SKILL 同步声明。时钟回拨/前跳测试仍属「计划中」（docs/01 §9），无虚报。

### MAJOR-07 — “断电”措辞与烟雾可复现性（doc-corrected）

`docs/02-fault-injection.md:39` 标题改「dsh-d 进程被杀后重派（不是断电）」；`:41` 明确 Stop-Process=进程终止不覆盖页缓存/掉电语义；`:49` 明确「叙述性证据；仓库没有 raw state/journal…无法从本仓复现」。`README.md:113`、`docs/00:125`、`docs/01:179/249-251` 同步。残留的“断电”字样全部出现在「不是断电 / 未做真实断电」的限定语境中（grep 核对），无夸大。`docs/02:18` 引用的 artifact 目录 `tests/fault/artifacts/2026-11-20T13-29-13-863Z/` 实际存在（Test-Path True）。

### MAJOR-08 — 测试矩阵声明（doc-corrected）

`docs/01:144-164` §9 已拆「已实现（23/23）」与「计划中/未实现（不要当成已覆盖）」两栏：随机/属性测试、逐写盘点崩溃、队列/journal 上限、单调时钟、四节点矩阵均列在计划中，不再冒充已覆盖；§12 实施状态（`:232-251`）逐阶段写实，含「没有 raw state/journal 归档」的声明。核对无「把未做的写成已覆盖」的残留。

## 2. 基线命令复跑（2026-11-20 21:30，本机）

```
node --check lib/scheduler.js        # 通过（无输出）
node --check lib/index.js            # 通过
node --test tests/*.test.mjs         # tests 23 / pass 23 / fail 0（journal 5 + plugin 1 + scheduler 17）
node tests/fault/run.mjs             # { scenarios: 8, passed: 8, failed: 0 } → artifacts/2026-11-20T13-30-30-502Z/
node tests/fault/check.mjs           # { audit: "PASS", scenarios: 8, failures: [] }，8 条 journal 独立 hash 链 ok
```

与任务书预期（23/23、8/8、PASS）一致。

## 3. 新发现（无 blocker / 无 major / 3 minor）

- **NEW-MINOR-01**：`docs/00-立项报告.md:76` 仍写「退避：`30s * 2^(attempts-1)`，封顶 10 min」（指数）；实现是线性 `30s×attempt` 封顶 300s（`lib/scheduler.js:723`），且同文件 `:25` 已改成线性——同文档自相矛盾，是原 MINOR-09 的漏网残句。建议改 `:76` 为线性公式。
- **NEW-MINOR-02**：`docs/00-立项报告.md:105` 与 `skills/lan-scheduler/SKILL.md:178` 仍声明 `state.json` 权限 600/0600；Windows 上 `0o600` 不生效（原 MINOR-07 已实证 mode 666），应改为「依赖父目录 ACL，Windows 上 0600 不保证」。
- **NEW-MINOR-03**：版本号不一致：`README.md:3` 写 0.1.0，`package.json:3` 是 0.1.1（AGENTS.md 也写 0.1.1）。顺带：`docs/00:88-99` 的 `sched_ingest` 契约描述仍是无 attempt/token 时代的旧形状（「text 纯 JSON 字符串」、拒绝原因 `unknown-task` vs 实现 `task-not-found`），属历史立项文档未加注，读者应以 docs/01 §7 为准。

原 15 个 minor 中其余未复核到修复的项（如 MINOR-04 按字符截断、MINOR-12 check 独立性）未在本轮范围内重验，按 docs/01 §12「挂 backlog」处理。

## 4. 仍未做的边界（不可由本材料推出）

- 真实**断电**/掉电/页缓存丢失/重新挂载下的持久性：从未测试（Stop-Process ≠ 断电，docs/02 §3 已声明）。
- 真实四节点 SIGKILL 全矩阵（协调者被杀/worker 被杀/双杀）、真实网络分区、pcap 抓包、真实时钟漂移。
- exactly-once 外部副作用、恶意/失控 worker 的副作用阻止、多协调者共享台账、journal/队列上限与轮转、单调时钟、跨方法任意交错的并发压力测试。

## 5. 一句话结论

8 个 major 全部按宣称方式闭合（4 代码修复 + 4 文档校准），基线 23/23、8/8、audit PASS 可复现，文档不再有断电/mutex/单调时钟/测试矩阵的夸大；仅剩 docs/00 两处旧措辞与版本号 3 个文档级 minor。

## 6. 后记（2026-11-20 21:35）

3 个文档级 minor 已修：`docs/00-立项报告.md` 退避改线性 `30s * attempts` 封顶 5 min、`sched_ingest` 契约补 `attempt`/`lease_token` 与 `task-not-found`、台账权限改“Linux 600 / Windows ACL”；`skills/lan-scheduler/SKILL.md` 的 0600 声明同步；“`README.md` 版本”改 0.1.1。修复后复跑 23/23、8/8、audit PASS，未改代码，verdict 仍为 **PASS**。
