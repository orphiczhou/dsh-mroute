# dsh-mesh 跨机能力评估：文件传输 / 任务委托 / 调度体系

> 评估对象：`@linyanzhi/dsh-mesh@0.3.50` + `dsh-mesh-node@0.0.24` + `dsh-mesh-host@0.0.5` + `dsh-mesh-autostart@0.0.14`
> 源码位置：`D:\Codes\DSH小插件\tmp\mesh-src\`（以下路径均以此为前缀）
> 参照物：`dsh-interconnect@0.17.0`（`tmp\interconnect\`，仅有 README 可读）
> 本机 DSH：`D:\DSHarness\resources\app.asar\dsh\package.json:4` = `0.2.2-rc.3`，在 mesh 的 `engines: dsh >=0.2.0-rc.2 <0.3.0` 范围内
> 评估方式：**纯源码只读**，未安装、未启动、未改任何配置；凭据文件仅记录"存在，未读取"

---

## 0. 结论先行

| 问题 | 结论 | 一句话依据 |
|---|---|---|
| 文件传输 | **有零件，无成品** | 只有 `file_read_chunk` / `file_write_chunk` / `file_hash` 三个分块原语（`src\tools\files.js:312-434`），没有 push/pull 编排、没有传输清单、没有断点元数据、没有原子落盘 |
| 任务委托 | **能跨机派活，但只是点对点** | `delegate` 在对端**新建一个 DSH 会话**并异步跑（`src\tools\delegate.js:12-20,303-325`），靠轮询 `status.json` 取结果（`453-536`）；无超时、无重试、无队列 |
| 调度体系 | **没有调度器** | 队列=部分（工具级异步作业）、优先级/定时/DAG/重试=无、持久化=部分、审计=部分；逐项见 §3 |
| 与 interconnect 关系 | **互补，不重叠** | interconnect=消息面（WS 长连/session 寻址/唤醒/回信），mesh=工具面（MCP 工具调用/文件分块）；两者信任域、端口、凭据完全独立 |
| 是否现在引入 | **不建议全量引入；要上就单节点最小面灰度** | 默认 `bind=127.0.0.1`+`tls=false`（`src\core\config.js:162-172`），跨机必须改绑定面；默认 ACL 把 `delegate`/`file_write_chunk` 开放给配对 peer（见 §6） |
| 最大隐患 | **mesh ACL 管不住 delegate 起的会话** | ACL 只在 mesh 工具分发处校验（`src\tools\index.js:51-55`）；委托出的会话是本机正常 DSH 会话，拥有该 profile 的**完整工具集**，护栏只是提示词（`delegate.js:129-131`） |

**总体判断**：dsh-mesh 补的是"跨机工具调用 + 远端起一个 agent + 文件分块读写"这一层**原语**，不是"任务分派与调度体系"。你现在的缺口（任务注册、状态机、重试、依赖、审计、结果回收）在 mesh 里**依然缺**；它能省掉的是"跨机执行通道"这件事，而不是"调度"这件事。

## 1. 文件传输能力

### 1.1 工具面（全部工具，无 CLI 子命令）

| 工具 | 作用 | 位置 |
|---|---|---|
| `file_read_chunk` | 读对端文件片段，返回 base64 + `sizeBytes/offset/length/eof` | `src\tools\files.js:312-354` |
| `file_write_chunk` | 写对端文件片段（`offset` + base64 + `truncate`） | `src\tools\files.js:355-397` |
| `file_hash` | SHA-256（整文件或区间，1MB 流式） | `src\tools\files.js:398-434` |
| `transfer_usage` | 当日已用字节/配额 | `src\tools\files.js:435-441` |
| `file_transfers` | 最近传输记录（只读列表） | `src\tools\files.js:442-471` |
| `find_files` / `search_text` | 远端检索（Everything `es.exe`→Everything HTTP→`fd`→walk / `rg`→walk） | `src\tools\files.js:472-499` |

**没有** push/pull：全仓 grep `push|pull|transfer` 在 `src\cli.js` 里只有无关命中；`src\cli.js:29-56` 的 USAGE 无任何文件命令。传输 = 调用方自己循环"读分块→发分块→写分块"。

### 1.2 语义细节（决定它能不能当"任务产物回收"用）

- 限额：`DEFAULT_TRANSFER` = chunk 4MB / 单文件 256MB / 每日 2GB（`files.js:15-19`），可被 `config.transfer` 覆盖（`21-23`）。
- 目标根目录：只能落在 `config.acl.fsRoots`（默认 `~/Code`，`config.js:179`）之内；`resolveGuarded` 做 `resolve`+`isInsideRoots`（`files.js:78-83`）。
  - 坑：**相对路径按 mesh 进程 cwd 解析，不是按 fsRoot 解析**，调用方必须传对端原生绝对路径。
- 续传：机制上可行（`offset` 由调用方持有），但**没有任何断点元数据**——没有 `{file, offset, sha256}` 状态，没有"上次写到哪"的记录，中断后完全靠调用方自己记账。
- 覆盖策略：只有一个 `truncate` 布尔。写入 flags 是 `offset===0 && truncate ? 'w' : existsSync ? 'r+' : 'w'`（`files.js:383`），**不校验 `offset` 是否等于当前文件长度** → offset 跳写会产生空洞（稀疏文件），且无临时文件/无原子 rename/无备份。
- 校验：`file_hash` 是独立工具，**不是传输的一部分**；无强制校验、无传输后自动比对。
- 无清单/无队列/无进度事件：`file_transfers` 只是历史（保留 200 条，`24-35`），没有"传输任务"实体，也没有可订阅的进度。
- 目录：`file_write_chunk` 会 `mkdirSync(dirname)`（`382`），能建目录，但没有"整目录打包"能力（无 shell 时不能 tar）。

### 1.3 跨平台（Linux ↔ Windows）

**字节层可用**：base64 → `Buffer` → `writeSync(fd, buf, 0, len, offset)`（`files.js:355-397`），无换行/编码转换，二进制安全。

**路径层要小心**：mesh 有一份 `src\core\remote-path.js`，用字符串处理对端路径的 `sepOf`/`parentDir`/`joinRemote`（`44-53`，注释 `1-8` 明说是为修"Linux 本机拼 Windows 对端路径"），但这只在 UI/展示层用；**传输工具本身不做分隔符转换**，`C:\Users\x\Code\a.zip` 和 `/home/x/Code/a.zip` 必须由调用方按对端平台拼好。

**其它差异**：Windows 路径长度 260 限制未处理；`fsRoots` 默认 `~/Code` 在两端解析成各自平台的路径，跨机时不能假设同一相对路径存在；文件权限/时间戳不保留。

### 1.4 安全边界（传输面）

- 路径穿越：`canonical()` = `resolve` + 存在时 `realpathSync`（`config.js:734-754`），**已存在文件**的符号链接会被解析，越界可挡；**待写的新文件** realpath 失败退化为字面量 → 父目录是符号链接时可写到 root 外（残余风险，代码路径已确认）。
- 覆盖/删除：无删除工具（只能写），但可 `truncate` 覆盖；无"保护文件"名单。
- 传输层：MCP over HTTP，**TLS 默认关闭**（`config.js:162-172`），Bearer 在 LAN 明文可见；开了 TLS 后走 pinned fetch（`src\core\peer-client.js:77-170`，`rejectUnauthorized:false`+`secureConnect` 上校指纹 `134-152`，https 无 pin 直接 `E_PEER_NO_PIN` `91-95`）。
- 鉴权：`/mcp` 必须 Bearer（`src\server.js:257-286`），token 存 `secrets.json` 0600，`timingSafeEqual` 比较（`config.js:722-732`）。
- ACL：文件工具在 `DEFAULT_ALLOW` 里（`config.js:59-88`，含 `file_write_chunk`），角色只做收窄：observer 只有读+hash（`src\core\roles.js:16-53`），operator 才加写（`roles.js:75`）。

### 1.5 一个"能跑"的搬运流程（以及它暴露的缺口）

mesh 支持的全部传输编排，写出来就是这几行：

```text
size = fs_stat(dst_root + "/build.zip").sizeBytes            # 或本机 fs_stat 源文件
for off in 0 .. size step 4MB:
    c = file_read_chunk(path=src, offset=off, length=4MB)     # 返回 base64 + eof
    file_write_chunk(path=dst, offset=off, data=c.base64, truncate=(off==0))
assert file_hash(dst).sha256 == file_hash(src).sha256         # 可选，独立一步
```

- 断点续传要调用方自己持久化 `{src,dst,size,sha256,offset}`；mesh 不存这些（`files.js` 无任何 offset 状态文件）。
- `r+` 续写不会校验"已落盘长度"，崩溃后继续写会产生空洞，只能靠 `file_hash` 区间比对兜底（`files.js:398-434`）。
- 没有 `eof` 之外的进度信号，UI 的"传输"页读的是历史记录（`file_transfers`，`files.js:442-471`），不是进行中任务。

## 2. 任务委托：`delegate` 的完整语义

### 2.1 关键拓扑（最容易被误解的一点）

`delegate` 工具**运行在被委托的那台机器上**。源码注释写得很直白：

> "These tools run on the machine being delegated TO: a peer AI calls `delegate` with a goal, this node picks a local DSH session, injects a task envelope via the host bridge, and the peer polls `delegate_status` / answers `delegate_reply`. No cookie, no shell." —— `src\tools\delegate.js:12-20`

即：A 机的会话通过 MCP 调用 B 机 8124 上的 `delegate`，B 机 **在自己的本机 DSH 里**新建会话跑任务。`instance` 参数指的是 **B 机本机的 DSH 实例 id**（9100/9101 host 桥），不是远端 peer。

### 2.2 是否创建/唤醒会话

- 默认 `createSession`：**新建一个全新会话**（`delegate.js:303-325`），`agentPreset` 默认 `standard`（`35` 行 `DEFAULT_AGENT_PRESET`），标题加 `[委托]` 前缀并钉住防 DSH 自动改标题。
- 传 `sessionId`：**续接一个存活会话**（`287-296`），先过 `sessionBlock` 保护（拥有定时任务的会话默认拒，`force:true` 可绕，`288-289`）。
- 投递：新建走 host `/host/prompt`（`mode:'queue'`），续接走 `/host/wake`（`target:'next-turn'`）（`394-400`）。
- 无 host 桥 = 无法委托：`hosts` 为空直接报 `no host bridge configured`（`delegate.js:282`）；对端需要装 `dsh-mesh-host`。

### 2.3 异步与取结果

- **异步**：提交即返回 `taskId/conversationId/sessionId/delivery`（`401-418`），并在 3 秒内看 seq/status 确认"是否真的起轮"，起不来会带 warning 而不是假装成功（`145-160`）。
- 任务目录：`<fsRoot>/.mesh/tasks/<taskId>/{request,status,result}.json`（`75-78`），`taskId` 形如 `T-YYYYMMDDHHmm-xxxx`（`43-47`、`326`）。
- 取结果：`delegate_status` 轮询 `status.json`/`result.json`，`waitSec` 0-60 秒（`453-536`，`460`）；状态缺失时用"活会话 seq"反推 `working`/`unreported`（`482-505`）。
- 回信：`delegate_reply` 把回答 wake 进同一会话（`537-563`）。

### 2.4 超时 / 取消 / 重试 / 去重

| 维度 | 事实 | 位置 |
|---|---|---|
| 服务端超时 | **无**。只有 `delegate_status` 的 `stalled>900s` 提示，且明确写"stalled 不等于失败" | `delegate.js:514-529` |
| 取消 | **有**，`delegate_cancel` 走 host `/host/sessions/cancel` 真中断当前轮；需 host ≥ 0.5.0，旧桥返回 `E_HOST_NO_CANCEL` | `564-676` |
| 自动清理 | `delegate_gc` 把超时任务标 `cancelled`，**默认 dry-run** | `725-773` |
| 重试 | **无**。失败/卡住都不自动重派，文档反而劝阻重派同一 goal | `526-529` |
| 去重 | 同 goal 未终态 30 分钟内复用旧 taskId（`force` 可绕） | `85-108`、`268-279` |

### 2.5 失败可见性（协作式，不是强制）

`requestText` 用提示词要求对端"每 30~60 秒更新 status.json"（`delegate.js:110-132`，第 `129` 行）。也就是说**状态是本机 agent 自愿写的**：

- 对端不写 → 只能靠"会话还在跑/seq 变了"反推 `working`/`unreported`（`482-505`）；
- 对端会话死了 → 状态是 `unknown`（`493`），且 `notFailed=true`（`514-527`）——**不会变成 failed**；
- 提示词里的护栏（"不要 kill 进程、不要 push、不要改无关文件"，`131`）只是文字，无强制力。

### 2.6 与 DSH 原生 subagent 的差异

| 维度 | mesh `delegate` | DSH 原生 subagent |
|---|---|---|
| 边界 | 跨机器 / 跨用户 | 同进程 / 同用户 |
| 会话 | 对端新建独立会话（standard 预设） | 子会话（继承预设/工作区） |
| 结果 | 轮询 `status.json`/`result.json`（协作式） | 工具返回即结果 |
| 超时/取消 | 无超时；cancel 靠 host 中断 | 由父会话/工具控制 |
| 上下文 | 全新、不共享 | 不共享父历史（fork 除外） |
| 权限 | 对端用户的完整权限 | 同用户、受父级工具面约束 |
| 依赖 | 对端须装 host 桥 + 开 `delegate` ACL | 内置 |

### 2.7 一次委托的完整时序（含失败路径）

1. A 调用 `mcp__dsh-mesh-<peer>__delegate {goal, workspace, agentPreset?}`，MCP over HTTP 打到 B 的 8124。
2. B 过 ACL（唯一校验点 `src\tools\index.js:51-55`），写 `.mesh/tasks/T-…/request.json`（`delegate.js:75-78`），再调本机 host 桥 9100 `/host/sessions/create` 拿 sessionId（`303-325`）。
3. B 把 `requestText` 经 `/host/prompt` 注进新会话（`110-132,394-400`），3 秒内观察 seq/status 确认"真的起轮"（`145-160`），然后**立即返回** `{taskId, sessionId, delivery}`（`401-418`）——A 拿到的是"已投递"，不是"已完成"。
4. B 的 agent 执行；按提示词每 30~60s 写 `status.json`（`129`）。
5. A 在后续轮次调 `delegate_status {taskId, waitSec≤60}` 轮询（`453-536`）；遇 `state=question` 用 `delegate_reply` 回答并唤醒同一会话（`537-563`）。
6. 收尾：成功 → B 写 `status.json state=done` + `result.json`，A 从 `result` 字段读产物（`530`）；会话消失 → `unknown` 且 `notFailed=true`（`492-493,514-527`）；A 中止 → `delegate_cancel`（`564-676`）；A 弃管 → `delegate_gc` 标 `cancelled`（默认 dry-run，`725-773`）。

**注意第 5 步是调用方义务**：mesh 没有推送/回调，A 必须自己安排轮询节奏（下一次工具调用、或 DSH 原生 `schedule_create` 定时唤醒）。

## 3. 调度体系：逐项判定

| 能力 | 判定 | 证据 |
|---|---|---|
| 任务队列 | **部分** | `task_submit` 把任意 ACL 允许的工具丢后台（`src\tools\tasks.js:16-57`）；作业落 `<mesh home>/jobs/<id>.json`（`src\core\jobs.js:16-32`）；但这是**工具级**异步作业，不是任务级队列，且无跨节点统一队列 |
| 优先级 | **无** | `jobs.js` 无 priority 字段；`delegate` 只有 `force`/去重，没有队列位次 |
| 定时 / cron | **无** | 全仓无 cron 实现。定时属于 DSH 原生 `schedule`：mesh 读 `<dshHome>/storages/schedule.json` 只为**避让**（`src\core\session-profile.js:12,41,122,135-147`）。理论旁路：`host_call` 可代调 DSH 原生 `schedule_create`（`src\tools\host.js:149-179`，写类工具守卫 `169-172`），但 `host_call` **不在默认 ACL** |
| 依赖 DAG | **无** | `delegate` 无 deps 参数；`cluster_exec` 只支持"一个 peer 一个工具"（`src\tools\cluster.js:256-303`，源码注释明说 read-only 才是设计意图） |
| 失败重试 | **无** | `jobs` 重启后把 queued/running 一律标 `failed E_INTERRUPTED`（`jobs.js:106-123`）；`delegate` 无 retry 代码路径；全仓唯一带重试语义的只是 `cluster_exec` 失败时返回 `retryable:true` 提示（`cluster.js:281`），仍由调用方决定 |
| 幂等 | **部分** | 作业 `idem` 去重（`jobs.js:125-151`）+ 同 goal 30 分钟去重（`delegate.js:85-108`） |
| 持久化 | **部分** | `jobs/`、`.mesh/tasks/`、`delegations.json` 都落盘（`delegate.js:367-392`），但**重启不续跑**（见上），只留记录 |
| 审计 | **部分** | `<mesh home>/audit.jsonl`，5MB 轮转一次到 `.1`，参数只记 key 名（`src\core\audit.js:10,13-36`）；**无哈希链、无外部锚定**，轮转即覆盖 |
| 并发 / 背压 | **部分** | 文件有日配额与单文件上限；作业**无并发上限、无队列深度上限** |
| 进度事件 / 回调 | **无** | 纯轮询（`delegate_status`），无 webhook/推送 |
| 人工审批门 | **无** | 无 human_gate 机制（对比 DSH flow-engine 的 gate） |
| 取消 | **有** | `delegate_cancel` 真 abort（`564-676`）；`task_cancel`（`tasks.js`） |

**判定**：dsh-mesh 是"**点对点远程调用 + 远端起 agent**"，不是调度器。它连"一个持久任务表"都没有——`delegations.json` 只是台账，不是可查询、可重排、可重试的任务状态机。

### 3.1 与"调度器"的最小差集

| 调度器必备件 | mesh 现状 | 影响 |
|---|---|---|
| 有界队列 + 位次 + 并发上限 | 无（作业无并发上限、无队列深度） | 无法背压，突发直接压到对端 |
| 超时 / 心跳 / 失败判定 | 只有 `stalled>900s` 提示，明确不判失败（`delegate.js:516-529`） | 卡死任务会一直"看起来在跑"，`unknown` 与 `failed` 混在一起 |
| 重试 / 退避 / 依赖 DAG | 无（唯一 `retryable:true` 提示在 `cluster.js:281`，仍由人决定） | 瞬时故障要人工重派，多步任务只能发起方自己串 |
| 调度决策 + 资源配额 + 可观测 | 无选节点逻辑（`delegate`/`cluster_exec` 都要显式指定 peer）；仅文件日配额；台账 `delegations.json` + 5MB 轮转的 `audit.jsonl` | 没有负载感知，也查不到"任务链路" |

一句话：**mesh 提供"执行端"，不提供"控制端"**。控制端（任务表/调度/重试/审计）必须另建——这正是 §5.3 薄层的职责。

## 4. 与当前 dsh-interconnect 的关系

### 4.1 能力对照

| 面 | dsh-interconnect 0.17.0 | dsh-mesh 0.3.50 |
|---|---|---|
| 通道 | 持久 WebSocket `/interconnect/link`，**挂在宿主 webserver 上**（README `12-16,189-208`），端口就是 3081/3082 | 独立 HTTP MCP server，默认 8124/tcp（`config.js:162-172`）；本机 host 桥 9100+（`dsh-mesh-host\lib\index.js:207-210`） |
| 寻址 | `sessionId`（含离线 resume 唤醒，README `249-273`） | peer(node) + 工具名；delegate 里再选本机 DSH 实例 |
| 触发 | 发一条消息，对端 agent 消费（`delivery` 三态 followup/steer/inject，README `297-309`） | 调一个工具，同步/异步返回 |
| 结果 | `interconnect_reply` 回信 | `status.json`/`result.json` 轮询 |
| 文件 | **无**（README 全文无文件章节；帧上限 1MiB，README `223`） | 分块读写 + 哈希 + 配额 |
| 任务 | **无**（无任务表/队列/重试） | `delegate` 点对点派活 |
| 信任 | 共享密钥 `DSH_INTERCONNECT_TOKEN`（credentials，fail-closed，README `335-337`） | `secrets.json` 入向 token + 一次性配对码（`src\core\pairing.js`）+ role ACL |
| 端口冲突 | 无 | 无（与 3081/3082 不冲突，与 9100 也不冲突） |

### 4.2 两者都装时的分工建议

- **消息面归 interconnect**：日常会话消息、跨机会话唤醒、回信、peer 发现——它已经是长连 + session 寻址，比 mesh 的"每条消息一次 HTTP + 手工轮询"更合适。
- **跨机工具/文件归 mesh**：只有"要在对端机器上跑工具、读写对端文件、起一个新 agent"时才用 mesh。这部分 interconnect 完全没有。
- **任务面谁都不归**：任务注册表、状态机、重试、依赖、审计在两边都不存在（§3），必须自研或在 DSH 侧组合。

### 4.3 是否需要改 DSH 插件或自研薄层

**需要，而且量不大**——但要清醒：mesh 的接入方式本身就要动 DSH profile 配置。它不改插件代码，但要求每个节点把一份 MCP overlay 拼进 `cordis.patch.yml`：

> `node src/cli.js peer patch` 生成 `<mesh home>/patches/<peerId>.yml`（0600，头部含 Bearer token），内容是 `insert: - id: <serverName> / name: "@deepseek-ai/dsh-mcp-client"`（`src\cli.js:148-184`）——**需要人工/脚本并入 profile**，不是插件自动完成。

所以 4 节点全上 mesh = 4 份 overlay + 4 个 host 桥 + 4 套 token/ACL 的运维面。而薄层如果挂在 interconnect 上，只需要一个 DSH 插件 + 一个任务表文件。

### 4.4 若真要上线，四节点的先后顺序

| 节点 | 建议 | 原因 |
|---|---|---|
| `.24`（dsh-d，单实例） | **第一个灰度** | 现成单实例、host 桥必占 9100 无歧义；出问题不影响双实例的 .23 |
| `.21`（dsh-c，单实例） | 第二个 | 同上，可用来验证跨 OS/跨主机路径拼接 |
| `.23`（dsh-a 3081 + dsh-b 3082） | **最后**，且先解决端口/家目录 | host 端口由 `DSH_HOME` 目录名推导（`.dsh0`→9100 / `.dsh1`→9101 / 其它→0），两个实例若都解析成 0 会**互抢 9100**（`dsh-mesh-host\lib\index.js:50-58,209`）；mesh node 本身也只有一个 8124，双实例要么共用（一份 `DSH_MESH_HOME` + `hosts` 两条）要么改端口 |
| 任意节点的 UI 面板 | **都不装** | 它的价值是状态页，代价是多一套可写 HTTP 面（§6 #9） |

## 5. 结论与建议

### 5.1 现在是否引入 dsh-mesh

**建议：不全量引入。** 理由三条：

1. 它解决的是"跨机通道"，不是你的缺口"任务分派+调度"——缺口不会因为装它而消失。
2. 默认安全姿态是**单机回环**（`bind 127.0.0.1` + `tls=false`，`config.js:162-172`），要上 LAN 必须主动改绑定面，等于自己打开一个新攻击面。
3. 默认 ACL 对配对 peer 相当宽松（`delegate`、`file_write_chunk`、`task_submit` 都在 `DEFAULT_ALLOW`，`config.js:59-88`），而 `delegate` 起的会话**不受 mesh ACL 约束**（§6 第 1 条）——这是"以为收紧了其实没有"的典型。

**例外**：如果近期真实需求是"跨机搬文件"或"在另一台机器上跑一个 agent 并把产物收回来"，mesh 是目前唯一现成选项，可以**单节点灰度**（建议 .24 或 .21，不要先动双实例的 .23）。

### 5.2 若引入：最小配置清单

1. **只装两个包**：`dsh-mesh-node@0.0.24` + `dsh-mesh-host@0.0.5`。
   **不装** `@linyanzhi/dsh-mesh`（UI 侧 `/api/dsh-mesh/permissions/set`、`/peers/remove`、`/tokens/revoke` 能改 ACL/删 peer/撤销 token，见 `lib\index.js:297-310,500-511,529-540`，且**只**校验 loopback `299,502,531`，宿主鉴权未核）；**不装** `autostart`（会在 DSH 进程内 spawn serve/frpc/pc-daemon/updater，默认路径是 `/root/dsh-mesh-kit/*` 的 Linux 手机套件遗产，`dsh-mesh-autostart\lib\index.js:60-66`）。
2. **网络**：`node.bind` 保持 `127.0.0.1`，跨机用 SSH 隧道（`ssh -L 8124:127.0.0.1:8124 peer`）。若必须直连 LAN：`tls.enabled=true` + 配对时核对 `certFingerprint` + 防火墙只放行对端 4 个 IP 的 8124/tcp。
3. **配对角色**：显式 `--role observer`，**不要用默认的 `node`**（`pairing.js:64` 默认 `role='node'`，`node` = 继承本机 ACL，`roles.js:76`）。需要委托时再单独发一个 `controller` token（`roles.js:55-69`）。
4. **token ACL 追加 deny**（deny 优先，`src\tools\index.js:51-55`）：`shell_run, host_call, channel_send, channel_wake, host_session_create, host_session_prompt, pc_action, pc_app, pc_browser, pc_window, plugin_install, service_restart, repair_*, mesh_config_patch, task_submit, file_write_chunk`；`delegate*` 按需保留一个受控 token。
5. **fsRoots 收窄**到专用交换目录（如 `D:\mesh-exchange`），不要用默认 `~/Code`（`config.js:179`）。
6. **关发现**：不启用 `lan`。默认 `lan.group` 为空 = UDP 8129 广播对所有节点可见，offer 里含 node 名/url/certFingerprint/version（`src\core\lan-discovery.js:7,51-64,73-76,83`）。
7. **每节点独立 token**，不复用 interconnect 的 `DSH_INTERCONNECT_TOKEN`；不把 token 写进仓库（patch 文件头已注明 keep out of git，`cli.js:148-184`）。
8. **双实例机器（.23）**：host 桥端口由 `DSH_HOME` 目录名推导（`.dsh0`→9100，`.dsh1`→9101，其它→0；`dsh-mesh-host\lib\index.js:50-58`）。3081/3082 两个实例若 DSH_HOME 不叫 `.dsh1`，会**都抢 9100** → 必须显式设 `DSH_MESH_HOST_PORT`（`index.js:209`）。
9. **版本锁死**到上面两个精确版本（host 包 version 0.0.5 与内部 `PLUGIN_VERSION '0.6.0'` 已漂移，`index.js:41`；autostart 依赖的是 node `0.0.22`，与主插件 `0.0.24` 不同版，会装两份）。
10. **审计外收**：`audit.jsonl` 5MB 就会轮转覆盖（`src\core\audit.js:13-36`），要留证据就定时 rsync 到日志机。

### 5.3 若不引入：在 interconnect 之上补"任务分派+调度"的最小自研范围

关键洞察：**interconnect 已经具备"把任务投给远端专用 worker 会话并唤醒"的能力**（`send` 默认 `resume=true`，README `249-273`），缺的只是"任务表 + 状态机 + 重试 + 回收 + 审计 + 文件"。所以薄层可以很薄：

| 模块 | 最小实现 | 量级 |
|---|---|---|
| 任务表 | `tasks.jsonl`（append + 定期压缩）：`{id,from,to,goal,workspace,files[],deps[],state,attempts,maxAttempts,deadlineAt,createdAt,updatedAt,resultHash}` | ~120 行 |
| 状态机 | `queued→dispatched→running→(waiting_human / blocked)→done / failed / cancelled`，每次转移写事件行；非法转移拒绝 | ~100 行 |
| 派发 | `interconnect_send` 到对端 worker 会话，消息体只带 `taskId` + 指针（防 1MiB 帧与上下文膨胀，README `223`） | ~80 行 |
| 回收 | 对端 worker `interconnect_reply` 摘要 + 产物 sha256；发起端写 `result` | ~80 行 |
| 重试 | 指数退避 30s/2m/10m，max 3；重试前 `interconnect_ping` + 幂等键（taskId+attempt） | ~60 行 |
| 依赖 | `deps` 全 done 才派发；入表时做环检测 | ~50 行 |
| 定时 | **复用 DSH 原生 `schedule_create`**（本端），cron 语义映射到 rrule | ~40 行 |
| 审计 | JSONL + `prevHash` 链 + 每日 hash 落独立 anchor 文件 | ~70 行 |
| 文件传输 | 512KiB 分块 base64（帧 <1MiB），接收端会话写盘 + 回 sha256；断点表 `{taskId,file,offset,sha256}` | ~200 行 |
| 会话花名册 | 每机一个 worker sessionId 的配置 + 健康检查 | ~40 行 |

合计 **约 700-900 行**（含测试 3-5 天，单人）。分块+配额+fsRoots 语义可直接借鉴 mesh 的 `files.js`（MIT），省约 1 天。**只有"要在远端新起一个全新会话"这一点**是薄层做不了的（interconnect 只能唤醒已有会话）——若这是硬需求，才轮到 mesh 的 `delegate`。

### 5.4 三条路线对比

| 路线 | 覆盖缺口 | 工作量 | 新增风险面 | 建议 |
|---|---|---|---|---|
| A：4 节点全量 mesh | 跨机通道 + 文件 + 远端会话；**仍缺调度** | 4 套安装/token/ACL/overlay，约 1-2 天 + 持续运维 | 大：LAN 绑定、TLS 配置、delegate 权限跃迁、UI 与 autostart 的额外进程 | 否 |
| B：interconnect + 薄层 | 通道已有；补齐任务表/状态机/重试/审计/文件 | 700-900 行，3-5 天 | 小：复用现有 token、WS、会话寻址 | **推荐** |
| C：B + 单点 mesh 灰度 | 全部（含"远端起新会话"） | B + 1 节点约 0.5 天 | 中：多一套凭据与 ACL，但只在一个节点 | 有硬需求时 |

## 6. 风险与收紧清单

| # | 风险 | 证据 | 级别 | 收紧动作 |
|---|---|---|---|---|
| 1 | **`delegate` 是权限跃迁**：ACL 只管"能不能调 delegate"，管不了被委托会话干什么——它是本机正常 DSH 会话，有该 profile 的完整工具（含 shell/任意 fs） | `delegate.js:12-20,303-325`；ACL 唯一校验点 `src\tools\index.js:51-55`；护栏只是提示词 `delegate.js:131` | **高** | 不给不可信 peer `delegate`；委托会话用受限 agentPreset/独立 profile；或只在审计过的节点开 |
| 2 | 配对默认 `role=node` = 继承本机 ACL，而默认 ACL 含 `delegate`/`file_write_chunk`/`task_submit` | `pairing.js:64`；`roles.js:76`；`config.js:59-88` | **高** | 显式 `--role observer`；token 加 deny 清单（§5.2-4） |
| 3 | `/health` 无鉴权，泄漏 hosts/pid/uptime/tools/jobs/tls/pairing 状态 | `src\server.js:150-179` | 中 | 保持 `bind 127.0.0.1`；若 LAN 直连用防火墙只放行对端 IP |
| 4 | `POST /pair` 无鉴权（设计使然）：能连上 8124 就能试配对码（8 位 Crockford + 5 次失败烧毁 + 200ms 延迟） | `server.js:182-255`；`pairing.js:19,110-132` | 中 | TLS + 网络隔离；配对码当面/内网传送，不截图群发 |
| 5 | 明文 HTTP 默认（`tls.enabled=false`）→ Bearer 在 LAN 可嗅探 | `config.js:162-172` | 中 | 开 TLS 或走 SSH 隧道；首次配对核对 `certFingerprint` |
| 6 | 符号链接写穿透：待写新路径 realpath 失败退化为字面量 | `config.js:734-754` | 中 | fsRoots 用独立目录、不接受外部可写父目录；定期核对 |
| 7 | LAN 发现默认对全网广播 node 名/url/指纹 | `lan-discovery.js:7,51-64,73-76,83` | 中 | 不启用 lan；必须用就设强 groupKey |
| 8 | `autostart` 会在 DSH 进程内 spawn frpc（内网穿透）/pc-daemon/updater，默认路径是 Linux 手机套件路径 | `dsh-mesh-autostart\lib\index.js:60-66`；`autostart.js:106-109`（schtasks `/RL LIMITED`） | 中 | **不装**；确需自启就只用 schtasks 起 `mesh serve`，不带 frpc |
| 9 | UI `/api/dsh-mesh/*` 的写路由可改 ACL/删 peer/撤销 token，只校验 loopback | `lib\index.js:297-310,500-511,529-540`（校验点 `299,502,531`） | 中 | 不装 UI 包；或用宿主鉴权/反代隔离（宿主侧鉴权本次未核） |
| 10 | TLS pin 采用 `rejectUnauthorized:false` + 指纹自校 | `peer-client.js:77-170,134-152` | 低 | 可接受（pin 有效），但指纹必须来自可信渠道 |
| 11 | 版本/兼容漂移：host 包 0.0.5 vs 内部 0.6.0；autostart 依赖 node 0.0.22；`engines dsh <0.3.0` | 各 `package.json`；`host\lib\index.js:41` | 低 | 锁精确版本；DSH 升 0.3 前不部署 |
| 12 | 审计可被覆盖（5MB 轮转）且无锚定 | `src\core\audit.js:13-36` | 低 | 外部收集 + 定期归档 |
| 13 | `shell_run`/`host_call`/`channel_send`/`pc_*`/`repair_*`/`plugin_install` 默认关——**这是优点，别为省事全开** | `config.js:53-88`；`roles.js:55-69` | — | 保持默认关；按需单点开，开完写进审计 |
| 14 | 插件是 in-process JS，**权限等于 DSH 用户**（README 原话） | 主插件 README | 高（原则性） | 用普通用户跑 DSH，不用管理员；服务账户隔离 |

---

## 7. 评估边界与未验证项

- **未运行**：没有安装/启动 mesh，所有结论来自静态源码；传输吞吐、TLS 互操作、4 节点实连延迟均未实测。
- **存在但未读取**：`~/.dsh-mesh/secrets.json`、`host-token(-dshN)`、`patches/*.yml`（含 Bearer），按纪律只确认代码路径，未打开。
- **未细读**：主插件 `client.js`（285KB 侧栏 UI）、`control-apps.js`（25KB 桌面自动化）、`channel-*.js` 渠道面；宿主 webServer 对 `/api/dsh-mesh/*` 的鉴权/CSRF 中间件（asar 只读工具无法 grep，未取证）。
- **待核**：`pairing.js:64` 默认 `ttlSec=300` 与 `config.js:212-217` 的 `codeTtlSec=1800` 不一致——CLI 是否传参未确认，实际码有效期可能比配置短（安全侧偏保守）。

---

## 8. 给决策者的一句话

**dsh-mesh 能把"跨机跑工具/搬文件/在对面起个 agent"补齐，但补不上"任务分派与调度"；而你现在的 4 节点已经用 interconnect 打通了消息面，最经济的路线是：消息继续归 interconnect，任务表/重试/审计/文件用 700-900 行薄层补上，mesh 只在"必须在对端新建会话"或"必须跨机文件"时按 §5.2 的单节点最小面灰度引入。**
