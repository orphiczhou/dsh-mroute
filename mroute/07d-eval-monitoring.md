# 07d 评测/监测社区插件源码级分析：执行通道、判分与排名数据结构（mroute 增补章）

- 树节点：mroute / mroute-W10-evalsrc
- 分析日期：2026-11-13
- 分析对象：8 个评测/监测类社区插件源码（`vendors/` 本地 checkout，read/grep 逐文件核对）
- 与上游关系：本文是 `04-eval-feasibility.md`（W5）的**源码实证增补**——W5 回答了「应该怎么做」，本文用 8 个真实插件的代码回答「别人实际怎么做、哪些可直接抄」。引用约定：`04§X` = 04 文档 X 节；`插件名@文件:行` = vendors 目录下源码位置
- 面向读者：mroute M5（评测引擎）/M6（榜单同步）的实现者

---

## 〇、一句话总览

**W5 的三条通道全部有社区实跑先例**：通道②（宿主 llm 服务）被 4 个插件独立实证（model-health / connection-test / model-master / swarm-router），且 model-master 补证了 04 遗留点 1 的一半——**prepareCall 第三参 configure 回调可以设置 reasoningEffort**（temperature/top_p 仍未见插件经宿主通道使用）；指纹监测因需要 raw 信封字段**必须走通道①**（big-coming）；headless 子进程评 agent 有两套成熟实现（agent-bench 隔离 DSH_HOME、eval-harness fork dsh CLI）。判分纪律上，两个互不相识的插件（agent-bench、eval-harness）趋同演化出同一条铁律：**确定性结论与 LLM 评审分离存储，评审漂移永不计入回归**——这是比任何单一实现都强的设计信号。

---

## 一、逐插件 A–E 分析

### 1. NEETnina--dsh-model-master（★19，TTFT/TPS 实测 + OpenRouter 榜单浏览）— MIT

| 问 | 结论 | 代码证据 |
|---|---|---|
| **A 调用通道** | **宿主 llm 服务，且是三插件中用得最深的一个**。Strategy 1：`prepareCall({provider, model, maxTokens: 80}, signal, configureCallback)`——第三参是 `configure(controls, modelInfo)` 回调，在读到**模型真实档位表** `modelInfo.reasoning.efforts[]` 后选 `efforts[0].id`（最低档）回填 `reasoningEffort`；随后 `prepared.stream({ ...prepared.config, messages, signal })`。Strategy 2 兜底：`llm.stream({...})` 裸调 | `index.js:795-832`；effort 必须钉死的注释 `index.js:776-793`（"probe that omits the effort silently inherits the session's current tier (often high)"——不传 effort 会静默继承会话当前档位，reasoning preamble 烧 token 抬高 TTFT 压低 TPS，测到的就是宿主选的档而不是模型裸速） |
| **B 用例/评测集** | 无评测集。单一探针题 `"Output exactly this sequence and nothing else, no explanation, no preamble: 1 2 3 … 20"`——固定输出串防 preamble 污染 token 数。判分=性能测量而非对错：TTFT=首个非空 text chunk 的 `performance.now()` 差（下限 10ms）；TPS=`tokenCount/generationSec`，**bursty 防护**（生成窗口 <0.12s 视为整包缓冲一次吐出，回退用全程耗时，防 TPS 虚高数倍）；token 数优先 provider usage（`outputTokens/completionTokens/output_tokens/completion_tokens/totalTokens` 多候选），回退 `words` 或 `len/3.5` 估算 | `index.js:740-957`；bursty 注释 `index.js:911-914` |
| **C 排名数据结构** | ①探针结果即时返回不持久化：`{success, ttft, tps, totalDuration, score, tokens, tokensFromUsage, reasoningEffort(实际生效档位,审计用), sample(前120字符可复核), ttftSpread}`；多采样（1–5 次）取**中位数**（注释实测单次方差 17–22%，"enough to rank two comparable models backwards"），连续 2 次失败早停不烧额度。②OpenRouter 榜单：`leaderboard-cache.json` 落 dataDir，行结构 `{id, name, org, shortId, intelligence, coding, agentic, arenaElo, arenaCategory, context, pricing{prompt,completion}, description, rank}`；排序键 intelligence→coding→arenaElo；截断 100 行 | `index.js:974-1025`（中位数）；`index.js:164-222`（榜单构建）；`index.js:119-143`（缓存） |
| **D 变化监测** | 榜单日更 `surveyDailyLeaderboard`：快照 JSON 与磁盘**逐字节相同则不写盘**；并发调用共享一个 in-flight 请求；最小间隔 60s（手动 force 也有 10s 冷却防连点）。**provenance 字段**：`sourceKind: 'live'\|'offline'\|'pending'`、`source`（人类可读来源句）、`isOnline`、`surveyDate`——"unknown 不是 up to date"纪律贯穿全插件 | `index.js:231-313`；provenance 纪律注释 `index.js:131-132, 319-322` |
| **E 成本控制** | `maxTokens: 80`、20s 超时 AbortController、采样数 clamp 1–5、2 次失败早停、探测文本极短 | `index.js:755, 975-986` |

**对 mroute 的独有价值**：①`prepareCall` configure 回调选 effort 的写法可直接抄（04 遗留点 1 的 effort 半边已被此代码证实可行）；②TTFT/TPS 的全部测量细节（bursty 防护、usage 优先、中位数+spread）是性能参考列的现成实现；③score 公式 `round((tps / sqrt(ttftSec/0.5)) * 10)`（TTFT 敏感度开根阻尼：2x 慢只罚 1.41x）。

### 2. oxlyn--dsh-model-health（★3，批量可用性/延迟测试）— MIT

| 问 | 结论 | 代码证据 |
|---|---|---|
| **A 调用通道** | **双通道并存**：①直连 HTTP——解析 `settings.yaml`/profile patch（兼容新旧两种文件形态）拿 `llm-pi-ai`/`llm-deepseek` section 的 `baseURL`+`apiKeyEnv` → `ctx.credentials.resolve(apiKeyEnv)` 取 Key → Node fetch `POST {baseURL}/chat/completions`；②宿主 llm——`ctx.get('llm')`，`collectRegistryModels` 用 `listProviders()`/`listModels(p.id)`/`resolveModelInfo(p.id, m.id)`（取 contextWindow/defaultMaxTokens/inputModalities）枚举注册表全量模型，`probeViaRuntime` 用 `llm.stream({provider, model, messages:[{role:'user',content:[{type:'text',text:'hi'}]}], maxTokens: 1, signal})`。文件配置里没有的条目（内置模型）由 runtime 兜底探测 | `dist/index.js:261-309`（直连 probe）；`dist/index.js:390-421`（registry 枚举）；`dist/index.js:430-486`（runtime probe） |
| **B 判分** | 三态 `ok/fail/skip`（不支持的协议标 skip 不硬判）+ latency。**200-但-错误对象防护**：`validateSuccessBody` 校验 200 响应体确实是 JSON 且含 `choices` 数组（"部分网关 200 但 body 是错误对象"）；错误体只读前 300 字符 | `dist/index.js:249-259` |
| **C 排名持久化** | 无。结果即时 JSON 返回面板；模型清单有 `/api/model-health/json` 只读端点 | `dist/index.js:544-564` |
| **D 变化监测** | 无 baseline（逐次人工点击触发） | — |
| **E 成本控制** | `max_tokens: 1`、直连超时 10s / runtime 30s、错误体读 1KB 封顶、成功体读 4KB 封顶（`readBodySnippet` 流式截断不整体载入）；apiKey 永不出进程（`toPublicRow` 剥离 apiKeyEnv） | `dist/index.js:225-247` |

### 3. Willmylife--dsh-model-connection-test（★1，经宿主 LLM 服务最小对话探针）— MIT

| 问 | 结论 | 代码证据 |
|---|---|---|
| **A 调用通道** | **宿主 llm 服务（任务书点名的重点）**：`ctx.inject(['webServer', 'llm'])`，挂 webServer 路由，handler 内 `llm.stream({provider, model, messages:[{role:'user', content:[{type:'text', text: prompt}]}], signal, maxTokens})`，`for await` 消费。**浏览器零凭据**：请求体只带 provider/model 名，"The browser never sees, holds, or sends any credential"——凭据解析全在 Host 进程内由 llm 服务完成。这是 mroute 通道②最干净的完备旁证 | `index.js:1-31`（头注）；`index.js:185-263`（probeAttempt） |
| **B 判分** | **verdict 判决对象**（不是分数）：`{ok, code, message, finishReason, totalMs, firstMs, timedOut, attempts, transient}`。成功=finish 块 `reason.kind ∈ {stop, max-tokens, tool-calls}`；失败码分类学：`RETRY_CODES = {RATE_LIMIT, SERVER, TRANSPORT, EMPTY_RESPONSE, PROBE_ERROR, NO_TERMINAL_CHUNK, LLM_ERROR}`（与 agent-loop 同款重试集）、`RETRY_ONCE = {TIMEOUT}`、`TRANSIENT_CODES`（UI 据此说 "unstable" 而非 "broken"）。`firstMs`=首个 `text-delta/reasoning-delta/tool-call-delta` chunk 时间（即 TTFT）。**流词汇表刻意保持不透明**："only the terminal `type:'finish'` chunk and its `reason.kind`/`reason.failure` shape are read, so chunk-kind changes upstream cannot break the probe" | `index.js:44-61`（码集）；`index.js:204-251`（流消费） |
| **C 排名持久化** | 无（verdict 即时返回） | — |
| **D 变化监测** | 无 | — |
| **E 成本控制** | `maxTokens ≤256` 默认 16、`prompt ≤200` 字符、timeout 1–120s 默认 60s、retries ≤4 带 jittered backoff `[400,900,1500,2200]+rand(200)`ms；路由围栏 same-origin fence（Host 必须回环/声明域名 + `sec-fetch-site` 拒跨站 + Origin 相等校验 + 宿主 `connection.requestRejection` 门）+ 4KB body 上限 | `index.js:36-61, 72-121, 265-296` |

**注意一处词表分歧**：本插件把 `stop`/`tool-calls` 也算成功 finish kind，而 04§A-② 记录的宿主词表是 `completed|max-tokens|error|aborted`，swarm-router 则按 `completed/aborted/error/max-tokens/refusal` 分支。三个插件三种词表 → **mroute 判分器必须对 finish kind 做宽表兼容**（`completed|stop` 都算成功，未知 kind 落入显式失败并附原文）。

### 4. songrui111--dsh-agent-bench（★1，固定 Agent 用例 + 确定性断言 + 两次运行对比）— MIT

| 问 | 结论 | 代码证据 |
|---|---|---|
| **A 调用通道** | **子进程 headless CLI（通道③变体）**：为每次 run 准备**隔离 DSH_HOME**（`.agent-bench/home`），凭据从真实 home **只读复制** `.credentials.yaml`（绝不回写）；账号登录（无 API Key）时自动生成 overlay YAML（禁 `llm-deepseek`、挂 deepseek-account provider）；profile 用宿主自带 `headless` 模板。`spawn(dsh, [...cliArgs, task])`——task 是 CLI 位置参数。可选 LLM 评审器走 **ctx.llm 流式**（"The host only offers a streaming call"，分块拼接后解析 `{score, reason}`），评审器模型名记录进 scorecard 以便 like-for-like 对比 | `lib/host.js:96-190`（隔离 home）；`lib/index.js:268-356`（reviewer）；`lib/index.js:102`（spawn） |
| **B 用例组织** | 目录约定 `benchmarks/<suite>/suite.json + <case>/case.json (+fixture/ +expect/)`。case schema：`{id(正则约束), title, task, allowedPaths[], assertions[], llmReview?:{criteria, minScore(0-1, 默认0.7)}}`；`fixture/` 整目录复制进沙箱（"Same fixture bytes mean the same starting state"）、`expect/` 是 file-equals-expect 的期望文件。**断言 7 种全确定性**：`file-exists / file-absent / file-contains / file-matches(RegExp) / file-not-contains / file-equals-expect(EOL 归一后全等) / command(sandbox 内 exec, expectExitCode)`。沙箱逃逸防护 `resolveInside`（拒绝对路径与 `..` 逃逸）；**串行执行是刻意的**："running them concurrently would make durations and costs incomparable between runs" | `lib/cases.js:36-136`；`lib/assertions.js:14-26`（逃逸防护）；`lib/runner.js:132-138`（串行注释） |
| **C 排名数据结构** | scorecard：`{schema:'dsh-agent-bench/scorecard', version:1, runId, suiteId, environment, summary:{total, passed, failed, passRate, llmReviewed, llmApproved}, cases:[{id, passed, assertions[], agent{ok, usage}, llm{score, approved, minScore, reason, reviewerModel}, artifacts[], durationMs}]}`。持久化 `<root>/runs/<runId>/<suiteId>.json` + 同名 `.md`（人读）+ `index.json` 追加式索引（按 finishedAt 排序、同 runId+suiteId 幂等覆盖） | `lib/scorecard.js:13-36, 144-175` |
| **D 变化监测（两次运行对比）** | `compareScorecards(baseline, candidate)` 逐 case id 对齐：**regression = 之前 passed 现在 failed**（附失败断言明细）、fixed、unchanged（确定性结论没变但 LLM 评审翻转 → 只记 note 不算回归）、onlyInBaseline/onlyInCandidate（用例集增删显式列出）。verdict 三值 `regressed/improved/stable` **只由确定性断言驱动**；LLM 评审变化永远只作漂移列出。bench_compare 工具默认 baseline=次新 run | `lib/scorecard.js:196-258`；头注 `lib/scorecard.js:1-4` |
| **E 成本控制** | caseTimeoutMs、断言 command 60s 超时、`maxArtifactBytes` 截断读、spawn maxBuffer 1MB。无预算帽（每次 bench 是人工触发的单 suite 量级） | `lib/assertions.js:118-127`；`lib/runner.js:42` |

### 5. BiBoyang--dsh-eval-harness（★14，YAML 用例驱动真实 headless agent + baseline 门禁）— package.json 声明 MIT（checkout 无 LICENSE 文件，来源 GitHub，见根目录 `_upstream.txt`）

| 问 | 结论 | 代码证据 |
|---|---|---|
| **A 调用通道** | **fork `dsh --profile <profile> --patch <overlay> <prompt>` headless 子进程**（prompt 是 CLI 位置参数放最后）；**观测不走模型调用**——collector 从子进程 `session.jsonl` trace 提取 `toolCalls(含 argsJson)/toolResults(含结果文本)/finalText/steps/tokens(分字段)/toolErrors/turnEnd`，断言引擎**离线零模型调用**执行。mock 模式：per-case 起 ephemeral mock provider + 隔离 DSH_HOME 指向它（故障注入 F0–F5、协议三选、`plugins` 钉版本安装被测插件）。LLM judge **直连 OpenAI 兼容 HTTP 不经宿主**——注释明说："不接 @deepseek-ai/dsh-llm——那是 cordis Service 体系……judge 只是一次性短调用，为此拉起整套运行时不值得"；`temperature: 0, max_tokens: 200`，CoT 前置+**末行必须恰为 PASS/FAIL** 的解析协议 | `src/runner.ts:312-317, 818-932`；`src/judge.ts:1-63`（设计注释与协议） |
| **B 用例 schema 与判分器（任务书重点）** | YAML 单文件一用例：`{name, prompt, require_plugins[], tags[], retries, trials, mock?:{fault, api, once, plugins[]}, sentinel?, assert}`。**assert 键集（12 键）**：`turn_end / exit_code / tools_called(保序子序列) / tools_exact / tools_not_called / output_contains / output_not_contains / output_matches(正则,解析期校验) / tool_args_contains[{name,contains}] / tool_result_contains[{name,contains}] / max_steps / max_tokens(input+output+reasoning, cacheRead/Write 不计) / no_tool_errors / output_judge{rubric}`。**两条独有纪律**：①结果型断言防复读——`tool_result_contains` 要求工具真实结果含哨兵串（`01-bash-tool.yml` 双保险：args 与 result 都须含 `BASHOK-7f3a`，"复述 prompt 过不了"，parrot 探针实测 0/12 全灭）；②哨兵校准——内置 `_sentinels/`（S1 必过 / S2 必不过）验证仪表本身健康，哨兵破判 gate 直接 FAIL，`sentinels:false` 只给程序调用且报告记 skipped 仍 FAIL（不存在"跳过但放行"）。可靠性：`trials>1` 产出 `successRate / passAtK(1-C(n-c,k)/C(n,k)) / passPowK`，gate 可按 **Wilson 单侧 95% 下界**判 unreliable。judge 校准：JSONL 人工标注集上算混淆矩阵，TPR/TNR ≥0.9 才 calibrated | `src/types.ts:5-105`（schema）；`src/assert.ts:23-136`（引擎）；`cases/real/01-bash-tool.yml`；`src/judge.ts:113-207`（校准） |
| **C 排名数据结构** | `report.json`：`{schemaVersion:1, cases:[CaseResult(含 attemptResults[] 完整历史/flaky 标记/reliability)], summary{total,passed,failed,errored}, calibration{sentinels, healthy, weakCases}}`。gate 报告 `GateReport`：`verdict PASS/WARN/FAIL/N/A + exitCode(0/1/2)`、`regressions/improvements/newFailures/added/removed/`**`removed 非空即 FAIL（缺席用例=E7 缺席即 FAIL）`**`/tokenRegressions(状态不变但 token 涨幅超阈值)/skippedLineIncreases(trace 漏帧增多)/flakyCases/baselineFlakyCases/toolErrorRecoveries/repeatedErrorSignatures(错误签名@栈顶帧聚合≥2次=共享态事故信号)/dshVersionChange(informational 标注不可直接比)/sentinels(breach→FAIL)/unreliableCases` | `src/types.ts:162-424` |
| **D 变化监测（baseline 门禁）** | baseline=`baseline/report.json`，由 `update-baseline.yml` workflow（Owner 触发、真实 API、~122k token）刷新，**不许手改**（AGENTS.md 纪律 1）；CI `eval.yml` 对新 baseline 全量回放（baseline-replay 防线）。门禁判定全部只看确定性断言；`dshVersionChange` 只标注不判定 | `src/gate.ts` + `src/types.ts:338-424`；AGENTS.md 纪律节 |
| **E 成本控制** | 结构性判分零模型调用（judge 除外）；per-case timeout + `retries`（attempts=retries+1）；E8 主仓库无 key 即红（CI 不静默跳过）；baseline 刷新烧钱需 Owner 明示（AGENTS.md："烧钱先问 Owner"） | AGENTS.md；`src/types.ts:93-95` |

### 6. Sumcam-L--dsh-big-coming（★0，模型指纹漂移监测）— MIT

| 问 | 结论 | 代码证据 |
|---|---|---|
| **A 调用通道** | **直连渠道 HTTP，刻意不用宿主 llm**——指纹监测要拿 raw 信封字段（`system_fingerprint`、envelope shape、`usage.prompt_tokens`），宿主中立词汇表流不透出这些字段。`GET {baseURL}/models`（便宜）+ 每个关注模型一个 `POST /chat/completions` `max_tokens:1, stream:false, thinking:{type:'disabled'}`（实测关思考把 deepseek-v4-pro 的 prompt 从 84 token 降到 5 且**不影响任何被比对字段**） | `lib/probe.js:1-9`（头注）；`lib/probe.js:177-243` |
| **B 指纹比对项清单（任务书重点，可直接作 reviewed_against 锚点）** | `diffCycle(baseline, cycle)` 纯函数产 6 类变化行：①`model-added`——catalog 模型集合新增；②`catalog`——每模型 8 元数据字段（`name/owned_by/context_window/max_output_tokens/input_modalities/output_modalities/effort/api_capabilities`）逐一比对；③`fingerprint`——`system_fingerprint`；④`served-model`——响应 `payload.model` 字段；⑤`tokenizer`——**固定 PROBE_TEXT 的 `prompt_tokens` 作分词器侧信道指纹**（"stable across calls, changes when vocabulary/merge table/chat template overhead changes"）；⑥`shape`——信封结构 `top/choice/message/usage` 四层 keys 排序后比对 + FNV-1a hash。**防误报三件**：`SHAPE_IGNORED` 忽略条件性字段（`completion_tokens_details/prompt_tokens_details/reasoning_content`——开关思考不该报"结构变了"）；tokenizer 比对要求**双方 probeText 相同**（旧基线没这字段时升级本身不触发）；shape sanitize 双侧应用 | `lib/probe.js:14-83`（字段表与忽略表）；`lib/probe.js:260-348`（diffCycle） |
| **C 持久化** | `~/.dsh/dsh-big-coming/state.json` v1：`{settings, baseline(上次快照), history(≤60 条事件, id=ts36+JSON hash), stats{checks/changes/failures/lastCheckAt/lastHeadline}}`；tmp+rename 原子写、**串行 flush 队列**（`#queue = #queue.then(...)`） | `lib/store.js:15-181` |
| **D 变化监测** | baseline=上一 cycle 快照；headline 分级：分词器变了 > 系统指纹变了 > 响应结构变了 > 新模型登场 > 模型参数变了 > 官方动了点东西（按可信度排序的告警升级） | `lib/probe.js:351-359` |
| **E 成本控制** | `max_tokens:1`+thinking disabled（84→5 tokens）、每周期 ≤4 个模型（`MAX_MODELS_PER_CYCLE`）、间隔 1min–10080min 可调默认 60min、超时 20s(catalog)/40s(probe) | `lib/probe.js:12`；`lib/store.js:21-22` |

### 7. r600a-code--dsh-swarm-router（★3，异质任务路由 + 真实反馈驱动排名）— MIT

| 问 | 结论 | 代码证据 |
|---|---|---|
| **A 调用通道** | 双模式：`direct` = `ctx.llm.stream({provider, model, messages:[createUserMessage({content:[{type:'text',text}]}), maxTokens, signal})` 一次性调用（"exact token capture"）；`subagent` = `ctx.subagents.start(provider, {label, prompt, parent, agentOptions:{provider, model, maxTokens}, toolFilter:{allow:[]}, signal})`（toolFilter 清空禁工具）。**usage 采集的关键研究结论（注释原文）**："global + forwarding is the only mechanism that catches child calls; sessionId correlation is REQUIRED because Promise.all runs many children concurrently and a bare global listener would cross-contaminate usage across siblings"——`ctx.on('llm/stream', …, {global:true})` 包一层 async generator，只在 `options.sessionId === childSessionId`（=run.id）时收 usage chunk，**必须逐 chunk forward**（保 agent-loop usage 持久化与下游监听器） | `index.js:339-359`（direct）；`index.js:362-415`（subagent+监听器） |
| **B 用例/评测集** | **无评测集**——"真实反馈驱动排名"：`swarm_feedback` 工具由调用方（模型/会话）在任务后自报 `{provider, model, kind, correct(bool), quality(1-5), note}`。静态侧是 `models/registry.json` 手工注册表（PR 流程 + `validate-registry.mjs` CI 校验），能力标签 `{reasoning, coding, longContext, fast, strength/speed/cost(1-10), contextWindow, maxTokens, unstable?}` | `index.js:168-190`（feedback 工具）；`models/registry.json` |
| **C 排名数据结构与持久化** | **score = successRate×0.6 + (avgQuality/5)×0.4**；排序 tie-break `score→count→model 字典序`（全序稳定）。**路由回流**：`rankingBoost` 三档——`rate≥0.9 && count≥3 → +1.5`（proven）、`rate≤0.4 && count≥3 → −3.0`（failing in practice）、否则 0（"not enough signal to override the static catalog"）——加到静态评分上。持久化两文件（tmp+rename，读失败回空对象不影响启动）：`rankings.json {byModel:{"provider/id":{kind:{count,successes,qualitySum}, name}}}`、`usage.json {totals, byProvider, byModel, byKind, records(≤2000 滚动)}`。成本估算：pricing 表 USD/1M tokens（Config 可调）+ flagship 基线对比 `savingsPct`（成就感层） | `ranking.js:14-54`；`store.js:47-174` |
| **D 变化监测** | 无 baseline/指纹（在线学习型，靠 count≥3 门槛防单次噪声改排） | — |
| **E 成本控制** | `maxTokens` clamp 64–65536 默认 1024、childPromptSuffix 明示"只输出任务要求的、别调工具"。无预算帽 | `index.js:33-47, 337` |

**注意一处宿主 API 漂移**：本插件用 `ctx.subagents.start(provider, spec)`，而 04§A-③ 引的是 `subagents.startActivation(spec)`——两个插件代次不同或 API 别名，**mroute 实现时以宿主当前 d.ts/实源为准**，不要照抄任一插件。

### 8. xiean676--dsh-freemodels-opencode（★0，逐模型真实请求七档结论 + 人工 S/A/B/C 评级进选择器）— MIT

| 问 | 结论 | 代码证据 |
|---|---|---|
| **A 调用通道** | **直连免费车道网关 HTTP（匿名，无 Key）**：`POST {baseUrl}/chat/completions`，读首个 SSE 帧即回（不等完整流），HTTP status + `retry-after` 头 + body 文本联合定结论。探针体刻意不是 ping：`max_tokens=96`（"数 1..30"，从 512 砍下来——"A ping that asks for a handful of tokens proves almost nothing"）。TTFT **实测而非宣称不可测**（"a slow model needed 29.8s before its first token — is measured instead of being declared unmeasurable"） | `src/probe.ts:1-108, 253-296` |
| **B 判分** | **verdict 八档**（`classify(status, raw)` 规则表）：`available / rate_limited / exhausted(免费车道拒绝此客户端) / region(区域限制) / unavailable(含 404/model_not_found) / paid(401/403 匿名被拒) / upstream_error(5xx 临时故障,**刻意排在特定 body 检查之后**——"A temporary server-side failure is not a verdict about the model") / unknown(400/422 及兜底)`。设计哲学注释："A verdict is one observation at one moment. Rate limits expire"——结论带时刻属性不冒充常量 | `src/probe.ts:161-226` |
| **C 人工评级数据结构与呈现（任务书重点）** | `rank.ts` 人工评级：`MANUAL_RANKS: Map<id, {score: 0-100, reason}>`（**reason 必填**——"the reason is what makes the entry reviewable later instead of looking like magic"）；档位 `GRADE_BANDS S≥90/A≥80/B≥70/C`；**grade 从 score 派生、从不与 score 并存存储**（"a retuned number can never disagree with its own letter"）。**heuristic 回退封顶 `HEURISTIC_CEILING=63` < 最低人工评级 64**（刻意只留 1 分缝隙：明天新上线的模型按关键词估分也只能垫底，"cannot displace a rating someone wrote on purpose"）；档位词按**整 token 匹配非子串**（minimax 含 "max" 的教训——子串匹配会给新模型 +4 抵消 flash 的 −8）。`source: 'table'|'heuristic'` 显式区分人工/估计，UI badge 悬浮显示 `note`（人工评级（不是跑分）·理由）。排序 `compareByCapability` 全序：score→contextWindow→effort 档数→id（"two models that score equally never swap places between renders"）。持久化 `state.json`：`{version:1, catalogVersion, selected[], models[{…, rank{score,grade,source,note}}], lastRefresh, lastError}`；**catalogVersion 形状版本**驱动升级后一次性刷新；`limitsKnown` 诚实位（fallback 尺寸不得冒充真实值——"the honest reading is unknown"）。写入 tmp+rename+串行队列；**onChange 回调 → bridge 免重启替换 adapter 路由**，评级后的模型按能力序进入宿主模型选择器 | `src/rank.ts:1-276`；`src/store.ts:11-328` |
| **D 变化监测** | catalog 形状漂移（catalogVersion+1 强制刷新）+ `deprecated`/`freeLane` 过滤（旧版本存的付费 id 加载时剪掉并回写）；上游 id 撤下的人工评级条目**保留不删**（"if the gateway puts them back they belong in their old place"） | `src/store.ts:30-37, 134-165`；`src/rank.ts:60-66` |
| **E 成本控制** | probe `max_tokens=96`、timeout 可配、免费车道零凭据（无烧钱面） | `src/probe.ts:91-108` |

---

## 二、汇总：mroute 评测排名模块设计建议

### 2.1 评测执行通道选型（对照 04§A，本轮源码证据）

| 通道 | W5 判定 | 8 插件源码证据 | 对 mroute M5 的结论 |
|---|---|---|---|
| **②宿主 llm 服务** | 主通道 | **4 个插件独立实证**：model-health `probeViaRuntime`（`dist/index.js:430-486`）、connection-test 全插件（浏览器零凭据架构）、model-master `prepareCall+configure 回调`（`index.js:795-817`）、swarm-router direct 模式（`index.js:339-359`）。**effort 控制面已被 model-master 补证**：`prepareCall(config, signal, (controls, modelInfo) => ({...controls, reasoningEffort: modelInfo.reasoning.efforts[0].id}))` 可行且必要；temperature/top_p 经宿主通道**仍无插件使用先例**（eval-harness 的 judge 用 temperature:0 走的是直连） | **维持 W5 主通道结论**；实现 `model_eval_run` 时照抄 model-master 的 prepareCall 写法，且**每题显式钉 effort**（从 `resolveModelInfo().reasoning.efforts` 选——能力评测用高档、性能探针用最低档，记录 `appliedEffort` 供审计）。04 遗留点 1 收窄为：仅 temperature/top_p 未证实 |
| **①直连 HTTP** | 探针+参数实验 | model-health 直连半边（读 settings 拿 baseURL/credentials.resolve）；big-coming **证明指纹监测必须走①**（宿主流不透出 system_fingerprint/信封 shape/prompt_tokens）；freemodels 全直连（免费车道无凭据场景） | 维持；**新增职责**：reviewed_against 自动锚点的指纹快照必须走①（§2.5） |
| **③子会话/headless** | tier 抽检仲裁 | 两套成熟实现可选：agent-bench（隔离 DSH_HOME + spawnSync CLI + 凭据只读复制 + overlay YAML 换 provider）与 eval-harness（fork dsh CLI + session.jsonl collector + 离线断言）。**抽检仲裁时照抄 agent-bench 的隔离 home 做法**（不污染真实配置、凭据不回写） | 维持「不做常规批量」；若做争议仲裁，agent-bench 的 `prepareBenchHome` 是现成蓝本 |

### 2.2 用例集 schema 推荐：**吸收 eval-harness 的 assert 键集，不整体复用其 YAML 形状**

**判断**：eval-harness 的 YAML 形状（`name/prompt/assert`）**不能直接整体复用**——它是「headless agent + session.jsonl trace」口径，其 `tools_called/tool_result_contains/max_steps` 等断言依赖 collector 从子会话 trace 提取事件；mroute v1 走通道②直调 `llm.stream`，拿得到的是**流级**观测（text-delta 拼接文本、tool-call 块、usage chunk、finish kind），没有 session.jsonl 的 step/turn 事件流。但它的 **assert 键集语义**几乎一一映射到通道②可观测量，建议按 04§B 的 JSON suite 骨架吸收如下映射：

| eval-harness assert 键 | mroute 通道②对应观测 | v1 取舍 |
|---|---|---|
| `output_contains / output_not_contains` | finalText（text-delta 拼接） | ✅ 直接采用 |
| `output_matches` | finalText + RegExp（解析期校验合法性，照抄 `runner.ts:76-81` 的前置校验） | ✅ 直接采用 |
| `tool_args_contains{name, contains}` | tool-call 块的 arguments 序列化串（DSH 中立词汇表 tool-call chunk） | ✅ 采用（连接04§B 的 `tool_args_schema`） |
| `tool_result_contains` | **通道②没有 tool result**（stream 只出调用不出执行）——需评测引擎自己 `ctx.tools.execute`（agent-loop L957-971 先例）或降级为 args 断言 | ⚠️ v2 再做；v1 用 `tool_args_schema` 顶替 |
| `turn_end / exit_code / max_steps` | 通道②对应 finish kind / 不适用 / 步数（多轮才有） | turn_end→`finish_kind` 断言；其余 v2 |
| `max_tokens` | usage chunk（input+output+reasoning 口径，cache 不计——照抄其口径注释） | ✅ 采用 |
| `no_tool_errors` | v1 无工具执行则不适用 | v2 |
| `output_judge{rubric}` | finalText → judge（直连 HTTP，照抄其 PASS/FAIL 协议） | ✅ v2 引入 LLM judge 时整套照抄（协议+校准+证据留痕） |

**schema 修订建议**（在 04§B JSON 示例之上）：

```jsonc
{
  "suite": "mroute-eval-lite", "suite_version": "1.0.0",
  "defaults": { "max_output_tokens": 1000, "reasoning_effort": "pick_lowest" },
  "questions": [
    {
      "id": "tool-001", "category": "tool_call",
      "prompt": "调用 query_weather 工具查询杭州明天的天气。只发起工具调用。",
      "tools": [ /* 04§B 原样 */ ],
      "grader": { "type": "tool_args_schema", "schema": {/*04§B*/} },
      "assert": { "finish_kind": ["completed", "stop"], "max_tokens": 1500 }  // 新增：宽表 finish kind + token 帽
    }
  ]
}
```

要点：①每题带 `assert.max_tokens` 作护栏兼判分（超限=失败，同 eval-harness 双语义）；②`finish_kind` 宽表兼容三个插件呈现的词表分歧（§一.3 注意项）；③`sentinel` 思想吸收：固定集内放 1 条「必过题」（如 JSON 输出自己名字）+1 条「必不过题」（如要求输出违反物理的事实），run 级校验仪表健康，破判则整轮标 `instrument_unhealthy` 不进排名。

### 2.3 判分器实现要点（8 插件趋同模式提炼）

1. **确定性与评审分离，评审漂移永不计入回归**——agent-bench（`scorecard.js:1-4` 头注）与 eval-harness（judge 证据独立字段、gate 只看确定性断言）两个互不相识的插件给出同一设计。mroute 的 `suggested_tier` 证据链里 judge 分数永远单独字段，且回归判定只用结构断言。
2. **judge 要校准 + 留痕**：抄 eval-harness 三件套——末行 PASS/FAIL 解析协议（CoT 前置）、`attempt.judge {pass, reason, model, baseUrl}` 证据、JSONL 标注集 TPR/TNR≥0.9 校准（`judge.ts:113-207`）。judge infra 错误记 error 不记断言失败。
3. **结果型断言防复读**：涉及工具的题必须有「工具真实结果才可能含」的哨兵串（eval-harness BASHOK-7f3a 双保险 + model-master 固定输出串）；期望串绝不写进 prompt。
4. **TTFT/TPS 若做性能参考列，整套照抄 model-master**：effort 钉死、bursty 防护（<0.12s 回退全程）、usage 优先估算兜底、3–5 采样取中位数 + `ttftSpread`（单次方差 17–22%，成对比较必须中位数）。
5. **200-但-错误对象校验**：任何 200 判成功前验 body 形状（model-health `validateSuccessBody`）。
6. **错误码分类学进 health 联动**：connection-test 的 `{RETRY_CODES, RETRY_ONCE, TRANSIENT}` 三集 + `transient` 语义直接复用为 mroute 渠道熔断器的失败分类（transient→degraded+可恢复提示，config 类→硬失败）。
7. **不在宿主进程 eval 模型输出**（04§B 已有；8 插件无一例外只用 RegExp/子串/schema 校验——再证）。
8. **provisional 的统计学升级**：04 用 `n_samples<8` 门槛；可升级为 eval-harness 的 Wilson 单侧 95% 下界（`passAtK` 配套），小样本时下界过不了阈值即 provisional。

### 2.4 suggested_tier 写回衔接（对齐 00§3.1 / 04§D-3，零 schema 破坏）

`channel.eval` 子对象字段建议在 04§D-3 基础上追加 4 个（全部来自本轮源码证据）：

```jsonc
"eval": {
  // …04§D-3 原字段不动…
  "applied_effort": "low",                    // model-master: 实际生效 reasoningEffort，审计「评的是哪个档」
  "instrument_healthy": true,                 // eval-harness: 哨兵破判时 false，整轮不进排名理由
  "probe": { "ttft_ms": 412, "tps": 68, "samples": 3, "ttft_spread": 95 },  // model-master: 性能参考列（不进 composite）
  "fingerprint": { "system_fingerprint": "…", "prompt_tokens": 5, "shape_hash": "a1b2c3d4", "checked_at": "2026-11-13" }
                                              // big-coming: 见 §2.5，写回时同步刷新
}
```

- `reviewed_against` 写法升级：`"eval-suite@1.0.0 + arena@2026-11-13 + fingerprint@a1b2c3d4"`——三个保鲜锚点一次挂全（04§D-3 衔接点②的落地）。
- `fingerprint` 变化时（big-coming ⑥类任一命中）：面板高亮「后端已变，建议重评」——这是 00§5 风险 4（能力分层过时）的**自动触发器**，把人工复核从「90 天超期提示」升级为「事件驱动」。

### 2.5 榜单/指纹监测可借鉴项

| 可借鉴项 | 来源 | 移植要点 |
|---|---|---|
| **OpenRouter `/api/v1/models` 作为榜单第一源** | model-master | 比 04§C 表中 4 个源都容易：机读 JSON、免鉴权、单请求含 Artificial Analysis 三指数 + Design Arena Elo + 定价 + 上下文。变体后缀过滤正则 `:(batch|free|extended|online|nitro|thinking)$`、100 行截断、intelligence→coding→arenaElo 排序键——全部可抄。**建议 M6 榜单清单把 OpenRouter 列为第 0 源**，Aider/SWE-bench 顺延 |
| **榜单快照工程模式** | model-master | `leaderboard-cache.json` + provenance 字段（`sourceKind/isOnline/surveyDate/source`）+ 快照不变不写盘 + in-flight 去重 + 最小间隔（60s/force 10s）。直接对齐 04§C 的「熔断降级 + 失败留痕」要求 |
| **指纹比对 6 类清单** | big-coming | `diffCycle` 是纯函数、零依赖（FNV-1a hash 30 行）、MIT——**可直接整文件移植**。mroute 用法：`model_eval_run` 结束时对被评模型跑一次直连快照（GET /models + max_tokens=1），diff 上次 `channel.eval.fingerprint`，变化行写进 EvalReport 证据链。**catalog 8 字段（context_window/max_output_tokens/effort 等）与注册表 `capability` 字段同源**，catalog 变了 = capability 该复核了 |
| **verdict 八档分类** | freemodels | `classify(status, raw)` 的规则表（含 body 关键词判 exhausted/region、5xx 刻意后置）可抄为 mroute 渠道探针的结论集；「verdict 是时刻观察」哲学写进 health.state 的展示文案 |

### 2.6 反馈驱动排名（swarm-router 模式）要不要做？

**v1 不做，v2 可选**。理由：①swarm-router 的反馈源是「任务后自报 correct/quality」，无人校验的申报数据有好人偏差（模型给自己报 quality 的通道不可靠）；②其 boost 阈值（count≥3 + rate≥0.9/0.4 两档）设计上是「小数据保守」，mroute 评测集本就是主动触发、无需在线学习；③可吸收的一点是**反馈挂 task kind 维度**（`byModel[provider/id][kind]`）——mroute 的 per-category 分数天然同构，04§D-2 的四类分数即「kind 维度排名」。swarm-router 真正值得抄的是 `ranking.js` 三个纯函数（共 63 行）与 `usage.json` 记账形状（records 滚动 2000 条 + byProvider/byModel/byKind 三桶）。

---

## 三、复用分级表

| 分级 | 插件 @ 部件 | 复用方式 | License 状态 |
|---|---|---|---|
| **直接复用**（代码可移植，注明来源） | big-coming `lib/probe.js`（指纹探针 + diffCycle + FNV-1a hash） | 整文件移植，改 baseURL/凭据来源（走 ctx.credentials） | MIT LICENSE 在库 |
| **直接复用** | model-master `runProbeOnce`（TTFT/TPS 测量 + prepareCall configure 回调 + 中位数降噪） | 函数级移植进 mroute 评测引擎探针模块 | MIT LICENSE 在库 |
| **直接复用** | connection-test `probeAttempt/probeModel`（verdict、错误码三集、jittered backoff）+ same-origin fence | 函数级移植进渠道探针与 webServer 路由围栏 | MIT LICENSE 在库 |
| **直接复用** | model-health `collectRegistryModels/probeViaRuntime/validateSuccessBody` | 函数级移植（模型枚举 + runtime 探针 + 200 体校验） | MIT LICENSE 在库 |
| **直接复用** | swarm-router `ranking.js` 全部 3 函数 + `store.js` usage 记账形状 | 若做 v2 反馈排名/用量统计，函数级移植 | MIT LICENSE 在库 |
| **改造借鉴**（形状/纪律借鉴，实现按通道②重写） | eval-harness `EvalAssert` 12 键集 + 哨兵 must-pass/must-fail + gate 字段集 + judge PASS/FAIL 协议与 TPR/TNR 校准 + 结果型断言纪律 | 断言键映射（§2.2 表）与纪律条款进 mroute suite schema 与判分器 | package.json 声明 MIT，**checkout 无 LICENSE 文件**——抄代码前从 GitHub 仓库补取 LICENSE 附引用，或仅借鉴形状不抄实现 |
| **改造借鉴** | agent-bench `compareScorecards`（回归判定算法）+ scorecard/index.json 持久化形状 + 隔离 DSH_HOME（host.js） | 对比算法移植到 mroute `eval-history` 两次 run 对比（换模型退化的呈现可直接复用其三值 verdict + LLM drift note）；抽检仲裁用其 home 隔离蓝本 | MIT LICENSE 在库 |
| **改造借鉴** | freemodels `rank.ts`（人工评级结构：grade 派生不存储、heuristic 封顶低于最低人工评级、整 token 档位词、全序排序） | mroute 人工面板确认 tier 的数据结构可借鉴此四纪律（suggested_tier 与人工 tier 不一致时显式 `source` 区分） | MIT LICENSE 在库 |
| **仅参考**（思想参考，不搬代码） | eval-harness runner/collector/mock 体系 | 那是 headless-agent 口径（session.jsonl trace）；mroute v1 通道②不需要；v2 若做通道③抽检再回来抄 collector | 同上 |
| **仅参考** | swarm-router `router.js` 静态评分与 `models/registry.json` 能力标签形状 | 「能力标签 + require 门 + effort-matched 权重」思想可参考，但 mroute 排序因子是财务维度（channel_type），混用会口径污染 | MIT LICENSE 在库 |

---

## 四、对上游文档的修正与补证

| # | 上游表述 | 本轮源码证据 | 处理建议 |
|---|---|---|---|
| 1 | 04§F 遗留点 1：「GenerateOptions 采样参数控制面未证实（读到的仅 maxTokens/reasoningEffort）」 | model-master `index.js:801-808`：**prepareCall 第三参 configure 回调内设置 `reasoningEffort` 可行且已有实跑**（从 `modelInfo.reasoning.efforts` 真实档位表选择）；temperature/top_p 仍无宿主通道先例 | 遗留点收窄：effort 面已证实（且必须显式钉死，否则继承会话档位污染测量）；temperature 类题维持走① |
| 2 | 04§A-②：finish reason.kind 词表 `completed|max-tokens|error|aborted` | connection-test 兼容 `stop|max-tokens|tool-calls`（`index.js:214`）；swarm-router 按 `completed/aborted/error/max-tokens/refusal` 分支（`index.js:51-60`）；eval-harness 断言 `turn_end: completed` | **词表存在代次漂移**——mroute 判分器对 finish kind 做宽表兼容（`completed|stop` 均算成功），未知 kind 显式失败附原文，不许静默放行 |
| 3 | 04§A-③ 引 `subagents.startActivation(spec)` | swarm-router 用 `ctx.subagents.start(provider, spec)`（`index.js:383-390`），spec 形状 `agentOptions/toolFilter/signal` | 实现③通道仲裁时以宿主当前 API 为准核对，不照抄任一插件 |
| 4 | 04§C 榜单清单未含 OpenRouter 目录 | model-master 实证 `/api/v1/models` 免鉴权机读含三指数+Elo+定价 | 建议列为 M6 榜单第 0 源（§2.5） |
| 5 | 00§5 风险 4 缓解靠「reviewed_at 90 天超期提示」 | big-coming 提供事件驱动锚点（6 类指纹比对） | reviewed_against 挂 fingerprint hash，指纹变化即触发复核提示（§2.4） |

---

## 附：证据清单（本报告全部结论的源码定位）

| # | 位置 | 支撑内容 |
|---|---|---|
| S1 | `vendors/NEETnina--dsh-model-master/index.js:740-1025` | prepareCall configure 回调、TTFT/TPS 测量、bursty 防护、中位数降噪、appliedEffort 审计 |
| S2 | 同上 `:119-313` | OpenRouter 榜单解析、缓存快照、in-flight 去重、provenance 字段 |
| S3 | `vendors/oxlyn--dsh-model-health/dist/index.js:224-505` | 双通道探针、registry 枚举、200 体校验、超时/读上限 |
| S4 | `vendors/Willmylife--dsh-model-connection-test/index.js:1-402` | 宿主 llm 探针全架构、verdict 错误码三集、backoff、same-origin fence |
| S5 | `vendors/songrui111--dsh-agent-bench/lib/{cases,assertions,runner,sandbox,scorecard,host}.js` | suite/case schema、7 种确定性断言、沙箱隔离、串行执行、compareScorecards、隔离 DSH_HOME |
| S6 | `vendors/BiBoyang--dsh-eval-harness/src/{types,assert,judge,runner}.ts` + `cases/real/01-bash-tool.yml` | EvalCase/EvalAssert 全键集、断言引擎、judge 协议与校准、fork dsh CLI、结果型断言 |
| S7 | `vendors/BiBoyang--dsh-eval-harness/src/gate.ts` + `src/types.ts:338-424` + `AGENTS.md` | GateReport 全字段、baseline 纪律、哨兵、E7/E8 |
| S8 | `vendors/Sumcam-L--dsh-big-coming/lib/{probe,store}.js` | 指纹 6 类比对、SHAPE_IGNORED、tokenizer 侧信道、state.json 原子写 |
| S9 | `vendors/r600a-code--dsh-swarm-router/{ranking,store,router,index}.js` + `models/registry.json` | score 公式、boost 阈值、rankings/usage 双文件、llm/stream 全局监听 sessionId 归因、能力注册表 |
| S10 | `vendors/xiean676--dsh-freemodels-opencode/src/{rank,store,probe}.ts` | 人工评级四纪律、verdict 八档、catalogVersion、onChange 免重编译发布 |

*本报告结论以 vendors/ 本地源码为准；行号均可回溯核对。所有被借鉴部件的 License 状态见 §三复用分级表。*
