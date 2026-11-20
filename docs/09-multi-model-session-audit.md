# 09 · 多模型会话审计报告（mroute 派发合规）

- 审计对象：本工作区 `D:\Codes\DSH小插件` 在 `C:\Users\sir_c\.dsh\sessions\--D-Codes-DSH~5C0F~63D2~4EF6--` 下的 **95 个会话**（创建时间 2026-11-13 ~ 2026-11-20）。
- 审计问题：会话有没有派子会话？子会话用的哪个渠道/模型？派发前有没有查 mroute 推荐？查了之后有没有按清单走？被策略门拒过几次？
- 生成方式：`plugin-mroute/devtools/audit-sessions.mjs`（零依赖、只读、流式）→ `plugin-mroute/devtools/out/summary.json` + `out/audit-summary.md`。
- 只读声明：全程未写入 `~/.dsh` 下任何文件；唯一写出物是本报告与 `out/` 两个文件。
- 脱敏声明：本报告不含任何 prompt/消息正文、API key、token、cookie 或 credential 值；session id 一律只写前 8 位；工具返回正文只保留错误前缀（≤120 字符）；时间以 `summary.json` 的 ISO UTC 为准，正文叙述为本地时间（UTC+8），两者差 8 小时。

**结论摘要**

1. **响应率 70.0%（14/20）**：本工作区 20 个会话派过子会话（或试过），其中 14 个在派发前查过 mroute 推荐且首个成功派发落在清单内；近 7 天窗口（`--since 2026-11-13T14:00:00Z`，70 会话）为 **77.8%（14/18）**。
2. 未响应面主要不是「忘了查」，而是「查了但清单没被执行」：deviation 3 个（会话沿用自身默认路由）、no_preflight 2 个、preflight_late 1 个。
3. 宿主策略门是本工作区唯一真实的「硬门」：**10 次拒绝 / 4 个会话**，被拒路由固定为 `zai-coding-cn/glm-4.6`、`deepseek-official/deepseek-chat`、`deepseek-account/deepseek-chat`；被拒后行为均为**省略 assignee 继承父路由**，而非按清单换下一项。
4. 新工具 `mroute_dispatch_plan`（M4.11 工具 B）已被 9 个会话使用，其中 25666cbb 是「取清单 → 按第 3 位派发」的正面样本；但 `mroute_dispatch_plan` **不像 `model_route_query` 那样写决策日志**，审计只能依赖会话日志里的 tool_call 事件（见 §1.6、§6）。
5. 未发现任何会话因模型路由而完全无法工作：92 次派发尝试中 76 次成功，16 次失败全部可归因于宿主策略门（10）、tree 编排端口故障（5）、参数缺 provider（1）。

---

## §1 方法与数据源

### 1.1 三类数据源

| 来源 | 路径 | 用途 | 读写 |
|---|---|---|---|
| 会话日志 | `C:\Users\sir_c\.dsh\sessions\<slug>\<session>\session.v4.jsonl.zstd` | 会话、模型、工具调用、派发、子会话归属 | 只读 |
| 推荐决策日志 | `C:\Users\sir_c\.dsh\mroute\decisions\decisions-202611.jsonl` | mroute 历史决策（全局口径，无 session id） | 只读 |
| 插件注册表 | `C:\Users\sir_c\.dsh\profiles\desktop\cordis.patch.yml` | 渠道/模型别名/能力档位，用于解释清单 | 只读 |

`sessions` 根下共 **26 个 slug 目录**；本次只扫本工作区 slug 一个（可用 `--workspace` 指定其它目录名或路径子串）。

### 1.2 工作区 slug 的发现与解码

DSH 的 slug 形态是「路径分隔符 → `-`，非 ASCII 字符 → `~XXXX~`（UTF-16 码元十六进制，大写）」。实测两个必须踩过的坑：

1. **相邻两个转义共用一个 `~`**：`DSH小插件` 存成 `DSH~5C0F~63D2~4EF6`，不是 `~5C0F~~63D2~~4EF6`。若用 `/~([0-9A-Fa-f]{4})~/g` 逐段解码，会解成 `DSH小63D2件`（丢掉「插」）。正确写法是先解所有 `~XXXX`，再清掉残余 `~`：
   `slug.replace(/~([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/~/g, '')`。
2. **同一 slug 下有「目录名 = uuid」与「目录名 = `session-<uuid>`」两代形态**；事件里的 `session.id` 也可能带 `session-` 前缀，父链解析必须先 strip 前缀再比。

实测解码结果：`--D-Codes-DSH~5C0F~63D2~4EF6--` → `D/Codes/DSH小插件`（与 `session.cwd` 完全一致，可作为反向校验）。

### 1.3 zstd 多帧解码（本审计最大的技术坑）

`session.v4.jsonl.zstd` 不是「一个 zstd 压缩包」，而是**多帧 zstd 拼接**（一行日志一帧）。`node:zlib` 的 `zstdDecompressSync` 只解**第一帧**就返回：

- 实测：某 258964 字节文件整包解压只得到 276 字节（第一帧内容），后续帧被静默丢弃。
- 正确做法：按 RFC 8878 的帧头逐帧切分（magic `0xFD2FB528` 小端、FCS 字段标志、单段标志、校验和标志、字典标志、RLE block 只占 1 字节），对每帧单独解压再拼接。
- 实测：54 帧全部成功 → 848926 字节 / 112 行；95 个会话共 **4.2 万事件（首次 41799 / 复跑 42469）、0 坏帧**（单文件失败只记 warning，不中断）。
- 兜底：若手工切帧失败，就在 buffer 里搜下一个 `28 B5 2F FD` magic 继续，避免整体放弃。

### 1.4 事件结构（实证）

所有事件都是单行 JSON，公共字段 `{type, seq, time, data}`；`time` 是 **epoch 毫秒数字**（不是 ISO 串），`seq` 在同会话内递增。部分事件额外带 `sourceEventSeqs` / `surfaceOp`。四个关键事件的实测形态（截断至 120 字符以内，正文/参数已替换为占位符）：

- `session`（无 seq/time，仅首行一次）：
  `{"type":"session","version":4,"id":"f3ccad2c-…","createdAt":1795182816924,"cwd":"D:\\Codes\\DSH小插件","parentSession":"session-802ab7be-…"`（完整键序：`type, version, id, createdAt, cwd, parentSession, isSeeded, origin, delegationDepth, agentPreset`；`origin=subagent` 表示这是子会话）
- `request/header`（模型来源，每个 step 一条）：
  `{"type":"request/header","seq":18,"time":1795182817201,"data":{"header":{"config":{"provider":"zai-coding-cn","model":"glm-5.3","maxTokens":131072}`
- `tool/call`（`arguments` 是 JSON **字符串**）：
  `{"type":"tool/call","seq":27,"time":1795182829364,"data":{"turn":1,"step":2,"callId":"call_975fc6129a6448d8b1e83c25","name":"mroute_dispatch_plan","arguments":"…"}}`
- `tool/result`（正文在 `message.content[].text`，失败看 `message.isError`）：
  `{"type":"tool/result","seq":23,"time":1795182824890,"data":{"turn":1,"step":1,"message":{"role":"tool","source":{"kind":"tool","callId":"call_9b5c…"},"isError":false,"content":[{"type":"text","text":"<略>"}]}}}`

会话级模型取 `request/header` 的 `data.header.config.{provider, model}`（同一会话可能换档，报告按「首次出现」记主模型，全部模型记 `models[]`）；取不到则记 `unknown`（本次 0 例）。

### 1.5 判定口径

- **派发工具**：`subagent` / `subagent_fork` / `tree_dispatch`；`tree_dispatch` 的实参只有 `action/leaf_id/prompt/tree_id`，**没有 assignee**，故一律视为「继承父路由」，其子会话模型取子会话自己的 `request/header`。
- **before 判定**：`mroute_dispatch_plan` 或 `model_route_query` 的 `tool/call.time` 早于**首次派发** `tool/call.time`，且该次查询成功（`isError=false` 且解析出清单）。继承派发也按此口径——查过清单但省略 assignee，仍算「查过」。
- **清单命中**：解析工具返回文本里的编号行得到 `ranked[{rank, provider, models[]}]`；判定三档 —— `strict`（渠道与模型双命中）、`provider`（仅渠道命中，清单只给「建议模型」时模型不同不扣分）、`off`（不在前 N）、`undetermined`（继承且子会话模型未知）。
- **分类（7 档，任务书 6 档 + deviation）**：以**首个成功派发**定档 —— 其前有策略门拒绝 → `compliant_fallback`；在清单前 N → `compliant`；查过但 off 且无拒绝 → `deviation`；成功派发前无成功查询 → `no_preflight`；有查询但全在首次派发之后 → `preflight_late`；全失败/全 undetermined → `unknown`；无派发 → `no_dispatch`。
- **父子关联**：优先 `parentSession` 精确匹配（全部 85 个子会话都有该字段）；再按时间窗口 120s 关联回派发调用。实测时间差 p50 = 12ms、p90 = 32ms、max = 33ms，窗口极宽裕；仍关联不上的记 `unlinked`。
- **分成 7 档而不是任务书 6 档**的原因：真实数据里存在「查了清单、但首个成功派发既不是清单项也不是被拒后回退」的会话（如 3bdb417d 沿用自身默认路由），把它塞进 `no_preflight` 会掩盖问题，故单列 `deviation`。

### 1.6 决策日志口径（必须写明的限制）

`C:\Users\sir_c\.dsh\mroute\decisions\decisions-202611.jsonl` 共 **73 条**，键为 `ts / args / top3[{id, rank, reason_head}] / excluded_count / generated_at`，**没有 session id**；按天分布 11-13:2、11-14:1、11-15:22、11-16:10、11-18:1、11-20:37。

关键事实：**只有 `model_route_query` 会写这条日志，`mroute_dispatch_plan` 不写**。因此：

- 决策日志只能做「全局推荐行为」的旁证，**不能**用来判断某个会话是否查过推荐（无 session 维度）；
- 会话是否查过 mroute、用的是 query 还是 dispatch_plan，只能从会话日志的 `tool/call` 事件还原；
- 本次 20 个有派发会话里，`model_route_query` 8 个、`mroute_dispatch_plan` 9 个、none 3 个——dispatch_plan 已超过 query，但它对决策日志不可见，这是当前观测面的一个真实缺口。

---

## §2 覆盖范围

| 指标 | 数值 |
|---|---|
| 扫描会话 | 95 / 盘上 95（失败文件 0） |
| 事件总数 | 41799（首次全量运行；含被审计的本次审计会话自身，复跑会略增） |
| 耗时 | 1.8~2.1 s（单遍流式，95 会话） |
| slug 目录（全局） | 26 |
| 有派发调用的会话 | 20（占 21.1%） |
| 派发尝试 | 92（成功 76 / 失败 16） |
| 子会话 | 85（关联回派发 76，未关联 9） |
| 主模型 unknown | 0 个会话 |

按会话创建日分布（只统计 `createdAt`，跨天会话计入创建日）：

| 日期 | 会话数 | 其中有派发 |
|---|---|---|
| 2026-11-13 | 34 | 4 |
| 2026-11-15 | 17 | 3 |
| 2026-11-16 | 1 | 0 |
| 2026-11-20 | 43 | 13 |
| 合计 | 95 | 20 |

覆盖缺口说明：11-14/11-17/11-18/11-19 无新会话创建；本工作区之外的 25 个 slug（如 `--C-Users-sir_c--`、dsh_orb 系列）未纳入本次统计。

---

## §3 合规统计

### 3.1 分类总表（95 会话）

| 分类 | 会话数 | 占有派发 | 含义 |
|---|---|---|---|
| compliant | 11 | 55.0% | 派发前查过，首个成功派发命中清单 |
| compliant_fallback | 3 | 15.0% | 先被策略门拒，改填清单内路由（或继承） |
| preflight_late | 1 | 5.0% | 查了，但在首次派发之后 |
| no_preflight | 2 | 10.0% | 派发前没查 |
| deviation | 3 | 15.0% | 查了，但首个成功派发不在清单前 N |
| unknown | 0 | 0% | 无法判定 |
| no_dispatch | 75 | — | 无派发调用 |

**响应率 = (compliant + compliant_fallback) / 有派发 = 14 / 20 = 70.0%**；查过推荐率 = 17 / 20 = **85.0%**。

### 3.2 近 7 天窗口（cutoff 固定为 `2026-11-13T14:00:00Z`，≈ 审计运行时刻 − 7×24h，用 `--since` 保证可复现）

| 指标 | 数值 |
|---|---|
| 会话 | 70 |
| 有派发 | 18 |
| 派发尝试 | 63 |
| compliant + fallback | 11 + 3 = 14 |
| **响应率** | **77.8%（14/18）** |
| 派发前查过推荐 | 16 / 18 = **88.9%** |
| 分类 | compliant 11 · fallback 3 · no_preflight 2 · deviation 2 |

说明：`--days 7` 的 cutoff 会随运行时刻滑动（复跑结果略变）；报告数字用 `--since` 固定窗口，命令见 §7。滑动窗口下本次复跑约为 62~70 会话、16~18 个有派发，响应率 75.0%~77.8%，量级一致。

### 3.3 按模型族（主模型族，只看有派发会话）

| 模型族 | 会话 | 有派发 | compliant | fallback | 响应率 |
|---|---|---|---|---|---|
| glm | 57 | 12 | 5 | 3 | 66.7% |
| deepseek | 37 | 8 | 6 | 0 | 75.0% |
| qwen | 1 | 0 | 0 | 0 | — |

glm 族响应率偏低的主因是 fallback 占比高（3/12）：这 3 个会话都是被策略门拒绝后继承父路由，而父路由恰是 zai-coding-cn 的 glm 档。

### 3.4 派发前的工具使用（Top 8，按调用次数）

| 工具 | 次数 |
|---|---|
| pwsh | 464 |
| read | 185 |
| edit | 87 |
| grep | 45 |
| write | 34 |
| glob | 19 |
| web_fetch | 18 |
| plugin_manager | 18 |

`mroute_dispatch_plan` / `model_route_query` 均未进入派发前 Top 8——说明「先查推荐」仍不是默认动作，而是少数会话的刻意行为。

### 3.5 派遣画像（92 次尝试）

- 显式 assignee（`provider`/`model` 至少给一个）：**38 次**；省略继承父路由：**54 次**（58.7%）。
- 按渠道：`zai-coding-cn` 42 · `opencode-go` 23 · `deepseek-account` 5 · `deepseek-official` 4 · `glmflash-free` 2。
- 子会话模型 Top：继承→`zai-coding-cn/glm-5.3-flash` 21 · 继承→`opencode-go/deepseek-v4.1-flash` 19 · 显式 `zai-coding-cn/glm-5.3` 18 · 继承→`deepseek-account/deepseek-flash` 5 · 显式 `deepseek-official/deepseek-v4-pro` 4 · 显式 `opencode-go/deepseek-v4.1-flash` 3 · 继承→`zai-coding-cn/glm-5.3` 3。
- 「渠道命中但模型与清单建议不同」的会话 4 个（同渠道异模型），均判 compliant（清单只给建议模型，渠道优先级已落实）。

### 3.6 全局工具直方图（Top 10，供环境画像参考）

pwsh 1978 · read 1966 · edit 1081 · grep 541 · write 281 · plugin_manager 193 · glob 178 · compress 110 · tree_report 103 · cordis_inspect_query 97（其下为 send_message 77、subagent 75）。

---

## §4 典型样本（3 个）

### 样本 A · `802ab7be` → compliant_fallback

- 基本信息：创建 2026-11-15 10:56（本地），7215 事件，主模型 `zai-coding-cn/glm-5.3-flash`，25 个子会话、29 次派发尝试，是全库最活跃的派发会话。
- 关键时间线（本地时间）：
  1. 10:57:01 首次 `model_route_query`，清单 rank1 = `zai-coding-cn`；
  2. 11:04:31 `subagent zai-coding-cn/glm-4.6` → **策略门拒绝**；
  3. 11:04:41 `subagent deepseek-official/deepseek-chat` → **策略门拒绝**；
  4. 11:04:47 `subagent deepseek-account/deepseek-chat` → **策略门拒绝**；
  5. 11:04:55 省略 assignee，**继承** `zai-coding-cn/glm-5.3-flash` → 首个成功（子会话 `39a8e0d7`）；
  6. 13:15:03 显式 `deepseek-official/deepseek-v4-pro` 成功（子 `e5d17e7f`）；13:15:13 只给 model 不给 provider 的一次调用失败（`?/deepseek-v4-pro`）；
  7. 21:27 起改用 `mroute_dispatch_plan`；21:53:36 / 21:53:41 显式 `zai-coding-cn/glm-5.3` 连派两个子会话（`f3ccad2c`、`ad323ae1`）。
- 判定：先被拒 3 次后改填清单内路由（同渠道同族模型），落 `compliant_fallback`。**注意**：它的「回退」是省略 assignee 继承父路由，而不是读清单后的下一项（清单 rank2 是 opencode-go）。

### 样本 B · `25666cbb` → compliant（工具 B 的正面样本）

- 基本信息：创建 2026-11-20 21:33（本地），仅 47 事件，主模型 `opencode-go/deepseek-v4.1-flash`，1 个子会话。
- 关键时间线：
  1. 21:34:16 `mroute_dispatch_plan` → 5 行清单（`zai-coding-cn > opencode-go > deepseek-official > deepseek-account > xiaomi`）；
  2. 21:34:27 `subagent deepseek-official/deepseek-v4-pro` → 子会话 `90dcb086` 成功。
- 判定：命中清单第 3 位（同渠道异模型按 `provider` 档记命中），`compliant`。这是「取动态清单 → 按清单派发」的最短可复现路径：2 次工具调用、11 秒内完成。

### 样本 C · `3bdb417d` → deviation

- 基本信息：创建 2026-11-13 21:49（本地），1159 事件，主模型 `glmflash-free/GLM-5.3-Flash`（期间也用 `GLM-5.3-Flash-Thinking`、`zai-coding-cn/glm-5.3`），7 个子会话。
- 关键时间线：
  1. 22:12:42 `model_route_query`（清单只解析出 rank1 `zai-coding-cn`）；
  2. 22:17:41 `subagent` **省略 assignee** → 继承 `glmflash-free/GLM-5.3-Flash-Thinking`（子 `08492e22`，首个成功）；
  3. 次日（11-14）10:58:04 / 10:59:20 显式 `opencode-go/deepseek-v4.1-flash`（`b89daae9`、`2ca3d3e5`）；10:59:42 显式 `deepseek-official/deepseek-v4-pro`（`05fdf62c`）；
  4. 11:07:18 继承 `zai-coding-cn/glm-5.3`（`5b0322d9`，终于落到清单渠道）；
  5. 13:13:17 `opencode-go/qwen3.8-flash`（`9c90c4eb`）、13:13:58 `deepseek-official/deepseek-v4-pro`（`b1f63ad7`）。
- 判定：查过清单，但首个成功派发沿用了自身默认渠道（glmflash-free），落 `deviation`。它后续确实出现过清单渠道，说明「查到清单」与「改派发」之间仍缺一步显式指令。

---

## §5 异常清单与解读

### 5.1 宿主策略门拒绝：10 次 / 4 个会话

| 会话 | 次数 | 被拒路由（按出现顺序） |
|---|---|---|
| `802ab7be` | 3 | `zai-coding-cn/glm-4.6` → `deepseek-official/deepseek-chat` → `deepseek-account/deepseek-chat` |
| `3c29b497` | 3 | 同上三条 |
| `9edb45a3` | 3 | 同上三条 |
| `519990b1` | 1 | `zai-coding-cn/glm-4.6` |

错误文本固定为 `Error: child LLM route "<provider>/<model>" is not allowed for this Session`。被拒模型均为**较低档位 / 未批准的 chat 档**；同一会话里 `deepseek-official/deepseek-v4-pro` 反而能成功（802ab7be 13:15:03 实证）。解读：宿主的放行面与「模型档位/会话审批」相关，与 mroute 清单顺序无关——清单 rank1 的渠道 `zai-coding-cn` 本身开放，但其 `glm-4.6` 模型档被拒。**这是宿主行为，不是 mroute 行为**（mroute 是 advisory-only）。

### 5.2 `unknown tool`：16 次 / 6 个会话

| 工具 | 次数 | 会话与时间 | 解读 |
|---|---|---|---|
| `tree_report` | 10 | 678e9a55(4)、84ae67eb(3)、1b9eacdd(2)、b5c47541(1)，全部 2026-11-13 11:43–12:36 UTC | 该时段树工具面未注册到这些子会话，属宿主工具面漂移 |
| `model_route_query` | 2 | 802ab7be，2026-11-20 10:44:32 / 10:44:55 UTC | M4.8 交付期 schema 用 `type: ['string','null']` 被宿主拒 → 三工具集体未注册（fiber 仍 active），已修复 |
| `team_task_create` | 3 | ebff682c，2026-11-15 06:41 UTC | 会话臆造了不存在的工具名（无此插件） |
| `team_task_list` | 1 | 同上 | 同上 |

### 5.3 mroute 工具自身报错：3 次 / 2 个会话

- `802ab7be`：`model_route_query` 两次 `need 参数非法：键 "vision" 的值 "bogus" 非法（允许 excellent|good|fair，大小写敏感）`；
- `22177ec2`：一次 `orchestration` 同型错误；
- 均为**故意传非法值做校验测试**，不是功能缺陷；也印证 M4.8 的「校验先于任何 IO」在真实调用里生效。

### 5.4 其它派发失败：6 次 / 2 个会话

- `519990b1` 的 5 次 `tree_dispatch` 全部 `Error: E_PORTS_PROTOCOL: ports.dispatch failed`（2026-11-13 13:49:16 / 13:49:16 / 13:49:59 / 13:49:59 / 13:50:15 UTC）；随后该会话在 13:50:48 改用 `subagent` 成功——与 AGENTS.md §4「tree_dispatch 端口故障 → 切原生 subagent」的处置一致。
- `802ab7be` 1 次：`subagent` 只给 `model=deepseek-v4-pro`、未给 `provider`（生效路由 `?/deepseek-v4-pro`），属调用方参数错误。

### 5.5 未关联子会话：9 个

全部属于 `519990b1`（25 个子会话，只有 16 次成功派发能与之一一对应）。这 9 个的 `parentSession` 仍指向父会话，但父日志里没有对应的 `subagent`/`tree_dispatch` 调用——是 tree-engine 的竹节接力/批量派发在引擎侧建会话，工具调用不落在父会话日志里。它们不影响分类（分类只看有派发调用的会话），但会低估「实际派发次数」。

### 5.6 解读

1. **当前只有提示层，没有强制层**：mroute 的 `enforce_gate` 仍是占位（`lib/config-schema.js:207-211`），所有「先查推荐」依赖系统提示句 + 工具自觉。数据也印证：85% 的派发会话查过清单，但真正按清单走的只有 70%。
2. **两处行为断点**：①被策略门拒绝后，模型倾向「继承父路由」而非「读清单换下一项」；②查到清单后，首个派发仍可能沿用自身默认渠道（deviation 3 例）。这两处正是 `mroute_dispatch_plan` 文本里「用法」脚注要提醒的动作，但仅靠工具返回文本不足以改变习惯。
3. **dispatch_plan 的观测盲区**：9 个会话用了它却不在决策日志里，M4.11 的 A+B 方案里「B 已上线、A 未生效」，审计侧只能靠会话日志补证。

---

## §6 局限

1. **`mroute_dispatch_plan` 不写决策日志**：决策日志只有 `model_route_query` 的记录且无 session id，因此本报告的「查过推荐」全部来自会话日志的 `tool/call` 事件，无法与决策侧 `top3` 对账，也无法知道用户是否在设置面板改过渠道顺序后立即重试。
2. **父子关联是启发式**：`parentSession` + 120s 时间窗；9 个未关联子会话（tree-engine 竹节接力）只能标 `unlinked`，故「派发次数」按有调用记录的 92 次计，实际子会话 85 个，两者不能互推。
3. **清单解析依赖文本格式**：`mroute_dispatch_plan`/`model_route_query` 的输出是给人看的中文文本，解析靠「顶格编号行」；插件改版（加段、改脚注、换符号）会静默少解析出条目（历史 bug：遇缩进续行只解析到 rank1）。脚本对解析失败只降级不报错，存在低估风险。
4. **时间口径与窗口滑动**：`createdAt` 决定会话归属日；跨天会话（如 802ab7be 跨 11-15 到 11-16）只计入创建日。`--days N` 的 cutoff 随运行时刻滑动（同一份日志隔天复跑会得到不同的「近 N 天」数字），报告 §3.2 因此改用 `--since` 固定窗口；报告正文用本地时间（UTC+8），`summary.json` 用 ISO UTC，读文件时需注意 8 小时偏移。
5. **`time` 字段是毫秒数字**，部分事件（`session`）没有 `seq`/`time`，只能靠 `createdAt`；「派发前」的边界在毫秒级（实测 p50 12ms），极端并发下可能把同 step 的并行调用排错顺序。
6. **无法判断动机**：审计只用元数据（工具名/模型名/时间/错误文本），不含 prompt 正文（红线），所以「为什么没查」「为什么选了 off 路由」只能从行为模式推测，不能断言原因。
7. **日志留存**：只看到盘上仍存在的 95 个会话；更早会话若已被清理/归档则不在统计内，历史响应率可能被高估（能留存的往往是重要会话）。
8. **模型族归类**：按 `provider` 前缀切族（`zai-coding-cn`/`glmflash-free` → glm，`deepseek-*`/`opencode-go` 里的 deepseek 模型另计），跨渠道同名模型（`model_aliases` 里 8 条自反映射）未做规范化合并，故「按模型族」是粗粒度视图。
9. **审计包含自身**：被审计的 95 个会话里有本次执行审计的子会话，其日志在运行期间持续增长，因此「事件总数」每次复跑都会略增（41799 → 42469 实测），但会话数、派发次数、分类结果稳定。

---

## §7 复现命令

```powershell
cd D:\Codes\DSH小插件

# 1) DoD 口径：本工作区最近 50 个会话（按目录 mtime 降序取前 N），打印摘要 + 落 out/
node plugin-mroute\devtools\audit-sessions.mjs --limit 50

# 2) 全量（95 会话，含 JSON + Markdown）
node plugin-mroute\devtools\audit-sessions.mjs

# 3) 固定 7 天窗口（推荐：可复现），自定义输出路径
node plugin-mroute\devtools\audit-sessions.mjs --since 2026-11-13T14:00:00Z `
  --json plugin-mroute\devtools\out\last7.json --md plugin-mroute\devtools\out\last7.md

# 3b) 滑动窗口（近 7 天，cutoff 随运行时刻变化）
node plugin-mroute\devtools\audit-sessions.mjs --days 7 `
  --json plugin-mroute\devtools\out\last7.json --md plugin-mroute\devtools\out\last7.md

# 4) 扫其它工作区（slug 名或路径子串）
node plugin-mroute\devtools\audit-sessions.mjs --workspace dsh_orb --limit 20

# 5) 静默模式（只落文件）
node plugin-mroute\devtools\audit-sessions.mjs --quiet
```

自检要点：

- 控制台应打印「扫描: N/N 会话 · 事件 X · 失败文件 0」；失败文件非 0 说明有会话日志损坏（脚本会继续）。
- `out/summary.json` 里 `sessions[].dispatches[].child_sid8` 为 `null` 表示未关联；`classification_reason` 是给人工复核的一句话依据。
- 脚本零依赖、只读；除指定的 `--json`/`--md` 外不写任何位置。

产物：

- `D:\Codes\DSH小插件\plugin-mroute\devtools\audit-sessions.mjs`（996 行，零依赖）
- `D:\Codes\DSH小插件\plugin-mroute\devtools\out\summary.json`（机读）
- `D:\Codes\DSH小插件\plugin-mroute\devtools\out\audit-summary.md`（自动摘要 71 行）
- 本报告 `D:\Codes\DSH小插件\docs\09-multi-model-session-audit.md`
