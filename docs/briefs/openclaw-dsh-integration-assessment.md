# OpenClaw × DSH 协作体系接入评估（只读，2026-11-20）

> 评估员：openclaw-assess（lead 派发）。只读评估，未对 OpenClaw / DSH 做任何修改。
> 结论先行，证据可复核；无法验证的条目明确标注「未验证」。

## 0. 一句话结论

**难度评级：中。建议现在只做两件事：①先落「方案 D」（在 .21 再跑一个 DSH 实例做 mesh peer，OpenClaw 保持旁路，低难度、零 OpenClaw 改动）；②再以「DSH 经 HTTP `/tools/invoke` 向 OpenClaw 发一条消息并收到回复」作为最小试点——但它被 OpenClaw 侧的管理员授权（operator scopes + 工具面放开）硬阻塞，试点前必须用户确认授权。** 深度桥接（方案 A/B）现阶段不建议。

> **2026-11-20 增补（保留上文为评估时点记录）**：后续发现 `openclaw acp` 本地桥，已用 DSH 的 ACP 外接子代理链路实测打通（隔离测试 profile 与生产 `dsh-c` 均成功）；它不需要 operator scopes，但只覆盖「把 OpenClaw agent 当一次性子代理调用」，不覆盖终端/管理面。详见 §7。

---

## 1. OpenClaw 的扩展/接入面盘点

依据：`tmp/oc-proto/package/protocol.schema.json`（@openclaw/gateway-protocol 2026.11.6 解包，`methods` 共 559 个）+ 官方文档 https://docs.openclaw.ai/gateway/protocol 、/gateway/operator-scopes 。

| 接入面 | 能否收发任务/消息 | 依据与限制 |
|---|---|---|
| **Gateway WS 协议 v4**（`chat.send`、`sessions.send`、`sessions.create`、`sessions.steer`、`sessions.subscribe`/`messages.subscribe`） | ✅ 收发均可（全双工：RPC 请求 + 事件订阅） | schema `methods`：`chat.send`/`sessions.send`/`tools.invoke` 要求 `scope:"operator.write"`；`terminal.open` 要求 `operator.admin`；`chat.inject` 要求 `operator.admin`；`sessions.create` 标 `dynamic`（普通自建会话 `operator.sessions.write` 即可，文档明示）。**前提：连接拿到 operator scopes** |
| **HTTP `/tools/invoke`**（Tools invoke API，见文档 "Tools invoke API" 页） | ⚠️ 理论可发（`sessions_send`/`sessions_create` 工具），**实测被工具白名单挡**：仅 `sessions_list` 等极少数可用，`sessions_send/create` 返回 404 `Tool not available`（已知事实，本次未复测） | 文档「Shared-secret auth」节：**共享密钥 bearer 认证会恢复完整默认 operator scope 集**——即若拿到正确的 gateway 共享 token，scope 不是问题；404 是网关工具面（`tools.gatewayPolicy`/agent 工具集）问题，需管理员放开 |
| **CLI（`openclaw`）** | ✅ 本机可用（.21 上有 CLI，未验证具体子命令面） | README `tmp/oc-proto/package/README.md:35` 提及 root `openclaw` CLI 独立版本。适合 SSH 一次性脚本，不适合常驻双向 |
| **插件系统**（`plugins.list/install/inspect/skills.read/sessionAction` 等 20+ 方法） | ⚠️ 插件可扩展 Gateway 本身（含 sessionAction、HTTP 路由、skills），是方案 A/B 的正牌载体 | schema `methods`：`plugins.*` 家族；安装/启停需 `operator.admin` 级（文档「plugins.sessionAction requires…」）。插件开发文档未在本包内，未验证 API 细节 |
| **channels**（`channels.start/status/pairing.*`，Telegram 等） | ⚠️ 面向人聊渠道，非机器总线 | schema `methods`：`channels.*`。可作 E 类旁路（见 §3-E）但语义脏 |
| **nodes**（`node.invoke`/`node.pair.*`/`node.pending.*`） | ⚠️ node 是"能力宿主"（macOS/iOS/Android/headless 设备），OpenClaw 作为 client 调 node 的命令，方向与我们需要（外部调 OpenClaw）相反 | 文档 roles：operator vs node 两角色；`node.invoke` 普通 `operator.write`，`system.run` 等高危命令 admin |
| **MCP（作为 server）** | ❌ **未见原生面**：协议 559 方法里无 MCP server 端点；`/v1/models` 404（已知事实）。OpenClaw 自身是 MCP **client**（agent 工具可用 MCP server）。社区 MCP 包装器存在与否**未验证** | `tmp/oc-proto/package/protocol.schema.json` methods 全列表核对 |
| **webhook** | ❌ 未见通用 webhook 入口（插件可实现 HTTP 路由，但那属于插件开发） | 同上核对；未验证 |

**小结：OpenClaw 唯一的正牌双向消息面 = Gateway WS v4（operator 角色）与 HTTP `/tools/invoke`；两者都被「拿 operator scopes + 网关放行相应工具」拦住。**

## 2. 已实证的阻塞事实（不重复验证，引自任务书 + 本地对证）

1. WS 握手 token 可连，`hello-ok.auth.scopes = []`；`terminal.open` 拒 `FORBIDDEN missing scope: operator.admin`（与文档 scope 模型完全吻合：token 未携带 operator 身份）。
2. HTTP `/tools/invoke` 仅 `sessions_list` 可用；`sessions_send`/`sessions_create` 404 `Tool not available`。
3. 结合文档「Shared-secret auth」：**共享密钥 bearer 本应恢复完整 operator scope**——当前 token 的空 scopes 说明它不是配置内的共享密钥 token（或 gateway.auth 收紧了），换/发正确 token 可能一步解锁，**需管理员操作，未验证**。
4. dsh-interconnect 只认 DSH 的 instanceId/sessionId，`/interconnect/link` WS + 共享密钥 `DSH_INTERCONNECT_TOKEN`（`tmp/interconnect-lab/.../dsh-interconnect/README.md:12-16,41-51`），不是通用消息总线。

## 3. 候选路径逐条评估

### A. DSH bridge 插件：OpenClaw session ↔ DSH peer 互映射
- **改哪侧**：只写 DSH 侧插件（host composition，参照 dsh-interconnect 的 `interconnect` 服务结构），实现 OpenClaw WS v4 client + 把 OpenClaw session 投影成 `interconnect_list` 可见 peer。
- **管理员/配对**：**需要**。WS 侧至少 `operator.write`（发消息）+ `sessions.subscribe`/`messages.subscribe`（收回复）；协议包可直接复用（`@openclaw/gateway-protocol` 就是官方 client schema/validator，`tmp/oc-proto/package/dist/`）。
- **会话语义**：部分保留——OpenClaw `sessions.send`/`chat.send` 与 DSH inbox 注入可映射；但 DSH 的 `delivery`(followup/steer/inject)、`resume` 唤醒、subagent 封栏在 OpenClaw 侧没有对应物，只能单向近似。
- **工作量**：**3-5 人日**（协议 client 骨架 1 天可借 dist 现成 validator；peer 投影/事件桥/重连各 0.5-1 天；测试 1 天）。前置仍是被 §2-1 的授权解锁。
- **风险**：授权不可得则全盘作废；协议版本随日历版滚动（README:13-22），需锁版本；唤醒语义缺失导致消息可靠性依赖对端 agent 在线。

### B. OpenClaw 暴露成 MCP server，DSH agent 直接调
- **改哪侧**：OpenClaw 侧（无原生 MCP server 面，需写 OpenClaw 插件包一层，或找社区包装器——未验证存在）。
- **管理员/配对**：需要（插件安装 admin）。
- **会话语义**：能保留（工具即 `sessions_send` 等透传）。
- **工作量**：OpenClaw 插件开发文档/API 未调研到位（本包不含），**估 2-4 人日 + 文档研读**，不确定性最高。
- **风险**：进入 OpenClaw 插件生态的学习曲线；DSH 侧只是加一条 MCP 连接（零代码，参照 gemini-eyes 先例）。
- **评级：不推荐首发**（两侧都要动 + 生态陌生）。

### C. DSH 侧 HTTP `/tools/invoke` 调 `sessions_send`/`sessions_create`
- **改哪侧**：DSH 侧只需一个小插件或既有会话里 `web_fetch`/脚本（零新插件可先试）。
- **管理员/配对**：**需要两项**：①正确的共享密钥 token（文档保证 bearer 恢复完整 scopes）；②网关放开 `/tools/invoke` 的工具面（当前 404 白名单，对应 `tools.gatewayPolicy` 或 agent 工具集，需管理员调，未验证具体键）。
- **会话语义**：保留发送；**收回复难**——HTTP 单发无事件流，回读要轮询 `sessions_list`/历史（poll 丑但可用）。
- **工作量**：授权解锁后 **0.5 人日**。
- **风险**：轮询延迟；token 等同 operator 全权，落在 DSH 配置里的泄露面要注意（走 `ctx.credentials`，勿进 Config/日志）。
- **这是最小试点的正选**（授权一旦到位）。

### D. 不桥接：.21 再跑一个 DSH 实例做 mesh peer，OpenClaw 保持旁路 ✅推荐
- **改哪侧**：零 OpenClaw 改动；DSH 侧为已有成熟动作（三台机 4 实例先例，SSH 免密可用）。
- **管理员/配对**：不需要 OpenClaw 任何授权；只需 DSH 间共享 token（已有）。
- **会话语义**：完整 DSH 语义（resume/delivery/subagent 封栏全在）。
- **工作量**：**0.5-1 人日**（装 DSH headless + dsh-interconnect + peers 双向配置；README:388-455 五步最小可用即为 runbook）。
- **风险**：与 OpenClaw **不互通**，只是同机共存（.21 上的 DSH 会话可用 SSH/HTTP 触碰 OpenClaw CLI，人工衔接）。满足"把 .21 算力纳入协作体系"，不满足"OpenClaw 本体纳入"。
- **注意**：OpenClaw 在 .21 上已有自己的 agent 执行面，同机再跑 DSH 需留意端口/资源冲突（未验证 .21 资源余量）。

### E. 其他更简单做法
- **E1（半自动胶水，零授权）**：.21 上的 DSH 实例（方案 D 产物）经 SSH 在本机执行 `openclaw` CLI 发起会话、读输出。不需要 operator token（CLI 在 gateway 本机信任域内，**未验证** headless CLI 的认证要求）。工作量 0.5 人日（脚本 + 会话内工具化）。缺点：无事件推送、依赖 CLI 行为稳定。
- **E2（channel 旁路）**：给 OpenClaw 挂 Telegram channel，DSH 侧机器人互聊。语义脏、外网依赖，**不推荐**。
- **E3**：等上游（openclaw issue #63344 类）完善 token 授权面再评估 A/C。

## 4. 关键阻塞点排序

1. **scopes/设备配对（硬阻塞，首位）**：token 连上但零 scopes；发消息面全部要求 `operator.write`（`chat.send`/`sessions.send`/`tools.invoke` schema 明示）。解锁 = 管理员配对设备或签发共享密钥 token（后者按文档可直接恢复完整 scope）。
2. **工具白名单（第二位）**：`/tools/invoke` 的 404 `Tool not available` 独立于 scope，需网关配置放开（具体配置键未验证）。
3. **消息可靠性/事件回传**：HTTP 路径无推送；WS 路径才有 `sessions.messages.subscribe`。决定 C 只能轮询、A 才是正解。
4. **会话语义不匹配**：DSH resume/delivery/subagent 封栏 vs OpenClaw session 生命周期，桥接只能近似（影响 A 的验收标准）。
5. **安全边界**：operator token = 该 Gateway 全权（文档明示 scope 是"信任域内护栏，非多租户隔离"）；DSH 侧须走 credentials 域、禁入日志/Config。

## 5. 结论与最小试点

- **难度**：真实桥接（A/C 解锁后）**中**；当前在授权未解锁状态下 **高**；方案 D **低**。
- **建议**：现在就做 **方案 D**（收益立得、零风险）；同时请用户走 OpenClaw 管理员流程解锁授权，然后做唯一一件事的最小试点：**「DSH → OpenClaw：经 HTTP `/tools/invoke` 调 `sessions_send`（或 WS `chat.send`）发一条消息，并在 OpenClaw 会话里看到回复/回读成功」**。反向（OpenClaw→DSH）试点推迟到 A 阶段。
- **试点前必须用户确认的权限**：
  1. OpenClaw 管理员为 DSH 桥签发**共享密钥 token**（或批准设备配对授 `operator.write`；terminal/admin 不申请）。
  2. 管理员放开 `/tools/invoke` 对 `sessions_send`/`sessions_create` 的工具面。
  3. 方案 D：同意在 .21 以 orphic 用户部署一个 headless DSH 实例（指定端口、开机自启策略）。
  4. 明确 token 存放：仅入 DSH credentials 域（`$DSH_HOME/.credentials.yaml` refs），不进仓库/日志。

## 6. 证据附录

- 协议方法与 scope：`tmp/oc-proto/package/protocol.schema.json`（`methods` 559 项；`chat.send`/`sessions.send`/`tools.invoke`=`operator.write`，`terminal.open`/`chat.inject`=`operator.admin`，`sessions.create`=`dynamic`）。
- 协议包说明：`tmp/oc-proto/package/README.md:1-35`（v4 线协议、Node>=22.19.0、日历版本策略）；入口 `dist/` 含 frame-guards/client-info 等 TypeBox-free 模块，可直接复用做 client。
- 文档：https://docs.openclaw.ai/gateway/protocol （transport/roles/discovery）；https://docs.openclaw.ai/gateway/operator-scopes （scope 等级、**共享密钥恢复完整 scope**、device/node 配对审批、`tools.gatewayPolicy`、sandbox 边界）。
- dsh-interconnect 事实：`tmp/interconnect-lab/home/profiles/lab-a/node_modules/dsh-interconnect/README.md:12-16`（WS-only `/interconnect/link`、共享密钥）、`:41-51`（instanceId 寻址）、`:195-208`（帧表）、`:210-229`（失败原因枚举）、`:249-296`（resume 唤醒=计费回合）、`:313-336`（配置表）、`:388-455`（两机最小可用五步）。
- 已知实测事实（任务书给定，未复测）：`/health` ok；WS 空 scopes；`terminal.open` FORBIDDEN；`/tools/invoke` 白名单 404；`/v1/models`、`/api/v1/admin/rpc` 404。
- **未验证**：`tmp/oc-gateway-probe.mjs`、`tmp/oc-terminal.mjs` 在 `tmp/` 下**未找到**（glob `tmp/oc-*.mjs` 无命中；任务书所指脚本或已移走）；OpenClaw 插件开发 API 细节；`openclaw` headless CLI 的认证要求；.21 资源余量；工具面放开的具体配置键；社区 MCP server 包装器是否存在。
- 敏感内容：`.21` 上 OpenClaw 配置/launch token 等——存在，未读取。

## 7. 2026-11-20 实测增补：ACP 外接子代理路径已打通

> 本节是评估后的实测记录，不推翻 §0-§6 的时点结论；它新增了一条当时未发现的路径，优先级高于原方案 C（HTTP `/tools/invoke`）。

### 7.1 结论

**DSH 可以把 OpenClaw 当作「一次性外部子代理」调用，不需要 operator scopes、不需要设备配对、不需要改 OpenClaw。** 链路：

`DSH agent` → `subagent_openclaw` 工具（`@deepseek-ai/dsh-tool-subagent`）→ `dsh-subagent-acp` provider → 本机 `openclaw acp --url ws://127.0.0.1:18789 --session agent:main:main` → OpenClaw Gateway → OpenClaw agent。

隔离测试 profile（`.21` 的 `~/.dsh-oc-test`，127.0.0.1:3083）与生产 `~/.dsh-lan-c` 均验证成功。生产 C 的实测会话 `session-94b5323d-281f-49cf-8e8d-43512a45b2b4` 最终 assistant 文本为：

```text
The OpenClaw subagent `agent-1` finished, and its closing message was, verbatim:

ACP_PROD_OK
```

### 7.2 最小可用配置

`~/.dsh-lan-c/profiles/lan/cordis.patch.yml`（保留原 `interconnect` 行，追加 `insert`）：

```yaml
- insert:
    - id: subagent-acp
      name: '@deepseek-ai/dsh-subagent-acp'
      config:
        providerName: acp
        command: /home/orphic/.npm-global/bin/openclaw
        args:
          - acp
          - --url
          - ws://127.0.0.1:18789
          - --session
          - agent:main:main
        permission: reject
    - id: tool-subagent-openclaw
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: acp
        toolName: subagent_openclaw
        maxDepth: provider-managed
```

安装时必须显式锁版本：`dsh plugin --profile lan add @deepseek-ai/dsh-subagent-acp@0.2.2-rc.3`。默认解析到的 `0.0.1-rc.1` 与 DSH 0.2.2-rc.3 不兼容。`maxDepth: provider-managed` 必填，否则激活报：

```text
tool-subagent: provider "acp" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: 'provider-managed' to leave the recursion budget to the provider
```

### 7.3 关键行为与坑

1. **`--session agent:main:main` 必填**。不带 `--session` 时 ACP `newSession` 后 prompt 阶段失败：`Subagent failure (provider: ACP; stage: prompt; category: transport)`。
2. **工具是异步的**：`subagent_openclaw` 立即返回 `started subagent agent-1`，不是最终文本；OpenClaw 的最终答复作为子代理完成通知在**下一轮**到达。调用方不要在这一轮里反复 `wait_agent` 阻塞（会把回合拖长）；需要结果时等完成通知，或由父回合结束后再读。
3. **测试脚本的读取位置**：`session/wait` 返回的是事件记录，assistant 文本在 `event.data.message.content` 里，不在顶层 `records[].text`。本次生产脚本首版只扫顶层 `text`，误判「没有 ACP_PROD_OK」；实际回合已成功。用 `state.cursor` 与 `afterSeq` 递增读取，不要固定 `afterSeq: 0`。
4. **不需要显式 gateway token**：本次 `openclaw acp` 未传 `--token` 即成功；它走的是本机 CLI 的 OpenClaw 配置/本地信任域，不经过 WS `auth.token` 的 operator scope 面。因此 `hello-ok.auth.scopes=[]` 不构成阻塞；但这也意味着它只适合「本机可信用户」场景（未做“无本地配置的隔离用户”验证）。
5. **能力边界**：只覆盖 OpenClaw agent 的一次性对话委派；不能列/管 OpenClaw 会话，不能执行 OpenClaw 终端/管理方法，不能替代 operator 面；反向（OpenClaw 主动调 DSH）仍未建立。文件传输/任务调度仍不在该链路内。
6. **`permission: reject`**：OpenClaw ACP 的权限请求一律拒绝。若 OpenClaw 侧任务需要工具审批，会直接失败；需要放开时改成 `allow` 并评估安全边界。
7. **OpenClaw Gateway 监听面**：实测 `.21` 的 `18789` 监听在 `0.0.0.0`，不只 loopback。即使 token scopes 为空，也建议用防火墙限制到可信网段，或把 gateway bind 改回 127.0.0.1；这是独立于 ACP 的既有暴露面。

### 7.4 与 §5 的最小试点建议的关系

- 原「方案 C（HTTP `/tools/invoke`）」仍受工具白名单限制，本次未解锁；ACP 路径绕开了它，应作为**首选试点**。
- 原「方案 D（OpenClaw 旁路 + 同机 DSH）」仍是最小零改动方案；ACP 则是在不改 OpenClaw 的前提下，把 OpenClaw agent 真正接进 DSH 工具面的一步。
- 建议：保留 `dsh-c` 上的 ACP 工具，但把它当作「受控的 OpenClaw 委派通道」，不要把它宣传成完整的 OpenClaw 管理面；使用方（DSH 会话）应明确告知用户任务会发给 OpenClaw agent。
