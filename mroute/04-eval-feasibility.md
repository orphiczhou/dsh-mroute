# 评测机制可行性调研：手工触发「评测模型能力 → 更新排名」在 DSH 插件形态下的实现

- 树节点：mroute / mroute-W5-evalmech
- 调研时间：2026-11-13
- 证据源：asar 源码逐行查证（`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-agent-loop`，read 工具）、上游 `00/01/02` 三份报告、web_search/web_fetch（出处见文末链接表）、本会话工具面亲测
- 与上游关系：01 已证实「插件注册 Tool/Service/UI、credentials、HTTP 出站」全部可行；02 已证实「10 渠道余额/用量机读分级」。本文增量回答：**模型调用走哪条通道、评测资产用现成还是自建、外部榜单怎么同步、排名怎么更新、成本怎么管**。

---

## A. 插件不经会话发起模型调用的三条通道

### A-0 前提查证：宿主 llm 服务**确实有**可被插件消费的调用入口（新证据，回应 W1 遗留疑点）

W1 留下的线索是「catalog 未见通用推理调用入口」。本次逐行读源码，结论：**catalog 只是投影子集，llm 服务对象上存在完整的流式调用 API，且宿主自己的对话引擎（本身是插件）就在这样消费**。

**1) LlmRuntime 就是 llm 服务类，自带调用面。** `dsh-llm/lib/index.js` L1756-1759 类注原文：

> *"The abstract `llm` service: an adapter registry plus a streaming model-call API, interceptable via the `llm/stream` waterfall."*

类声明 `class LlmRuntime extends TypertRemoteService`（L1760-1766），构造器绑定服务名 `"llm"`（L1815-1817）。公开方法逐行清单（均在同一文件）：

| 方法 | 行号 | 语义 |
|---|---|---|
| `registerAdapter(providers, adapter)` | L1842 | 注册适配器（DUPLICATE_ADAPTER 全有全无） |
| `listProviders()` | L1908 | 已注册 provider 路由 |
| `registerConfigurableProviders(entries)` / `listConfigurableProviders()` | L1919 / L1964 | 可配置 provider 目录（设置页背后） |
| `registerModelDiscovery(ns, discover)` / `discoverModels(ns, request, signal)` | L1977 / L1998 | 端点探测（模型发现） |
| `providerRetryPolicy(provider)` | L2041 | 路由级重试政策 |
| `listModels(provider)` | L2086 | 适配器目录模型清单 |
| `resolveModelInfo(provider, model, signal)` | L2116 | 精确模型元数据（contextWindow/defaultMaxTokens/efforts/inputModalities） |
| `resolveCallConfig(config, signal)` | L2179 | 派遣前活校验（01§B-2 已引用） |
| **`prepareCall(config, signal)`** | L2225-2266 | 绑定适配器代次，返回冻结 handle `{config, retryPolicy, adapterDefaults, context?, inputModalities?, stream(options)}`（一次一投，防 HMR 混代次） |
| **`stream(options)`** | L2387-2403 | 裸调用入口。JSDoc 原文：*"Stream one model call as raw chunks (token-level deltas)… `options.provider` selects the adapter. @returns the chunk stream, possibly wrapped by `llm/stream` listeners."* 内部经 `ctx.waterfall(this, "llm/stream", …)`（L2402） |

**2) 决定性消费先例：宿主对话引擎 dsh-agent-loop 本身是插件。** 其 package.json 自述 *"The concrete agent loop plugin for the DeepSeek Harness"*（devDependencies 含 cordis-plugin-loader）。`dsh-agent-loop/lib/index.js`：

- `AgentLoop extends Service`，`static inject = ["agents","sessions","llm","tools","systemPrompt","sessionProjections"]`（L1298-1306）——**以服务注入方式拿 llm 实例**；
- 每步请求前 `preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal)`（L1005）；
- 发起调用 `const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)`，随后 `for await (const chunk of stream)` 逐块消费（L877-884）；
- 响应里解析 `block.type === "tool-call"` 块，并经 `this.loopCtx.tools.execute({calls, …})` 跑工具循环（L957-971）。

**3) 判读**：inspect Service catalog 只列 8 个方法（01§B-3），是因为 catalog 是给远程/巡检用的投影（TypertRemoteService + `@Remote` 装饰器只标了 3 个方法，L1769-1771），**不是对象访问面**。进程内插件拿到的 `ctx.llm` 就是 LlmRuntime 实例全表面。=> **通道②在源码层面成立**。

**4) 可复用词汇表**（同包导出，L2434 export 列表）：`createSystemMessage/createUserMessage/createAssistantMessage/createToolResultMessage`（消息构造，L37-112）、`AssistantStreamAccumulator/BlockAssembler/assembleAssistantStream/joinAssistantStreamText/isTokenDelta/lastAssistantStreamChunk`（流消费与拼装）。插件 `import { … } from "@deepseek-ai/dsh-llm"` 即可用，不必自造协议。

### 通道①：直连渠道 HTTP API（openai-compatible chat/completions）

**机制**：插件进程内 ESM 直接 Node `fetch` / 正规接缝 `ctx.connection.fetch`（01§E，已证实）；Key 走 `ctx.credentials`（绝不进 Config，01§E + host-plugin.md L77）。

**能测什么**（openai-compatible 端点全自由度）：
- 文本生成、JSON mode / 结构化输出（`response_format: json_schema`）、原生 `tools` + `tool_calls` 工具调用 JSON 模式；
- **采样参数完全自由**（temperature/top_p/max_tokens）——这是①独有的控制面；
- 长上下文：把 prompt 塞到窗口上限测遵循度；
- 渠道特有端点：智谱 coding 路由 `/api/coding/paas/v4`（与标准 API 是**两个独立额度池、独立 Key**，02§一#2 与出处#26）——评测哪个池由 baseURL 决定，口径明确。

**限制**：
- 每渠道手写适配：端点/鉴权头/SSE 流解析/错误码/退避重试全部自理；无宿主 llm-retry；
- 订阅端点与 API 端点分离的渠道（OpenAI 订阅 vs API、Anthropic 订阅赠 credit 走 Console 不走 API，02§一#8/#9），直连测到的只是 API 池；
- 评测消耗直接打在渠道账上且与宿主使用双份记账（好处：计价精确）；
- 部分渠道无公开余额 API（02§二.D），超卖风险要靠预算帽兜。

### 通道②：经宿主 llm 服务（源码证实，推荐主通道）

**机制**：插件 service `static inject = ['llm']` → `const stream = ctx.llm.stream({ provider, model, messages, tools?, maxTokens?, reasoningEffort?, signal })`；或先 `prepareCall` 拿绑定 handle 再投一次。消息用 DSH 中立词汇表（`createUserMessage({content:[{type:"text",text}]})` 等）；流终止块 `finish.reason.kind ∈ completed | max-tokens | error | aborted`（adapterFailureChunk，L2406-2419；agent-loop L923 按 kind 分支）。

**免费拿到的东西**（相对①的净收益）：
- 适配器选择、**凭据自动解析**（设置页/credentials 已存的 Key 直接可用，含 zai-coding-cn/xiaomi/opencode-go 这类可配置 provider）；
- attributionHeaders 合规（LlmAdapter 契约，L1665-1669）、providerRetryPolicy、宿主 **llm-retry 插件**的统一重试（本机 active，01§F）；
- token usage 事件（成本核算数据源，与 00§3.1 D 类「本地折算」同源）；
- `resolveModelInfo` 返回 `context.contextWindow`——长上下文题可按真实窗口构造贴边样本；
- **保真度最高**：评测走的就是派遣走的同一条链（同 adapter、同凭据池、同 retry）。评 zai-coding-cn 就是评 coding 路由本身，结果对 `model_route_query` 排序直接有代表性。

**限制/未知（诚实标注）**：
- **采样参数控制面未证实**：逐行读到的请求控制只有 `maxTokens`/`reasoningEffort`（resolveCallWithInfo L2188-2212）与 signal；GenerateOptions 是否透传 temperature/top_p 未验证。需要固定采样参数的题目要么先做一次字段验证，要么退①。
- 评测调用同样过 `llm/stream` waterfall：其他监听器（如 token 计量插件）会看到这些请求。若担心污染会话级统计，应给评测请求加自定义标记（`markAgentLoopRequest` 是给 agent loop 的同类先例导出，L2434）——标记的消费面未逐行验证，列为遗留点。
- 并发无文档上限：评测引擎应自己串行/低并发。
- 工具调用格式是 DSH 词汇表（语义等价 openai 原生，adapter 负责翻译）；测「模型原生 tool_calls JSON 模式」的细节行为（如 parallel tool calls、strict schema）仍走①更接近原生。

### 通道③：派子会话实测

**机制**：`subagents.startActivation(spec)` / `agents.create`（01§B-7）；派遣口同构（`subagent`/`subagent_fork`/`tree_dispatch` 的 assignee）。本会话工具面亲测三者俱在。

**能测什么**：唯一能测 **agent 能力**而非模型 API 能力的通道——多步任务、真实工具使用（读写文件、跑命令）、多轮纠错、跨步记忆。这就是用户「评估各种模型能力」里最接近实际派遣体验的部分。

**成本/限制**：
- 每次派遣起完整会话（system prompt + 工具定义 + 多轮），token 成本最高。参照量级：Aider 官方榜单一行记录单模型 225 题消耗 prompt tokens 约 2.5-3M（官网数据，见 C 节）——批量跑不现实；
- 并发控制弱：宿主会话调度无内置「评测并发槽」，需评测引擎自己排队（tree_dispatch 串行派发可行）；
- 结果回收靠回报文本，结构化程度靠任务书约定（DoD/taskType），解析鲁棒性一般。

**适用**：不做常规批量评测；做 **tier 升降级的抽检仲裁**——争议模型抽 3-5 题真实任务跑一遍，作为人工确认 tier 变更前的最后参考。

### A 对比总表与推荐

| 维度 | ①直连 HTTP | ②宿主 llm 服务 | ③派子会话 |
|---|---|---|---|
| 接入成本 | 高（每渠道手写适配+SSE 解析） | 低（inject + 一次调用） | 低（现成派遣口） |
| 凭据 | 自管（credentials） | 宿主适配器自动解析 | 宿主自动 |
| 重试/退避 | 自己写 | llm-retry 免费拿 | 宿主内部已有 |
| 对派遣的保真度 | 中（端点同、链路不同） | **最高（同链路同池）** | 最高（整链路+工具生态） |
| 可测能力面 | 文本/JSON/工具/长上下文 + 采样参数全自由 | 文本/JSON/工具/长上下文（采样参数待验证） | 多步任务/真实工具/多轮（agent 级） |
| 成本核算 | 精确（自算 usage） | usage 事件免费拿 | 最高（会话开销） |
| 并发控制 | 完全自控 | 自控（建议串行） | 弱 |
| 智谱 coding 池口径 | 需自己选对池 | 自动=派遣同池 | 自动=派遣同池 |

**推荐**：评测引擎以 **② 为主通道**（批量跑四类题）；**① 做两件事**——渠道连通性探针（每次触发 1 模型 1 题，验证 API Key/端点活着）与参数实验（采样/思考预算）；**③ 做 tier 抽检仲裁**。混用时机：tier 升降有争议 → ③；渠道订阅池与 API 池分离（智谱/OpenAI 订阅）→ ① 补测另一池；常规批量 → ②。

---

## B. 现成评测资产调研

### promptfoo（node 生态）

- **形态：CLI 与库双形态**。官方 node-package 文档：`npm install promptfoo`（**要求 Node.js ≥22.22.0，推荐 24 LTS**），编程接口 `import promptfoo from 'promptfoo'; const results = await promptfoo.evaluate(testSuite, options)`——**可作库嵌入**，非仅 CLI。
- **License：MIT**。README 原文：*"a CLI and library for evaluating and red-teaming LLM apps"*、*"Promptfoo is now part of OpenAI. Promptfoo remains open source and MIT licensed"*（已被 OpenAI 收编但保持开源 MIT）。
- **openai-compatible**：自定义 provider 指任意 openai-compatible baseURL+Key；断言体系成熟——javascript 表达式断言（`value: output.category === 'billing'`）、`json` / `json_schema` 断言、关键词/equals/`llm-rubric`（模型判卷）等（OpenAI provider 文档演示 response_format json_schema + assertions 读 `output.category`）。
- **嵌入判断：可嵌但不建议第一版嵌**。三个理由：① 需求只是「固定集 10-20 题 + 自动判分」，自建判分器（JSON schema 校验 + 关键词 + 少量断言函数）一两百行、零依赖；② promptfoo 依赖树重（red-teaming 全家桶），嵌进宿主进程拉大内存与启动面，且 Node 版本要求需先验证宿主 Electron 内置 Node 是否 ≥22.22（未验证，列为遗留点）；③ 其增量价值（web viewer、llm-rubric、red-teaming）本期用不上。**开发期可用其 CLI 在开发机离线批量对比**，产出 JSON 汇总人工导入，插件运行时零依赖。

### evalscope / lm-eval-harness（重量级）

- evalscope（ModelScope）：Python、自定义数据集组合 + 可视化、中文友好；lm-eval-harness（EleutherAI）：学术界标准、任务库庞大（arc/gsm8k/humaneval/ceval 等）。
- **均需 Python 运行时；DSH 插件是宿主进程内 ESM JS，嵌入需捆绑 Python——不适合嵌入**。
- 它们能给的「学术基准分数」与 C 节外部榜单高度重叠：**直接同步榜单数据即可，不必自己跑**。evalscope 若想跑中文基准可放开发机自跑、人工导入结果（不进插件运行时）。

### 轻量自建 prompt 集（推荐方案）

固定集 JSON（`suite_version` 化），四类各 10-20 题，判分器全部确定性（不引入 LLM judge，零额外成本、可复现）：

| 类别 | 题型 | 判分方式 |
|---|---|---|
| `code` | 生成/修复（写函数、改 bug） | 结构断言 + 关键词 + （v2）③通道内跑真单测 |
| `tool_call` | 按工具 schema 发起调用 | **tool-call 参数 JSON schema 校验** + 业务断言（如日期=明天） |
| `long_context` | 长文大海捞针/跨段引用 | 答案关键词/精确子串 |
| `instruction` | 格式与约束跟随 | JSON schema / 正则 / 长度上限 |

**设计示例（可直接当 suite 文件起点）**：

```jsonc
{
  "suite": "mroute-eval-lite",
  "suite_version": "1.0.0",
  "defaults": { "max_output_tokens": 1000 },
  "questions": [
    {
      "id": "tool-001",
      "category": "tool_call",
      "prompt": "调用 query_weather 工具查询杭州明天的天气。只发起工具调用。",
      "tools": [{
        "name": "query_weather",
        "parameters": { "type": "object",
          "properties": { "city": { "type": "string" }, "date": { "type": "string", "description": "YYYY-MM-DD" } },
          "required": ["city", "date"] }
      }],
      "grader": { "type": "tool_args_schema",
        "schema": { "type": "object", "properties": { "city": { "const": "杭州" } }, "required": ["city", "date"] },
        "extra": { "date_check": "next_day" } },        // date 等于运行日+1
      "max_output_tokens": 500
    },
    {
      "id": "ctx-002",
      "category": "long_context",
      "prompt": "以下是 30 页虚构合同文本（构造时注入）。第 17 页第 3 条约定的违约金比例是多少？只回答百分比数字。",
      "context_builder": { "type": "filler_to_window", "needle": "第十七条 违约金为合同总额的 7.5%……" },
      "grader": { "type": "regex", "pattern": "7\\.5\\s*%" },
      "max_output_tokens": 200
    },
    {
      "id": "instr-004",
      "category": "instruction",
      "prompt": "输出一个 JSON 对象：{\"name\": <你的模型名>, \"langs\": [恰好 3 种你最擅长的编程语言]}。只输出 JSON。",
      "grader": { "type": "json_schema",
        "schema": { "type": "object", "properties": { "name": {"type":"string"}, "langs": {"type":"array","minItems":3,"maxItems":3} },
                    "required": ["name","langs"], "additionalProperties": false } }
    },
    {
      "id": "code-005",
      "category": "code",
      "prompt": "写一个 JS 函数 debounce(fn, wait)。只输出代码块。",
      "grader": { "type": "structural",
        "checks": ["包含 setTimeout", "包含 clearTimeout", "返回值为函数", "不含 setInterval"] }
      // v2 升级：走通道③在子会话里对产物跑真单测（计时替身），插件进程内不用 eval
    }
  ]
}
```

**判分器安全提示**：不要在宿主进程里对模型输出做 `eval`/`new Function`——`node:vm` 不是安全沙箱。v1 用结构断言/关键词/schema 校验；「跑真单测」留给通道③（子会话天然有沙箱边界与文件系统）。

---

## C. 外部榜单作为人工参考数据源（人工触发「同步榜单」）

| 榜单 | URL | 更新频率 | API / 抓取面 | 抓取可行性 |
|---|---|---|---|---|
| **LMArena**（原 LMSYS Chatbot Arena，已更名 Arena AI） | `https://arena.ai/leaderboard/` | 票数滚动累计、排名数日一刷；**无官方公开 API** | 社区镜像 `oolong-tea-2026/arena-ai-leaderboards`：GitHub Actions **日更全量 JSON 快照**（data/按日期分目录+latest.json），另托管免费 REST（无需鉴权，第三方域名）；兜底直接抓页面 | **可行**（镜像最稳；镜像失效回退页面抓取，走熔断） |
| **LiveCodeBench** | `https://livecodebench.github.io/leaderboard.html` | 连续滚动：新题按窗口加入（release_v1…vN 版本化）；榜单随提交更新 | 页面数据内嵌；数据集在 HuggingFace/ModelScope（CC 许可） | 可行；**引用必须带 release 版本号**（防「 newer 题=污染」口径错位） |
| **Aider polyglot** | `https://aider.chat/docs/leaderboards/` | 作者手工更新（页脚 *"last updated November 20, 2025"*，量级月更） | 单页 HTML 结构化表格：Pass rate 1/2、**总成本、prompt/completion tokens、秒/题**全公开；本次调研 web_fetch 实测 HTTP 200 可读 | **可行且最容易**（fetch+解析表格即得，成本列对 E 节预算设计有参照价值） |
| **SWE-bench Verified** | `https://www.swebench.com/` | 随提交批次/leaderboard 阶段更新，无固定日程 | **页面内嵌 JSON**：`<script type="application/json" id="leaderboard-data">` 标签内含全榜分组（"Verified" 等），regex + HTML-unescape 即得（开源包 swebenchsota 的解析先例原话） | **可行**（有现成解析先例，实现量小） |

**同步器设计要点**：人工触发按钮 → 逐源 fetch → 落插件数据目录 `leaderboards/<source>/<date>.json`（本地历史留痕）→ 面板只读展示（**external reference 层，绝不自动改 tier**）。LMArena 优先走社区镜像 REST（机读稳定），失败即熔断降级页面抓取，再失败标「同步失败于 <date>」。**模型名对齐**是最大工程坑：各榜命名不规范（alias/日期后缀/托管渠道前缀），同步器须维护一张人工校准的 `model_alias` 映射表（榜单名 → 本机 provider/model），未映射条目进「待人工映射」队列，不进面板交叉引用。

---

## D. 排名体系设计

### D-1 tier 保持人工语义，评测分数只做证据

tier（overseas_sota / domestic_sota / bulk）与 `priority` 是**编辑期知识**（00§3.1 设计要点、00§5 风险 4），评测分数是**证据**不是裁决。**自动改 tier 明确不做**——评测完成只产出 `suggested_tier / suggested_priority`，人工确认才写回。

### D-2 组内分数：v1 用加权百分制，Elo 缓行

- **不建议 v1 上 Elo**：样本量 10-20 题/类时，pairwise Elo 需要数百场对战才收敛，且 pairwise 需要判卷者（LLM judge 引入新偏差与成本）——小样本下 Elo 噪声大于区分度。简单加权百分制可复现、可解释、算力零增量。
- **推荐**：per-category 通过率（0-100）→ Config 权重合成 composite（默认 `coding 0.35 / tool_call 0.25 / long_context 0.20 / instruction 0.20`，权重放 Config 可调）；「composite 每元成本 / 每千 token」作**参考列**不进主分（成本修正交给 00§3.1 的财务优先级层，两套口径不混）。
- **纳入门槛**：某类 `n_samples < 8` 或成本数据缺失 → 分数标 `provisional`，不参与 tier 建议与排序理由。
- **Elo 留作 v2 选项**：当题库 >100 题、评测月频化、且愿意引入 pairwise 盲判时再评估。

### D-3 评测元数据与注册表衔接（对齐 00§3.1 schema）

注册表 channel 对象**新增一个 `eval` 子对象**（其余 schema 不动），完整逐题历史落插件数据目录（不进 Config，保持 Config 可读可 diff）：

```jsonc
// 00§3.1 channel 内新增：
"eval": {
  "last_run_id": "eval-2026-11-13-001",
  "last_run_at": "2026-11-13T21:04:00+08:00",
  "suite_version": "1.0.0",
  "channel_used": "host_llm",              // host_llm | direct_http | subagent —— 评测走的通道
  "evaluated_route": { "provider": "zai-coding-cn", "model": "glm-…", "reasoning_effort": "…" },
  "route_matches_registry": true,          // 不一致时面板高亮警告（评的和排的不是同一个模型）
  "n_samples": 52,
  "cost": { "amount_cny": 0.42, "source": "usage_event" },   // usage_event | manual_estimate
  "scores": { "coding": 86, "tool_call": 78, "long_context": 64, "instruction": 90 },
  "composite": 79,                          // Config 权重合成
  "provisional": false,
  "suggest": { "tier": "domestic_sota", "priority": 92, "evidence": "composite 79 > 阈值 75；aider 74.2% 国内前列" }
}
// 逐题明细：插件数据目录 eval-history/eval-2026-11-13-001.json（不进 Config）
```

**衔接点**：① `registry_version` 每次人工确认写回 +1；② `reviewed_at` / `reviewed_against` 随确认刷新（`reviewed_against` 写成 `"eval-suite@1.0.0 + arena@2026-11-13"`，把评测与榜单两个保鲜锚点都挂上）；③ `model_route_query` 排序时把 `eval.composite` 作为 tier 内次级排序因子（`priority` 仍人工定，eval 只提建议）；④ 榜单同步数据放 `leaderboards/` 引用层，channel 可挂 `"external_ref": {"arena_rank": 12, "as_of": "2026-11-13"}` 供面板交叉展示。

### D-4 更新流程（评测完成 → 建议 → 人工确认 → 写回）

```
人工触发评测（面板按钮 / model_eval_run 工具）
  → 评测 run（通道②串行逐题；usage 累计；熔断监控）
  → run 完成：生成 EvalReport（分数 + suggested_tier/priority + 证据链：分数阈值表 + 外部榜单交叉引用）
  → 面板展示 diff：当前 tier/priority vs 建议（红绿高亮，附 eval 元数据）
  → 人工点「确认采纳」→ configEditor.edit() 写回注册表（registry_version+1、tier/priority 更新、
     channel.eval 落摘要、reviewed_at=今天）——或点「忽略」→ 留档不写回
  → 下一次 model_route_query 即吃到新排名；systemPrompt 提示层无需改动
```

---

## E. 成本护栏

| 护栏 | 设计 | 数据来源 |
|---|---|---|
| **预算上限** | Config `eval_budget: { per_run_cny_max, monthly_cny_max }`；run 前按「题数 × max_output_tokens × 渠道单价表」预估，超限拒跑；run 中按 usage 事件累计，超限即停（已跑题保留，标 `partial`） | 单价表人工登记（版本化，同 00§3.1 coeff_table_ref 做法） |
| **与余额联动** | run 前查渠道余额：余额 < 预估成本 × 3 → 拒跑并提示；A/B 类机读直读（02§一），DeepSeek 优先宿主 `deepseekAccount.getBalance`（01§E）；C/D 类余额不可读 → 只靠 per_run 预算帽 | 02§二 A-D 分级 |
| **包月渠道优先** | `channel_type=monthly` 的渠道额度池内边际成本≈0，默认先评、可用全量样本；prepaid 渠道默认每类 5 题冒烟，升级全量需人工确认 | 02§三.Q3.3 财务分级 |
| **单次样本上限** | `per_run_questions_max`（默认 40）；每题 `max_output_tokens`（默认 1k，长上下文题单独配）；**并发=1**（串行逐题防限流）；可选题间 sleep | — |
| **失败熔断** | 连续 N 次（默认 3）网络错误/5xx/429 → 暂停该渠道 run（标 `paused_degraded`）；429 走指数退避（宿主 llm-retry 已兜一层，这里兜渠道级熔断）；断点保存进 eval-history，续跑跳过已完成题 | 00§3.3 熔断框架同构复用 |
| **手工触发入口** | **面板按钮为主**（UI slot「运行评测」→ `webServer.register` 路由 → service 执行；不占会话 token、人工语义最纯）；`model_eval_run` Tool 为辅（会话内可发起，**必须配 `tools.guard()/ask` 人工确认**，description 明写「评测消耗真实渠道额度」——防模型自主烧钱） | 01§A（Tool/UI/webServer 注册面）、01§C（guard 语义） |

---

## F. 结论

### 可行性逐点判定

| # | 判定项 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | 插件不经会话发起模型调用 | **可行（两条通道）**：①插件进程内直连渠道 HTTP（01§E 机制沿用）；②**经宿主 llm 服务**——源码证实 LlmRuntime 公开 `stream()/prepareCall()`（dsh-llm L2387/L2225），且宿主对话引擎 agent-loop 本身是插件、以 `static inject=['llm']` + `loopCtx.llm.stream(request)` 消费（dsh-agent-loop L1298-1306/L877/L1005）。catalog 未列 stream 是投影子集，非访问面 | 本文 A-0 |
| 2 | 能测文本/工具调用/长上下文 | **可行**：②通道 messages/tools/maxTokens/reasoningEffort 全覆盖，tool-call 块解析与 `ctx.tools.execute` 循环有宿主先例（agent-loop L957-971）；长上下文可用 `resolveModelInfo().context.contextWindow` 构造贴边样本。**采样参数控制面未证实**（遗留点 1） | 本文 A-② |
| 3 | 评测框架用现成还是自建 | **自建轻量集为主**（四类 10-20 题 + 确定性判分器，零依赖）；promptfoo（MIT、CLI+库双形态）可嵌入但 v1 不嵌（依赖重、Node ≥22.22 待验证），开发期可用其 CLI；evalscope/lm-eval-harness 为 Python 生态不嵌入，其价值由外部榜单替代 | 本文 B |
| 4 | 外部榜单同步（人工触发） | **可行**：Aider（单页 HTML 结构化，实测可抓）、SWE-bench（页面内嵌 JSON，有解析先例）、LiveCodeBench（页面+版本化数据集）、LMArena（无官方 API，社区日更 JSON 镜像+免费 REST 兜底）。最大工程量在**模型名 alias 映射**（人工校准表） | 本文 C |
| 5 | 排名更新流程（评测→建议→人工确认→写回） | **可行**：tier/priority 保持人工语义，评测只产 `suggest`；确认后 `configEditor.edit()` 写回 + `registry_version`+1 + `reviewed_at` 刷新——与 00§3.1 schema 无缝衔接（channel 加一个 `eval` 子对象即可） | 本文 D |
| 6 | 成本护栏与手工触发 | **可行**：预算帽/余额联动/包月优先/串行限流/熔断全部有上游机制支撑（02 余额分级、00§3.3 熔断框架）；入口=面板按钮（主）+ `model_eval_run` 工具配 guard 确认（辅） | 本文 E |

### 推荐方案（一句话）

**评测引擎以「宿主 llm 服务直调」（通道②）为主通道跑自建轻量固定集（四类 10-20 题、确定性判分、加权百分制合成、provisional 门槛），直连 HTTP 只做渠道探针与参数实验、子会话抽检只做 tier 争议仲裁；评测产出 suggested_tier/priority 证据，人工在面板确认后经 configEditor.edit 写回注册表并刷新 reviewed_at，全程串行限流 + 预算帽 + 余额联动 + 熔断，外部榜单（Aider/SWE-bench/Arena 镜像/LiveCodeBench）作为人工同步的只读参考层。**

### 遗留不确定点（诚实声明）

1. **GenerateOptions 采样参数**（temperature/top_p）支持面未逐字验证（读到的请求控制仅 maxTokens/reasoningEffort/signal，L2188-2212）——需要固定采样的题目实现前先做一次字段验证，或该类题走通道①。
2. **llm/stream waterfall 可见性**：评测调用会被全局监听器（token 计量等）看到；给请求打自定义标记的做法有 `markAgentLoopRequest` 同类先例（导出在案），但标记消费面未逐行验证。
3. **宿主 Node 版本**未验证（Electron 内置）——若未来要嵌 promptfoo（要求 ≥22.22）需先确认；v1 自建判分器不受影响。
4. **判分器安全面**：不在宿主进程 eval 模型输出；代码题「跑真单测」留通道③（子会话），node:vm 非安全沙箱。
5. inspect exact-query 在本 build 损坏（01§开篇注），llm 服务 catalog 证据沿用 01§B-3 的无参复现路径 + 本文源码行号。

---

## 出处

**DSH 源码（asar，read 工具逐行核对）**

| # | 位置 | 支撑内容 |
|---|---|---|
| S1 | `node_modules/@deepseek-ai/dsh-llm/lib/index.js` L1756-1817 | LlmRuntime=llm 服务类声明与构造（"adapter registry plus a streaming model-call API" 原注） |
| S2 | 同上 L1842-1908 / L1919-1964 / L1977-2041 | registerAdapter/listProviders/registerConfigurableProviders/listConfigurableProviders/registerModelDiscovery/discoverModels/providerRetryPolicy |
| S3 | 同上 L2086-2212 | listModels/resolveModelInfo/resolveCallConfig（contextWindow/defaultMaxTokens/efforts 校验面） |
| S4 | 同上 L2225-2266 | prepareCall：冻结 handle（config/retryPolicy/adapterDefaults/context/stream 一次一投） |
| S5 | 同上 L2387-2403 | stream() JSDoc 原文与 llm/stream waterfall 派发 |
| S6 | 同上 L1665-1755 | LlmAdapter 契约（registerAdapter 指引、attributionHeaders、prepareCall 默认实现） |
| S7 | 同上 L37-112、L2434 | 消息构造助手与全量导出面（AssistantStreamAccumulator/joinAssistantStreamText/markAgentLoopRequest 等） |
| S8 | 同上 L2406-2419 | finish 块 kind ∈ completed/max-tokens/error/aborted |
| S9 | `node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js` L1298-1306 | AgentLoop extends Service，static inject 含 llm |
| S10 | 同上 L877-884 | `this.loopCtx.llm.stream(request)` + for-await 消费（决定性先例） |
| S11 | 同上 L957-971、L1005-1015 | tool-call 块解析 + ctx.tools.execute 循环；prepareCall 调用点与 NO_ADAPTER 回退 |
| S12 | `node_modules/@deepseek-ai/dsh-agent-loop/package.json` | "The concrete agent loop plugin"——宿主引擎即插件形态 |
| S13 | 上游 00§3.1/§3.3/§5 | 注册表 schema（tier/priority/channel_type/balance/manual/reviewed_at）与熔断框架 |
| S14 | 上游 01§A/§B/§C/§E/§F | 注册面、llm catalog 投影、guard 语义、HTTP/credentials、本机插件清单 |
| S15 | 上游 02§一/§二/§三 | 渠道余额分级、智谱 coding 双额度池（含出处 #26）、订阅端点分离 |

**Web（web_search / web_fetch，检索日 2026-11-13）**

| # | 链接 | 支撑内容 |
|---|---|---|
| W1 | https://www.promptfoo.dev/docs/usage/node-package/ | promptfoo npm 库用法：`promptfoo.evaluate(testSuite, options)`；**Node ≥22.22.0（推荐 24 LTS）** |
| W2 | https://chromium.googlesource.com/external/github.com/promptfoo/promptfoo/+show/f7c7b61f28b04b43883f41d3ea1026928643a6d4/README.md | *"a CLI and library"*；*"now part of OpenAI. Remains open source and MIT licensed"* |
| W3 | https://www.promptfoo.dev/docs/providers/openai/ | openai-compatible provider、response_format json_schema + javascript 断言（`output.category === 'billing'`）示例 |
| W4 | https://github.com/datawhalechina/diy-llm/blob/main/coursework/assignment6-evaluation/README.md | lm-evaluation-harness（EleutherAI）/evalscope（ModelScope）定位与对比（均为 Python 生态） |
| W5 | https://github.com/oolong-tea-2026/arena-ai-leaderboards | Arena AI（原 LMSYS）无官方公开 API；社区日更 JSON 快照 + 免费 REST（api.wuling.dev）；data/ 按日期分目录 |
| W6 | https://raw.githubusercontent.com/oolong-tea-2026/arena-ai-leaderboards/main/README.md | 同上镜像的 REST 用法与数据结构（latest.json 指向最新快照；镜像自述托管 REST 于 api.wulong.dev——第三方域名，同步器实现前须复核可用性） |
| W7 | https://www.modelscope.cn/datasets/AI-ModelScope/code_generation_lite/resolve/master/README.md | LiveCodeBench 榜单 URL（livecodebench.github.io/leaderboard.html）与 release_v1…vN 版本化口径、CC 许可 |
| W8 | https://aider.chat/docs/leaderboards/ | Aider polyglot 榜单：单页 HTML 结构化数据（Pass rate 1/2、总成本、tokens、秒/题）；页脚 "last updated November 20, 2025"；**本次实测 HTTP 200** |
| W9 | https://pkg.go.dev/github.com/anthony-chaudhary/fak@v0.55.0/internal/swebenchsota | swebench.com 页面内嵌 `<script type="application/json" id="leaderboard-data">` 全榜 JSON，regex+HTML-unescape 解析先例（"Verified" 分组） |
| W10 | https://benchgecko.ai/benchmark/aider-polyglot | 第三方聚合视角佐证 aider 榜单量级（54 模型、top 88.0、更新节奏） |

> 引用纪律：W5/W6 为社区镜像（非官方承诺），同步器必须带熔断降级；W9 的解析方式依赖页面结构，改版即需修复——榜单层一律「人工触发 + 失败留痕」，绝不阻塞主流程。
