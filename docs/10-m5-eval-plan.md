# 10 · M5 自动评测总计划（多专家合并版）

> 状态：**计划定稿 · MVP 待开工**（2026-11-20）。正源＝本文件；三份专项输入：[m5-plan-channel.md](briefs/m5-plan-channel.md)（通道/工程）、[m5-plan-design.md](briefs/m5-plan-design.md)（评测设计）、[m5-plan-product.md](briefs/m5-plan-product.md)（产品/风险）。
> 读者：后续实施子会话先读 §2 裁决与 §7 范围，再看自己那一段。

## 0 目标与验收总判据

M5 要解决的是「能力档位靠人工猜」——目前六维档位是用户在面板里手填的 `model_ratings`，没有任何实测依据。M5 让插件能**自己跑一批小任务、按维度打分、把结论摆到用户面前，由人决定采纳**。

三条总判据（缺一不算完成）：

1. **能跑**：一次工具调用内可完成一轮评测，finish 全部落在白名单内，无静默失败。
2. **能判**：分数可复现、可解释，无法确定性判分的维度必须显式置 `null` 而不是给假分。
3. **能记账**：每次 run 落 JSONL，注册表里能读到摘要 + `suggest`，且**不改任何既有排序/输出契约**。

## 1 三份专家输入的合并结论

**共识（三人一致，无需再议）**

- 通道②=宿主 `ctx.llm` 现成可用，`plugin-mroute/index.js:31` 的 `inject` 已含 `llm`，不需要新增接入面。
- `prepareCall` 返回**冻结一次性句柄**：`stream` 只能派发一次，重试必须重新 `prepareCall`，否则 `LlmError / INVALID_PREPARED_CALL`。
- **effort 必须显式钉死**，否则宿主用 `defaultEffort` 填充，跨模型对比退化成跨档位对比。
- 判分白名单要按 **chunk 层** 写（`stop|tool-calls|max-tokens|error|aborted`）；`completed` 是上层 settlement 标签，不是 `finish.reason.kind`。
- 写回只有一个入口：**人点「确认采纳」**，工具永不自动改 `tier/priority`。
- MVP 必须**零耦合**：eval 不进排序键、不进 `need` 匹配、不改 `model_route_query` / `mroute_dispatch_plan` 任何一个字节。
- 成本的真实风险是**包月渠道 5h 窗口**，不是 token 钱；护栏要在「选渠道」阶段硬筛。

**分歧与我的裁决**

| 议题 | E1 | E2 | E3 | 裁决 |
|---|---|---|---|---|
| 六维能否全测 | 未表态 | 只有 coding/tools/long_context 可确定性判分；vision 结构性 `null`；world_knowledge 只作哨兵；orchestration 只能测计划 JSON | — | **采纳 E2**：M5 诚实产出是「分维表 + provable 标记」，不是排名 |
| judge（LLM 评分） | 未表态 | 撞凭据红线 + 同族 skew 虚高 | 推到 M5.1 | **MVP 关 judge**；M5.1 再议，且必须走 `ctx.credentials` |
| 是否先补 schema | 未表态 | eval 当前零消费 | `channels[].eval` 不存在、顶层 `eval` 是空对象，不补会被静默吞掉 | **开工前置**，见 §3 |
| 面板「运行中」态 | — | — | 必须写 `eval.last.status='running'`，否则「跑中」与「没跑过」同形 | **采纳**（M4.10 同款缺陷） |
| 单题预算 | 默认 `maxTokens` 可达 131072，必须显式压小 | 6 题×3 模型≈18 次单轮 | 一次工具调用约 40s，有超时风险 | **显式 `maxTokens` + 单题超时 + 总调用上限三闸** |

**任务书纠偏（专家提出，已采纳）**：原 07 方案设想「eval 子对象挂在 `channels[]` 里」，与 M4.7「能力档位按统一模型名登记」冲突。**eval 也应挂在规范模型名下**（见 §3），否则同一模型在多个渠道会被重复评测、分数互相覆盖。

## 2 设计裁决（正源）

1. **评测对象 = 规范模型名**（`model_aliases` 合并后的 canonical），不是渠道。同一模型跨渠道只评一次。
2. **结果落点 = 新顶层 `model_eval`**（`z.dict` 按 canonical 索引），不改 `channels[]` 结构、不改 `model_ratings` 语义。
3. **覆盖链固定**：`manual.status` > 渠道 `tier/priority` > `model_ratings`（人工档位）> `model_eval.suggest`（实测建议，仅展示）。实测**永远不覆盖**人工登记，只提示。
4. **工具**：新增 `model_eval_run`（不是 `model_eval_run` 自动跑；由会话或用户显式调用），默认 `dry_run: true`。
5. **MVP 题量**：6 题（六维各 1）× 至多 3 个模型 × 单 trial，串行。
6. **判分**：确定性判分（exact / regex / JSON schema / 数值容差）优先；`vision` 置 `null`；`world_knowledge` 仅作哨兵；`orchestration` 只校验计划 JSON 结构。
7. **统计**：结论强度用 Wilson 95% 下界；<12 题/维一律标 `provisional`，**只允许建议 `priority ±10`，不允许建议改 `tier`**。
8. **写回**：`model_eval_run` 写 `model_eval`（分数与 `suggest`）与 `eval_status`；`tier/priority` 只能由面板「确认采纳」经 `settings.mutate` 写。

## 3 数据模型（开工前置）

```js
// lib/config-schema.js 追加（顶层，volatile；内部字段不标 volatile）
model_eval: z.dict(z.object({
  last_run: z.string().default(''),            // ISO
  applied_effort: z.string().default(''),      // 钉死的档位；与 resolveModelInfo.efforts 不符 → instrument_healthy=false
  instrument_healthy: z.boolean().default(false),
  scores: z.object({                            // -1 = 未测；null 语义用 -1 + dimension_status 表达
    coding: z.number().default(-1),
    tools: z.number().default(-1),
    long_context: z.number().default(-1),
    vision: z.number().default(-1),
    world_knowledge: z.number().default(-1),
    orchestration: z.number().default(-1),
  }).default({}),
  dimension_status: z.dict(z.string()).default({}), // 'graded' | 'null' | 'sentinel' | 'skipped'
  composite: z.number().default(-1),
  samples: z.number().default(0),
  wilson_lb: z.number().default(-1),
  provisional: z.boolean().default(true),
  suggest: z.object({
    tier: z.string().default(''),               // 空 = 不建议改 tier
    priority_delta: z.number().default(0),      // MVP 只允许 ±10
    note: z.string().default(''),
  }).default({}),
  evidence_refs: z.array(z.string()).default([]), // 指向 eval-history/<run_id>.jsonl
  probe: z.object({ ttft_ms: z.number().default(-1), tps: z.number().default(-1), samples: z.number().default(0) }).default({}),
}).default({})).default({}).volatile(),

// 运行态镜像（面板读它显示「运行中」，同 dynamic_snapshot 先例）
eval_status: z.object({
  as_of: z.string().default(''),
  state: z.string().default(''),                // '' | 'running' | 'done' | 'failed'
  run_id: z.string().default(''),
  note: z.string().default(''),
}).default({}).volatile(),
```

**Schemastery 探针（开工第一步，不可跳）**：`z.dict(z.object({...}))` 在 volatile 父级下能否 roundtrip、`.default({})` 是否让空表合法、嵌套 `scores/dimension_status` 是否逐键存活。任一不通过 → 降级为 `model_eval: z.dict(z.any()).default({}).volatile()` + 读侧自校验（沿用 07 §3.2 降级预案）。

## 4 通道②调用纪律（E1 实证，必须照做）

```js
const prepared = ctx.llm.prepareCall({ provider, model, maxTokens: 512, temperature: 0 }, signal, (controls) => { controls.effort = pinnedEffort })
const chunks = []
for await (const chunk of prepared.stream(input)) chunks.push(chunk)
const usage = chunks.at(-2)?.usage            // usage 是倒数第二个
const finish = chunks.at(-1)?.finish          // finish 是最后一个
```

- 重试 = 重新 `prepareCall`；**不缓存句柄**。
- 白名单：`stop` 成功；`tool-calls` 对 tools 维算成功、其它维算可疑（记 `finish_kind` 原文）；`max-tokens|error|aborted` 失败；未知 kind 显式失败并落原文。
- `maxTokens` 必须显式传小值（默认可达 131072）。
- 并发：MVP 全串行；单题超时 60s，整轮上限 `max_calls`。
- `applied_effort` 取自 `resolveModelInfo.efforts` 校验，不一致整轮 `instrument_healthy=false`。

## 5 六维评测表（E2 结论）

| 维度 | 题型（MVP 1 题） | 判分 | status | 说明 |
|---|---|---|---|---|
| coding | 给定输入输出的纯函数补全，跑断言 | 确定性（执行/比对） | `graded` | 主力维度 |
| tools | 单轮函式调用，校验 `tool_calls[].name/args` 结构 | 确定性（结构校验） | `graded`* | **风险**：插件侧无 `tools` 注入实证；先做 30 分钟 spike，失败则本维 `null` |
| long_context | 长文里埋 3 个可检索事实，问其中 2 个 | 确定性（exact contains） | `graded` | 命中率即分数 |
| vision | 图 + 问「图里写了什么」 | **不测** | `null` | 宿主把图投影成文本占位，成功≠看见 |
| world_knowledge | 有确定答案的事实题 | 仅哨兵 | `sentinel` | 污染+时效，不进 composite |
| orchestration | 给目标要求输出计划 JSON（步骤/依赖） | 结构化校验 | `graded`* | 通道②无 tool-result，只测「计划质量」不测「执行」 |

`composite` = 仅对 `status='graded'` 的维度按权重加权；`null/sentinel` 维度不参与。

## 6 统计与 suggest 规则

- 单维分数 = 通过题数 / 有效题数；结论强度取 **Wilson 95% 下界**。
- `samples < 12` → `provisional = true`：**只出 `priority_delta`（±10，且 `min(coding, tools)` 的下界 ≥0.55），`suggest.tier` 留空**。
- `samples ≥ 12` 且下界 ≥0.75 → 可给 `suggest.tier`（仍只建议，人工采纳）。
- 哨兵（must-pass / must-fail）任一破 → 整轮 `instrument_healthy=false`，不写 `model_eval` 分数，只写 `eval_status.state='failed'` 与原因。

## 7 MVP 范围（M5-MVP-0，目标 1–2 人日）

**做**：
1. schema 探针 + `model_eval` / `eval_status` 两个顶层字段（含降级预案）。
2. `lib/eval/suite-lite.mjs`：6 题（§5），每维 1 题，题面写死在代码里（不进配置），`version: 'lite/1'`。
3. `lib/eval/runner.mjs`：串行执行、超时、`maxTokens` 压小、finish 白名单、usage 采集、`applied_effort` 校验。
4. `lib/eval/score.mjs`：确定性判分 + 哨兵 + Wilson + `dimension_status` + `suggest`。
5. `lib/tool-eval-run.mjs` + `index.js` 平级 try 注册：`model_eval_run({ models?: string[], dry_run?: boolean = true, max_calls?: number = 18 })`；文本报告 + 结构化 output。
6. 存储：`<DSH_HOME>/mroute/eval-history/<run_id>.jsonl`（逐题明细）+ `model_eval` 摘要 + `eval_status` 运行态三写。
7. 三个成本闸：单题 `maxTokens`、`max_calls` 上限、渠道白名单（**MVP 默认只允许 prepaid 渠道**，避免打爆包月窗口）。
8. selfcheck：新增 `eval-run.test.mjs`（≥10 组：白名单/超时/哨兵破/文件缩水 vision=null/provisional 正确/suggest 上限/dry_run 不落盘）。

**不做（M5.1 起）**：LLM judge、指纹复核（`fingerprint`）、性能探针实采（`probe` 全 -1）、12 题/维正式卷、面板图形化报告（MVP 只加一行状态文本）、跨 run 对比、自动排期。

**面板（最小改动）**：`model_eval` 与 `eval_status` 只读镜像 + 一行说明（`评测：未运行/运行中/最近 N 分钟前`），不做「确认采纳」按钮（M5.1 再上，避免零耦合验收被打破）。

## 8 MVP 验收清单（逐条可观测）

1. `node --check` 三个新文件 0 错；`npm.cmd run check` exit 0。
2. `npm.cmd run selfcheck` 全绿（≥146 条：现 136 + 新 10）。
3. 探针记录：`z.dict(z.object(...))` roundtrip 通过或已降级，结论写进 `config-schema.js` 头注。
4. `model_eval_run()` 无参 → `dry_run` 生效，**不写盘**，返回「将评测哪些模型/多少题」。
5. `model_eval_run({dry_run:false, models:['deepseek-flash']})` → 6 题跑完，文本报告含每维 `graded/null/sentinel` 与 `finish` 计数。
6. 落盘存在：`eval-history/<run_id>.jsonl` 行数 = 实际调用数；`model_eval['deepseek-flash']` 有 `last_run/composite/samples/wilson_lb/provisional`。
7. `vision` 的 `scores.vision === -1` 且 `dimension_status.vision === 'null'`（不得给 0 或 100）。
8. 哨兵破判可复现：临时把哨兵答案改错 → `instrument_healthy=false`、`eval_status.state='failed'`、`model_eval` 未写入假分。
9. `provisional === true`（6 题<12），且 `suggest.tier === ''`。
10. `suggest.priority_delta` ∈ [-10, 10]。
11. `model_route_query` 与 `mroute_dispatch_plan` 输出与改动前**逐字节一致**（diff 证明）。
12. 面板 `Regions.snapshot` 能看到「评测：…」文本行；`Tool.listTools` 能查到 `model_eval_run`。

## 9 成本护栏（四层）

| 层 | 位置 | MVP 取值 |
|---|---|---|
| L1 单题 | `maxTokens` | 512（coding 可 1024） |
| L2 单轮 | `max_calls` | 默认 18，硬顶 40 |
| L3 渠道 | 选渠道前过滤 | **只允许 prepaid**（deepseek / xiaomi），包月渠道 opt-in 才允许 |
| L4 全局 | 日预算 | 记录当日调用数，超 200 次自动拒绝跑新轮 |

## 10 里程碑

- **M5-MVP-0（本计划 §7/§8）**：能跑能判能记账、零耦合、全 provisional。
- **M5.1**：12 题/维 + judge（走 `ctx.credentials`）+ 探针实采 + 面板报告与「确认采纳」写回 + 指纹锚。
- **M5.2**：跨 run 对比、定时刷新、`suggest` 进入 `need` 匹配的可选开关（仍 advisory）。

## 11 待用户裁决（5 问，MVP 开工前）

1. **MVP 首轮评测哪些模型？** 推荐：`deepseek-flash`（prepaid，最省）+ `mimo-v2.6-flash`（prepaid）+ 可选 `glm-5.3`（包月，会吃 5h 窗口）。
2. **允许 MVP 打包月渠道窗口吗？** 推荐：默认不允许（L3 白名单只 prepaid）。
3. **tool/vision 两维先置 `null` 还是先做 spike？** 推荐：先做 30 分钟 `tools` spike，成功才纳入，否则 `null`。
4. **`suggest` 是否允许建议改 `tier`（MVP 内）？** 推荐：不允许，只给 `priority_delta`。
5. **评测结果是否要写进 `mroute_dispatch_plan` 的展示（MVP 内）？** 推荐：不写（守住零耦合验收）。

## 12 证据索引

- 通道契约：`plugin-mroute/lib/livecheck.js:20-49`、asar `dsh-llm/lib/index.js:2330/2351-2370/2360-2361/2301-2305/2447-2448`
- 判分与统计：`mroute/07d-eval-monitoring.md`（§2.2 键集映射、§2.3 校准）、`mroute/07-assembly-plan.md:205`（字段集冻结）
- 现行 eval 占位：`plugin-mroute/lib/config-schema.js:213`、`lib/registry.js:283-300`
- 能力闭集：`plugin-mroute/lib/capability-need.js:14`、`lib/config-schema.js:32`
- 面板与写回先例：`plugin-mroute/client.js:1331`（inject 面）、`lib/tool-query.js:514-710`（`assembleRouteTable`）
- 三份专项：`docs/briefs/m5-plan-channel.md`、`m5-plan-design.md`、`m5-plan-product.md`、共享底 `m5-eval-plan-brief.md`
