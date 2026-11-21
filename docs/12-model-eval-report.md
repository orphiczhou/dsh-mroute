# 12 · M5.1 正式评测报告（suite formal/1，四 prepaid 模型）

> 生成：2026-11-21 · 执行会话 m51-dev · 任务书 `docs/briefs/m5.1-formal-eval.md`
> 题集 `plugin-mroute/lib/eval/suite-formal.mjs`（SUITE_VERSION `formal/1`）· 判分器零模型调用，确定性规则判分。

## 0. 一句话结论

四模型在 formal/1 上全部达到「可用」以上：**deepseek-flash 与 mimo-v2.6-pro 满分（36/36，composite=1.00）**；deepseek-v4-pro 判分全对但 3 题答满 maxTokens 被截断（samples=33）；mimo-v2.6-flash 唯一实质弱项是 orchestration（3/6，两题只输出 1 项计划）。按取档公式，四个 graded 维（coding/tools/long_context/orchestration）在 n≤10 的单维样本下 Wilson 下界最高只到 0.72，**单维最多评到 good**——这是统计下界公式的固有保守性，不是模型退步；建议以「总体 composite + wilson_lb」横向比较为主。

## 1. 方法

- 题集：36 道判分题（coding 10 / tools 10 / long_context 10 / orchestration 6）+ 2 道校准哨兵（world_knowledge，记分不计档）+ 1 道 vision 恒 null 占位 = 38 次调用/模型。
- 渠道：全部 prepaid（allow_monthly=false），跨渠道统一模型名去重后每模型取排序链首个渠道（deepseek-official ×2、xiaomi ×2）。
- 调用纪律：effort 钉死共同档 high（跨模型可比）；串行；单题超时 60s；maxTokens coding=1024、tools/lc/orch=512、哨兵=256；每模型 max_calls=40。
- 判分：确定性规则（文本归一化后锚点匹配/JSON 结构校验/工具调用名+参数匹配），**零 LLM judge**；判分器健康度由每题 fixture_pass/fixture_fail 双向自证（本轮 4 个 run 均 instrument_healthy=true，哨兵 38/38）。
- 记分口径（沿 M5 设计）：finish.kind 不在白名单（非 stop / tools 维非 tool-calls）的作答记 status=invalid，pass=false 但**不计入 samples/composite**（截断≠答错，属另一类信号，见 §6）；vision 恒 null；world_knowledge 只作哨兵。
- 成本：实际 4×38=152 次调用 < 日预算 200。

## 2. 逐模型 × 逐维原始数字

p = passed/n；lb = Wilson 95% 下界（z=1.96，`lib/eval/score.mjs wilsonLowerBound`）。
「graded n」= 计分口径的样本数（截断题已剔除）；「raw」= 把截断当错的保守口径，供对照。

### deepseek-flash（deepseek-official，run eval-20261121-191929-85ae）

| 维度 | passed/graded n | p | lb | finish 备注 |
|---|---|---|---|---|
| coding | 10/10 | 1.0000 | 0.7225 | stop×10 |
| tools | 10/10 | 1.0000 | 0.7225 | tool-calls×10，参数全中 |
| long_context | 10/10 | 1.0000 | 0.7225 | 双行检索全中 |
| orchestration | 6/6 | 1.0000 | 0.6097 | 结构校验全过 |
| world_knowledge（哨兵） | 2/2 | 1.0000 | — | 不计档 |
| vision | — | — | — | 恒 null |

总体：samples=36 composite=1.00 wilson_lb=**0.9036**（p=1.0000）→ 总体档 **excellent**。suggest：tier domestic_sota→overseas_sota，priority_delta=+10（advisory 未应用）。

### deepseek-v4-pro（deepseek-official，run eval-20261121-192023-38d2）

| 维度 | passed/graded n | p | lb | raw（截断算错） | finish 备注 |
|---|---|---|---|---|---|
| coding | 8/8 | 1.0000 | 0.6756 | 8/10 p=0.8000 lb=0.4902 | coding-2、coding-10 答满 1024 tokens 截断 |
| tools | 10/10 | 1.0000 | 0.7225 | 同左 | tool-calls×10 |
| long_context | 10/10 | 1.0000 | 0.7225 | 同左 | |
| orchestration | 5/5 | 1.0000 | 0.5655 | 5/6 p=0.8333 lb=0.4365 | orchestration-2 答满 512 截断 |
| world_knowledge（哨兵） | 2/2 | 1.0000 | — | | |
| vision | — | — | — | | 恒 null |

总体：samples=33 composite=1.00 wilson_lb=**0.8957**（p=1.0000）→ 总体档 **excellent**（raw 口径 33/36 p=0.9167 lb=0.7817 → good）。suggest：tier→overseas_sota，+10（advisory 未应用）。

### mimo-v2.6-flash（xiaomi，run eval-20261121-192341-671a）

| 维度 | passed/graded n | p | lb | raw | finish 备注 |
|---|---|---|---|---|---|
| coding | 10/10 | 1.0000 | 0.7225 | 同左 | |
| tools | 10/10 | 1.0000 | 0.7225 | 同左 | tool-calls×10 |
| long_context | 10/10 | 1.0000 | 0.7225 | 同左 | |
| orchestration | 3/5 | 0.6000 | 0.2307 | 3/6 p=0.5000 | orch-1、orch-6 实错（「数组长度不足 3（1）」=只输出 1 项计划）；orch-2 答满 512 截断 |
| world_knowledge（哨兵） | 2/2 | 1.0000 | — | | |
| vision | — | — | — | | 恒 null |

总体：samples=35 composite=0.90 wilson_lb=**0.7762**（p=0.9143）→ 总体档 **good**（p=0.9143<0.92 差 0.6 题）。suggest：tier bulk→domestic_sota，priority_delta=+8（advisory 未应用）。

### mimo-v2.6-pro（xiaomi，run eval-20261121-192812-5812）

| 维度 | passed/graded n | p | lb | finish 备注 |
|---|---|---|---|---|
| coding | 10/10 | 1.0000 | 0.7225 | |
| tools | 10/10 | 1.0000 | 0.7225 | tool-calls×10 |
| long_context | 10/10 | 1.0000 | 0.7225 | |
| orchestration | 6/6 | 1.0000 | 0.6097 | |
| world_knowledge（哨兵） | 2/2 | 1.0000 | — | |
| vision | — | — | — | 恒 null |

总体：samples=36 composite=1.00 wilson_lb=**0.9036** → 总体档 **excellent**。suggest：tier bulk→domestic_sota，+10（advisory 未应用）。

## 3. 六维分级表（★）

取档公式（任务书 §4，`lib/eval/score.mjs suggestRating` 原样实现）：p=passed/n，lb=wilsonLowerBound(p,n)；
**excellent ⇔ lb≥0.75 且 p≥0.92；good ⇔ lb≥0.55；fair ⇔ p≥0.30 且不满足 good；none ⇔ p<0.30；无数据 ⇔ n<6**。
vision 维恒无数据（本轮零样本）；world_knowledge 只作哨兵，单列校准结果不计档（4 模型哨兵 2/2 全对，判分器可信）。

| 模型 | coding | tools | long_context | vision | world_knowledge（哨兵） | orchestration | 总体（composite / lb / 档） |
|---|---|---|---|---|---|---|---|
| deepseek-flash | good ★★（10/10, lb .7225） | good ★★（10/10, lb .7225） | good ★★（10/10, lb .7225） | 无数据 | 2/2 对（不计档） | good ★★（6/6, lb .6097） | 1.00 / .9036 / **excellent** ★★★ |
| deepseek-v4-pro | good ★★（8/8, lb .6756）〔raw 8/10 → fair〕 | good ★★（10/10, lb .7225） | good ★★（10/10, lb .7225） | 无数据 | 2/2 对（不计档） | 无数据（5/5，n<6）〔raw 5/6 → fair〕 | 1.00 / .8957 / **excellent** ★★★〔raw → good〕 |
| mimo-v2.6-flash | good ★★（10/10, lb .7225） | good ★★（10/10, lb .7225） | good ★★（10/10, lb .7225） | 无数据 | 2/2 对（不计档） | 无数据（3/5，n<6）〔raw 3/6 → fair〕 | 0.90 / .7762 / **good** ★★ |
| mimo-v2.6-pro | good ★★（10/10, lb .7225） | good ★★（10/10, lb .7225） | good ★★（10/10, lb .7225） | 无数据 | 2/2 对（不计档） | good ★★（6/6, lb .6097） | 1.00 / .9036 / **excellent** ★★★ |

> 为什么单维没有 excellent：10 题全对时 Wilson 95% 下界只有 0.7225（6 题全对只有 0.6097），达不到 0.75 的 excellent 下界门槛——**这是小样本下界的统计事实**。要单维出 excellent 需 n≥13（12/12 时 lb=0.7423 仍差一线，13/13 时 lb=0.7655 过线）。总体档合并 36 样本后 lb≈0.90，统计上更稳。
> deepseek-v4-pro 的 orchestration 与 mimo-v2.6-flash 的 orchestration 按 graded 口径 n=5<6 记「无数据」，〔raw〕列给出把截断当错的保守对照。

## 4. 与当前配置的差异（只陈述，不写入）

当前 `cordis.patch.yml` 的 `model_ratings`（人工登记值）vs 本次实测档（graded 口径）：

| 模型 | 维度 | 当前登记 | 实测档 | 差异说明 |
|---|---|---|---|---|
| deepseek-flash | coding/tools/lc/orch | excellent×3 + orch excellent | good×4 | 实测判分全对但单维下界只到 good；与登记差距是**样本量问题**非能力矛盾 |
| deepseek-flash | vision / world_knowledge | good / good | 无数据 / 哨兵 2/2 | 本轮不产生 vision 证据 |
| deepseek-v4-pro | coding | good | good | 一致 |
| deepseek-v4-pro | tools | good | good | 一致 |
| deepseek-v4-pro | lc/orch | excellent / excellent | good / 无数据 | lc 一致方向；orch n<6 无数据；另有 3 题截断的 raw 信号（fair）未反映在登记 |
| v4-pro | vision / wk | none / excellent | 无数据 / 哨兵 2/2 | — |
| mimo-v2.6-flash | coding | fair | good | 实测 10/10，**登记偏保守** |
| mimo-v2.6-flash | tools/lc | good / good | good / good | 一致 |
| mimo-v2.6-flash | orch | fair | 无数据（3/5，raw fair） | 与登记方向一致（偏弱），证据是 2 题只输出 1 项计划 |
| mimo-v2.6-flash | vision/wk | good/fair | 无数据/哨兵 2/2 | — |
| mimo-v2.6-pro | coding | good | good | 一致 |
| mimo-v2.6-pro | tools/lc | excellent/excellent | good/good | 判分全对，下界档位差一档（样本量） |
| mimo-v2.6-pro | orch | good | good | 一致 |
| mimo-v2.6-pro | vision/wk | good/excellent | 无数据/哨兵 2/2 | — |

渠道档位建议（advisory，均未应用）：deepseek 两模型 domestic_sota→overseas_sota（+10）；mimo 两模型 bulk→domestic_sota（+10/+8）。

## 5. 证据与复现

- run_id 与落盘（`C:\Users\sir_c\.dsh\mroute\eval-history\`）：
  - deepseek-flash：`eval-20261121-191929-85ae`（.jsonl 38 行 + .summary.json）
  - deepseek-v4-pro：`eval-20261121-192023-38d2`
  - mimo-v2.6-flash：`eval-20261121-192341-671a`
  - mimo-v2.6-pro：`eval-20261121-192812-5812`
- 写回：`model_eval["<模型>"]`（samples/composite/wilson_lb/provisional=false/suggest）+ `eval_status{state:ok}`；**未写 channels[]/model_ratings**（红线遵守，`git diff --stat` 五核心文件为空见 §6 验收）。
- 复现：`model_eval_run {suite:'formal', models:[…], allow_monthly:false, max_calls:40, dry_run:false}`（dry_run:true 先预检）；判分器自证 `node --check` + selfcheck §F1–F7（`npm.cmd run selfcheck` 159/159）。
- 截断/失败明细：v4-pro = coding-2、coding-10、orchestration-2（finish=max-tokens，status=invalid）；mimo-flash = orchestration-1、orchestration-6（「数组长度不足 3（1）」）+ orchestration-2（max-tokens）。

## 6. 等用户拍板（未写入，本轮零写入）

1. **是否把实测档回写 model_ratings**：单维只有 good 的统计下界 vs 人工登记的 excellent——建议保留人工登记为「用户判断层」，model_eval 实测为「机器证据层」并行展示，不自动覆盖（advisory-only 红线）。
2. **截断（max-tokens）的记分口径**：现行设计把截断剔除出 samples；raw 口径下 v4-pro 总体从 excellent 降到 good、mimo-flash orchestration 到 fair。若用户认为「预算内答不完=能力不足」，可考虑后续版本把 invalid 计入分母（需改 score 口径，本轮未动）。
3. **tier 建议采纳**：4 条 suggest（2×→overseas_sota、2×→domestic_sota）均 advisory 未应用；「确认采纳」入口按任务书明确不在本轮范围。
4. **单维 excellent 的样本量**：要单维出 excellent 需 ≥13 题/维（或放宽下界门槛）；是否扩题量属下一轮决策。

## 验收自检

- [x] `node --check` 全 0（check 链含 suite-formal.mjs）
- [x] `npm.cmd run check` exit 0
- [x] `npm.cmd run selfcheck` 159/159（新增 eval-formal.test.mjs §F1–F7）
- [x] dry_run 预检正确（4 模型 / 152 次计划 / 预算 200 内）
- [x] 四模型结果落盘（4 run_id + model_eval 写回）
- [x] 报告按 §2.3 结构落盘（本文件）
- [x] 五核心文件 `git diff --stat` 为空（ranking.js / tool-query.js / tool-dispatch-plan.js / registry.js / capability-need.js）

## 勘误（2026-11-21，M5.2 复核发现；不改动上文原文，改动另立此节）

> 纪律：旧结论不静默改写。以下四处在 M5.2 用 JSONL 独立重算时发现与原表不一致，原文保留，以本节为准。

1. **mimo-v2.6-flash（`eval-20261121-192341-671a`）总体数字错**：原文 §2 写 `samples 35 / composite 0.90 / wilson_lb 0.7762 / good`，JSONL 独立重算为 **`samples 35（graded 35，pass 33）/ composite 0.9429 / wilson_lb 0.8139 / excellent`**（0.7762 系按 32/35 计算，属笔误）。该模型**唯一实质弱项仍是 orchestration（3/5 + 1 invalid）**这一结论不变。
2. **Wilson 下界数值微差**：原文引用的 `.7655`（13/13）与 `.7423`（12/12）是近似值，实测 **13/13 → 0.7719**、**12/12 → 0.7575**（同一 Wilson 95% 单侧公式）。不影响任何取档结论。
3. **`eval-20261121-192341-671a` 的截断数**：原文把 mimo-flash 记为无截断，实际有 **1 题 `max-tokens`**（orchestration-2），与 v4-pro 的 3 题同属「输出闸过低」而非能力问题。
4. **结论方向**：上述更正后，M5.1 四个模型里 **三个 excellent、一个 good** 变为 **四个全部 excellent**；「区分度不足」的判断因此更早出现（M5.2 已据此提出 ≥20 题/维或加权评分）。

证据：`C:\Users\sir_c\.dsh\mroute\eval-history\eval-20261121-192341-671a.jsonl`（38 行，逐行 `dimension`/`status`/`pass` 重算）。重算脚本口径与 `plugin-mroute/lib/eval/score.mjs` 一致（只聚合 `status==='graded'`，sentinel 不计入）。

