# dsh-lan-scheduler · 插件级会话上下文

> 只写本插件特有约定；通用规则见工作区根 [AGENTS.md](../../AGENTS.md)。

## 1. 本插件一句话

在协调者 DSH 上提供 `sched_*` 工具：登记 `dsh-interconnect` 的活会话为 worker，维护一份 JSON 台账，做任务提交/重试/租约/回执；不新开端口、不写第二套网络协议。

## 2. 本插件特有坑

- **`self` 不是“本机自动可用”**：`selfOrigin()` 固定 `http://127.0.0.1:<port>`；若 DSH `--host` 绑定具体 LAN IP，loopback 未监听，link 永远 down（实测 `ECONNREFUSED 127.0.0.1:3081`）。同机派活请在 `peers` 写固定 origin，如 `dsh-a: http://192.168.3.23:3081`。
- **Windows sandbox TEMP**：`.24` 上 `TEMP/TMP` 落在 workspace 内会触发
  `sandbox-local: windows-acl temp root must be outside the workspace`，该会话所有 `pwsh` 在命令前失败。启动脚本设 `$env:TEMP/$env:TMP = 'C:\Windows\Temp'` 并重启 DSH。
- **长 prompt 截断**：用 `session/prompt` 驱动 agent 时，多步清单会被截断（实测只到 `label:A`，agent 反复 `ask_user_question`）。登记/派活/查询都**一次一个动作**。
- **worker 需要 standing rule**：worker 会话必须知道收到 `[LAN-SCHED TASK v1]` 后用工具执行，并 `interconnect_reply` 回纯 JSON；不要在回合里 `wait_agent` 等回复。
- **`state.json` 是运行态**：`~/.dsh-lan-scheduler/state.json` 含任务与 worker；换协调者/清库前备份。`sched_worker_register` 幂等（instanceId+sessionId），失败任务和旧 worker 不会自动清理。
- **`sched_ingest` 是最后一跳**：worker 回执原文交给它；活任务必须同时带匹配的 `attempt` + `lease_token`（来自派发信封），否则返回 `attempt-required`/`lease-token-required`/`attempt-mismatch`/`stale-lease`，台账不变；非 JSON/未知 status 返回 `invalid-status`，**不落 failed**。
- **journal 是 source of truth**：同目录 `.journal.jsonl` 先 `fsync` 再应用，`state.json` 只是派生缓存；`load()` 会重放 journal 并把未完成的 `dispatching` 任务重新入队（旧回执被 token 拒绝）。**mid-file 坏行会拒绝 load** 并复制 `.corrupt-*`，只自动截断末尾无换行 tail；追加前要求最后字节是 `\\n`。
- **并发/时钟边界**：没有通用 AsyncMutex；靠事件循环同步段 + `tick` 单飞 + `inFlight` + send 后重读。租约用墙钟 `Date.now()`，NTP 跳变会影响租约。`dispatchTimeoutMs` 默认 15s，超时记 `send-timeout`。
- **单写者**：一个台账只应由一个协调者进程写；多协调者共享同一 state 文件会互相覆盖。journal/任务数量无上限。
- **多节点发布**（2026-11-20）：插件已装到 A/B/C/D，但**只有 dsh-a 是 active coordinator**；B/C/D 只提供工具面与空台账。同机 A/B 必须用 `DSH_LAN_SCHEDULER_STATE` 分台账（B 为 `~/.dsh-lan-scheduler-b/state.json`），C/D 默认路径各自独立。
- **B 的 systemd 203/EXEC**：用 `{...}>run.sh.new; mv` 改 `run.sh` 会丢可执行位；`chmod 755` 后 `systemctl --user restart dsh-lan-b` 才 active。
- **D 的误装**：Windows 远程 `dsh.cmd plugin add` 必须先显式 `DSH_HOME=C:\Users\User\.dsh-lan-d`（用 `powershell -EncodedCommand`），否则会装进默认 `.dsh`；用 `.dsh-lan-d\profiles\lan\package.json` 的 `bundles` 是否含 `@local/dsh-lan-scheduler` 复核。

## 3. 关键文件地图

- `package.json` — `@local/dsh-lan-scheduler` 0.1.1；`dsh.bundle.patch` 指向 `cordis.patch.yml`。
- `cordis.patch.yml` — 只 insert `lan-scheduler` 一行，配置由 profile 的 patch 覆盖。
- `lib/index.js` — 宿主入口：`inject=['tools','interconnect']`，注册 9 个 `sched_*` 工具。
- `lib/scheduler.js` — 纯逻辑：worker/task 状态机、选 worker、租约 fencing、重试、journal/replay、崩溃恢复。
- `skills/lan-scheduler/SKILL.md` — 使用说明 skill（协议、工具、worker standing rule、四节点实测、坑）。
- `tests/scheduler.test.mjs` — 状态机/重试/租约/fencing/恢复/并发/send 超时/invalid-status 单测。
- `tests/journal.test.mjs` — journal 重放、损坏恢复、mid-file 拒绝/备份、截断、hash 篡改。
- `tests/plugin.test.mjs` — 工具注册与参数/返回形状冒烟。
- `tests/fault/` — 8 场景确定性故障注入 + 独立 hash 链审计。
- `docs/01-correctness.md` — 失败模型/不变量/journal/fencing/测试矩阵/实施状态。
- `docs/02-fault-injection.md` — 故障注入证据与“未做”边界。
- `docs/03-independent-audit.md` — P6 独立审计原文（不改）。
- `README.md` — 对外说明；`docs/00-立项报告.md` — 设计与验收。
