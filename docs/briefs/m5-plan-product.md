# M5 自动评测 · E3 产品落地与风险

> 输入：`docs/briefs/m5-eval-plan-brief.md` §4「E3」六问。证据源：`plugin-mroute/lib/config-schema.js`、`lib/registry.js`、`lib/ranking.js`、`lib/tool-query.js`、`lib/tool-dispatch-plan.js`、`plugin-mroute/client.js`、`mroute/07-assembly-plan.md`、`mroute/07d-eval-monitoring.md`、`mroute/04-eval-feasibility.md`。
> 分工：本文只裁产品形态、验收与风险；通道执行形态交 E1、判分器与题库交 E2，冲突点集中列在 §9。

## 0. 结论先行（4 条）

1. **工具只产报告，永不写注册表**。`model_eval_run` 的写面只有两处：插件数据目录的历史文件 + 一个 volatile 摘要字段（供面板读）；`tier/priority/channels[].eval` 只能由人点「确认采纳」经 client `settings.mutate` 写入（复用 `client.js:1116-1125` 的 revision/冲突/回滚链）。理由三条：①04§D-1 明令「自动改 tier 明确不做」；②client 无工具调用面（`client.js:1331` inject 只有 `slots/remote/remote.settings/remote.credentials`），写链天然只在面板；③工具自我写回＝机器自裁决，破 advisory-only 红线。
2. **MVP 是「摸地图」不是「出分数」**：只做确定性判分 + 2 条哨兵，`vision/world_knowledge/orchestration` 在 MVP 里必然「未测」，`provisional` 恒真。目标 1–2 人日；07 方案 §M5 的 8–12 人日是含 judge/指纹/全量题库/跨 run 对比的全量，差额全部推到 M5.1/M5.2。
3. **零耦合**：M5-MVP 不改 `rankChannels` 任何排序键（`ranking.js:69-79`）、不改 `need` 匹配来源、不新增 `routes[]` 键，`model_route_query` / `mroute_dispatch_plan` 输出**逐字节不变**（验收第 13 条用 diff 证明）。分数要影响推荐，只能走「人工采纳改写 tier/priority」这条既有键路径。
4. **面板是报告与采纳入口，不是运行入口**。MVP 面板不给「运行」按钮（点不出工具，只能给一行可复制的调用命令），把「触发」留在会话里由 `model_eval_run` 完成。

## 1. 任务书三处纠偏（先纠再答）

- **`channels[].eval` 在 schema 里根本不存在**：`config-schema.js:170-198` 的 channelSchema 只有 id/routeProvider/models/channel_type/tier/priority/fallbacks/capability/model_capability/manual/quota_platform/quota_account_verified/reviewed_at。顶层唯一预留是 `eval: z.object({}).default({}).volatile()`（`:212-213`）——空对象对子键无定义，Day-1 探针只验证过「有显式定义的嵌套对象」roundtrip（`tmp/day1-schemastery-probe/`），空 object 写子键能否存活**未经实测**。结论：M5 第一步是补 schema（顶层 `eval` 定形 + channelSchema 加 `eval`），不是先写逻辑；否则写回被静默吞掉，且症状与 M4 坑「schema 默认值 ≠ 生效值」同型。
- **冻结字段集的 `scores` 是四类，现注册表是六维**：04§D-3（:222-236）写 coding/tool_call/long_context/instruction，而 `CAPABILITY_KEYS`（`config-schema.js:32`）是 coding/tools/long_context/vision/world_knowledge/orchestration。**映射必须显式**：`tool_call↔tools` 可并，`instruction` 无对应维（MVP 不落进 scores，只在 evidence 里作备注），`vision/world_knowledge/orchestration` 在 MVP 恒未测。禁止同名假设。
- **「把分数写进注册表 eval 字段」这句话对 MVP 不成立**：正确表述是「跑评测产报告 → 留档 → 人点确认 → 才写入 `channels[].eval` 摘要 + tier/priority」。

## 2. `model_eval_run` 工具契约

### 2.1 三条设计原则

- **贵操作，一次调用一个答案**：工具调用是一次性同步返回（含 `run_id`），不做后台任务（无队列、无轮询）。整轮墙钟默认 120s，超时截断为 `partial` 并如实说「跑了 n/m 题」。
- **能预估的先预估**：`dry_run=true` 零 LLM 调用，只返回题数/目标/预估 tokens/预估成本；agent 应先 dry-run 再真跑。
- **校验先于任何 IO**：沿用 `tool-dispatch-plan.js:244-258` 的先例，报错文案统一 `${TOOL_NAME}: <字段> 参数非法：…`。

### 2.2 入参（默认值 + 校验点）

| 参数 | 类型 / 缺省 | 校验规则（时机） |
|---|---|---|
| `suite` | string，`'lite'` | 闭集 `lite`（M5.1 才加 `lite-full`）；大小写敏感（**零 IO**） |
| `scope` | string，`'smoke'` | 闭集 `smoke|full`；`full` 时 `targets` 上限 1（**零 IO**） |
| `targets` | string[]，省略 = 取当前排序 #1 渠道的首个模型 | 每项须匹配 `^[a-z0-9][a-z0-9._-]*/[^\s]+$`，1..3 项，去重（**零 IO**）；provider/model 是否在 `ctx.llm` 目录内（host 内本地读，**无网络**） |
| `need` | object，无 | 六维键闭集 × 评级闭集，复用 `normalizeNeed`（**零 IO**）；只影响目标解析与报告标注，不改排序 |
| `effort` | string，`'pick_lowest'` | 闭集 `pick_lowest|pick_highest`，或该模型 `efforts[]` 内的合法 id（**零 IO**） |
| `probe` | boolean，`true` | 布尔；3 次采样出 `probe{ttft_ms,tps,samples,ttft_spread}`，不进 composite（**零 IO**） |
| `dry_run` | boolean，`false` | 布尔；`true` 只出预估，**零 LLM 调用**（**零 IO**） |
| `max_cost_cny` | number，取配置 `eval.budget.per_run_cny`（缺省 2） | >0、两位小数、≤ 配置硬顶 `per_run_cny_max`（**零 IO**） |
| `deadline_ms` / `timeout_ms` | integer，`120000` / `20000` | 整轮 30000..300000、单题 1000..120000（**零 IO**）；超时 → `status='partial'` |

隐式闸门（同样零 IO 或本地读）：①单飞——已有 run 在跑 → `E_EVAL_BUSY`；②日次数 + 日预算计数器（进程内 + 配置快照）；③目标渠道 `manual.status=disabled|exhausted` → 拒跑并说明；④渠道余额 < 预估 × 3 → 拒跑（04§E，走 quota 本地 loopback，属网络 IO 但仍在 stream 之前，失败只提示不阻断）。

### 2.3 返回文本样例（真实排版，照 `renderDispatchPlan` 的密度）

```
模型评测报告 · model eval（lite@1.0.0 · run eval-20261121-001）
口径：确定性判分 + 2 条哨兵 · 串行单模型 · 分数仅作建议，不阻断、不写注册表（advisory-only）
目标 1/1：deepseek-official / deepseek-v4-pro（effort=pick_lowest → applied=low · fingerprint f3a9c2d1）
问题：6 题（smoke · 每维 1 题）· 有效 5 · 失败 1 · 错误 0
分数：coding 100 · tools 50 · long_context 100 · vision 未测 · world_knowledge 未测 · orchestration 未测
综合：composite 78（已测 3 维加权归一化：coding .35 / tools .25 / long_context .20 → 归一）
用量：tokens 4,182（prompt 1,904 / completion 2,278）· 耗时 41.7s · 成本：无单价未折算 · 探针 ttft 820ms / tps 62.4 / 采样 3 / 抖动 ±95ms
仪表：instrument_healthy=true（哨兵 2/2 通过）· provisional=true（n=6 < 8，仅供参考）
建议：tier domestic_sota（不变）· priority 50 → 58；依据 composite 78、3/3 已测维 ≥ 50
留档：eval-history/eval-20261121-001.json · 采纳请在「设置 → 模型路由 → 评测」点确认（本工具不写注册表）
```

坏仪表时首段替换为（其余字段照常留档）：
`仪表：instrument_healthy=false（哨兵 must-fail 题被判通过：「水中燃烧」答成可行）` → `结论：⚠ 本轮不可用于采纳（判分仪表异常）；已留档 eval-history/…-002.json，建议换题或重跑`

### 2.4 结构化 output 字段表

| 字段 | 类型 | 说明 |
|---|---|---|
| `run_id` | string | `eval-<yyyymmdd>-<seq>`；同 run 重试沿用并标 `attempt` |
| `suite` | object | `{id, version, scope, question_count}` |
| `started_at` / `finished_at` / `duration_ms` | string / string / number | 本地时区 ISO；`duration_ms` 含全部重试 |
| `status` | string | `ok|partial|failed|unhealthy`（**无 `adopted`**，采纳态只存在于配置） |
| `targets[]` | array | 每项见下（MVP 长度 1..3） |
| `targets[].scores` | object | 六维键，**缺测的维不发该键**（禁 null，宿主 schema 只吃单一 type） |
| `targets[].composite` / `provisional` / `measured_dims[]` | number / boolean / string[] | composite 只对 `measured_dims` 归一化 |
| `targets[].counts` | object | `{n_questions, n_valid, n_failed, n_error}` |
| `targets[].usage` | object | `{prompt_tokens, completion_tokens, total_tokens}`；`cost_cny` 仅在有单价时出现 |
| `targets[].instrument_healthy` / `unhealthy_reason` | boolean / string | `false` 时 `suggestion` 键整体不出现 |
| `targets[].suggestion` | object | `{tier, priority, changed[]}`；**永远只是建议** |
| `targets[].applied_effort` / `fingerprint` | string / object | 07d§2.4 追加字段；`fingerprint` 变化才能说「后端已变」 |
| `budget` | object | `{estimated_cny, spent_cny, cap_cny, state}`；`state ∈ ok|exceeded|partial` |
| `evidence_ref` / `notes[]` | string / string[] | 报告相对路径 + 人读提示（如「prepaid 渠道建议先 smoke」） |

### 2.5 必须在任何 IO 之前完成的校验（分三层）

1. **纯入参（零服务调用）**：类型/枚举闭集/数组长度/正则/去重/`full`×`targets` 组合约束/`deadline≥timeout`/`max_cost` 上界/`dry_run` 与 `effort` 的冲突。失败必须**零 token**，且错误文本带「未发起任何模型调用」。
2. **本地服务读（host 内、无网络）**：`ctx.llm` 目录核 provider/model（不存在 → 文案指向 `model_route_sync_models` 先对齐）、注册表渠道 `manual.status`、单飞锁、日计数器。
3. **网络前最后一道**：预算预估（有单价按单价，无单价按 `max_output_tokens` 上限估）→ 超帽直接拒跑；quota 余额联动（失败只降级为提示）。**通过后才允许第一条 stream。**

## 3. 面板形态

### 3.1 位置与线框

位置：`PreviewCard`（`client.js:923`）之后、`DynamicCard`（`:888`）之前——决策流是「建议顺序 → 质量证据 → 余额」。默认**折叠**（照 `AliasCard` 先例），摘要 chip 在折叠态也要能看出健康态。

```
┌ .mroute-card.mroute-eval-card.is-open ───────────────────────────────┐
│ .mroute-eval-head  评测 · eval  +  .mroute-eval-chip.is-idle|is-running|is-ready|is-unhealthy
│ .mroute-eval-body（折叠开关 .mroute-card-toggle；默认折叠）
│   .mroute-eval-summary  最近 eval-…-001 · 11-21 22:07 · ok
│   .mroute-eval-meta     composite 78 · n=6 · provisional · healthy
│   .mroute-eval-targets → .mroute-eval-target × N └ -target-id / -target-score
│   .mroute-eval-dims    → .mroute-eval-dim × 6   └ -dim-name / -dim-score / .mroute-eval-bar[data-score]
│   .mroute-eval-diff    → .mroute-eval-diff-row × 2（.is-same/.is-up/.is-down）
│                          └ .mroute-eval-diff-label / -old / -arrow / -new
│   .mroute-eval-actions → .mroute-eval-adopt + .mroute-eval-adopt-hint
│   空态/中断: .mroute-eval-empty + .mroute-eval-runline ‖ 提示: .mroute-eval-warn / .mroute-eval-error
└──────────────────────────────────────────────────────────────────────┘
```

样式只用既有 theme token（`client.js:1207-1327` 的写法），不新引入颜色变量；`.mroute-eval-bar` 用宽度百分比表达分数，不画图。

### 3.2 三态（判据取自配置里唯一那根「状态线」）

面板只读 settings 镜像，所以报告必须落到 volatile 字段才有得渲染——**仿 `dynamic_snapshot` 先例**（`config-schema.js:274-285`），新开 `eval.last`（运行态镜像，宿主写）与 `channels[].eval`（采纳态，面板写）分开。

| 态 | 判据 | 展示 | 可操作 |
|---|---|---|---|
| 未跑 | `!eval.last.run_id` | `.mroute-eval-empty` + `.mroute-eval-runline`（一行可复制命令） | 无按钮 |
| 运行中 / 中断 | `eval.last.status==='running'` | `开始于 …`；`now-started > 10min` 追加 `疑似中断（超时或宿主重启），可重跑` | 无按钮 |
| 有报告 | `status ∈ ok|partial|unhealthy` | 摘要 + 目标 + 六维 + diff | `确认采纳`（`unhealthy` 时 disabled）+ 忽略 |
| 已采纳 | `eval.last.adopted_at` 存在 | 摘要 + `已于 … 采纳（registry_version=n）`，报告转只读 | 无 |

**为什么要写 `status='running'`**：面板无法得知宿主内进程态（client 只有 settings RPC），不写这一笔，运行中与「从没跑过」在界面上完全一致——这正是 M4.10「面板永远显示暂无动态数据」的同类缺陷。代价是每轮多一次 volatile 写，可接受；崩溃残留的 `running` 恰好变成「中断」指示器，是特性不是 bug。

### 3.3 报告 diff 的五个呈现要点

1. **一行一个可采纳字段，只 diff `tier`/`priority`**（MVP 采纳面就这两项），不变时 `.is-same` 灰显「不变」，不制造噪音。
2. **红绿只表方向，不表「更好」**：文案是「priority 50 → 58」而非「↑ 优化」，避免把机器估分渲染成裁决。
3. **证据随行**：diff 右侧挂 `composite 78 · n=6 · provisional`；逐题明细 M5.1 再做，MVP 只给报告文件名。
4. **健康态先行**：`instrument_healthy=false` 时 diff 上方一条 `.mroute-eval-warn`「判分仪表异常，本轮不可采纳」，diff 仍显示（留档）但按钮 disabled。
5. **不渲染模型原文**：面板只显示题 id + 通过/失败，不显示 answer 全文——体积、泄密面、无意义三头赚。

### 3.4 「确认采纳」写回链路

- **谁写**：client 半。一次 `remote.settings.mutate(NS, ops, revision)`（`client.js:1116-1125`），原子提交，任一条失败即不落盘。
- **写什么（5 条 op，顺序无关）**：①`{op:'set', path:['channels'], value:<整替数组>}`——目标渠道 `tier`/`priority` 改建议值，并写入 `channels[].eval` 摘要（04§D-3 冻结字段集 + 07d§2.4 的 applied_effort/instrument_healthy/probe/fingerprint）；②`registry_version` = 旧值 + 1；③`reviewed_at` = 今天；④`reviewed_against` = `eval-suite@1.0.0 + fingerprint@f3a9c2d1 + eval-run/eval-20261121-001`；⑤`{op:'set', path:['eval'], value:<整替>}`——把 `eval.last.adopted_at/adopted_run_id` 记上（**整替而非嵌套 path**，避开嵌套 set 的未验证语义）。
- **失败提示（四类，文案各自独立）**：①`SETTINGS_CONFLICT` → 「设置已在别处修改，已刷新；本次未采纳」+ **重新计算 diff**（绝不能拿旧报告套新 tier）；②`ok:false` 或 schema 拒 → `saveErrors` 逐条列 op 的可读原因，注册表零变化；③报告过期（`report.finished_at < channel.reviewed_at`）→ 不报错，按钮旁 `.mroute-eval-warn`「报告早于人工修改，建议重跑」，采纳仍允许；④采纳后版本不符（他处已 +1）→ 按冲突处理。

## 4. 与既有功能的耦合规则（最小侵入）

| 面 | 读 eval 吗 | MVP 决定 | 证据 |
|---|---|---|---|
| `rankChannels` 排序 | 否 | 不加任何键；唯一间接通路是人工采纳改写 tier/priority（既有键） | `ranking.js:69-79` 全序键里无 eval |
| `need` 匹配 / `suggested_model` | 否 | 档位来源仍是 `model_ratings → model_capability → capability` | `registry.js:108-160` 解析顺序 |
| `mroute_dispatch_plan` | 否 | 输出逐字节不变；M5.1 才考虑行尾 `eval=78p` 尾注 | `tool-dispatch-plan.js:123-151` |
| `model_route_query` | 否 | `routes[]` 不新增键；M5.1 才有可选 `eval` 摘要（单一 type、非必需） | `tool-query.js:632-693` |
| `dynamic_snapshot` | 否 | 各写各的字段；两者都是 read-modify-write，理论可互相覆盖，概率低且下一轮自愈 | `config-schema.js:274-285` |
| `DecisionRecord` | 否 | 不动 | — |

**一句话**：M5-MVP 把变更收敛在「配置字段 + 面板 + 新工具」三处，四个既有工具的 JSON 与文本输出零改动。这条不只是洁癖——`assembleRouteTable` 是两个工具共用的装配器（`tool-query.js:514-517`），往里塞 eval 会一次性改两个工具的契约和全部既有快照断言。

## 5. 隐私 / 安全 / 成本

- **读什么**：只读注册表 Config（渠道/评级/别名）+ 可选 quota 快照 + `ctx.llm` 目录。**不读**工作区文件、会话历史、`ctx.credentials`、环境变量、用户当前 prompt。题库随包内置（`lib/eval/suite-lite.json`），`model_eval_run` **不接受文件路径或自由 prompt**——这既堵住「诱导工具把用户代码发给 5 家 provider」的外泄面，也堵住提示注入面。
- **凭据**：mroute 全程不持有 key、不拼 Authorization、不新增任何 outbound HTTP；评测流量走宿主 `ctx.llm`（既有通道与既有计费）。这是比 M2 更干净的隐私面——mroute 从头到尾没见过凭据。
- **日志边界**：`eval-history/<run_id>.json` 只落 `{题 id, 维, 判定 pass|fail|error, 判分器, tokens, ms, 错误码, judge_reason ≤200 字}`，**不落 answer 全文**（debug 需要时用 devtools 脚本，不进工具面与发布包）；宿主 logger 只 warn 一行摘要，不逐题打点；`eval.last` 只放摘要，不放 provider 原始响应（与 M2 的处理口径一致：上游原始响应不进配置）。目录按 `dshHomePath('mroute')`，保留最近 20 个 run，超出按 mtime 清理。
- **预算三闸**（配置 `eval.budget`，面板可编辑）：预检（预估超帽 → 拒跑，文案给三条降本建议）→ 运行中（累计超帽 → 停跑，`status='partial'`，如实说「跑了 4/6 题，已花 ¥1.72」）→ 日闸（次数或金额耗尽 → 拒跑并说明重置时间）。
- **不臆造金额**：无单价表时只显示 `tokens=4,182（无单价，未折算）`，与 M2「未核实渠道不显示数值」同一口径。包月渠道边际成本≈0，默认允许 `scope=full`；prepaid 默认 `smoke`，升 full 需显式传参。
- **`instrument_unhealthy` 的产品语义**：四触发（哨兵 must-pass 判错 / must-fail 被判通过 / 连 3 题 infra error / 出现未知 finish kind）。后果：报告 `status='unhealthy'`、不生成 `suggestion`、面板采纳按钮 disabled、文本首行 `⚠ 本轮不可用于采纳`、**不进 `channels[].eval`**。与 M2 的 `degraded/cooling` 同一条原则：数据不可信就明说不可信，绝不给一个看起来正常的假数字。

## 6. M5-MVP 验收清单（13 条，一天可验完）

| # | 跑什么 | 看到什么（可观测断言） |
|---|---|---|
| 1 | `node --check` 全部新文件 → `plugin_manager set_bundle` 关→开 | `Tool.listTools` 出现 `model_eval_run`，且既有 4 个工具仍在（schema 无 type 数组） |
| 2 | `model_eval_run {dry_run:true}` 无参 | 文本含「预估」行（题数/目标/预估 tokens）；宿主无 provider 请求 |
| 3 | 三个非法入参各一次（`suite:'x'`、`targets:['nope/nope']`、`need:{bogus:'good'}`） | 三条报错原文正确，且均带「未发起任何模型调用」 |
| 4 | `{scope:'smoke', targets:['deepseek-official/deepseek-v4-pro']}` | 报告含 run_id/6 题/composite/healthy/耗时；墙钟 < 90s |
| 5 | 让 must-fail 题被答「过」（mock 或换题） | `instrument_healthy=false`、无 `suggestion`、文本首行不可采纳 |
| 6 | `max_cost_cny:0.01` | 预检拒跑，文案含预估 vs 上限，零调用 |
| 7 | 把 per-run 预算压到只够 2 题 | `status='partial'` + 「已跑 2/6」，注册表零变化 |
| 8 | 对 `eval-history/*.json` grep 工作区路径/会话 id/`sk-` | 零命中；字段白名单全中 |
| 9 | 面板：设置 → 模型路由（未跑态） | `.mroute-eval-empty` + `.mroute-eval-runline` 可见 |
| 10 | 面板：跑完一轮后重开 | `.mroute-eval-summary` / `.mroute-eval-dim` / diff 行（`.is-same`/`.is-up`）齐全 |
| 11 | 点 `.mroute-eval-adopt` | `.mroute-saved` 出现；`model_route_query` 见 priority 生效、`registry_version`+1、`reviewed_at`=今天 |
| 12 | 双窗口：A 改 tier 保存、B 点采纳；再造一次 `ok:false` | 冲突提示 + 自动刷新，注册表未被覆盖；失败时红条 + 可重试 |
| 13 | 同一注册表下 `model_route_query` / `mroute_dispatch_plan` 输出与 M4.11 快照 diff | 空 diff（零耦合证明） |

**MVP 明确不做**：面板按钮触发运行；自定义/多套题库；LLM judge；tier 自动改；eval 进排序/`need`/两工具输出；指纹监测与「后端已变」提示；跨 run 对比；成本单价表；多目标并发（MVP 串行，`targets≤3`）。

## 7. 里程碑

- **M5-MVP（1–2 人日）**：`model_eval_run`（lite/smoke/串行单模型/确定性判分/2 哨兵/dry_run/预算三闸）+ 历史落盘 + `eval.last` 摘要 + 面板三态与确认采纳 + 零耦合。验收 = §6 全绿 + `selfcheck` 新增组通过。
- **M5.1（3–5 人日）**：全量题库（≤18 题）+ LLM judge（末行 PASS/FAIL、TPR/TNR≥0.9、Wilson 下界）+ `scope=full` 多目标 + 跨 run 对比 + 面板逐题展开 + dispatch 行尾 `eval=` 标注。验收：judge 校准集 TPR/TNR≥0.9；同模型两轮 composite 差 ≤5 分；采纳后排序变化可手算复现。
- **M5.2（3–5 人日）**：评级建议（分数→`model_ratings` 阈值表，逐维人工采纳）+ 指纹监测 + 外部榜单交叉 + 批量/定时评测（包月优先）。验收：人工值与建议并存时能区分来源（`source=manual|eval`）；批量不破日预算。

## 8. 需要用户裁决的 5 个问题

1. **eval 分数是否允许影响推荐顺序？** A 只经人工采纳改写 tier/priority（推荐，守住 M4 契约与 2026-11-20「模型档位不影响渠道顺序」裁决）；B `composite` 作 tier 内次级键（07/04 原案，动排序）；C 不进排序只做标注。
2. **面板要不要「点一下就跑」？** A MVP 只给可复制命令（推荐，零新机制）；B 面板写 `eval.request`、宿主监听触发运行（需幂等/重启/中断恢复设计）；C MVP 连入口都不给。
3. **采纳范围？** A 只写 tier/priority + `channels[].eval`（推荐）；B 同时按阈值改写 `model_ratings` 六维；C 只写 eval 摘要、不动 tier/priority（纯留档）。
4. **默认预算档？** A 单轮 ¥2 / 日 ¥5 / 日 3 次（推荐）；B 单轮 ¥0.5 / 日 ¥2（更保守）；C 不设默认，每次必填。
5. **默认评测目标？** A 省略时取排序 #1 渠道首个模型（推荐，贴合「派遣前预检」直觉）；B 必须显式指定 `targets`；C 取 `need` 命中的首个 `suggested_model`。

## 9. 我与其他角度可能冲突的判断

- **与 E1（通道）**：本文假设「一次工具调用内同步跑完 6 题 × 1 模型 ≈ 40s」。若 E1 实测单题 P95 >15s 或宿主工具调用有更短硬超时，MVP 必须降到 3 题或改异步，验收第 4 条时长断言同步下调。
- **与 E2（判分）**：我把 LLM judge 推出 MVP，代价是三个维恒「未测」、composite 只覆盖确定性可判的维。若 E2 坚持「无 judge 无语义区分度」，需裁决 MVP 是否含 judge——那会把 1–2 人日推到 3–4 人日，并新增 judge 自评偏差风险。
- **与任务书**：见 §1 三处纠偏；其中 `channels[].eval` 缺 schema 与写回路径归属是**必须 lead 确认后再开工**的前置，否则 M5 第一天就会踩在空 object 上。
- **与 07 方案估工**：8–12 人日是全量口径，本文把 MVP 压到 1–2 人日，差额不是「省掉」而是显式挪进 M5.1/M5.2，用户若要求一次性全量请按 8–12 人日排。
