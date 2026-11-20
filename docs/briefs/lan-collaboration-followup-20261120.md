# 局域网多机 DSH / OpenClaw 协作：四项跟进结论（2026-11-20）

> 范围：`.21`（Ubuntu，OpenClaw 宿主）、`.23`（Ubuntu）、`.24`（Windows 10）。
> 基线：四实例 `dsh-a/b/c/d` 已通过 `dsh-interconnect` 完成双向会话消息；本文件回答用户 m01603 的四项要求。
> 证据：安装/连通记录见 `lan-dsh-interconnect-test.md`；OpenClaw 细节见 `openclaw-dsh-integration-assessment.md` §7；mesh 细节见 `dsh-mesh-capability-assessment.md`。

## 1. 各机器 DSH 安装：已完成并验证

| 机器 | 版本 / 位置 | Node | 原生模块 | 终端工具 | 其他 |
|---|---|---|---|---|---|
| `.21` | DSH 0.2.2-rc.3，`~/.local/dsh-cli`（前缀布局，顶层 `node_modules`） | v24.22.3 | `node-pty`/`koffi`/`dsh-subprocess-local` require OK；pty spawn EXIT=0 | `terminal`/`pty`/`subprocess` 均在 `--dump-config` 中 | `rg` 14.1.0；`/usr/local/bin/dsh` 符号链接 |
| `.23` | DSH 0.2.2-rc.3，`~/.local/dsh-cli`（`bin/dsh -> ../lib/node_modules/...`） | v24.22.3 | 原生模块在 `lib/node_modules/@deepseek-ai/dsh/node_modules` 下；require OK | 同上 | `rg` 已有；`/usr/local/bin/dsh` 符号链接 |
| `.24` | DSH 0.2.2-rc.3，全局 `C:\Users\User\AppData\Roaming\npm` | v24.13.0 | `node-pty`/`koffi`/`dsh-subprocess-local` 均存在且 require OK；pty spawn `PTY_OK_24` EXIT=0 | 同上 | `dsh.cmd`/`npm.cmd`；`rg` 14.1.1 已放全局 bin；计划任务 `DSH-LAN-D` |

结论：三台机器的 DSH **不是“只装了个壳”**——HTML web、模型调用、pty/subprocess 原生依赖均实测可用。`.24` 之前“`--ignore-scripts` 导致原生依赖未编译”的判断已被 pty 实测推翻。

## 2. 网络方式：按用户要求走局域网直连，不用 SSH 隧道

- 四实例监听：`dsh-a` = `192.168.3.23:3081`，`dsh-b` = `192.168.3.23:3082`，`dsh-c` = `192.168.3.21:3081`，`dsh-d` = `192.168.3.24:3081`。
- `.21/.23` 用 systemd 用户服务（`dsh-lan-a/b/c.service`，`Linger=yes`）；`.24` 用计划任务 `DSH-LAN-D`（S4U、最高权限、AtLogOn）+ Windows 防火墙入站规则 `DSH LAN 3081`。
- 当前全为**明文 HTTP/WS**，仅适用于可信网段。DSH 启动时会明确警告；`.21` 的 OpenClaw Gateway `18789` 还监听在 `0.0.0.0`，建议单独用防火墙限制，或改回 loopback。
- 安全边界：`DSH_INTERCONNECT_TOKEN`、launch token、DeepSeek key 只在启动环境/受限文件中，未写入仓库；Linux 侧 600，Windows 侧 ACL 收紧到当前用户。

## 3. OpenClaw：深度桥接难，ACP 轻量接入已成功

### 3.1 结论

- **深度桥接（把 OpenClaw 会话投影成 DSH peer、双向事件流）**：难度中高，受 `operator scopes` 与工具白名单硬阻塞；原报告 §2 已列。
- **轻量 ACP 委派（本次新增，已实测）**：难度低。DSH 用 `@deepseek-ai/dsh-subagent-acp@0.2.2-rc.3` + `@deepseek-ai/dsh-tool-subagent` 把 `openclaw acp` 当外部子代理拉起；**不需要 operator scope，也不需要改 OpenClaw**。
- 覆盖范围：DSH agent 可以向 OpenClaw agent 发一次任务、拿到最终文本；**不覆盖** OpenClaw 终端/管理面、会话列表、文件传输、反向调用。

### 3.2 生产接入

`.21` 的 `~/.dsh-lan-c` 已加：

```yaml
- insert:
    - id: subagent-acp
      name: '@deepseek-ai/dsh-subagent-acp'
      config:
        providerName: acp
        command: /home/orphic/.npm-global/bin/openclaw
        args: [acp, --url, ws://127.0.0.1:18789, --session, agent:main:main]
        permission: reject
    - id: tool-subagent-openclaw
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: acp
        toolName: subagent_openclaw
        maxDepth: provider-managed
```

实测：C 的新会话调用 `subagent_openclaw`，OpenClaw 最终返回 `ACP_PROD_OK`；C 的 assistant 最终文本原样包含该结果。C 重启后 `interconnect_peers` 仍显示 a/b/d 全 up，说明 ACP insert 不影响原 interconnect。

### 3.3 注意事项

1. `--session agent:main:main` 必填；不带时 prompt 阶段 `category: transport` 失败。建议后续换专用 key（如 `agent:main:dsh-bridge`）隔离用户主会话。
2. 工具是**异步**的：立即返回 `started subagent agent-1`，最终答复在下一轮完成通知里；不要在当轮反复 `wait_agent` 阻塞。
3. `permission: reject` 会拒绝 OpenClaw 侧权限请求；需要工具审批时改 `allow` 并评估。
4. 只适合本机可信用户：`openclaw acp` 走本地 CLI 信任域，不是 operator token 面。

## 4. dsh-mesh：有搬运/代跑零件，没有调度体系

| 维度 | dsh-mesh 能力 | 判定 |
|---|---|---|
| 文件传输 | `file_read_chunk` / `file_write_chunk` / `file_hash` 三个分块原语 | **有零件，无成品**：无 push/pull 编排、无清单、无断点、无原子落盘 |
| 跨机任务 | `delegate` 在对端新建 DSH 会话并异步跑，靠轮询 `status.json` 取结果 | **点对点代跑**：无超时、无重试、无队列、无优先级 |
| 调度 | 工具级异步作业，`task_*` 只是本机后台作业 | **无调度器**：无 cron/DAG/租约/依赖/审计 |
| 与 interconnect | interconnect = 消息面；mesh = 工具面 | 互补，不重叠 |
| 最大隐患 | ACL 只在 mesh 工具分发处校验；delegate 起的会话拥有目标 profile 完整工具集 | 护栏主要是提示词，不是强制沙箱 |

**回答“任务分派和调度体系是否没有建立起来？”：是的。** 现在只有“会话消息互通 + 点对点代跑”，没有任务注册表、状态机、队列、优先级、重试、依赖、租约和审计。`dsh-mesh` 补的是跨机执行通道，不是调度层。

> **2026-11-20 增补**：上表是“薄调度层落地前”的快照。现已新增 `plugin-lan-scheduler`（`@local/dsh-lan-scheduler` 0.1.1），补了任务注册表、JSON 台账、queued 排序、租约/退避重试、`sched_ingest` 回执；四节点各派一单全部 succeeded，并已发布到四实例完成组网 E2E。仍无 DAG/抢占/文件传输/多协调者共享台账。

## 5. 建议的最小下一步

1. **保留现状**：`dsh-interconnect` 做消息/唤醒面；`.21` 的 `dsh-c` 保留 ACP 工具，作为受控 OpenClaw 委派通道。
2. **任务层薄自研（700–900 行）**：任务表（SQLite/JSONL）+ 状态机（pending/assigned/running/blocked/done/failed）+ 重试/租约/幂等 + 审计 + 文件清单；dispatcher 可先放 `.23` 的 A 或单独常驻进程；worker 用现有 DSH 会话，通过 interconnect 接任务、回结果。
3. **mesh 只在需要时灰度**：只在对端新建会话或跨机传文件时引入，单节点最小 ACL，默认关闭 `shell_run`/`pc_*`/`channel_send`。
4. **安全**：给 `.21` 的 18789/3001/5001 加网段限制；如果以后要跨不可信网络，再上 TLS/隧道；当前按用户要求保持 LAN 直连。

## 5A. 2026-11-20 增补：薄调度层已落地

- 代码：`D:\Codes\DSH小插件\plugin-lan-scheduler\`（`@local/dsh-lan-scheduler` 0.1.1，MIT，无第三方运行依赖）。
- 协调者：`dsh-a` `.23:3081` 装插件；四个 worker 会话登记为 `w-1` B / `w-2` A / `w-3` C / `w-13` D。
- 工具：`sched_worker_register/list`、`sched_submit/status/list`、`sched_ingest/tick/cancel/stats`。
- 实测：四节点各派 `RUN_PROBE`，全部 `succeeded`（A `t-mwow229w-8`、B `t-mwovzopg-7`、C `t-mwow516f-9`、D `t-mwowf6nd-14`）；单元测试 **23/23**，故障注入 8/8 + 独立 hash 链 PASS，P6 审计 PASS-WITH-FINDINGS → 复审 PASS。
- **2026-11-20 晚发布与组网 E2E**：插件已装到 A/B/C/D 四实例，只有 dsh-a 为 active coordinator；B 用 `~/.dsh-lan-scheduler-b/state.json` 与 A 分台账，C/D 用各自默认台账。dsh-a 协调者会话 `session-b911ca40-b324-4085-90d4-a051d8c13db9` 连续提交四单：B `t-mwp1kdiz-25`、C `t-mwp1l21c-29`、D `t-mwp1ljr2-33`、A `t-mwp1m06j-37`，均 `attempts=1`、`succeeded`；B/C/D 的 `sched_stats` 各自返回空台账（`tasks:0`、`seq:0`）。skill 已同步四节点，15593 字节。
- 关键坑：`self` 在 LAN IP 绑定下解析到未监听的 127.0.0.1；`.24` 的 `TEMP/TMP` 必须在 workspace 外；长多步 prompt 会截断；B 的 `run.sh` 用 `mv` 重写丢可执行位会 203/EXEC；Windows 远程装插件不显式 `DSH_HOME` 会误装默认 `.dsh`。
- 边界：仍无 DAG/抢占/文件传输/多协调者共享台账；`state.json` 保留调试期失败任务与旧 worker。
- 文档：`plugin-lan-scheduler/README.md`、`AGENTS.md`、`docs/00-立项报告.md`、`skills/lan-scheduler/SKILL.md`。

## 6. 证据索引

- 安装/连通/系统服务：`D:\Codes\DSH小插件\docs\briefs\lan-dsh-interconnect-test.md`（§5.5、§5.6、§8）。
- OpenClaw ACP 实测与配置：`D:\Codes\DSH小插件\docs\briefs\openclaw-dsh-integration-assessment.md` §7。
- mesh 源码级评估：`D:\Codes\DSH小插件\docs\briefs\dsh-mesh-capability-assessment.md`（§0、§2.1、§3.1、§5）。
- 关键现场：C 会话 `session-94b5323d-281f-49cf-8e8d-43512a45b2b4` 的 `ACP_PROD_OK`；C 的 `interconnect_peers` 三 peer 全 up；三机 pty spawn 通过。