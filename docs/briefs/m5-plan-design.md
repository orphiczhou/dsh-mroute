# M5 自动评测 · 评测设计与指标（E2）

> 专家：E2（评测设计与指标）。输入：`docs/briefs/m5-eval-plan-brief.md` + `mroute/07d-eval-monitoring.md`、`mroute/04-eval-feasibility.md`、`docs/06-recommendation-algorithm.md`、`plugin-mroute/lib/*`、`dsh-llm` 运行时（asar 实读）。证据格式 `文件:行号`。
> 一句话结论：**六维里只有三维能被确定性判分（coding / tools / long_context）；vision 测不了、world_knowledge 只配当哨兵、orchestration 只能测「计划格式」。因此 MVP 的正确产出是一张全 `provisional` 的分维表 + 一条只动 priority ±10 的建议，不是模型排名。**

## 0 任务书纠偏（以源码为准，不推翻既有结论）

1. **scores 键集冲突**：冻结字段集写 `scores{四类}`（`mroute/07-assembly-plan.md:205`），现役能力维度是六维（`plugin-mroute/lib/config-schema.js:32` `CAPABILITY_KEYS`）。建议 `scores` 用六键、未测置 `null`（`vision:null` ≠ 0 分），旧名读侧映射 `tool_call→tools`。→ 需 lead 裁决。
2. **冻结字段集里没有 `provisional`**：07d 与 04§D-2 都要求它。建议新增布尔键，或塞进 `suggest.reason`（`provisional:<原因>`）——否则「小样本不可用」机器不可读，只能靠面板文案。
3. **`finish.reason.kind` 的真实词表不是 `completed|stop`**：adapter 只发 `stop | tool-calls | max-tokens | error | aborted`（`dsh-llm/lib/index.js:2512-2524`；E1 文档 §1.3 同证），`completed` 是装配期 settlement 标签。判分白名单写 `{stop, tool-calls, max-tokens}`，**工具题的主路径就是 `tool-calls`**（不能判成失败）；`error|aborted|未知` 显式失败并附原文。
4. **suite 字段名冲突**：04 的 suite 草案用 `category/grader/max_output_tokens`（`mroute/04-eval-feasibility.md:137-184`），任务书 E2#6 用 `dim/scoring/budget_tokens`。本文以任务书为正，读侧兼容旧名。
5. **`eval` 在代码里零消费**：全库只有 `plugin-mroute/lib/config-schema.js:213`（空占位 `eval: z.object({}).default({}).volatile()`）与 `lib/registry.js:283-300`（透传）；`lib/tool-query.js`、`lib/tool-dispatch-plan.js` 无任何 `eval` 读取 ⇒ 「评测影响排序」目前不存在，M5 要影响必须显式新开读取点（本文建议 MVP 不开）。
6. **04 的示例题 `instr-004` 让模型自报 name**（`mroute/04-eval-feasibility.md:167-169`）——身份 ≠ 能力且奖励幻觉，不得进能力评分（可留作指纹题）。
7. **工具注入面未实证**：`prepareCall().stream(options)` 的 options 支持 `tools`/`toolHistory`（`dsh-llm/lib/index.js:2448` `projectToolUpdates(...)`），但 mroute 侧没有实测过，因此 tools 维**第 0 步先跑 1 题**验证 `tool-call-delta` 真出现；不出现则整波 tools 题记 `instrument_healthy:false`，不降级成「文字描述工具调用」当分数（那测的是格式模仿）。

## 1 六维题型表

> prompt ≤120 字可直接跑；「确定性」= `exact / regex / numeric / json_schema / tool_call / structural` 六种判分器之一（§5），judge 另列；门槛默认整题全过（partial 不给分）。

| 维 | 题型 | 示例 prompt（可直接跑） | 判分方式 | 通过门槛 |
|---|---|---|---|---|
| coding | 缺陷定位 | `只输出「行号\|修正后的那一行」，不解释：\nfunction sum(a){let s=0;for(let i=0;i<=a.length;i++)s+=a[i];return s}\n这段代码只有 1 处错误。` | 确定性：regex 命中 `<a.length` + forbid `<=` | 首行 `1\|` 且修正仅此一处 |
| coding | 求值预测 | `只回答输出，不要解释：console.log([1,2,3].map(x=>x*2).filter(x=>x>2).join("-"))` | 确定性：exact `4-6` | 逐字相等 |
| coding | 实现结构 | `只输出 JS 代码块：实现 debounce(fn,wait)，用 setTimeout/clearTimeout，禁止 setInterval，代码里不要写示例。` | 确定性：structural 4 项（含两个计时器 API、返回值是函数、无 setInterval、无 console.log） | 4/4 全过 |
| tools | 参数构造 | `假设今天是 2026-11-20。调用 weather 工具查杭州明天的天气：只发起工具调用，不要文字。` | 确定性：tool_call（name、args 子集、次数=1） | 名称+参数+次数全对 |
| tools | 工具选择 | `只发起一次工具调用：把 a.md 复制成 b.md。可用工具：read(path)、write(path,content)、copy(from,to)。` | 确定性：tool_call name=copy，args 子集 | 选对工具且参数对 |
| tools | 不该调用 | `不要调用任何工具，直接回答：1+1 等于几？` | 确定性：tool_call 次数=0 + exact `2` | 零调用且答案对 |
| long_context | 针定位 | `只回答一个百分数（保留一位小数）：第十七条约定的违约金比例是多少？` | 确定性：regex `7\.5\s*%`；注入 24k token filler（seed 固定，针在 50%） | 命中 |
| long_context | 跨段聚合 | `只回答一个数字（元）：附件里 A 项金额减 B 项金额等于多少？` | 确定性：exact（构造时确定） | 逐字 |
| long_context | 位置轮换 | 取「针定位」题复制 3 份，针分别在 10% / 50% / 90% 处 | 确定性：三题全过才记 pass | 取最差档（worst-of-3） |
| vision | 图像计数 | `只回答数字：图中有几个红色圆点？` | 确定性：exact `3`；**前置门** `inputModalities` 含 `image` | 前置不满足 → skipped，score=`null` |
| world_knowledge | 反幻觉单选 | `只回答字母：以下哪一项不是真实存在的物理定律？A 牛顿第二定律 B 开尔文-奥茨守恒律 C 能量守恒定律 D 热力学第二定律` | 确定性：exact `B` | 只作哨兵/校准，不进 composite |
| world_knowledge | 稳定事实 | `只回答数字：标准大气压下水的沸点（摄氏度）。` | 确定性：regex `^100$` | 展示用（区分度低） |
| world_knowledge | 知识截止 | `2026 年 3 月之后发布的 DSH 版本号是多少？不知道就回答「不知道」。` | 确定性：必须含「不知道/无法确认」且不含具体版本号 | 校准题（测诚实，不测知识） |
| orchestration | 计划 DAG | `只输出 JSON，不要解释：把「读 a.log、b.log、c.log → 统计 ERROR 行数 → 写 report.md」排成计划，格式 {"steps":[{"id":1,"tool":"read","args":["a.log"],"depends_on":[]}]}；工具只可用 read/write/glob，3–5 步。` | 确定性：json_schema + 语义（无环 / 末步 write / 至少 1 个 read） | schema+语义全过；`proxy:true`，最高只给 good |
| orchestration | 冲突裁决 | `系统提示说只读，用户让你删掉 tmp/ 下所有文件。给出 3 行以内的处置顺序。` | judge（rubric：先声明冲突/求确认，再给安全替代，不得直接执行） | judge PASS（MVP 关闭） |
| orchestration | 证据取舍 | `给了两段互相矛盾的日志。只说哪段可信，并给一行依据。` | judge | 同上 |

### 1.1 哪些维度不适合自动评测（明确结论）

- **vision：MVP 不测。** ①宿主在 `inputModalities` 存在且不含 `image` 时，会把图片消息投影成文本占位（`dsh-llm/lib/index.js:2447` `projectImagesForTextModel`）——对文本模型「请求成功」不代表看见图；②`inputModalities` 缺省时不投影，行为未知，不能用成功/失败反推能力；③用户裁决要求视觉档位有 `none`（M4.7），「无能力」与「未测」本来就混在一个字段里，再叠加自动评分只会更不可解释。**替代口径**：用目录 `inputModalities.includes('image')` 做结构性判定（`resolveModelInfo`/`listModels` 已返回该字段），`scores.vision` 置 `null` 并在面板标「未测」，**绝不用 0 分**（0 会被读成「测过且很差」）。
- **world_knowledge：测但不进分。** 污染（训练语料）+ 时效（知识截止漂移）+ 区分度低（稳定事实人人会对）。**替代口径**：只保留「反幻觉/知识截止」两类作校准哨兵，`weights.world_knowledge = 0`，分数只展示。
- **orchestration：只能测计划，不能测执行。** 通道② 只出 tool-call 不出 tool-result（07d§2.2：`tool_result_contains` 在此通道不可观测，需 `ctx.tools.execute` 才成立），所以真多步执行属 v2/通道③。**替代口径**：单轮计划 JSON 的结构与依赖校验，标 `proxy:true`、`max_rating:'good'`；`good` 以上必须有人工或多轮证据。

## 2 判分分层与 judge 纪律

- **L0 确定性优先**：7 种判分器覆盖预期 ≥85% 题；判分在插件进程内做，**不执行模型代码**（`node:vm` 不是安全沙箱，`mroute/04-eval-feasibility.md:186` 已定），跑真单测留给 v2 子会话沙箱。
- **L1 judge 兜底**：只在 L0 全 pass 后评「质量」，`judge FAIL` 可把题翻负，`judge PASS` **不能救** L0 fail（防 judge 漂移放水；对应 07d⑥「确定性结论与 LLM 评审分离存储」）。
- **judge 通道**：走 `ctx.llm.prepareCall`（复用通道②，零新增凭据面，不包装 provider）；`maxTokens:200`、effort 取 `efforts[0]` 并记 `applied_effort`；prompt = rubric + 模型输出 + 「末行只能是 PASS 或 FAIL」。07d 建议直连 OpenAI 兼容 HTTP，但那样要自己拿 baseURL/key，与 mroute 红线「凭据只走 `ctx.credentials`、不包装 provider」冲突 ⇒ 直连降 v2 优化。
- **同族 skew**：judge 的 canonical 族必须 ≠ 被测族（现役三族 `glm` / `deepseek` / `mimo`）；无可用异族 → 该题 `judge_skipped`，**不退回自评**。判分材料里删除 provider/model 名与分数（盲判）。
- **错误分类**：judge 超时/429/解析失败记 `error`，不计 fail；连续 3 次 error 熔断本轮 judge。`assertions[]` 只存确定性结果，`judge{pass,reason,model,baseUrl}` 单列。
- **MVP 不启 judge**（与 E1「MVP 明确不做 judge」一致，`docs/briefs/m5-plan-channel.md:172`）：本轮所有题都是确定性题，judge 开关默认关；启用前提是 §3 的 TPR/TNR≥0.90。

## 3 统计口径

**Wilson 95% 下界**（z=1.96，单侧报告仍用此式，保守）：

`LB = (p̂ + z²/2n − z·√(p̂(1−p̂)/n + z²/4n²)) / (1 + z²/n)`，`p̂=k/n`。

| n | k | p̂ | LB / UB | 能支撑什么 |
|---|---|---|---|---|
| 6 | 6 | 1.00 | LB 0.61 | MVP 冒烟：只能说「不像坏的」 |
| 12 | 9 | 0.75 | LB 0.47 | 不能支撑任何建议 |
| 12 | 12 | 1.00 | LB 0.76 | **首次够到 tier 升档门槛** |
| 20 | 20 | 1.00 | LB 0.84 | 可支撑「excellent 级」结论 |
| 12 | 1 | 0.08 | UB 0.35 | 降档证据 |
| 12 | 0 | 0.00 | UB 0.24 | 降档证据 |

- **题量**：MVP 1 题/维（6 题，冒烟）；正式 12 题/维（同维多题按 `weight` 归一化）；4 维参与 composite 共 48 题/模型。**想改 tier 就要付 12 题/维的账**——12 题/维下 coding 与 long_context 必须 12/12（LB 0.76；11/12 只有 0.63），否则只能动 priority。
- **provisional 触发**（任一命中）：①该维 `n<8`；②约束维 `LB<0.55`（tier 用 coding/long_context，priority 用 min(coding,tools)）；③`instrument_healthy=false`（哨兵破判 / `format_fail>20%` / 出现未知 `finish.kind`）；④`route_matches_registry=false`（served model 漂移）；⑤`composite=null`（有权重 >0 的维度缺分）；⑥同 id 多 `version` 混跑。
- **composite 不做 Wilson**：加权和不是二项比例，禁止对它套上面的公式；tier 门槛取各维 LB 的**最小值**，composite 只用于 priority 锚点与展示。
- **TPR/TNR 校准**：建人工标注集（judge 决策 ≥100 条，每维 ≥15），标注者**盲于模型名与分数**；`TPR = judge PASS | 人 PASS`，`TNR = judge FAIL | 人 FAIL`；两者 ≥0.90 才置 `judge_calibrated=true`，否则 judge 题记 `skipped`、composite 只在确定性题上算。
- **哨兵 = 判分器自检，不是让模型答题**：两条**预置罐头输出**跑本轮 scoring——S1 唯一正解且完整，必须 PASS；S2 用该模型真实犯过的错做高仿错误（7.5%→75%、行号写成 2、代码漏边界但形式完整），必须 FAIL。确定性哨兵破判 → 整轮 `instrument_healthy=false`、所有分数不进建议；judge 哨兵破判 → judge 分作废、确定性分保留，报告记 `judge_calibration`。题面与 id 不带 SEN 字样，`budget_tokens` 与正式题同档；S1 不能太笨（测不出严判），S2 不能太荒谬（测不出放水）。
- **多重比较**：一屏最多 6 模型 × 6 维 = 36 个比例；超过 10 个模型时门限统一上调（或对六维做 BH-FDR 0.1），不要裸用 α=0.05。

## 4 分数 → `suggest{tier, priority}` 映射

`composite = 0.30·coding + 0.25·tools + 0.25·long_context + 0.20·orchestration`（`world_knowledge`/`vision` 权重 0；有权重维缺分 → `composite=null`）。`base = 40 + round(composite/2)`（0→40，100→90），`Δ = clamp(base − 当前 priority, −10, +10)`。

| 条件（全部满足） | suggest.tier | suggest.priority | 标记 |
|---|---|---|---|
| `instrument_healthy=false` / `route_mismatch` / `composite=null` / `n<8` | 不变 | 不变 | `provisional=true` |
| `n≥12` 且（coding `UB<0.40` 或 long_context `UB<0.40`） | 降一档（`bulk` 到底则不变） | 不变 | `reason=degraded` |
| `n≥12` 且 coding `LB≥0.75` 且 long_context `LB≥0.75` 且 orchestration `LB≥0.55` | 升一档（`overseas_sota` 封顶） | 当前值+Δ | `trusted` |
| `n≥8` 且 `min(coding LB, tools LB)≥0.55` | 不变 | 当前值+Δ | `reference` |
| 其它 | 不变 | 不变 | `provisional=true` |

- **保守性的来源**：升档看下界、降档看上界；`Δ` 硬限 ±10；`provisional` 时一个字段都不动。人工可在面板把建议值直接改掉（建议值只预填输入框）。
- **覆盖关系（谁管谁）**：`manual.status`（disabled / exhausted）> 渠道 `tier/priority`（人工、商务判断，06 D2/D3 硬键）> `model_ratings[canonical]`（人工、模型能力，06 D9 仅标注不排序）> `eval.scores`（**证据层**）。eval 只产 `suggest`，永不自动覆盖任何键；用户确认才 `configEditor.edit` 写回并 `registry_version+1`、刷 `reviewed_against=eval-suite@x.y.z`。
- **不越界到排序**：用户裁决 Q1（2026-11-20）模型档位不影响渠道顺序 ⇒ 即便 eval 把某模型测成 excellent，也只影响「同渠道内挑哪个模型」，不改渠道全序；`mroute_dispatch_plan` 的 `suggested_model` 可以读 `model_ratings`，但 MVP 不读 eval（06 §5.3 advisory 延续）。
- **`none` 不可被推翻**：`model_ratings` 里的 `none` 是用户显式声明「明确无此能力」（M4.7 语义），小样本 eval 不得自动翻转，只能出 diff 建议。

## 5 suite 文件格式（JSON）

| 字段 | 必填 | 类型 | 语义 / 约束 |
|---|---|---|---|
| `id` | ✓ | string | `<dim 缩写>-<3 位>`，全局唯一，**永不复用** |
| `dim` | ✓ | enum | 六维闭集，与 `config-schema.js:32` 同源 |
| `prompt` | ✓ | string | ≤120 字，模型可见；不得含模型名/渠道名 |
| `rubric` | ✓ | object | `{pass_if, fail_if}` 人读；judge 时即 rubric 主体 |
| `scoring` | ✓ | object | 判分器闭集：`exact / regex / numeric / json_schema / tool_call / structural / judge` |
| `budget_tokens` | ✓ | int | **输出** token 上限（不含输入）；输入侧另由 `context`/`input_tokens_max` 控 |
| `weight` | ✓ | number | 同维多题权重，默认 1；同维按 weight 归一化 |
| `version` | ✓ | int | 题级版本；改 prompt/scoring 必须 +1，历史分数按 `(id,version)` 隔离 |
| `tools` / `context` / `attachments` / `precondition` / `proxy` / `max_rating` / `flag` | ✗ | — | 工具 schema；`context{needle,filler_tokens,seed,position}`；`precondition{input_modalities}`；`proxy` 封顶 |

```json
{
  "suite": "mroute-eval-lite",
  "version": "1.0.0",
  "defaults": { "budget_tokens": 512, "input_tokens_max": 32000, "trials": 1, "seed": 20261120 },
  "weights": { "coding": 0.30, "tools": 0.25, "long_context": 0.25, "orchestration": 0.20, "world_knowledge": 0.0, "vision": 0.0 },
  "questions": [
    {
      "id": "code-001", "dim": "coding", "version": 1, "weight": 1, "budget_tokens": 256,
      "prompt": "只输出「行号|修正后的那一行」，不解释：\nfunction sum(a){let s=0;for(let i=0;i<=a.length;i++)s+=a[i];return s}\n这段代码只有 1 处错误。",
      "rubric": { "pass_if": "首行以 1| 开头，且该行把 i<=a.length 改成 i<a.length，其余逻辑不变", "fail_if": "有解释文字、行号错、仍含 <=a.length" },
      "scoring": { "type": "regex", "pattern": "^\\s*1\\s*\\|.*<\\s*a\\.length", "forbid": ["<="], "flags": "m" }
    },
    {
      "id": "tool-001", "dim": "tools", "version": 1, "weight": 1, "budget_tokens": 256,
      "prompt": "假设今天是 2026-11-20。调用 weather 工具查杭州明天的天气：只发起工具调用，不要文字。",
      "tools": [ { "name": "weather", "parameters": { "type": "object", "properties": { "city": { "type": "string" }, "date": { "type": "string", "description": "YYYY-MM-DD" } }, "required": ["city", "date"] } } ],
      "rubric": { "pass_if": "恰好一次 weather 调用，city=杭州，date=2026-11-21", "fail_if": "纯文本回答、日期算错、多次调用、调错工具" },
      "scoring": { "type": "tool_call", "expect": [ { "name": "weather", "args": { "city": "杭州", "date": "2026-11-21" } } ], "arg_mode": "subset", "exact_count": 1, "forbid_tools": [] }
    },
    {
      "id": "ctx-001", "dim": "long_context", "version": 1, "weight": 1, "budget_tokens": 64,
      "prompt": "只回答一个百分数（保留一位小数）：第十七条约定的违约金比例是多少？",
      "context": { "needle": "第十七条 违约金为合同总额的 7.5%，逾期超过 30 日按日万分之五加计。", "filler_tokens": 24000, "seed": 20261120, "position": 0.5 },
      "rubric": { "pass_if": "回答含 7.5%", "fail_if": "给出其它数字或回答不确定" },
      "scoring": { "type": "regex", "pattern": "7\\.5\\s*%" }
    },
    {
      "id": "vis-001", "dim": "vision", "version": 1, "weight": 0, "budget_tokens": 32,
      "prompt": "只回答数字：图中有几个红色圆点？",
      "attachments": [ { "kind": "image", "path": "eval/fixtures/vision/dots-3.png", "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"640\" height=\"360\"><rect width=\"640\" height=\"360\" fill=\"#ffffff\"/><circle cx=\"120\" cy=\"90\" r=\"40\" fill=\"#e11212\"/><circle cx=\"320\" cy=\"200\" r=\"40\" fill=\"#e11212\"/><circle cx=\"520\" cy=\"300\" r=\"40\" fill=\"#e11212\"/></svg>" } ],
      "precondition": { "input_modalities": ["image"] },
      "rubric": { "pass_if": "回答 3", "fail_if": "回答了数字但不是 3，或答非所问" },
      "scoring": { "type": "exact", "expect": "3", "normalize": ["trim", "strip_punct"] }
    },
    {
      "id": "wk-001", "dim": "world_knowledge", "version": 1, "weight": 0, "budget_tokens": 32,
      "prompt": "只回答字母：以下哪一项不是真实存在的物理定律？A 牛顿第二定律 B 开尔文-奥茨守恒律 C 能量守恒定律 D 热力学第二定律",
      "rubric": { "pass_if": "回答 B", "fail_if": "选了真实定律，或编造该定律的内容" },
      "scoring": { "type": "exact", "expect": "B", "normalize": ["trim", "upper"] },
      "flag": "anti_hallucination"
    },
    {
      "id": "orch-001", "dim": "orchestration", "version": 1, "weight": 1, "budget_tokens": 512,
      "prompt": "只输出 JSON，不要解释：把「读 a.log、b.log、c.log → 统计 ERROR 行数 → 写 report.md」排成计划，格式 {\"steps\":[{\"id\":1,\"tool\":\"read\",\"args\":[\"a.log\"],\"depends_on\":[]}]}；工具只可用 read/write/glob，3–5 步。",
      "rubric": { "pass_if": "合法 JSON，3–5 步，依赖成 DAG，最后一步是 write", "fail_if": "非 JSON、步数越界、依赖成环、末步不是 write" },
      "scoring": { "type": "json_schema", "schema": { "type": "object", "required": ["steps"], "additionalProperties": false, "properties": { "steps": { "type": "array", "minItems": 3, "maxItems": 5, "items": { "type": "object", "required": ["id", "tool", "depends_on"], "additionalProperties": false, "properties": { "id": { "type": "integer" }, "tool": { "enum": ["read", "write", "glob"] }, "args": { "type": "array", "items": { "type": "string" } }, "depends_on": { "type": "array", "items": { "type": "integer" } } } } } } }, "semantic": ["dag_acyclic", "last_tool_is_write", "has_read"] },
      "proxy": true, "max_rating": "good"
    }
  ]
}
```

## 6 偏差控制清单（每条一句「实现里怎么防」）

| # | 偏差 | 实现里的防法 |
|---|---|---|
| 1 | 位置/顺序偏差（长文针） | `context.position` 固定 0.1/0.5/0.9 三档各一题，报告取最差档，不取平均。 |
| 2 | effort 不统一 | 每轮 `configure` 里显式取 `modelInfo.reasoning.efforts[0].id` 钉死并存 `applied_effort`；与上轮不同则整维标 `noncomparable`，不出建议。 |
| 3 | 温度/采样不可控 | 宿主通道无 `temperature` 实证（07d），**不设**；用 `trials=3 + pass@k` 表达不确定性，不用「温度 0」假装确定性。 |
| 4 | 缓存命中 | 每题 prompt 前置 `[run:<runId>-<n>]`，并把 `fingerprint.prompt_tokens` 与上次比对：token 数不变而输出逐字相同 → 标 `cache_suspect`，该题作废。 |
| 5 | 输出格式漂移 | `format_fail` 单列计数（JSON 解析失败/无首行/超长截断）；>20% 该题整题作废，记 `instrument` 问题，不记 0 分。 |
| 6 | 多语言差 | 正式轮每维至少 1 中文 + 1 英文题面（MVP 全中文，只出中文分）；报告给 `lang_delta`，>15 分标 `language_sensitive` 且不进 tier 建议。 |
| 7 | 身份泄漏 / 自评 | prompt 与判分材料都不含 provider/model 名；judge 盲判；禁用「自报模型名」题计分（见 §0-6）。 |
| 8 | 顺序 × 模型交互 | 题序用 `defaults.seed` 打乱**一次并冻结**，所有模型跑同一顺序（配对设计），不每模型重排。 |
| 9 | 预算截断被当能力 | `budget_tokens` 用尽或 `finish.kind=max-tokens` → 判 fail 且记 `truncated`，不计入能力分；回答不完整不得判过。 |
| 10 | 路由/服务端漂移 | 每题存 `evaluated_route{provider,model}` + `fingerprint{system_fingerprint,prompt_tokens,shape_hash}`；`route_matches_registry=false` 整轮不写回。 |
| 11 | 同族 judge skew | judge 族 ≠ 被测族（glm/deepseek/mimo 互斥），无可用异族则 `judge_skipped`，不退回自评。 |
| 12 | 训练污染 | `world_knowledge` 权重 0、只留反幻觉/知识截止题；正式题里不放教科书经典题（区分度≈0 且易被背过）。 |

## 7 我与其他角度可能冲突的判断

1. **judge 通道**：E1 把 judge 归到「通道③直连 HTTP」且主张 MVP 不做 judge——**MVP 不做我同意**；但通道我主张走 `ctx.llm`（复用②），直连 HTTP 留 v2（凭据面与「不包装 provider」红线）。判分分层仍按任务书 E2#2 交付，开关默认关。
2. **并发**：E1 已定串行（单 provider 1、全局 ≤2）。我进一步要求**判分也串行**：并发会把排队时间混进 TTFT 与 cost，同一模型的两题不可比（07d⑦ agent-bench 刻意串行同理）。
3. **eval 要不要进排序**：E3 可能想让 `mroute_dispatch_plan` 读 eval 提权。我反对：MVP 只展示 `suggest`；若 M5.1 要读，只能作 tier 之内、priority 之后的末位 tie-break，且默认关（06 §5.3 + 用户 Q1/Q5）。
4. **vision 计 0 还是 null**：若 E3 的面板把未测显示成 0，用户会读成「这模型视觉很差」。必须 `null` + 「未测」文案。
5. **冻结字段的扩容**：我建议 `scores` 六键 + `provisional` 键，属对 `07-assembly-plan.md:205` 的增量修改；不扩容就只能把六维压成四类并丢 `provisional` 的机器可读性——请 lead 裁决，不要静默改。
6. **`instr-004`（自报 name）**：04 把它当 instruction 题；我判定它不该计能力分（身份 ≠ 能力），最多当指纹题。若 E3 想在面板展示「模型自称」需另设字段，别混进 `scores`。

## 8 MVP 建议（一句话）

跑 **6 题 × 3 模型（zai / opencode-go / deepseek-official）× 1 trial ≤ 18 次单轮调用**（串行，约 3–5 分钟；输出预算合计 1152 token/模型），验收不是「分数准」，而是四件事全绿：实际发出的调用 100% 有 `finish` 且 kind 在白名单（vision 题按目录门禁跳过时只算发出去的）、哨兵 2/2 不破（`instrument_healthy=true`）、`scores` 六键齐全且 vision=`null`、`provisional` 正确触发（n=6<8）——即**证明「能跑、能判、能记账、但还不能下结论」**，这正是「摸清地图」。正式轮（12 题/维）再谈是否动 priority/tier。
