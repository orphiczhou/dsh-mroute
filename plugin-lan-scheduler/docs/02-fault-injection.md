# 02 · 故障注入与验收证据

日期：2026-11-20。对象：`plugin-lan-scheduler` 的 P2-P5 正确性深化。
本文件记录**实际跑过的**故障与证据；未跑的四节点全矩阵明确列为限制，不冒充。

## 1. 边界级确定性故障（8/8）

命令：

```bash
cd plugin-lan-scheduler
node tests/fault/run.mjs
node tests/fault/check.mjs
```

最近一次原始证据目录：

`tests/fault/artifacts/2026-11-20T13-29-13-863Z/`

- 8 个场景全部 `pass: true`；
- `check.mjs` 独立重算 journal sha256 链，输出 `audit: PASS`，`failures: []`；
- 每个场景保留 `.journal.jsonl` / `.state.json`，可直接重放。

| 场景 | 注入 | 观测 |
|---|---|---|
| F1 | `dispatch-started` 已 journal，进程重启，未 send | 任务 requeued，`lastError=recovered-dispatch` |
| F2 | send 抛错（可能已送达） | 任务 queued，重派 token 改变 |
| F3 | 连续两次 `ECONNREFUSED` | attempts 1→2→3，第三次 running |
| F4 | 租约过期后旧回执 | `stale-lease`；新 token 接受，summary `new lease wins` |
| F5 | 非 JSON 回执 | `invalid-status`，任务保持 running，台账不变 |
| F6 | 1 MiB+1 字节回执 | `reply-too-large`，任务保持 running |
| F7 | 两个并发 `tick()` | 同一个 promise，只 send 一次 |
| F8 | `state.json` 损坏 + journal 尾行截断 | replay 存活，`verify().ok` |

单元测试总数：`node --test tests/*.test.mjs` → **23/23 pass**。

## 2. 真实环境烟雾

### 2.1 dsh-d 进程被杀后重派（不是断电）

- 动作：在 `.24` 上 `Stop-Process -Id 11092 -Force`，确认 3081 无监听；这是**进程终止**，不覆盖 OS 页缓存/电源掉电语义。
- A 向 `dsh-d` 提交 `t-mwozltca-19`（title `outage-d`，target `dsh-d`）：
  - 返回 `status: queued`, `lastError: "unreachable"`, `nextAttemptAt` 约 +30s；
  - 原始回执含 `attempts: 1`。
- 重启计划任务 `DSH-LAN-D`，D 恢复监听（PID 9240）。
- A 的自动 tick 在重试窗口后把任务重派为 `running`（`attempts: 2`，`workerId: w-11`）。
- 随后 `sched_cancel t-mwozltca-19 outage-test-done` 收口，未让 lease 空转。
- 结论：节点进程不可达 → queued + backoff → 节点恢复 → 自动重派，链路成立。
- **证据强度**：叙述性证据；仓库没有这次烟雾的 raw state/journal，目标机也没有对应归档，无法从本仓复现。要声称“断电持久性”，需做真实断电/VM 掉电 + 重新挂载测试。

### 2.2 带租约的真实回执

- A 提交 `t-mwozkig0-15`（title `lease-smoke`，worker `w-1`/dsh-b）。
- 派发结果：`status: running`, `attempts: 1`, `leaseToken: lt-...`（token 不写入本文件/仓库）。
- worker 回执后，A 调 `sched_ingest`，同时带 `taskId`、`attempt: 1`、`lease_token`；
  返回 `ok: true`、任务 `succeeded`、`result.summary: LEASE_SMOKE`。
- 结论：生产代码的 fencing 字段端到端可用；旧/缺 token 的拒绝由确定性 F4/F5 覆盖。

## 3. 明确未做

- 未做四节点 SIGKILL 全矩阵（协调者被杀、worker 被杀、双杀）；
- 未做真实网络分区（本机无 iptables/nft；只有 dsh-d 进程被杀一条）；
- 未做真实断电/页缓存丢失/重新挂载；
- 未做真实时钟漂移；
- 未做 pcap 级抓包。

这些是后续 chaos 工作，不应被本文件的 8/8 冒充。当前可复现证据是：
边界级 8 场景 + 23 单测 + 两条真实烟雾（进程被杀无 raw 归档）+ 独立 hash 链审计。
