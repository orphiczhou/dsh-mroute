# 03 · 独立审计报告：薄调度层 P2-P5 正确性深化

- 审计对象：`plugin-lan-scheduler`（`@local/dsh-lan-scheduler` 0.1.0）P2-P5
- 审计日期：2026-11-20
- 审计员：独立审计会话（只读；未参与实现）
- 审计范围：`docs/01-correctness.md` §2-§12、`lib/scheduler.js`、`lib/index.js`、`tests/scheduler.test.mjs`、`tests/journal.test.mjs`、`tests/plugin.test.mjs`、`tests/fault/run.mjs`、`tests/fault/check.mjs`、`docs/02-fault-injection.md`、`README.md`、`docs/00-立项报告.md`，以及 `tests/fault/artifacts/2026-11-20T12-58-09-828Z/` 原始证据。
- 审计方式：源码逐段核对 + 官方测试复跑 + 独立重算 journal hash 链 + 8 个场景之外的补充探针。未修改 `lib/`、`tests/` 源码，未修改 `docs/01`、`docs/02`。
- 环境：Windows 11 Pro 10.0.26300；Node v24.20.0；工作区不是 git 仓库（无法用 diff 证明“只读”，以文件清单和生成物说明代替）。

## 0. 结论

**Verdict：PASS-WITH-FINDINGS。**

| 级别 | 数量 | 收口含义 |
|---|---:|---|
| Blocker | 0 | 无阻断收口的缺陷 |
| Major | 8 | 应收口前修复或明确降级/写清边界 |
| Minor | 15 | 记录并排期，不阻断本轮 |

一句话结论：**journal 先写后应用、hash 链、fencing 主路径、tick 单飞和 `superseded` 竞态在已覆盖的进程内场景下成立；但“journal 坏行保留备份”、AsyncMutex 串行化、单调时钟三个设计声明与实现不符，`tick` 存在队头饿死，`interconnect.send` 无超时，且 docs/02 把 `Stop-Process` 进程 kill 写成了“断电”，测试矩阵的声明也大于实际测试。** 这些不推翻 P2-P5 的主干，但当前材料还不能支撑“正确性已证明”。

## 1. 实际执行与复现

在 `D:\Codes\DSH小插件\plugin-lan-scheduler` 下执行：

```powershell
node --version
node --test tests/*.test.mjs
node tests/fault/run.mjs
node tests/fault/check.mjs
```

结果：

- `node --test tests/*.test.mjs`：**18 tests, 18 pass, 0 fail, 0 skipped**（597.2485 ms）。
  - `tests/journal.test.mjs` 4 条、`tests/plugin.test.mjs` 1 条、`tests/scheduler.test.mjs` 13 条。
- `node tests/fault/run.mjs`：**8 scenarios, 8 passed, 0 failed**，exit 0；生成 `tests/fault/artifacts/2026-11-20T13-03-30-427Z/`，并把生成物 `tests/fault/fault-report.json` 指向该次运行。
- `node tests/fault/check.mjs`：`audit: PASS`、`failures: []`、`scenarios: 8`，exit 0。
- 目标证据目录 `tests/fault/artifacts/2026-11-20T12-58-09-828Z/` 保持原样；其 `fault-report.json` 为 8/8，`independent-check.json` 为 PASS。
- 独立复核目标目录：8 条 `.journal.jsonl` 的 sha256 链全部可由我自己的实现重算通过；每个场景 `state.json.seq` 等于该场景 journal 最后一条事件的 `seq`；事件数依次为 5/7/9/9/6/5/5/3；每个场景 1 个 task。
- 运行 `run.mjs` 会重写 `tests/fault/fault-report.json` 并新增 artifact 目录；这是任务书允许的生成物。`lib/`、`tests/*.test.mjs`、`tests/fault/run.mjs`、`tests/fault/check.mjs`、`docs/01`、`docs/02` 均未被审计员编辑。

复现命令（目标目录与独立检查）：

```powershell
cd D:\Codes\DSH小插件\plugin-lan-scheduler
Get-Content tests/fault/fault-report.json -Raw
Get-ChildItem tests/fault/artifacts | Sort-Object Name | Select-Object -Last 3
node tests/fault/check.mjs
```

补充探针位于审计临时目录（`%TEMP%\lan-audit-probe.mjs`、`lan-audit-probe2.mjs`、`lan-artifact-audit.mjs`），**未写入仓库**；探针场景在下文对应 finding 中标注为 A-M，可按描述重建。`docs/03` 是本次唯一新增的仓库文件。

## 2. 已确认正确的点

以下不是“看起来对”，而是有代码/测试/独立重算证据的确认项。

1. **journal 先写后应用，顺序正确。**
   `appendEvent()` 在 `lib/scheduler.js:477-483` 以 append 模式打开、写入单行、`fsyncSync`、关闭；`commit()` 在 `:488-494` 先 `appendEvent`，再 `applyEvent`，再 `save()`。不存在“先改内存、后写 journal”的路径。
2. **state.json 原子写。**
   `save()` 在 `:496-519` 使用 `tmp-<pid>-<ts>`、写文件、`fsync`、`rename`；Windows 上跳过目录 `fsync`（`:507-518`），这是已记录的平台限制。
3. **hash 链公式正确，目标证据可独立复算。**
   `appendEvent()` 在 `:474-475` 计算 `sha256(prevHash + stableStringify(body))`；`readJournal()` 在 `:450-454` 用同一公式校验。我用独立实现重算目标目录 8 条 journal，全部通过，且 `state.seq` 与最后事件 seq 一致。
4. **不完整尾行会被截断，且重放可继续。**
   `readJournal()` 把无换行的最后一行视为 tail（`:429-434`），`load()` 在 `:341-348` 截断到 `goodBytes`；`tests/journal.test.mjs:75` 与 F8 均覆盖。
5. **state.json 损坏有备份并从 journal 恢复。**
   `readSnapshot()` 在 `:397-405` 复制到 `state.json.corrupt-<ts>`；`tests/journal.test.mjs:62` 覆盖。
6. **fencing 主路径严格。**
   `ingest()` 在 `:769-787` 依次做 terminal duplicate、active/token 存在性、attempt 匹配、token 匹配；缺 attempt、缺 token、错 token、旧 token 分别返回 `attempt-required`、`lease-token-required`、`stale-lease`、`attempt-mismatch`。`tests/scheduler.test.mjs:176` 与 F4 覆盖；旧 token 在重派后被拒、终态重复不二次写入均成立。
7. **dispatch 崩溃窗口有明确恢复路径。**
   `recoverDispatching()` 在 `:376-388` 把非 `inFlight` 的 `dispatching` 任务通过 `dispatch-failed` 重新入队，旧 token 失效；`tests/scheduler.test.mjs:247` 与 F1 覆盖。注意这是“至少一次重派”，不是 exactly-once，见 docs/01 §4。
8. **tick 单飞成立。**
   `tick()` 在 `:819-825` 返回同一个 `tickPromise`；F7 断言两次 `tick()` 是同一个 promise 且只 send 一次。
9. **`superseded` 竞态成立。**
   `dispatch()` 在 send 返回后于 `:722-752` 重新读取任务，要求仍为 `dispatching` 且 token 未变，否则返回 `superseded`，不覆盖终态；`tests/scheduler.test.mjs:284` 的“完成先于 send 返回”覆盖。
10. **输入上限存在。**
    prompt 上限 256 KiB（`submit`，`:619-668`）；reply 上限 1 MiB（`ingest`，`:760-762`，在 JSON 解析前拒绝）；files 最多 100 条（`:46-48`）。F6 与 `tests/scheduler.test.mjs:231` 覆盖 reply；探针 K 验证 prompt 边界（256 KiB 接受、+1 拒绝）。
11. **工具面与日志面无 token 泄漏。**
    9 个 `sched_*` 工具注册；`sched_list`、`sched_stats` 不返回 `leaseToken`；`logger.warn/info` 不带 token；仓库 docs/README/skill 中无实际 token 值。`sched_status` 和 `sched_ingest` 的拒绝返回完整 task（含 token/prompt），属于协调者本地工具面的信任边界，见 Minor-14。
12. **8/8 可复现，独立 hash 检查可复现。**
    我的运行与目标目录都是 8/8；`check.mjs` 不 import scheduler，独立重算 hash 公式，`audit: PASS` 可复现。其独立性边界见 Minor-12。

## 3. Findings

### 3.1 Blocker

**无。** 没有发现会阻断 P2-P5 收口的确定性缺陷。下述 Major 都是“应收口前修/写清”的问题，而不是“主路径不成立”。

### 3.2 Major（8）

#### MAJOR-01：journal 坏行恢复是破坏性的，且与 docs/01 的“保留备份”声明相反

- 位置：`lib/scheduler.js:338-348`（`load()` 对任何 `journal.truncatedBytes > 0` 都 `fs.truncateSync`）、`:409-462`（`readJournal()` 对坏 JSON/坏事件/seq gap/prev break/hash mismatch 都返回前缀 + `truncatedBytes`，**不备份 journal**）、`:363-366`（snapshot 领先时 “journal wins” 并覆盖 state）。
- 证据（探针 A）：造 3 个 task，把第 3 行改成坏 JSON，重新 `load()`：
  - 只剩第 1 个 task；
  - journal 从 2142 字节被截到 1400 字节；
  - 目录下没有 journal 的 `.corrupt-*` 备份（只有 state.json 有备份路径）；
  - 随后 `save()` 用截断后的状态覆盖 `state.json`。
- 与文档冲突：`docs/01-correctness.md:198` 明确写“坏行保留备份并拒绝其后事件”；实现是“坏行直接截断、丢弃其后事件、不留备份”。`:113` 只要求截断“最后一行不完整”，实现把 mid-file 坏行也当 tail 处理。
- 影响：磁盘位翻转、手工编辑、部分写失败后继续 append 等场景会造成**无备份的数据丢失**；`verify()` 在 load 截断后再跑会基于干净前缀返回 `ok:true`，看门狗无法发现丢事件。
- 建议：在截断前把原 journal 复制为 `.corrupt-<ts>`；只有“最后一个无换行片段”才自动截断；mid-file 解析/链错误应拒绝加载并保留现场，要求人工修复或显式 `--repair`。

#### MAJOR-02：设计声明“AsyncMutex 包裹所有 mutating 操作”，实现没有 mutex

- 位置：`lib/scheduler.js:326-327` 只有 `inFlight = new Set()` 和 `tickPromise = null`；全文件 grep 无 `AsyncMutex`、无 `this._lock`。`docs/01-correctness.md:54`（I7“所有状态变更经过同一个异步互斥”）与 `:135-137`（“`AsyncMutex`（`this._lock`）包裹所有 mutating 操作”）与实现不符。
- 实际安全机制：JS 单线程 + 各 mutating 方法在第一个 `await` 前完成同步检查/写入；`tick` 单飞；`dispatch` 用 `inFlight` 防止同一 task 并发；send 返回后重新读 status/token。
- 证据：18/18 与 8/8 均未出现 double dispatch；`tests/scheduler.test.mjs:272`（并发 tick）、`:284`（完成先于 send）覆盖了两个关键交错。但没有 `submit`/`dispatch`/`ingest`/`tick` 交叉并发的压力测试，也没有对 `recoverDispatching` 与正在 `dispatch` 的任务做系统性交错测试。
- 影响：当前可观察行为没有坏，但“I7 已由 mutex 保证”的论证不成立；以后把某个方法拆出 `await` 或新增 async 步骤，可能引入竞态而测试看不出来。
- 建议：要么实现真正的串行化（mutex/队列），要么把文档改成“依赖事件循环原子段 + tick 单飞 + inFlight + 写后重读”，并补交叉并发压力测试。

#### MAJOR-03：租约用墙钟，不是文档声称的单调时钟

- 位置：`lib/scheduler.js:315` `now = () => Date.now()`；`:727` `leaseUntil = new Date(this.now() + this.leaseMs)`；`:834-835` `Date.parse(leaseUntil) <= now`；`:674` `nextAttemptAt` 同样基于 `this.now()`。
- 文档冲突：`docs/01-correctness.md:41`（F7“用单调时间做租约判定；记录墙钟仅审计”）、`:64`（“租约使用协调者单调时钟”）与实现不符。`docs/01:154` 声称有 clock 单测，实际没有。
- 影响：NTP 回拨会让租约延长（任务晚回收）；前跳会让租约提前到期（可能重复派发/重复执行）。fencing 能阻止旧 token 的“完成”被接受，但不能阻止 worker 已经执行旧消息的副作用；这正是 docs/01 §4 自己承认的边界。
- 建议：用 `process.hrtime.bigint()` 或等价单调源计算 lease/backoff，墙钟只写入 `at`/`leaseUntil` 供审计；补“now 注入回拨/前跳”测试，或明确把 F7 降级为“未实现”。

#### MAJOR-04：`tick` 的队头 `break` 会造成永久饿死

- 位置：`lib/scheduler.js:843-848`：按 priority 降序遍历 queued，若队头任务 `selectWorker(task)` 为 null 就 `break`，不再看后面的任务。
- 证据（探针 C）：一个 priority 10 的任务 `targetInstanceId = dsh-missing`（永远不可满足），一个 priority 0 的任务可由现有 worker 执行；连续两次 `tick()` 都返回 `actions: []`，低优先级任务始终 queued。
- 影响：一个错误 target、一个被移除的 worker、或一个暂时忙的目标 worker，可以永久阻塞所有低优先级任务；这不是“priority 只排 queued”的预期语义，而是 liveness 缺陷。
- 建议：把 `break` 改为 `continue`（记录 `no-idle-worker`），或只在“全局无任何可用 worker”时 break；补“队头不可满足、后续可满足”的回归测试。

#### MAJOR-05：`dispatch` 对 `interconnect.send` 无超时，挂起后进程内无法收敛

- 位置：`lib/scheduler.js:714-721` `await this.interconnect.send({...})`，没有 `AbortSignal`/超时/竞速；`:376-388` 的 `recoverDispatching` 明确跳过 `inFlight`；`:819-825` 的 `tick` 也无法结束这个 await。
- 证据（探针 D）：`send` 返回一个永不 resolve 的 promise；task 保持 `dispatching`、`inFlight=true`；`tick()` 返回 `actions: []`，任务不被回收；手动 resolve 后才进入 `running`。
- 影响：对端 TCP 半开、interconnect 内部卡住、或 send 实现无超时，会让任务永久停在 `dispatching`，只能重启协调者；`recoverDispatching` 的注释“崩溃后重入队”覆盖不到“进程还活着但 send 挂起”。
- 建议：调度器层加 `Promise.race`/`AbortController` 超时；超时按 `dispatch-failed` 重试并记录 `send-timeout`；或者在文档中明确要求 interconnect 必须提供有界 send，并加契约测试。

#### MAJOR-06：畸形/未知状态回执被提交为 `failed`，与 F9“有界拒绝”不一致

- 位置：`lib/scheduler.js:790-798`：`rawStatus` 只有 `succeeded`/`success` 映射成功，其余（包括空、`failed`、拼写错误、非 JSON 文本）一律 `failed`，随后 `:800-807` 提交 `task-failed`。
- 证据：F5（`tests/fault/run.mjs:235-254`）用有效 attempt/token + `text: 'not-json at all'`，断言 `result.ok === true` 且任务 `failed`；`tests/fault/run.mjs:250-252` 明确把这个行为固化为测试。
- 文档冲突：`docs/01:43` F9 期望“有界拒绝；不破坏台账”；`docs/01:235` 又写“F5 畸形回执 → failed”。两处不一致。
- 影响：worker 发了一个带正确 token 的乱码/未知状态回执，任务会被不可逆地判失败；如果 worker 实际成功但回执格式错，协调者会误判并可能重派，造成额外副作用。
- 建议：明确 `status` 闭集；非 `succeeded|success|failed` 的输入返回 `invalid-status` 且不写 task-failed（保持 running 等租约/人工处理），或把“fail closed”写进 F9 并接受误判；两者选一，不能文档两说。

#### MAJOR-07：docs/02 与 README 把 `Stop-Process` 进程 kill 写成“断电”，且真实烟雾不可复现

- 位置：`docs/02-fault-injection.md:39` 标题“dsh-d 断电重派”；`:41` 实际动作是 `Stop-Process -Id 11092 -Force`；`README.md:110` 写“dsh-d 断电后任务 unreachable”；`docs/01-correctness.md:243` 也写“真实四节点只做了断电重派”。`docs/02:37` 的“真实环境烟雾”正文没有给出原始 state/journal、journalctl 或命令输出。
- 关键区别：`Stop-Process` 是**进程终止**，不是**断电**。进程终止不覆盖 OS 页缓存未落盘、目录项丢失、电源掉电下的 fsync 语义；把两者混写会夸大“断电恢复”证据。
- 可复现性：目标机器上没有 `~/.dsh-lan-scheduler/`，仓库也没有这次烟雾的 raw state/journal；审计员只能读到叙述，无法复现 `t-mwozltca-19` / `t-mwozkig0-15`。docs/02 §3 对“未做四节点全矩阵”的声明是诚实的，但“断电”这个词仍应降级为“节点进程被杀”。
- 影响：验收材料对“断电/崩溃持久性”的证据强度高于实际；`state.json`/journal 的 fsync 在 Windows 上的真实掉电行为没有被验证。
- 建议：把标题与 README 改为“dsh-d 进程被杀后重派”；把这次烟雾的 raw state/journal 归档到 `docs/02` 引用的路径，或明确标注“叙述性证据、不可复现”；若要声称断电，需做真实断电/VM 掉电 + 重新挂载测试。

#### MAJOR-08：docs/01 的测试矩阵声明大于实际测试

- 位置：`docs/01-correctness.md:150-156` 声称：随机事件序列 replay、在 dispatch 每个写盘点/发送点注入异常、clock 回拨/前跳、bounds（prompt/reply/queue）、journal corruption。实际：
  - 没有 property/随机 replay；`tests/journal.test.mjs:36` 是固定 round-trip；
  - 没有“每个写盘点/发送点”注入；F1（`tests/fault/run.mjs:90-97`）是直接 `commit('dispatch-started')` 后新建 scheduler，不是真实 crash；
  - 没有 clock 测试（见 MAJOR-03）；
  - 没有 prompt/queue 的单元测试（探针 K 只是审计临时验证）；
  - F8（`tests/fault/run.mjs:301-303`）追加坏 state + 无换行 tail，但 artifact 保存的是**恢复后**的干净 journal，注入现场没有保留。
- 影响：18/18 是真的，但它不等于 docs/01 那张矩阵；`docs/01:226` 的计数正确，`:150-156` 的能力声明不正确。P5 的“全绿”只能证明 8 个确定性场景 + 13 个状态机测试，不能证明 crash point 全覆盖。
- 建议：删除/降级未实现的矩阵行，或补测试；至少在 docs/02 的“可复现证据”里区分“实现边界测试”和“计划中的矩阵”。

### 3.3 Minor（15）

#### MINOR-01：`dispatch-delivered` 不清 `nextAttemptAt`

- 位置：`lib/scheduler.js:237-245` 只改 status/delivery/leaseUntil/updatedAt，不清 `nextAttemptAt`；`docs/01:144` 说“`nextAttemptAt` 成功时清空”。
- 证据：目标 artifact 的 F2/F3 在 `running` 状态仍带未来 `nextAttemptAt`（F2 约 12:58:39、F3 约 13:00:09）；探针 B 在成功重派后仍保留该字段。
- 影响：主要是状态展示/审计噪音；成功完成时 `:274` 会清空，功能上不改变派发。但“running 的任务还在 backoff”会误导排障。

#### MINOR-02：torn tail 不先修复就继续 append，可能丢后续事件

- 位置：`lib/scheduler.js:464-486` 的 `appendEvent` 直接 `open('a')`，不检查文件尾是否完整；`load()` 只在启动时截断。
- 证据（探针 I）：先写入无换行片段 `{"v":1,"seq":`，不重新 load，继续 `submit` 一个合法任务；再重新 load，后一个任务丢失（前缀任务保留）。
- 影响：只有“写失败但进程继续运行、随后又提交”的窄窗口；但一旦发生，journal 中间会出现坏行，触发 MAJOR-01 的破坏性截断。建议 append 前检查/修复尾行，或让写失败直接使 scheduler 进入不可写状态。

#### MINOR-03：`stateFile` 不以 `.json` 结尾时 journal 与 state 同路径

- 位置：`lib/scheduler.js:320`：`journalFile = journalFile || stateFile.replace(/\.json$/i, '.journal.jsonl')`。若 `stateFile` 是 `.../state`，`journalFile === stateFile`。
- 证据（探针 H）：state 文件开头变成 pretty JSON；重新 load 后 task 还在，但 `verify()` 为 false；重复 load 会反复截断/重写，具有破坏性。
- 影响：配置边缘；默认路径以 `.json` 结尾，正常安装不触发。建议对 `journalFile === stateFile` 直接抛错。

#### MINOR-04：`MAX_SUMMARY_BYTES` 实际按字符截断

- 位置：`lib/scheduler.js:24` 定义 `16 * 1024`；`:792-793` 用 `String(...).slice(0, MAX_SUMMARY_BYTES)`（按 UTF-16 code unit）。
- 证据（探针 J）：20,000 个“汉”字被存成 16,384 字符 = 49,152 字节，约 3 倍于 16 KiB；per-file 字符串长度也没有上限（只有 `MAX_FILES=100`）。
- 影响：边界名为 BYTES、行为是 chars；CJK 场景下磁盘/内存上限被放大。建议改名 `MAX_SUMMARY_CHARS` 或用 `Buffer.byteLength` 截断。

#### MINOR-05：首事件 `prev` 未校验

- 位置：`lib/scheduler.js:447-454` 只在 `prevHash !== null` 时检查 `event.prev`；第一条事件的 `prev` 可以是任意值，hash 公式用的是 `prevHash ?? ''`，不绑定 `event.prev`。
- 证据（探针 E）：把首事件 `prev` 改成 `TAMPERED`、保留原 hash；重新 load 接受，`verify().ok === true`。
- 影响：首事件来源/链头可被伪造而不被发现；后续事件仍绑定首事件 hash，所以影响有限。建议首事件要求 `prev === null`。

#### MINOR-06：空行校验器不一致

- 位置：scheduler 的 `readJournal` 在 `:425-427` 静默跳过中间空行；`tests/fault/check.mjs:43-45` 把中间空行判为 `blank line` 失败。
- 证据（探针 G）：同一 journal，scheduler load + verify 通过，check.mjs 会失败。
- 影响：两个“权威”校验器对同一文件给出不同结论；故障注入产物若被手工加空行，会出现“运行通过、审计失败”。

#### MINOR-07：Windows 上 `0o600` 不生效，且目录 fsync 被跳过

- 位置：`lib/scheduler.js:477`、`:499` 的 `0o600`；`:507-518` 在 `win32` 跳过目录 fsync。`docs/00:105` 与 `SKILL.md:170-171` 声称 `state.json` 权限 600。
- 证据（探针 F）：本机 state/journal 的实际 mode 是 `666`（Windows 上 Node 的 mode 参数不映射为 POSIX 权限；最终权限由父目录 ACL 决定）。没有证据表明默认 ACL 对其他本地用户可读，但不能用“0600”作为保证。
- 影响：台账含 prompt/token；安全声明应改成“依赖父目录 ACL，Windows 上 0600 不保证”。目录 fsync 跳过是平台限制，docs/01:115 提到“记录限制”，但 docs/00/skill 没有同步。

#### MINOR-08：journal 与任务队列均无上限/无轮转

- 位置：`lib/scheduler.js:464-486` 只 append；`:413` 每次 load 读全文件；`submit()`（`:619-668`）没有 `tasks` 数量/队列长度上限；`docs/01:55` I8 说“prompt、回执、队列、journal 都有明确上限”，`:65` §4 又说“不保证无限保留、轮转是后续工作”。
- 影响：长期运行磁盘增长；load 的耗时/内存随事件数线性增长；大量 queued 任务会无限占用内存并放大 MAJOR-04 的饿死面。建议至少加 journal 大小监控、队列/任务数上限，或在文档里把 I8 的“队列/journal 上限”改为“当前无上限，已知限制”。

#### MINOR-09：README/docs/00 的测试数与退避描述过时

- 位置：`README.md:5`“单元测试 9/9”与 `README.md:108`“18/18”自相矛盾；`README.md:80`、`docs/00:76` 写“30s 起指数退避 / `30s*2^(attempts-1)` 封顶 10min”，实现是 `:674` `30s * attempts` 封顶 300s（线性）；`docs/00:60`“0.1.0 不做 WAL”也已过时。
- 影响：读者会按指数退避估算重试时间，实际第 1/2/3 次是 30s/60s/90s（上限 300s），不是 30s/60s/120s；测试数会让验收者误判基线。

#### MINOR-10：docs/01 的 lastSeq/replay、恢复 backoff、旧 token 兼容三处与实现不符

- 位置与差异：
  - `docs/01:112` 说 `state.json` 带 `lastSeq`、从 `lastSeq+1` 重放；实现 `emptyState()`（`:62-64`）没有 `lastSeq`，`load()`（`:359-365`）重放**全部**事件。
  - `docs/01:140` 说 recovered dispatching 的 `nextAttemptAt=now`；实现 `recoverDispatching()`（`:376-385`）走 `retryOutcome()`，是 `now + 30s*attempts`。
  - `docs/01:131` 说旧格式无 token 回执“只允许在 task 没有 token 的历史/迁移数据上接受”；实现 `:771-774` 对没有 `leaseToken` 的任务一律 `task-not-active:<status>`，并未提供迁移接受路径；`docs/01:130` 的拒绝原因列表也没有 `task-not-active`。
- 影响：迁移旧台账时按文档会预期可接收，实际会被拒；恢复时机与文档不一致。

#### MINOR-11：`dispatched` 是死状态

- 位置：`lib/scheduler.js:18-19` 把 `dispatched` 列入 ACTIVE；`:832` 也检查它；但 `applyEvent` 只产生 `dispatching`/`running`，`dispatch` 从不写 `dispatched`。`docs/01:129` 仍把 `dispatched` 列为可接受状态。
- 影响：状态机/代码有未使用分支；若未来有人手工造 `dispatched`，租约逻辑会把它当 running 处理但没有 `leaseUntil`，行为不明确。建议删除或明确保留为兼容态。

#### MINOR-12：`check.mjs` 的独立性只覆盖 hash 链

- 位置：`tests/fault/check.mjs:82-94`：`result.pass`、`result.verify?.ok` 直接来自 `run.mjs`/scheduler 的自报；`check.mjs` 只独立重算 journal hash 链（`:34-78`）和 succeeded-with-error 不变量，**没有读取/重放 `state.json`**。
- 评价：`docs/02:21` 说“独立重算 journal sha256 链”是准确的；但不能把 `8/8 PASS` 说成完全独立复算。至少加一条：从 journal replay 出 tasks，与 artifact 的 `state.json` 做字段对比（这正是 docs/01:187 要求的 raw evidence 审计）。
- 影响：scheduler 的 `verify()` 如果有系统性 bug，check 仍可能 PASS；当前 hash 链独立，但状态语义不是。

#### MINOR-13：`removeWorker` 可移除仍有 queued 任务的 worker；`stats.idleWorkers` 名不副实

- 位置：`lib/scheduler.js:588-595` 只用 `ACTIVE` 判断（queued 不算 active，所以可移除）；`:881` 的 `idleWorkers` 用 `isWorkerAvailable`（active < maxConcurrent），不是“空闲”。
- 影响：移除后 queued 任务仍带旧 `workerId`；若任务**有 targetWorkerId**，它会永久 queued（叠加 MAJOR-04），无 target 时通常还能被其他 worker 选中，但 `workerId` 显示已失真。统计会高估空闲 worker。建议 remove 前检查 `activeTasksFor`（含 queued），或把 queued 任务重新分配；统计改名 `availableWorkers`。

#### MINOR-14：`sched_status`/`sched_ingest` 拒绝路径暴露完整 task（含 token/prompt）

- 位置：`lib/index.js` 的 `sched_status` 返回完整 task；`lib/scheduler.js:773/778/781/784/787` 的拒绝返回 `task`；`sched_ingest` 的 `task` 含 `leaseToken`/`prompt`。
- 评价：这是协调者本地工具面，token 是能力而不是登录凭据；日志无泄漏（已确认），`sched_list/stats` 也脱敏。风险是“任何能调 `sched_status` 的会话都能拿到 token 并冒领完成”，没有 caller/worker 绑定。当前单协调者信任模型下可接受，但应在 docs/skill 明确“token 等同于完成权限，不要转发/打印”。
- 建议：至少在 `sched_status` 的说明里标注敏感字段；若未来多会话共享协调者工具面，考虑按 caller 校验 owner。

#### MINOR-15：README/skill 未完整承载 docs/01 §4 的“明确不保证”

- 位置：`docs/01:58-69` 要求“必须写进 README/skill”；`README.md:88` 只写了 exactly-once 一条；`skills/lan-scheduler/SKILL.md:158-174` 覆盖 at-least-once/exactly-once，但没有“恶意 worker 可执行旧消息”“租约用协调者时钟（且实现目前是墙钟）”“journal 不保证无限保留”三条。
- 影响：worker 作者/运维可能误以为调度器能阻止旧 worker 的副作用，或以为 journal 会自动轮转。建议把 §4 四条原样补进 README 和 skill，并同步 MAJOR-03 的时钟事实。

## 4. docs/02 声明与 artifacts 的逐条核对

| docs/02 声明 | 核对结果 | 证据/说明 |
|---|---|---|
| “8/8 场景全部 pass” | **成立** | 目标目录 `fault-report.json` 8/8；我的复跑 `2026-11-20T13-03-30-427Z` 也是 8/8。 |
| “`check.mjs` 独立重算 sha256 链，`audit: PASS`，`failures: []`” | **hash 链部分成立，整体略强** | 独立重算 8 条 journal 全部通过；但 `check.mjs:82-94` 的 `pass`/`verify` 取自 run/scheduler 自报，且不 replay `state.json`（MINOR-12）。 |
| “每个场景保留 journal/state，可直接重放” | **大部分成立，F8 有保留偏差** | 8 个场景都有两份文件；F8 保存的是恢复后的干净 journal，注入的坏 state/无换行 tail 没有原样保留，不能据此复现注入现场（MAJOR-08）。 |
| “F1 进程重启，未 send” | **不精确** | `tests/fault/run.mjs:90-97` 是直接 `commit('dispatch-started')` 后新建 scheduler，没有真实进程崩溃/重启；只能证明“重启后 load 的行为”，不能证明“崩溃点覆盖”。 |
| “F2 send 抛错（可能已送达）” | **不精确** | FakeInterconnect 在 `send` 开头抛错（`run.mjs:28-36`），没有“已送达但响应丢失”的分支；F2 实际是同步抛错重试。 |
| “真实 dsh-d 断电重派” | **过度声明** | 实际动作是 `Stop-Process`（`docs/02:41`），是进程 kill，不是断电；README:110 进一步写成“断电”；没有 raw state/journal，无法复现（MAJOR-07）。 |
| “带 token 回执在 dsh-a 实跑成功” | **不可从仓库复现** | docs/02:52-55 只有叙述；没有 artifact/命令输出。代码路径有 F4/单测覆盖，但“真实环境”这一条无法由审计员验证。 |
| “未做四节点 SIGKILL 全矩阵、真实分区、时钟漂移、pcap” | **成立，且是加分项** | `docs/02:58-65` 明确列出，并说“不应被 8/8 冒充”；这一点应保留。 |
| “只有节点断电一条” | **措辞错误** | 应为“只有节点进程被杀一条”（MAJOR-07）。 |

结论：**8/8 与独立 hash 链审计本身没有夸大，均可复现；被夸大的是“断电”语义、F1/F2 的故障精度、以及“测试矩阵已覆盖”的暗示。** docs/02 的 §3 限制声明是诚实的，问题主要在标题/README 的用词和缺少 raw evidence。

## 5. 对“能否证明正确”的边界判断

**能证明的：**

- 在**单协调者进程 + 合作 worker + 事件循环内**的模型下，已覆盖路径的语义正确：
  - journal 先 append+fsync 再 apply，state 是派生缓存；
  - 正常 journal 的 hash 链可独立复算；
  - 不完整尾行可截断并继续；
  - attempt/token fencing 的接受/拒绝顺序正确；
  - terminal 幂等；
  - tick 单飞；
  - send 返回后的 `superseded` 不覆盖终态；
  - prompt/reply 的主边界。
- 这些有 18 个单测、8 个故障场景、目标 artifact 的独立重算支撑，**不是空口宣称**。

**不能证明的：**

- 真实**断电**下的持久性：Windows 目录 fsync 被跳过，`0o600` 不生效；没有掉电/重新挂载测试。`Stop-Process` 不能替代。
- 真实四节点的 SIGKILL/网络分区/时钟漂移全矩阵；docs/02 自己承认只做了两条烟雾，且不可从仓库复现。
- **exactly-once 副作用**：设计已明确不保证；旧 worker 可能执行两次，fencing 只保证“最多一个完成被接受”。
- **恶意/失控 worker**：可以执行旧消息、伪造回执、发超大/畸形文本；调度器只做有界拒绝，不能阻止副作用。
- **多协调者共享台账**：单写者假设；没有文件锁/租约协调。
- **mid-file journal 损坏**：当前实现会无备份截断（MAJOR-01），不能证明“可恢复”；这是本次审计最实质的持久性缺口。
- **高并发/任意交错**：没有 mutex（MAJOR-02），只证明了少数交错；事件循环原子段是隐式假设，不是显式不变量。
- **send 挂起**：无超时（MAJOR-05），进程内不能收敛。
- **队头不可满足**：会永久饿死后续任务（MAJOR-04）。

因此，准确的表述是：**“在已建模的确定性边界内，核心机制有可复现证据；但不能说‘正确性已被证明’，也不能把 8/8 当成四节点/断电矩阵。”** 这正好对应 docs/01 §4 的原始边界声明；本次审计建议把 §4 的边界再收紧到实现事实（时钟、mutex、journal 损坏恢复）。

## 6. 收口建议（给 lead）

建议 **按 PASS-WITH-FINDINGS 收口，但不要直接把当前文档当成“正确性已证明”**。收口前优先处理三件会改变结论可信度的事：①修 MAJOR-01（journal 坏行先备份、只截断真正 tail；否则一次坏行就是无备份丢数据，且与 docs/01:198 相反）；②修 MAJOR-04/05（`break` 改 `continue`、send 加超时；这两个是可直接构造的 liveness 缺陷）；③把 MAJOR-02/03 的文档声明改成实现事实，或补 mutex/单调时钟——现在的 I7/F7 是“写了但没做”。MAJOR-06 需要产品决策（畸形回执是 fail-closed 还是拒绝），决定后同步 F9 与 P5 文案。MAJOR-07/08 是证据纪律：把“断电”改为“进程被杀”，把 F1/F2/F8 的注入精度写清楚，并把 docs/01 的测试矩阵降级为“已实现/计划中”两栏；否则下一轮审计仍会卡在“声明大于证据”。Minor 中 MINOR-01/02/03/07/12 建议顺手修（成本低、直接影响可审计性），其余排入 backlog。最后，建议把本报告的“能证明/不能证明”边界原样补进 README/skill——这比再补一个 8/8 场景更能防止误用。

---

### 附：本次审计未做的事（避免误读）

- 未做真实四节点 SIGKILL/网络分区/时钟漂移/pcap；这些不在本次只读审计的可执行范围。
- 未复现 docs/02 的 dsh-d 烟雾（本机没有 `~/.dsh-lan-scheduler/`，仓库也没有 raw state/journal）。
- 未做形式化证明、模型检查或 property-based 随机测试；结论是“代码审查 + 已执行测试 + 定向探针”的工程判断。
- 未修改任何源码/测试/`docs/01`/`docs/02`；`tests/fault/fault-report.json` 与新增 artifact 是运行 `run.mjs` 的生成物。
- 报告中的 lease token 一律以字段名指代，未复制任何实际 token 值。
