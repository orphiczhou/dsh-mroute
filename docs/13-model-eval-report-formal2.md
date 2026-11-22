# 13 · M5.2 正式评测报告（suite formal/2，四 prepaid 模型）

> 生成：2026-11-21 · 执行会话 m52-dev · 任务书 `docs/briefs/m5.2-expand-eval.md`
> 题集 `plugin-mroute/lib/eval/suite-formal.mjs`（`SUITE_VERSION='formal/2'`）· 判分器零模型调用、确定性规则判分 · 上一轮 `docs/12-model-eval-report.md`（formal/1）

## 0. 一句话结论

四个 prepaid 模型在 formal/2（52 道判分题，13 题/维）上**全部达到 excellent**：deepseek-flash 52/52（composite 1.0000、wilson_lb 0.9312）、deepseek-v4-pro 52/52（1.0000 / 0.9312）、mimo-v2.6-pro 50/52（0.9615 / 0.8702）、mimo-v2.6-flash 48/52（0.9231 / 0.8183）。**216 次调用零 max-tokens 截断**（formal/1 曾 4 题截断，仅 v4-pro 就 3 题——8192 输出上限把这类假阴性消掉了）。单维评级因 n=13 首次可出 excellent（13/13 → lb **0.7719**，比任务书估算的 0.7655 高，以代码实测为准）；但 12/13 → lb 0.6669 只能 good——**一题之差跨一档**，单维结论仍应结合 n 与题面差异读。与 formal/1 相比有三处结论变化：①「mimo-v2.6-flash 唯一弱项是 orchestration」不再成立（它在 formal/2 每维各错 1 题、orchestration 反而 12/13）；②v4-pro 的截断问题消失；③mimo-v2.6-pro 出现 tools 弱项（11/13）。另复核发现 `docs/12` 的 mimo-flash 总体 lb/p/档有笔误（详见 §5.6），本报告一律以 JSONL 独立重算为正式口径。

## 1. 方法

- **题集**：55 题 = 52 判分（coding 13 / tools 13 / long_context 13 / orchestration 13）+ 2 校准哨兵（world_knowledge，记分不计档）+ 1 vision 恒 null（`skip:true`）= **54 次调用/模型**；54 条可执行 prompt 两两唯一。
- **maxTokens 分档**（`suite-formal.mjs MAX_TOKENS`）：coding 8192、orchestration 8192、tools 2048、long_context 2048、world_knowledge 1024、vision 0。本轮实际分布：**8192×26 · 2048×26 · 1024×2**（`max_tokens` 覆盖参未启用；该参已实现并对 54 道可执行题整体覆盖，见 §7 自检）。
- **渠道**：全部 prepaid（`allow_monthly=false`），跨渠道统一模型名去重后每模型取排序链首个渠道（deepseek-official ×2、xiaomi ×2）；zai-coding-cn / opencode-go 因包月被排除，deepseek-account 两条因同名去重被排除。
- **调用纪律**：effort 钉死共同档 `high`（跨模型可比）；串行（一个模型跑完再下一个）；单题超时 60s；每个模型一次 invocation、`max_calls:60`（实际 54）。
- **判分**：确定性规则（文本归一化后锚点/数值匹配、JSON 结构 + deps 校验、工具调用名 + 参数匹配），**零 LLM judge**；判分器健康度由每题 `fixture_pass`/`fixture_fail` 双向自证：本轮 **52/52 双向 PASS**，4 个 run 均 `instrument_healthy=true`（54/54）。
- **记分口径**（沿 M5 设计）：`finish_kind` 不在白名单（非 stop / tools 维非 tool-calls）的作答记 `status=invalid`、不计入 samples/composite；vision 恒 null；world_knowledge 只作哨兵。`composite` = 四个 graded 维正确率的算术平均（`lib/eval/score.mjs:153`），`wilson_lb` 用 passes/graded samples（`score.mjs:154`）——两者分母口径不同，故 composite 不等于 passes/samples。
- **成本与预算披露**：本轮 4×54 = **216 次调用**。当日实际总调用 **368 次（M5.1 152 + 本轮 216）**，超出用户批准的 300 日预算；**经 lead 裁决一次性放宽到 400，M5.1 证据全部保留**（`DAILY_CALL_BUDGET` 注释已写明下一里程碑回落 300）。dry_run 预检照实打印「今日已调用 152 次（日预算 400）· 本轮预计再调 216 次 → 当日累计 368 次」。

| 模型 | 渠道 | run_id | 执行时刻（本地） | 调用 | graded samples |
|---|---|---|---|---|---|
| deepseek-flash | deepseek-official | `eval-20261121-195835-a529` | 19:58:35–19:59:55 | 54 | 52 |
| deepseek-v4-pro | deepseek-official | `eval-20261121-200112-d2e6` | 20:01:12–20:06:47 | 54 | 52 |
| mimo-v2.6-flash | xiaomi | `eval-20261121-200652-f264` | 20:06:52–20:14:35 | 54 | 52 |
| mimo-v2.6-pro | xiaomi | `eval-20261121-201435-55be` | 20:14:35–20:19:50 | 54 | 52 |

## 2. 逐模型 × 逐维原始数字

p = passed/n；lb = Wilson 95% 下界（z=1.96，`lib/eval/score.mjs wilsonLowerBound`）。本轮四组均无 invalid、无截断，graded 口径 = raw 口径。

### deepseek-flash（deepseek-official，run eval-20261121-195835-a529）

| 维度 | passed/n | p | lb | 档 | finish 备注 |
|---|---|---|---|---|---|
| coding | 13/13 | 1.0000 | 0.7719 | excellent | stop×13 |
| tools | 13/13 | 1.0000 | 0.7719 | excellent | tool-calls×13，参数全中 |
| long_context | 13/13 | 1.0000 | 0.7719 | excellent | 双点检索全中 |
| orchestration | 13/13 | 1.0000 | 0.7719 | excellent | 数组长度 + id/name/deps 全过 |
| world_knowledge（哨兵） | 2/2 | 1.0000 | — | 不计档 | |
| vision | — | — | — | 无数据 | 恒 null |

总体：samples=52 composite=1.0000 wilson_lb=**0.9312** → **excellent**。finish：stop=41 tool-calls=13 max-tokens=0 error=0 aborted=0；54 次共 31047 tokens / 79.1s。suggest：domestic_sota→overseas_sota，+10（advisory 未应用）。

### deepseek-v4-pro（deepseek-official，run eval-20261121-200112-d2e6）

| 维度 | passed/n | p | lb | 档 | finish 备注 |
|---|---|---|---|---|---|
| coding | 13/13 | 1.0000 | 0.7719 | excellent | stop×13（formal/1 的 coding-2/10 截断未复现） |
| tools | 13/13 | 1.0000 | 0.7719 | excellent | tool-calls×13 |
| long_context | 13/13 | 1.0000 | 0.7719 | excellent | |
| orchestration | 13/13 | 1.0000 | 0.7719 | excellent | formal/1 的 orchestration-2 截断未复现 |
| world_knowledge（哨兵） | 2/2 | 1.0000 | — | 不计档 | |
| vision | — | — | — | 无数据 | 恒 null |

总体：samples=52 composite=1.0000 wilson_lb=**0.9312** → **excellent**。finish：stop=41 tool-calls=13 max-tokens=0 error=0；42251 tokens / 334.8s（本轮最慢，逐题均值约 6.2s）。suggest：domestic_sota→overseas_sota，+10。

### mimo-v2.6-flash（xiaomi，run eval-20261121-200652-f264）

| 维度 | passed/n | p | lb | 档 | finish 备注 |
|---|---|---|---|---|---|
| coding | 12/13 | 0.9231 | 0.6669 | good | **coding-11** `countWays(15)` 实现了函数但值错（`has_value=false`） |
| tools | 12/13 | 0.9231 | 0.6669 | good | **tools-11** `send_email` 调用缺 to/subject 之一 |
| long_context | 12/13 | 0.9231 | 0.6669 | good | **long_context-9** 校验码 LOT-1102 / LOT-1106 均未取到 |
| orchestration | 12/13 | 0.9231 | 0.6669 | good | **orchestration-4** 未输出 JSON 数组 |
| world_knowledge（哨兵） | 2/2 | 1.0000 | — | 不计档 | |
| vision | — | — | — | 无数据 | 恒 null |

总体：samples=52 composite=0.9231（四维均值）wilson_lb=**0.8183**（48/52）→ **excellent**。finish：stop=41 tool-calls=13 max-tokens=0 error=0；27347 tokens / 456.8s（本轮最慢，逐题均值约 8.5s）。suggest：bulk→domestic_sota，+8。**错误分布**：四维各 1 题，无维度性短板（与 formal/1「orchestration 唯一弱项」相反）。

### mimo-v2.6-pro（xiaomi，run eval-20261121-201435-55be）

| 维度 | passed/n | p | lb | 档 | finish 备注 |
|---|---|---|---|---|---|
| coding | 13/13 | 1.0000 | 0.7719 | excellent | stop×13 |
| tools | 11/13 | 0.8462 | 0.5776 | good | **tools-3** 未发起 `get_stock_price(AAPL)`；**tools-8** 未发起 `flight_status(CA1234)`（两题均以 stop 结束、只给了文本答案） |
| long_context | 13/13 | 1.0000 | 0.7719 | excellent | |
| orchestration | 13/13 | 1.0000 | 0.7719 | excellent | |
| world_knowledge（哨兵） | 2/2 | 1.0000 | — | 不计档 | |
| vision | — | — | — | 无数据 | 恒 null |

总体：samples=52 composite=0.9615 wilson_lb=**0.8702**（50/52）→ **excellent**。finish：stop=43 tool-calls=11 max-tokens=0 error=0；31949 tokens / 314.8s。suggest：bulk→domestic_sota，+9。

## 3. 六维分级表（★）

取档公式（`lib/eval/score.mjs suggestRating`）：p=passed/n，lb=wilsonLowerBound(p,n)；**excellent ⇔ lb≥0.75 且 p≥0.92；good ⇔ lb≥0.55；fair ⇔ p≥0.30 且不满足 good；none ⇔ p<0.30；无数据 ⇔ n<6**。vision 维恒无数据；world_knowledge 只作哨兵（4 模型 2/2 全对，判分器可信）。

| 模型 | coding | tools | long_context | vision | world_knowledge（哨兵） | orchestration | 总体（composite / lb / 档） |
|---|---|---|---|---|---|---|---|
| deepseek-flash | excellent ★★★（13/13, lb .7719） | excellent ★★★（13/13, lb .7719） | excellent ★★★（13/13, lb .7719） | 无数据 | 2/2 对（不计档） | excellent ★★★（13/13, lb .7719） | 1.0000 / **.9312** / **excellent** ★★★ |
| deepseek-v4-pro | excellent ★★★（13/13） | excellent ★★★（13/13） | excellent ★★★（13/13） | 无数据 | 2/2 对（不计档） | excellent ★★★（13/13） | 1.0000 / **.9312** / **excellent** ★★★ |
| mimo-v2.6-flash | good ★★（12/13, lb .6669） | good ★★（12/13, lb .6669） | good ★★（12/13, lb .6669） | 无数据 | 2/2 对（不计档） | good ★★（12/13, lb .6669） | 0.9231 / **.8183** / **excellent** ★★★ |
| mimo-v2.6-pro | excellent ★★★（13/13） | good ★★（11/13, lb .5776） | excellent ★★★（13/13） | 无数据 | 2/2 对（不计档） | excellent ★★★（13/13） | 0.9615 / **.8702** / **excellent** ★★★ |

> **n=13 的统计边界**：13/13 全对时 lb=**0.7719**，刚好越过 0.75 的 excellent 下限；12/13 时 lb=**0.6669** 只能 good。对照：10/10 → 0.7225（formal/1 全 good 的原因）、12/12 → **0.7575**、6/6 → 0.6097。任务书 §2.3 写的「n=13 → lb 0.7655」是估算值，代码实测为 0.7719；formal/1 报告里「12/12 → 0.7423」同样与代码不符，正确值是 0.7575——两处均以 `score.mjs` 实测为准。
> **跨模型的读法**：mimo-v2.6-flash 四维全 12/13，单维只能 good；但总体 48/52 的 lb 0.8183 仍是 excellent。**单维 good + 总体 excellent 的组合是样本量+一题失误的产物，不是矛盾**；横向比较建议以「总体 composite + wilson_lb」为主，单维看失败题的具体形态（§2）。

## 4. 与当前配置 `model_ratings` 的差异（只陈述，不写入）

当前 `cordis.patch.yml:476-545` 的人工登记 vs 本次实测档（graded 口径）。**本轮未写入任何 `model_ratings` 条目**（红线：suggest 保持 advisory-only）。

| 模型 | 维度 | 当前登记 | 实测档 | 差异说明 |
|---|---|---|---|---|
| deepseek-flash | coding / tools / long_context / orchestration | excellent / excellent / excellent / excellent | excellent×4 | 一致 |
| deepseek-flash | vision / world_knowledge | good / good | 无数据 / 哨兵 2/2 | 本轮无 vision 证据 |
| deepseek-v4-pro | coding / tools | good / good | excellent / excellent | 登记偏保守（实测 13/13） |
| deepseek-v4-pro | long_context / orchestration | excellent / excellent | excellent / excellent | 一致 |
| deepseek-v4-pro | vision / world_knowledge | none / excellent | 无数据 / 哨兵 2/2 | — |
| mimo-v2.6-flash | coding | fair | good（12/13） | 登记偏保守 |
| mimo-v2.6-flash | tools / long_context | good / good | good / good | 一致 |
| mimo-v2.6-flash | orchestration | fair | good（12/13） | 登记偏保守；formal/1 的弱项判断未在 formal/2 复现 |
| mimo-v2.6-flash | vision / world_knowledge | good / fair | 无数据 / 哨兵 2/2 | — |
| mimo-v2.6-pro | coding / orchestration | good / good | excellent / excellent | 登记偏保守 |
| mimo-v2.6-pro | tools | excellent | good（11/13） | **登记偏乐观**：2 题没发起工具调用 |
| mimo-v2.6-pro | long_context | excellent | excellent | 一致 |
| mimo-v2.6-pro | vision / world_knowledge | good / excellent | 无数据 / 哨兵 2/2 | — |

渠道档位建议（advisory，均未应用）：deepseek 两模型 domestic_sota→overseas_sota（+10）；mimo 两模型 bulk→domestic_sota（+8 / +9）。`channels[]` 的 tier/priority 未被改写。

## 5. 与 formal/1 的对比（结论变化点）

### 5.1 规模与调用

| 项 | formal/1 | formal/2 |
|---|---|---|
| 判分题 | 36（10/10/10/6） | 52（13/13/13/13） |
| 哨兵 / vision | 2 / 1 | 2 / 1 |
| 每次调用/模型 | 38 | 54 |
| maxTokens 分档 | coding 1024、其余 512、哨兵 256 | coding/orch 8192、tools/lc 2048、哨兵 1024 |
| 四模型合计 | 152 次 | 216 次 |

### 5.2 逐模型对照（均从 JSONL 独立重算）

| 模型 | formal/1（samples / comp / lb / 档） | formal/2（samples / comp / lb / 档） | 变化 |
|---|---|---|---|
| deepseek-flash | 36 / 1.0000 / .9036 / excellent | 52 / 1.0000 / **.9312** / excellent | 判分维度全对；单维由 good×4 → excellent×4（n=13 跨过门槛）；lb 提升 |
| deepseek-v4-pro | 33 / 1.0000 / .8957 / excellent | 52 / 1.0000 / **.9312** / excellent | **截断 3 → 0**；samples 补齐；单维 excellent×4 |
| mimo-v2.6-flash | 35 / 0.9000 / .8139 / excellent（docs/12 误记 .7762 / good，见 §5.6） | 52 / 0.9231 / .8183 / excellent | orchestration 由 3/5 → 12/13；错误分散到四维各 1 题 |
| mimo-v2.6-pro | 36 / 1.0000 / .9036 / excellent | 52 / 0.9615 / .8702 / excellent | 首次出现 tools 失分（11/13） |

### 5.3 结论变化的五点

1. **单维首次出现 excellent**：formal/1 因 n≤10（10/10 → lb 0.7225）四个 graded 维只能 good；formal/2 的 13/13 → 0.7719 过线。**这是题量带来的评级分辨率提升，不是模型能力变化**。
2. **v4-pro 的 max-tokens 截断消失**：formal/1 有 3 题（coding-2、coding-10、orchestration-2）答满 1024/512 被记为 invalid；formal/2 给 coding/orchestration 8192 后 0 截断（本轮四组均 0/54）。**formal/1「v4-pro 判分全对但答不完」的信号在更大预算下不再出现**——不能再说它「输出预算不足」。
3. **mimo-v2.6-flash 的「orchestration 唯一弱项」不成立**：formal/1 是 orchestration 3/5（另 1 题截断），formal/2 的 orchestration 12/13，而 coding/tools/long_context 也各 12/13；失败题分散（coding-11 数值、tools-11 参数不全、long_context-9 检索、orchestration-4 结构）。**更像抽样波动 + 个别题型失误，而非维度性短板**；formal/1 的结论应降级为「一处曾出现的弱信号」。
4. **mimo-v2.6-pro 出现 tools 弱项**：formal/1 tools 10/10，formal/2 11/13（tools-3、tools-8 均以文本回答、未发起工具调用）。**这是本轮唯一新增的维度性弱信号**，与登记 `tools: excellent` 相反（见 §4）。
5. **总体档全部 excellent，但含义更稳**：52 样本下 lb 从 .90 提升到 .93（deepseek）/ .82（mimo-flash）/ .87（mimo-pro）；四模型差距压缩到 composite 0.92–1.00，横向区分度下降。**若目标是区分模型，应看「失分题型」而非总分**：mimo-flash 失在「多步数值/多参工具/跨节检索/结构输出」各 1 题，mimo-pro 失在「该发工具调用却直接作答」2 题。

### 5.6 对 `docs/12` / `devlog §23` 的两处数字更正（以 JSONL 为准）

- **mimo-v2.6-flash 总体**：`docs/12` 与 devlog §23 记 `samples=35, composite=0.90, lb=0.7762, p=0.9143, 总体档 good`。JSONL 实为 **33 pass / 35 graded**（coding 10 + tools 10 + long_context 10 + orchestration 3）= p **0.9429**、lb **0.8139** → 按取档公式是 **excellent**，不是 good。`0.7762 / p=0.9143` 恰好等于 **32/35**，应为统计时漏计 1 题；`docs/12` 自己的 §2 表（10/10、10/10、10/10、3/5）也合计 33 题，与总体行自相矛盾。**本报告 §5.2 用重算值**，并在 §6 列为待裁决（是否回改 docs/12/AGENTS 原文）。
- **Wilson 常数**：`docs/12` §3 写「13/13 时 lb=0.7655」「12/12 时 lb=0.7423」，代码实测为 **0.7719** 与 **0.7575**（`score.mjs wilsonLowerBound`，z=1.96）。任务书 §2.3 引用的 0.7655 同源，均以代码为准。

## 6. 局限与待裁决（本轮零写入）

1. **预算披露**：当日 368 次 > 用户批准的 300（2026-11-21 M5.1 152 + 本轮 216 同日）；经 lead 裁决 `DAILY_CALL_BUDGET` 一次性放宽到 400，证据全部保留，下一里程碑回落 300。
2. **vision 仍无数据**：4 个模型均未做视觉题（suite 里恒 null）；`vision` 维的登记值（good/none）本轮未获任何证据。
3. **world_knowledge 只作哨兵**：2 题全对只能证明判分器校准可信，不构成能力档；不进 composite。
4. **effort 仅 high**：低 effort 的成本/正确率权衡未测（评测工具支持按渠道钉 effort，但本轮统一 high 以保可比）。
5. **13 题/维刚好跨过 excellent 门槛**：12/13 → good、13/13 → excellent，**单题决定档位**；若要让单维评级稳定，建议下一轮 ≥20 题/维（或对单维 lb 报告置信区间而非单点档位）。
6. **8192 后截断信号消失**：0/216 截断说明预算充足，但也意味着「答不完」与「答得完」不再可区分；JSONL 里保留了每题 outputTokens，可用于后续「预算压力测试」（另设低 maxTokens 档对照）。
7. **题面代表性**：formal/2 仍是模板化合成题（数值计算/参数抽取/跨节检索/JSON 计划），fixture 只证明判分器正确，不证明题面覆盖真实工作负载；coding 无多文件/调试类，tools 无多轮/错误恢复类。
8. **待用户拍板**：①是否把实测档回写 `model_ratings`（建议保持人工层/实测层并行，不自动覆盖）；②4 条 tier suggest 是否采纳（均 advisory 未应用）；③截断口径是否改为计入分母（本轮 0 截断，暂无影响）；④是否扩到 ≥20 题/维；⑤是否回改 `docs/12` / `devlog §23` 的两处数字（本报告未改原文，按增补纪律记录）。

## 7. 证据与复现

- 落盘（`C:\Users\sir_c\.dsh\mroute\eval-history\`）：4 个 run 各有 `.jsonl`（54 行）与 `.summary.json`：
  `eval-20261121-195835-a529`（flash）、`eval-20261121-200112-d2e6`（v4-pro）、`eval-20261121-200652-f264`（mimo-flash）、`eval-20261121-201435-55be`（mimo-pro）。
- 写回：仅顶层 `model_eval["<统一模型名>"]`（samples/composite/wilson_lb/provisional=false/suggest）+ `eval_status{state=ok}`；**未写 `channels[]`、未写 `model_ratings`**（patch 476-545 原样，`mimo-v2.6-flash.coding` 仍为 `fair`，与实测 12/13 形成对照）。
- 复现命令：`model_eval_run {suite:'formal', models:['<模型>'], max_calls:60, dry_run:true}` 预检 → `dry_run:false` 实跑；四模型串行分别执行（`max_calls` 是单次 invocation 全局上限，不能用一个 invocation 跑 4 模型 ×54）。
- 独立复核脚本（本会话新增，不在插件发布包内）：`tmp/m52-recount.mjs` → 从 4 份 JSONL 重算 samples/composite/lb/逐维 p/lb/失败题；`tmp/m52-verify.mjs` → 题集 55/54/52 分布、maxTokens 分布、54 条 prompt 唯一性、52/52 fixture 双向、sentinelCheck、四份 summary 元数据。两者输出与 §2/§3 逐格一致。
- 自检：`npm.cmd run check` exit 0；`npm.cmd run selfcheck` **165/165 pass 0 fail**（`selfcheck/eval-formal.test.mjs` §F1–§F13 覆盖分布、分档、fixture、取档公式、n=13 边界、`max_tokens` clamp 0→1 / 200001→200000 / 2.9→2 / 字符串报错、`HARD_MAX_CALLS=80`、`DAILY_CALL_BUDGET=400`、覆盖实跑、schema 无 type 数组）。

## 验收自检

- [x] `node --check` 全 0（check 链含 `suite-formal.mjs` / `tool-eval-run.mjs` / `runner.mjs`）
- [x] `npm.cmd run check` exit 0
- [x] `npm.cmd run selfcheck` 165/165（新增 §F1–§F13）
- [x] 题集 55 = 52 判分 + 2 哨兵 + 1 vision；13/13/13/13；54 次调用/模型
- [x] 52/52 fixture 双向 PASS；4 run `instrument_healthy=true`
- [x] dry_run 预检：4 模型 / 216 次计划（54/模型）/ maxTokens 分布 / 今日 152 → 368
- [x] 四组 run samples 均 52 ≥ 37（52×0.7）
- [x] 报告数字与 JSONL 独立重算一致（`tmp/m52-recount.mjs`）
- [x] 零耦合：`ranking.js` / `tool-query.js` / `tool-dispatch-plan.js` / `registry.js` / `capability-need.js` 的 `git diff --stat` 为空
- [x] 未写 `model_ratings` / `channels[].tier` / `channels[].priority`；仅写 `model_eval` + `eval_status`
- [x] 版本 `0.11.0-m5.2`；任务书 §2.3 六段结构落盘（本文件）

## 8. 补测：包月渠道 GLM（2026-11-21 晚）

> 用户要求（2026-11-21 晚）：在 §0–§7 的 4 个 prepaid 模型之外**补测包月渠道 GLM**，只跑 `glm-5.3` 与 `glm-5.3-flash`；`glm-5.3-highspeed` 明确不跑（用户判断「只是速度差异」）。本节只追加，**不改 §0–§7 与上文验收自检的任何章节与数字**。

### 8.1 为什么默认没有测到 GLM

`model_eval_run` 的渠道白名单默认 **prepaid-only**：候选装配对 `channel_type==='voucher'` 一律排除（`plugin-mroute/lib/tool-eval-run.mjs:183-184`），对 `monthly` **仅当 `allow_monthly:true` 时**才纳入（`plugin-mroute/lib/tool-eval-run.mjs:187-188`；入参缺省 `false`，`:123`）。GLM 两个模型所在的渠道都是包月：zai-coding-cn（`glm-5.3` / `glm-5.3-flash` / `glm-5.3-highspeed`，tier `domestic_sota`、priority 90）与 opencode-go（只有 `glm-5.3-flash`）。因此 §1 的 `allow_monthly=false` 轮次里整条渠道被排除、GLM 根本没进候选；本轮两次 dry_run 显式带 `allow_monthly:true` 后才出现在「将评测」清单。

### 8.2 执行与 run 表

- **一次 invocation 只跑一个模型**（`max_calls` 是单次调用全局上限）：`{suite:'formal', models:['<单模型>'], allow_monthly:true, max_calls:60}` 串行两次；每次先 `dry_run:true` 核对「计划 54 次 + 当日累计 ≤ 500」再 `dry_run:false`。
- effort 钉死共同档 `high`、单题超时 60s、54 次/模型；两次 run 均 `instrument_healthy=true`（哨兵 54/54）、`provisional=false`、**0 max-tokens 截断 / 0 invalid**；maxTokens 实分布 8192×26 · 2048×26 · 1024×2（与 §1 分档一致，`max_tokens` 覆盖参未启用）。
- `glm-5.3-flash` 的跨渠道去重：dry_run 原文排除 `opencode-go/glm-5.3-flash: 统一模型名 "glm-5.3-flash" 已在更高序渠道入选（跨渠道去重）` ⇒ **只测了 zai-coding-cn 那一份**。

| 模型 | 渠道 | run_id | 执行时刻（本地） | 调用 | graded samples | tokens | 墙钟 |
|---|---|---|---|---|---|---|---|
| glm-5.3 | zai-coding-cn（monthly） | `eval-20261121-213304-6132` | 21:33:04–21:36:41 | 54 | 52 | 30,075 | 217s |
| glm-5.3-flash | zai-coding-cn（monthly） | `eval-20261121-213654-90c8` | 21:36:55–21:41:30 | 54 | 52 | 30,693 | 275s |

### 8.3 逐维原始数字

#### glm-5.3（zai-coding-cn/glm-5.3，run `eval-20261121-213304-6132`）

| 维度 | passed/n | p | lb | 档 | finish 备注 |
|---|---|---|---|---|---|
| coding | 13/13 | 1.0000 | 0.7719 | excellent | stop×13 |
| tools | 13/13 | 1.0000 | 0.7719 | excellent | tool-calls×13，参数全中 |
| long_context | 13/13 | 1.0000 | 0.7719 | excellent | 跨节校验码全中 |
| orchestration | 13/13 | 1.0000 | 0.7719 | excellent | 数组长度 + id/name/deps 全过 |
| world_knowledge（哨兵） | 2/2 | 1.0000 | — | 不计档 | 只作判分器校准 |
| vision | — | — | — | 无数据 | 恒 null |

总体：samples=52 composite=**1.0000** wilson_lb=**0.9312** → **excellent**。finish：stop=41 tool-calls=13 max-tokens=0 error=0 aborted=0；平均 TTFT 1753ms。suggest：`domestic_sota → overseas_sota`，+10（advisory 未应用）。

#### glm-5.3-flash（zai-coding-cn/glm-5.3-flash，run `eval-20261121-213654-90c8`）

| 维度 | passed/n | p | lb | 档 | finish 备注 |
|---|---|---|---|---|---|
| coding | 13/13 | 1.0000 | 0.7719 | excellent | stop×13 |
| tools | 13/13 | 1.0000 | 0.7719 | excellent | tool-calls×13，参数全中 |
| long_context | 13/13 | 1.0000 | 0.7719 | excellent | 跨节校验码全中 |
| orchestration | 13/13 | 1.0000 | 0.7719 | excellent | 数组长度 + id/name/deps 全过 |
| world_knowledge（哨兵） | 2/2 | 1.0000 | — | 不计档 | 只作判分器校准 |
| vision | — | — | — | 无数据 | 恒 null |

总体：samples=52 composite=**1.0000** wilson_lb=**0.9312** → **excellent**。finish：stop=41 tool-calls=13 max-tokens=0 error=0 aborted=0；平均 TTFT 2360ms。suggest：`domestic_sota → overseas_sota`，+10（advisory 未应用）。

### 8.4 六维分级表（★）

取档口径同 §3（`suggestRating`：excellent ⇔ lb≥0.75 且 p≥0.92；good ⇔ lb≥0.55；fair ⇔ p≥0.30；none ⇔ p<0.30；无数据 ⇔ n<6）。13/13 → lb **0.7719** 刚好越线，与 §3 的 n=13 边界一致。

| 模型 | coding | tools | long_context | vision | world_knowledge（哨兵） | orchestration | 总体（composite / lb / 档） |
|---|---|---|---|---|---|---|---|
| glm-5.3 | excellent ★★★（13/13, lb .7719） | excellent ★★★（13/13, lb .7719） | excellent ★★★（13/13, lb .7719） | 无数据 | 2/2 对（不计档） | excellent ★★★（13/13, lb .7719） | 1.0000 / **.9312** / **excellent** ★★★ |
| glm-5.3-flash | excellent ★★★（13/13, lb .7719） | excellent ★★★（13/13, lb .7719） | excellent ★★★（13/13, lb .7719） | 无数据 | 2/2 对（不计档） | excellent ★★★（13/13, lb .7719） | 1.0000 / **.9312** / **excellent** ★★★ |

> **跨模型位置**：两模型与 deepseek-flash / deepseek-v4-pro 并列 formal/2 最好成绩（composite 1.0000、lb .9312），高于 mimo-v2.6-pro（.9615/.8702）与 mimo-v2.6-flash（.9231/.8183）。**GLM 的加入没有增加区分度**——6 个受测模型里已有 4 个 lb .9312，若目标是分辨模型，应看失分题型或继续加题（同 §6.5）。

### 8.5 与当前 `model_ratings` 手工登记的差异（只陈述，未写入）

当前登记见 `cordis.patch.yml` 的顶层 `model_ratings` 块（`glm-5.3-flash` / `glm-5.3` 两行；该文件同时被宿主配置写入器改写，行号不稳定，按 key 定位）。**本轮未写任何 `model_ratings` 条目**。

| 模型 | 维度 | 当前登记 | 实测档 | 差异说明 |
|---|---|---|---|---|
| glm-5.3 | coding / tools / long_context / orchestration | excellent ×4 | excellent ×4（13/13） | **一致** |
| glm-5.3 | vision / world_knowledge | none / excellent | 无数据 / 哨兵 2/2 | vision 本轮无证据；world_knowledge 只作哨兵 |
| glm-5.3-flash | coding | good | **excellent**（13/13, lb .7719） | **登记偏保守** |
| glm-5.3-flash | tools | excellent | excellent（13/13） | 一致 |
| glm-5.3-flash | long_context | good | **excellent**（13/13） | **登记偏保守** |
| glm-5.3-flash | orchestration | good | **excellent**（13/13） | **登记偏保守**（与 M5.1 的 fair 判断同向偏保守） |
| glm-5.3-flash | vision / world_knowledge | good / good | 无数据 / 哨兵 2/2 | vision 无证据；哨兵不构成档位 |
| glm-5.3-highspeed | 全部 | 与 glm-5.3 相同（excellent×4 / none / excellent） | **未测** | 用户裁决不跑（仅速度差异），无新证据 |

渠道档位建议（advisory，均未应用）：zai-coding-cn 两条都出 `domestic_sota → overseas_sota`（+10）。`channels[]` 的 tier/priority 未被改写（zai 行仍是 `tier: domestic_sota`、`priority: 90`，与 suggest 相反即为证据）。

### 8.6 当日预算披露

- 当日实际调用：M5.1 **152** + M5.2 四模型 **216** + 本轮 GLM **108** = **476 次**（`eval-history` 中 2026-11-21 的 JSONL 行合计 476，独立核过）。
- 两次 dry_run 的累计行照实打印：`今日已调用 368 次（日预算 500）· 本轮预计再调 54 次 → 当日累计 422 次` → `今日已调用 422 次（日预算 500）· 本轮预计再调 54 次 → 当日累计 476 次`。
- **500 是用户 2026-11-21 晚再次一次性放宽**（`plugin-mroute/lib/tool-eval-run.mjs:55` `DAILY_CALL_BUDGET=500`，常量上方注释写明「常规仍按 300 执行，M5.3 起回落」）。证据未归档、计数未绕过，预检与实跑都走同一计数器。

### 8.7 局限

1. **包月渠道运行时扰动 5h 窗口**：zai-coding-cn 是 GLM Coding 包月订阅（5h 滚动窗口 + 周窗口），108 次评测调用会在窗口内计入使用量，与 prepaid 的 token 计费不同——**评测会临时占用生产可用额度**；本轮未在评测间加冷却，也未在结束后复核窗口读数，只按「不改预算、不并行」执行。
2. **`glm-5.3-flash` 只代表 zai-coding-cn 一份**：opencode-go 的同名模型被跨渠道去重排除（§8.2）。同一模型 id 在不同渠道可能路由到不同端点/effort，因此 opencode-go 侧的能力与成本未经本轮证据覆盖。
3. **vision 仍无数据**：两模型 vision 维恒 null（suite 设计如此），登记值（none / good）未获任何证据。
4. **effort 仅 high**、题面仍是模板化合成题（同 §6.4–§6.7）；单维 13/13 刚好跨过 excellent 门槛（lb .7719），12/13 就掉回 good——一题决定档位。
5. **world_knowledge 只作哨兵**：2/2 只证明判分器校准可信，不构成能力档。

### 8.8 独立复核（JSONL 重算）

- 脚本 `tmp/m52b-recount.mjs`（本会话新增、不进发布包）：自行实现 Wilson 公式（z=1.96）与聚合，只取 `status==='graded'`、哨兵不计、composite = 四维正确率均值。两份 JSONL 输出与工具结果**逐格一致**：glm-5.3 / glm-5.3-flash 均 `rows=54 graded=52 pass=52 composite=1.0000 lb=0.9312`，四维各 13/13（lb .7719）、哨兵 2/2、vision 0；`summary.json` 对比 `IDENTICAL`（`calls_executed=54`、`instrument_healthy=true`、effort=common）。
- 写入面：仅 `model_eval["glm-5.3"]` / `model_eval["glm-5.3-flash"]`（`last_run`/scores/samples/composite/wilson_lb/suggest/evidence_refs）+ `eval_status{state=ok, run_id=eval-20261121-213654-90c8}`；`model_ratings` 块前后原样（`glm-5.3-flash` 仍 `coding: good` / `long_context: good` / `orchestration: good`，未被写成实测档），`channels[]` 的 tier/priority 未动。

## 9. 补测：qwen3.8-flash（2026-11-22，opencode-go 包月渠道）

### 9.1 需求

用户在 GLM 补测后追加要求：「qwen 3.8 flash也要测试，测试对比表格发我看，我来自己解读后手工维护。测试题目规模够了，测试体系存档，后面有新模型加入时候再测试。浮动球不改，记录计划等待后续启动。」

### 9.2 执行

- 调用：`model_eval_run { suite:'formal', models:['qwen3.8-flash'], allow_monthly:true, max_calls:60, dry_run:false }`。
- 渠道：`opencode-go`（monthly，故必须 `allow_monthly:true`）；统一模型名 `qwen3.8-flash`，无跨渠道重复。
- 日预算：本轮前已把 `DAILY_CALL_BUDGET` 由 500 回落为 **300**（2026-11-21 的 400/500 属当日一次性放宽，注释与 `selfcheck/eval-formal.test.mjs` §F9 一并改回）；本日（2026-11-22）调用 54 次。
- run_id：`eval-20261122-091501-adda`；证据 `C:\Users\sir_c\.dsh\mroute\eval-history\eval-20261122-091501-adda.jsonl`。

### 9.3 结果

| 项 | 值 |
|---|---|
| 判分 | **52 / 52** |
| composite | **1.0000** |
| Wilson 95% LB | **0.9312** |
| 档 | **excellent**（`provisional=false`、`instrument_healthy=true`、effort=high） |
| 四判分维 | coding 13/13 · tools 13/13 · long_context 13/13 · orchestration 13/13（各 lb .7719） |
| 哨兵 | world_knowledge 2/2（不计入 composite）· vision 恒 null |
| finish | stop=41 · tool-calls=13 · max-tokens=0 · error=0 · aborted=0 |
| suggest | `tier=overseas_sota`(+10)，相对当前 `domestic_sota`；advisory，未应用 |

### 9.4 独立复核（JSONL 重算）

用自写脚本重算 `eval-20261122-091501-adda.jsonl`（只聚合 `status==='graded'`、排除哨兵，自行实现 Wilson z=1.96）：`graded=52 / pass=52 / composite=1.0000 / lb=0.9312`，四维各 `13/13 · lb .7719`，`skipped=0` —— 与工具输出逐格一致。零耦合：`lib/{ranking,tool-query,tool-dispatch-plan,registry,capability-need}.js` diff 为空；`model_ratings` 未被写。

### 9.5 七模型对比表（formal/2 口径，52 判分题）

| 排名 | 统一模型名 | 渠道 / 付费类型 | 判分 | composite | Wilson LB | 档 | 唯一失分点 |
|---|---|---|---|---|---|---|---|
| 1 | deepseek-flash | deepseek-official / prepaid | 52/52 | 1.0000 | .9312 | excellent | — |
| 1 | deepseek-v4-pro | deepseek-official / prepaid | 52/52 | 1.0000 | .9312 | excellent | — |
| 1 | glm-5.3 | zai-coding-cn / monthly | 52/52 | 1.0000 | .9312 | excellent | — |
| 1 | glm-5.3-flash | zai-coding-cn / monthly | 52/52 | 1.0000 | .9312 | excellent | — |
| 1 | qwen3.8-flash | opencode-go / monthly | 52/52 | 1.0000 | .9312 | excellent | — |
| 6 | mimo-v2.6-pro | xiaomi / prepaid | 50/52 | .9615 | .8702 | excellent | tools 11/13 |
| 7 | mimo-v2.6-flash | xiaomi / prepaid | 48/52 | .9231 | .8183 | excellent | coding/tools/lc/orch 各 12/13 |

**读表要点（供人工维护参考，不构成裁决）**

1. **区分度已耗尽**：5 个模型并列第一（52/52），第 6/7 名只差 1–2 题；`excellent` 门槛（lb ≥ .75 且 p ≥ .92）在 13 题/维下几乎只区分「全对」与「错 ≥2 题」。要继续拉开差距需 ≥20 题/维（用户已决定「题目规模够了」，故本轮为归档终态）。
2. **单维 13/13 的 Wilson 下界只有 .7719**，12/13 掉到 .6756（→ good）：一题之差决定档位，跨模型比较应以「总 composite + 总 LB」为主。
3. **glm-5.3-flash 的手工登记偏保守**：登记 coding/long_context/orchestration 为 `good`，实测三维全 excellent（13/13）。是否回写由用户决定（本轮未写）。
4. **vision 维全部无数据**（suite 设计为恒 null），登记值（none/good/fair）无任何实测证据。
5. **world_knowledge 只作哨兵**（2/2 仅证明判分器校准可信），不构成能力档。
6. lite/1 时期的历史 run（deepseek-v4-pro 33 题含 3 处截断、mimo-pro 36、mimo-flash 33/35）与本表**不可直接比较**，仅作趋势参考；其数字见 §2–§4 与 §9.5 勘误。

### 9.6 评测体系归档声明（2026-11-22）

用户裁决：「测试题目规模够了，测试体系存档，后面有新模型加入时候再测试。」据此冻结：

- **冻结对象**：`suite formal/2`（`plugin-mroute/lib/eval/suite-formal.mjs`，`SUITE_VERSION='formal/2'`，55 题 → 54 次/模型）+ 判分器（`lib/eval/score.mjs`：Wilson、`suggestRating`、`six-dimension` 语义）+ 取档门槛（excellent lb≥.75 且 p≥.92 / good lb≥.55 / fair p≥.30 / none p<.30 / 无数据 n<6）。
- **复用条件**：**仅当有新模型加入注册表时**运行 `model_eval_run { suite:'formal', allow_monthly:<按渠道>, max_calls:60 }`；不复跑已有模型，不改题集、不改门槛、不改 `max_tokens` 分档（coding/orchestration 8192、tools/long_context 2048、world_knowledge 1024、vision 0）。
- **写回政策**：评测只写 `model_eval` / `eval_status`；`model_ratings`（六维能力档）与 `tier`/`priority` **一律由用户手工维护**，`suggest` 输出仅作参考（advisory-only）。
- **证据留存**：`C:\Users\sir_c\.dsh\mroute\eval-history\eval-*.jsonl` + 本报告 §2–§9。
