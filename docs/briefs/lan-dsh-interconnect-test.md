# DSH↔DSH 局域网协作 — .21/.23/.24 验证记录

日期：2026-11-20
插件：`dsh-interconnect@0.17.0`（MIT）
DSH：`0.2.2-rc.3`；Linux Node `v24.22.3` / pnpm `10.34.9`；Windows Node `v24.13.0` / npm `11.6.2` / pnpm `10.34.9`

## 1. 结论与拓扑

已在三台机器上跑通 **4 个独立 DSH 实例**，全部使用 `dsh-interconnect` 通过 WebSocket `/interconnect/link` 互联，完成真实 agent 会话之间的双向消息往返：

| 实例 | 机器 | 监听 | 角色 |
|---|---|---|---|
| `dsh-a` | 192.168.3.23（Ubuntu 24.04.1） | `192.168.3.23:3081` | 对端/回复方 |
| `dsh-b` | 192.168.3.23（同上） | `192.168.3.23:3082` | 同机第二实例 |
| `dsh-c` | 192.168.3.21（Ubuntu 24.04.1） | `192.168.3.21:3081` | 跨机发起方 |
| `dsh-d` | 192.168.3.24（Windows 10） | `192.168.3.24:3081` | 跨机发起方 |

已验证的路径：

- **同机**：A↔B 完整往返（先跑通）。
- **跨机 .21→.23→.21**：C→A 发送 `ping from dsh-c`，A 回复 `pong from dsh-a`，C 收到。
- **跨机 .24→.23→.24**：D→A 发送 `ping from dsh-d`，A 回复 `pong from dsh-a`，D 收到。
- **跨机 .24→.21→.24**：D→C 发送 `ping from dsh-d`，C 回复 `pong from dsh-c`，D 收到。
- D 的 `interconnect_peers` 显示 `dsh-a`/`dsh-b`/`dsh-c` 全部 `up`；A/B/C 也已把 `dsh-d` 加入 peers。

## 2. 安装位置

| 项 | .21 / .23（Linux） | .24（Windows） |
|---|---|---|
| Node | `/home/orphic/.local/node24` | `D:\Nodes\node.exe`（v24.13.0） |
| DSH CLI | `/home/orphic/.local/dsh-cli/bin/dsh` | `C:\Users\User\AppData\Roaming\npm\dsh.cmd` |
| pnpm | `/home/orphic/.local/pnpm` | `C:\Users\User\AppData\Roaming\npm\pnpm.cmd` |
| 实例 home | `~/.dsh-lan-a` / `-b` / `-c` | `C:\Users\User\.dsh-lan-d` |
| 共享 token | `~/.dsh-lan-token`（600） | `C:\Users\User\.dsh-lan-token` |
| 模型 key | `~/.dsh-lan-c/dskey`（600） | `C:\Users\User\.dsh-lan-d\dskey` |

> token 与 key 只存在于上述受限文件/启动环境，本记录不写具体值。

## 3. 实例配置

每个实例的 `profiles/lan/cordis.patch.yml`：

```yaml
# dsh-a
- id: interconnect
  config:
    instanceId: dsh-a
    peers:
      dsh-b: http://192.168.3.23:3082
      dsh-c: http://192.168.3.21:3081
      dsh-d: http://192.168.3.24:3081
```

```yaml
# dsh-b
- id: interconnect
  config:
    instanceId: dsh-b
    peers:
      dsh-a: http://192.168.3.23:3081
      dsh-c: http://192.168.3.21:3081
      dsh-d: http://192.168.3.24:3081
```

```yaml
# dsh-c
- id: interconnect
  config:
    instanceId: dsh-c
    peers:
      dsh-a: http://192.168.3.23:3081
      dsh-b: http://192.168.3.23:3082
      dsh-d: http://192.168.3.24:3081
```

```yaml
# dsh-d
- id: interconnect
  config:
    instanceId: dsh-d
    peers:
      dsh-a: http://192.168.3.23:3081
      dsh-b: http://192.168.3.23:3082
      dsh-c: http://192.168.3.21:3081
```

## 4. 启动方式

### Linux（.21 / .23）

必须显式设置 `DSH_HOME`，否则会退回默认 `~/.dsh`，用到没有 peers 的 profile：

```bash
cd /home/orphic/.dsh-lan-a
DSH_HOME=/home/orphic/.dsh-lan-a \
DSH_INTERCONNECT_TOKEN="$(cat /home/orphic/.dsh-lan-token)" \
DEEPSEEK_API_KEY="$(sed -n 's/^DEEPSEEK_API_KEY=//p' /home/orphic/.dsh/env)" \
nohup /home/orphic/.local/dsh-cli/bin/dsh \
  --profile lan --no-open --host 192.168.3.23 --port 3081 \
  > /home/orphic/.dsh-lan-a/web-lan.log 2>&1 &
```

启动脚本：

- `.23`：`/tmp/start-ab.sh`（同时起 A/B，监听 `192.168.3.23:3081/3082`）。
- `.21`：`/tmp/start-c.sh`（起 C，监听 `192.168.3.21:3081`）。

### systemd 用户服务（正式常驻方式）

`.21/.23` 已改为 systemd 用户服务，开机自启（`loginctl Linger=yes` 已确认）：

| 机器 | 服务 | 监听 |
|---|---|---|
| .23 | `dsh-lan-a.service` | `192.168.3.23:3081` |
| .23 | `dsh-lan-b.service` | `192.168.3.23:3082` |
| .21 | `dsh-lan-c.service` | `192.168.3.21:3081` |

unit 文件在 `~/.config/systemd/user/`，`ExecStart` 指向各 home 下的 `run.sh`；`run.sh` 内部显式 `export DSH_HOME=...`，并从受限文件读取 token/key。

```bash
systemctl --user status dsh-lan-a dsh-lan-b     # .23
systemctl --user status dsh-lan-c               # .21
systemctl --user restart dsh-lan-a dsh-lan-b    # .23
journalctl --user -u dsh-lan-a -n 50 --no-pager
```

手动命令保留作为排障手段；正式运行以 systemd 为准。

注意：

- `DSH_INTERCONNECT_TOKEN` **不能**写进 `$DSH_HOME/.env`，否则启动报
  `only the launching environment may set ...`。
- 不要写 `dsh --profile lan web ...`，会报 `too many arguments. Expected 0 arguments but got 1: web.`。
- `--host` 用具体 LAN IP；DSH 会提示 plain HTTP 只适用于可信网络。

### Windows（.24）

用计划任务避免 SSH 会话结束时子进程被回收：

- 计划任务：`DSH-LAN-D`，用户 `DESKTOP-G65JU1V\User`，`S4U`，最高权限，触发器 `AtLogOn`。
- 包装脚本：`C:\Users\User\.dsh-lan-d\start-dsh.ps1`，从受限文件读取 token/key，然后：

```powershell
& "C:\Users\User\AppData\Roaming\npm\dsh.cmd" `
  --profile lan --no-open --host 192.168.3.24 --port 3081 `
  *>> "C:\Users\User\.dsh-lan-d\web-lan.log"
```

- 防火墙已加入站规则 `DSH LAN 3081`（TCP 3081）。
- PowerShell 5.1 的执行策略禁止 `npm.ps1`/`dsh.ps1`，必须用 `npm.cmd`/`dsh.cmd`。

## 5. 验收证据

通过 `GET /connect?token=<launch-token>&interactions=answer` 换取 `dsh-auth-...` cookie，再用 Typert Remote RPC 驱动真实 agent 会话。

### 5.1 同机 A↔B

- A `interconnect_peers`：`dsh-b http://127.0.0.1:3082 [up]`
- A `interconnect_send`：`delivered to dsh-b via followup`
- B `interconnect_reply`：`Reply delivered to dsh-a: pong from dsh-b`
- A turn 3 收到 `pong from dsh-b`

会话：
- A：`session-a65ef9ff-31f9-49d4-8767-97e650f0d4fe`
- B：`session-3bdfdfc0-fea5-4c79-86b5-95efed2da97f`

### 5.2 跨机 C（.21）↔ A（.23）

- C `interconnect_peers`：`dsh-a up`、`dsh-b up`
- C `interconnect_send`（目标 A 活会话 `session-9dacd146-5018-4712-bbef-0388cd4c2892`）：
  `delivered to dsh-a via followup`
- A 收到后 `interconnect_reply`：`pong from dsh-a`
- C `session/wait` 记录到回复文本 `pong from dsh-a`

### 5.3 跨机 D（.24）↔ A（.23）

- D `interconnect_peers`：`dsh-a up`、`dsh-b up`、`dsh-c up`
- D `interconnect_send`（目标 A 活会话 `session-2fbd455a-830d-4716-9803-70891ffff02b`）：
  `delivered to dsh-a via followup`
- A 收到后 `interconnect_reply`：`pong from dsh-a`
- D `session/wait` 记录到 `Noted — reply received: "pong from dsh-a".`

D 会话：`session-0386e815-6aaa-49ea-9b00-bacb3bebc29c`
A 新会话：`session-2fbd455a-830d-4716-9803-70891ffff02b`

### 5.4 跨机 D（.24）↔ C（.21）

- D `interconnect_list("dsh-c")` 找到 C 活会话 `session-35022037-fc84-460b-843a-a0438d67d4e5`（READY/idle）。
- D `interconnect_send`：`delivered to dsh-c via followup`，文本 `ping from dsh-d`。
- C 收到后 `interconnect_reply`：`pong from dsh-c`（delivered to dsh-d，followup）。
- D 的下一轮收到并回报：
  `Reply received from dsh-c. Exact reply text: pong from dsh-c`。
- 至此 D 已同时打通 A 与 C；D 的 peer 列表为 `dsh-a`/`dsh-b`/`dsh-c` 全 up。

> 操作注意：D 的 agent 当时反复调用 `wait_agent` 等待回复，把自己锁在长回合里，C 的回复只能排队。用 `session/prompt` 的 `mode:"steer"` 发一句「Stop waiting and end this turn」后，排队消息在下一轮被正常处理。跨实例回复不要用 `wait_agent` 阻塞，结束当前回合让 followup 起新回合即可。

### 5.5 systemd 重启后复核

`.21/.23` 切到 systemd 用户服务并重启后，D（.24）再调 `interconnect_peers`，结果：

```text
dsh-a  http://192.168.3.23:3081  up
dsh-b  http://192.168.3.23:3082  up
dsh-c  http://192.168.3.21:3081  up
```

D 的 `netstat` 同时存在到 `192.168.3.21:3081` 与 `192.168.3.23:3081/3082` 的 ESTABLISHED 连接，说明重启后 peer 自动重连正常。

### 5.6 ACP 插件上线后 C 重启复核

`~/.dsh-lan-c` 追加 OpenClaw ACP 外接子代理配置并重启 `dsh-lan-c` 后，新建会话调 `interconnect_peers`，结果仍为：

```text
dsh-a  http://192.168.3.23:3081  [up]
dsh-b  http://192.168.3.23:3082  [up]
dsh-d  http://192.168.3.24:3081  [up]
```

结论：ACP 工具是增量 insert，不影响原 `interconnect` 服务；C 重启后三条 peer 链路自动恢复。ACP 细节见 `openclaw-dsh-integration-assessment.md` §7。

## 6. 可复现的 RPC 驱动方法

```text
GET  /connect?token=<launch-token>&interactions=answer   -> 302 + dsh-auth cookie
POST /api/session/create
  {"type":"client-request","rpcId":"...","method":"session/create",
   "payload":{"args":{"request":{}}}}
  -> {"sessionId":"session-..."}

POST /api/session/prompt
  {"type":"client-request","rpcId":"...","method":"session/prompt",
   "payload":{"args":{"request":{
     "requestId":"...","sessionId":"session-...","mode":"queue",
     "content":[{"type":"text","text":"..."}]}}}}

POST /api/session/wait
  {"type":"client-request","rpcId":"...","method":"session/wait",
   "payload":{"args":{"request":{
     "sessionId":"session-...","timeoutMs":90000,
     "afterSeq":0,"maxMessages":120}}}}
  -> result.value.output.records（含 assistant text / tool-call）
```

注意参数名：
- `session/create` 用 `request`；漏了会报 `missing "request"`。
- `session/list` 用 `_request`。
- `session/wait` 是等待真实 agent 回合完成并取回工具调用的关键；不必直连 WebSocket。

## 7. 踩过的坑

1. **`DSH_HOME` 漏设**：实例退回 `~/.dsh`，`interconnect_peers` 报
   `no peers configured: this instance can receive messages but cannot send...`。
2. **token 放 `.env`**：启动被拒；必须从启动环境导出。
3. **`interconnect_send` 目标必须是 peer 上可唤醒的会话**：
   误用本机 session id → `not delivered: could not wake "...": no persisted session under that id`。
4. **A 未配置 dsh-d 时回复失败**：
   `peer-not-configured — this instance configures no peer dsh-d`；把 `dsh-d` 加入 A/B/C 的 peers 并重启后恢复。
5. **`interconnect_list` 可能只列旧会话**：
   D 的列表仍显示 A 的旧会话，但向新会话发送仍 `delivered`（`resume` 默认 true 会唤醒持久化会话）。验证时应以 `session/wait` 的实际回合为准，或先让目标会话处于 READY。
6. **Windows SSH 启进程**：`Start-Process` 起的进程会随 SSH 会话结束被回收；用计划任务 `S4U` + `AtLogOn` 持久化。
7. **PowerShell 编码**：远程 `cmd /c more > file` 会写入 UTF-16/null 字节，YAML 报
   `null byte is not allowed in input`；改用 `[IO.File]::WriteAllText(..., UTF8Encoding($false))`。
8. **Windows 执行策略**：`dsh.ps1`/`npm.ps1` 被禁，统一用 `.cmd`。
9. **不要用 `wait_agent` 等跨实例回复**：它会把当前回合拖成长等待，对方的 `interconnect_reply` 只能排队。正确做法是结束回合，让 `followup` 起新回合；已经卡住时用 `session/prompt {mode:"steer"}` 注入「结束等待」。

## 8. 安全边界

- 共享 token、launch token、DeepSeek key 不写入仓库/日志；Linux 侧 token/key/log 已 `chmod 600`；Windows 侧 `.dsh-lan-token`、`dskey`、`web-lan.log` 已用 `icacls /inheritance:r` 收紧为 `DESKTOP-G65JU1V\User` 完全控制。
- 注意：`web-lan.log` 与 systemd journal 里会出现带 `?token=...` 的启动 URL；这些文件已限制为用户可读，仍应按敏感信息管理。
- 当前 4 个实例均为 **局域网明文 HTTP/WS**，仅适用于可信网段；DSH 启动时明确警告
  `listening ... over plain HTTP; restrict this port to a trusted proxy or network`。
- `.24` 已加入站防火墙规则 `DSH LAN 3081`；`.21/.23` 需自行确认 ufw/iptables 只放行可信网段。
- 生产化建议：当前按用户决策走**局域网直连**（不引入 SSH 隧道）；至少应把 3081/3082 限制到可信网段（ufw/防火墙），不要在不可信网络上裸跑。若要跨不可信网络，再考虑 TLS 反向代理或 SSH 隧道。
- `.24` 的计划任务以 `S4U` 运行，不需要保存密码；但只在该用户登录时触发。

## 9. 待办 / 后续

1. 可选补测 B↔D 或 A↔C 的独立往返；当前同机 A↔B、跨机 C↔A、D↔A、D↔C 均已通过，四实例 peer 全 up。
2. `.21/.23` 的 systemd 用户服务已启用并验证监听；重启机器后复核 `systemctl --user status dsh-lan-a/-b/-c` 与 D 的 `netstat` 连接。
3. 评估是否用 SSH 隧道/TLS 替换裸 HTTP；若保留 LAN 直连，补 ufw 规则。
4. 清理 `tmp/` 下的探针脚本与临时凭据文件；不要把 token/key 带进提交。
5. 将本方案收敛为「部署 runbook + 故障排查」两节，纳入 README/AGENTS 的环境事实。
