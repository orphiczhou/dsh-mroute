# M5 评测计划 · E1 通道与工程可行性（专项）

> 专家：E1（通道与工程可行性）。
> 输入：`docs/briefs/m5-eval-plan-brief.md`（事实底）+ asar 实读 + vendors 现役实现 + `plugin-mroute/` 现役代码。
> 结论口径：**通道②（`ctx.llm` 直调）一天可跑通**。真正卡住 MVP 的不是宿主契约，而是「effort 静默继承 / finish 词表分层 / 判分器自证」三件事。
> 证据格式 `文件:行号`；asar 路径前缀 `app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js` 简称 `dsh-llm`（该包无 `.d.ts`，证据全部来自运行时 JS）。范围：只答任务书 §4-E1 六条 + §1 四件实证；评审/红队/许可不在本篇。

## 0. 摘要（先看这段）

1. 契约已实证到行：`prepareCall(config, signal, configure)` → 一次性句柄 `{config, retryPolicy, context, stream}` → `prepared.stream(options)` 发真实请求；`finish` 是最后一个 chunk、`usage` 是它前一个。
2. **`completed` 不是 `finish.reason.kind`**。adapter 侧只发 `stop|tool-calls|max-tokens|error|aborted`；`completed` 是装配期的 settlement 标签（见 §1.3）。任务书说的「词表代次漂移」，真相是**同一语义被放在两层**——判分侧白名单必须按 chunk 层写，未知 kind 显式失败。
3. `plugin-mroute/index.js:31` 的 `inject` 里**已经有 `llm`**——通道② 不需新增注入面、不包装 provider、不监听 `llm/stream`（我们只做瀑布的**调用者**，§1.5）。
4. MVP 7 个新文件 ≈1100 行、一天可跑通单题链路；3 个「跑不通就得改设计」的硬风险全部带判据与降级（§6.3）。成本单量不是问题（单题 500–1100 tokens），**真正的成本风险是包月渠道 5h 窗口被打爆**——护栏必须拦在「选哪些渠道跑」（§7）。

## 1. E1-①：`ctx.llm` 真实契约

### 1.1 签名与返回形状

- `async prepareCall(config, signal, configure)` —— `dsh-llm:2330`；`config` 形状 `{provider, model, ...controls}`（`:2332` 解构），内部转 `registration.adapter.prepareCall(provider, model, signal)`（`:2334`）。
- `configure` 的**确切入参是被剥掉 provider/model 的 controls**：`:2337-2341` `configure(deepFreeze(structuredClone(controls)), deepFreeze(modelInfo))`，返回值再与 `{provider, model}` 合并 ⇒ 回调里拿不到、也不该改 provider/model。
- 返回 **frozen 句柄**：`{ config, retryPolicy, adapterDefaults, context?{contextWindow}, inputModalities?, systemPromptUpdate?, toolUpdate?, stream(options) }`（`:2351-2370`）。
- **`stream` 只能派发一次**：二次派发或派发前配置漂移抛 `LlmError`，code `INVALID_PREPARED_CALL`（`:2360` `"a prepared LLM call can only be dispatched once"`；`:2361` `"prepared LLM call config changed before adapter dispatch"`）⇒ 重试**必须重新 prepareCall**。派发即 `this.streamWithRegistration(options, {registration, config: resolvedConfig, modelInfo, dispatch})`（`:2363`）。

### 1.2 effort 必须显式钉死（否则静默继承）

- 缺省填空发生在宿主：`maxTokens` 缺省取 `info.defaultMaxTokens`（`:2293-2296`）；`const effective = requested ?? reasoning.defaultEffort`（`:2303`）⇒ **不传 effort ＝ 钉成模型默认档，不是「不指定」**。
- 非法 effort 直接抛：`provider "X" model "Y" does not support reasoning effort "Z"`，code `UNSUPPORTED_REASONING_EFFORT`（`:2301`、`:2305`）。
- 合法档位来自 `resolveModelInfo(provider, model, signal)`（`:2221-2223`）→ `reasoning.efforts[].id`（`:2241-2272`）。现役先例正是取第一档：`vendors/dsh-feishu-plugin/lib/index.js:127306` `info?.reasoning?.efforts?.[0]?.id`。
- 同一教训写在 `vendors/NEETnina--dsh-model-master/index.js:779-787` 注释：「prepareCall materializes `requested ?? reasoning.defaultEffort`，所以省略 effort 的探针会静默继承会话当前档位」——`applied_effort` 字段（`mroute/07-assembly-plan.md:205`）就是为记这个存在。

### 1.3 finish / usage 在哪里拿

- 流内 chunk 只有七种（`AssistantStreamAccumulator.push` `dsh-llm:1290-1317`，default 走 `assertNever`）：`text-delta` / `reasoning-delta` / `tool-call-delta` / `block-start` / `block-end` / `usage` / `finish`。
- `finish` 是**最后一个** chunk：`{ type:"finish", reason:{ kind, failure? } }`。kind 由 adapter 产出：`stop | tool-calls | max-tokens`（`vendors/xiean676--dsh-freemodels-opencode/lib/index.js:1388`：`length→max-tokens`、`tool_calls→tool-calls`、其余→`stop`）与失败态 `error` / `aborted`（同文件 `:1448-1458`、`:1466-1476`；宿主兜底 `dsh-llm:2512-2524`）。
- `failure` = `{ message, code, providerRetryAfterMs? }`；aborted 时 code 固定 `"ABORTED"`（`xiean676…:1470-1474`）。
- `usage` 是**倒数第二个** chunk：`{ type:"usage", usage:{ inputTokens, outputTokens, totalTokens, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? } }`（`xiean676…:1389-1403,1432-1443`；断言先例 `…/scripts/selftest.mjs:967` `chunks.at(-2).usage.inputTokens`）；adapter **允许发全 0 占位**（`:1436-1443`）⇒ 判分与成本统计必须容忍 `usage.totalTokens===0` 并回落估算，回落要打标（`usage_estimated:true`）。
- 宿主自己的归一化口径：`parseTokenUsage` 六字段（`vendors/wingsky-1--dsh-plugin-hub_packages_dsh-provider-usage/lib/index.js:10704-10714`）；从存档流取 usage/finish 用 `lastAssistantStreamChunk(stream, type)`（`dsh-llm:1501-1506`）。
- **`completed` 的真相**：它是 wingsky 的**装配期 settlement** 标签（同文件 `:11096`），不是 chunk 字段。分类器对 `stop|tool-calls|max-tokens` 记 normal、`error|aborted` 记 error、**default 记 unknown**（`:10886-10907`）⇒ 判分侧照抄这个 default 分支，未知 kind 显式失败而不是乐观成功。

### 1.4 TTFT 的权威口径（不要自己发明）

- `isTokenDelta(chunk)`（`dsh-llm:1402-1409`）：`text-delta`/`reasoning-delta` 且 `chunk.text !== ""`；`tool-call-delta` 且 `argumentsDelta !== "" || name !== undefined`；其余 false。**TTFT = 第一个 `isTokenDelta` 为真的 chunk 的时刻**。
- 别拿 `isVisibleChunk`（`:1418-1425`）当 TTFT 口径：后者剔除纯空白，语义是「读者可见」，与「模型开始吐 token」不是一件事。采集点必须是**消费流的那一层**（`for await` 循环里打时间戳），不能用事后存档流（存档的时间分辨率取决于落盘路径）。

### 1.5 与 llm/stream 红线的关系（易误判）

- `prepareCall().stream()` 内部同样走 `this.ctx.waterfall(this, "llm/stream", options, …)`（`:2363` → `:2506-2508`；公开 `stream` `:2503-2505` 同路）⇒ **通道②、通道③ 都必然被别的插件的 `llm/stream` 观察者看见**。
- 这不违反「不碰 llm/stream 改道」：红线禁的是**注册 waterfall 处理器去改写/阻断**，我们是**调用方**。合规三条件：不 `ctx.on('llm/stream')`、不改 `options`、不包 adapter。
- 副作用要记账：quota / usage 类插件会把评测流量算进用户额度——这正是 §7 护栏存在的理由，不是可以无视的噪音。

### 1.6 不设 `maxTokens` 的代价（真实请求头实证）

- 缺省走 `info.defaultMaxTokens`（`:2293-2296`），而真机请求头里这个值可以大到 **131072**：`docs/09-multi-model-session-audit.md:57` 实录 `{"provider":"zai-coding-cn","model":"glm-5.3","maxTokens":131072}`。
- ⇒ 评测**必须显式传小 `maxTokens`**（建议 256–512）。不传不是「不限」，而是「按模型上限预留」，一旦判分 prompt 触发长输出，单题成本会从 1k 级跳到 10k 级，§7 的预算帽会被一次调用吃掉。句柄上的 `context.contextWindow`（`:2351-2370` 返回字段）可用于写前自检：`prompt_tokens + maxTokens > contextWindow` 直接判 `invalid`，不发请求。

### 1.7 错误面速查（判分侧要区分的三种「失败」）

| 层 | 表现 | 判分处置 |
|---|---|---|
| 注册/准备期 | `LlmError` code `UNSUPPORTED_REASONING_EFFORT` / route not allowed | `skipped_gate`，换模型不换题 |
| 派发期 | `INVALID_PREPARED_CALL`（复用句柄） | 代码 bug，整轮 abort（不要重试掩盖） |
| 流内终态 | `finish{kind:'error'|'aborted', failure.code}` | `invalid`/`error` 记录，按 §3 熔断计数 |

## 2. 最小可用调用序列（≤30 行伪代码）

```js
// 一次句柄 = 一次请求；重试必须重新 prepareCall
async function runOnce({ llm, provider, model, effort, messages, signal, maxTokens }) {
  const info = await llm.resolveModelInfo?.(provider, model, signal)  // 合法 effort 白名单 + contextWindow
  const prepared = await llm.prepareCall(
    { provider, model, maxTokens, ...(effort ? { reasoningEffort: effort } : {}) }, signal,
    (controls) => (effort ? { ...controls, reasoningEffort: effort } : controls))  // 双保险：configure 再钉一次
  const t0 = Date.now(); let ttft = null, usage = null, finish = null, text = ''
  for await (const chunk of prepared.stream({ ...prepared.config, messages, signal })) {
    if (chunk.type === 'usage')  { usage = chunk.usage; continue }    // 倒数第二个
    if (chunk.type === 'finish') { finish = chunk.reason; continue }  // 最后一个
    if (ttft === null && isTokenDeltaLike(chunk)) ttft = Date.now() - t0
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return { text, finish, usage, ttft, tEnd: Date.now(), applied_effort: effort ?? 'default' }
}
// isTokenDeltaLike：text-delta|reasoning-delta 且 text!==''；tool-call-delta 且 argumentsDelta!==''||name!==undefined
```

- 先例交叉验证：`vendors/NEETnina--dsh-model-master/index.js:796-817`（三参 prepareCall + configure 钉 effort + `prepared.stream({...prepared.config, messages, signal})`）；`vendors/dsh-feishu-plugin/lib/index.js:127296-127336`（`ctx.get('llm') ?? ctx.llm`、`resolveModelInfo` 取档、累 text-delta、`chunk.reason` 收束、AbortController 8s）。
- `resolveModelInfo` 一律用可选链：现役插件对目录读失败是**降级不抛**（`plugin-mroute/lib/livecheck.js:27,36` 只用 `listProviders/listModels`；`lib/tool-sync-models.js:5` 明说宿主目录才是正源）。

## 3. E1-②：串行/并发边界、单飞、超时、重试与熔断

- **并发上限**：单 provider 串行 1，全局并发 ≤2（跨 provider）。MVP 全串行——评测价值在可比性不在吞吐；并发会把排队时间混进 TTFT。
- **单飞**：同一时刻只允许一轮 eval。实现照抄 `lib/quota-cache.js:62-106` 的 in-flight promise 复用（`await inFlight` + `finally { inFlight = null }`），入口工具在 run 未结束时直接返回 `E_EVAL_BUSY`，**不排队**（排队会让护栏计数与真实时间错位）。
- **超时与取消**：宿主只接 `signal`，**不会替你设超时**（`prepareCall` 签名 `:2330` 无 timeout 参数）。自己起 `AbortController` + `setTimeout(...).unref()`（先例 feishu `:127330-127336`）；abort 后流以 `finish{kind:'aborted', failure:{code:'ABORTED'}}` 收束（`dsh-llm:2512-2524`）⇒ 记 `invalid`，不是 `error`。
- **重试**：句柄上有 `retryPolicy`（宿主来源 `adapter.providerRetryPolicy(provider) ?? 默认`，`dsh-llm:1981`；adapter 侧形状 `xiean676…:1167-1180` = `{mode,maxRetries,retryableCodes,initialDelayMs,maxDelayMs,jitterRatio}`）。**但 runner 内不自动重试**：重试污染 TTFT 与成本、破坏可复现性。重试上移到轮次层——同题同模型最多 2 次尝试，第 2 次单独记 `attempt:2`。
- **熔断**：按 provider 计数。`permanent` 集（`AUTH / INVALID_CREDENTIAL / MISSING_CREDENTIAL / QUOTA …`，`wingsky-1…:10920-10924`）命中一次即本轮停用该 provider；`transient` 集（`EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`，同文件 `:10919`）连续 3 次 → 冷却 5 分钟（沿用 `quota-cache.js:29,38,91-96,121-125` 的 ok/degraded/cooling/half-open 状态机）。熔断状态**只在内存**，不写配置：advisory-only 要求评测不得改变用户后续任何请求行为。

| 参数 | 建议值 | 依据 |
|---|---|---|
| 单调用超时 | 60s（探针 20s） | 本机历史 TTFT 量级 + 上游长输出余量 |
| 同轮尝试上限 | 2 | 保留一次可观测重试，同时不放大统计噪声 |
| transient 冷却 | 5min | 沿用 `quota-cache.js:38` `cooldownMs` |
| permanent 阈值 | 1 次即停用 | `AUTH/QUOTA` 类不会自愈，重试纯烧时间 |

## 4. E1-③：性能探针如何不污染判分

- **独立调用**：探针单独发一次 `runOnce`（固定短 prompt、小 `maxTokens`），不复用判分调用耗时——判分 prompt 长短与工具面差异会让 TTFT 不可比。记录带 `sample_kind:'probe'|'judge'`。
- 采样与方差：n=1 起步。`vendors/NEETnina--dsh-model-master/index.js:969-971` 注释记单次探针 **17–22% run-to-run 方差** ⇒ n=1 时 `samples:1`、`ttft_spread:null`，**不许**把单次值当稳定排名依据；n≥3 才写 spread（中位数 + 极差）。tps = `usage.outputTokens / (tEnd - tFirstToken)`，加 bursty 防护——生成窗口 <0.12s 改用总时长、下限 0.05s（`model-master:899-923`）；`usage` 缺失时 `tps=null` 而非 0。
- **三条不污染硬规矩**：① `lib/eval/probe.js` 不被 `score.js` import，`composite` 只由 `scores{}` 算（`mroute/07-assembly-plan.md:205` 已冻结「probe 不进 composite」）；② 探针 token 记独立桶 `probe_tokens`，不占 suite 预算；③ 探针失败只让 `probe` 字段缺省，**不许**把该模型判成 `instrument_healthy:false`（哨兵只管判分器，不管性能探针）。

## 5. E1-④：结果落地

- 目录：`~/.dsh/mroute/eval/runs/<run_id>/`，含 `records-YYYYMMDD.jsonl`（按天分片、append-only）、`run.json`（轮级 meta）、`summary.json`（派生、可重建）。
- 记录形状（单题单模型终态，一行）：

```jsonc
{ "run_id":"20261121T0930-a1b2", "task_id":"L1-03", "provider":"deepseek-official", "model":"deepseek-v4-pro",
  "applied_effort":"high", "sample_kind":"judge", "status":"ok", "finish_kind":"stop",   // 白名单外一律 invalid
  "usage":{"inputTokens":412,"outputTokens":188,"totalTokens":600}, "ttft_ms":840, "tps":46, "attempt":1,
  "evidence_refs":["out/L1-03.txt","assert:cites_file","run:20261121T0930-a1b2"], "at":"2026-11-21T09:31:12+08:00" }
```

- **原子写**：`run.json` 用 `writeFile(tmp) + rename` 覆盖；JSONL 用 `fsp.appendFile` 一行一记录（现役先例 `plugin-mroute/lib/decision-log.js:46-57`：mkdir recursive + appendFile、失败静默返回 false、不影响主流程）。
- **坏数据隔离**：解析失败的行不参与聚合，整文件挪到 `records-<日期>.corrupt-<ts>` 后跳过（先例：lan-scheduler 的「mid-file 坏行拒绝 load + `.corrupt-*` 备份」）；写入前做 shape 校验（必填键集 + `finish_kind` 白名单 + `applied_effort` 非空），不合法即写 `status:'invalid'` + `reason`，**不进排名**。
- **eval 写回**：唯一合法写链 `ctx.fiber.entry` + `ctx.get('configEditor').edit(entry, current => next)`（`plugin-mroute/lib/tool-sync-models.js:243-290`；缺 entry/editor 返回 `apply_error` 文本、不抛）。写回范围**只准 `eval` 子对象**；`channels[]` 是 volatile 整替语义，整表写会吞掉面板编辑。
- **evidence_refs**：只存可重取的指针（产物相对路径、assert 命中名、`run_id`），**不存 prompt/输出正文**（脱敏纪律同 `docs/09-multi-model-session-audit.md:7`）。

落盘布局（`<eval_root>` = `~/.dsh/mroute/eval`）：

```text
~/.dsh/mroute/eval/
├── suites/L1.suite.json          # 静态题集（人读、可 git）
├── runs/20261121T0930-a1b2/{run.json, records-20261121.jsonl, summary.json}
└── records-20261119.corrupt-...  # 隔离的坏分片（只备份不删）
```

## 6. E1-⑤：MVP 最小链路

### 6.1 文件与导出（7 新增 + 1 处增量 ≈1100 行）

| 文件 | 行量级 | 导出 | 职责 |
|---|---|---|---|
| `lib/eval/runner.js` | ~200 | `runEval` / `runOnce` | 串行队列、AbortController、attempt 记账 |
| `lib/eval/score.js` | ~180 | `scoreTask` | assert 求值 + 哨兵破判 + composite |
| `lib/eval/probe.js` | ~90 | `measureProbe` | TTFT/TPS 采样（隔离） |
| `lib/eval/store.js` | ~140 | `appendRecord` / `writeRunMeta` / `loadRecords` | 日分片、原子写、坏行隔离 |
| `lib/eval/suite.js` | ~80 | `loadSuite` / `validateSuite` | suite JSON 解析 + 形状校验 |
| `lib/eval/guard.js` | ~160 | `checkBudget` / `pickChannels` | 四层护栏计数与渠道筛选 |
| `lib/tool-eval-run.js` | ~180 | `createEvalRunTool` | `model_eval_run`（dry-run 默认，apply 才写 eval） |
| `index.js` | +15 | — | **平级独立 try** 注册（照 `index.js:117-128`） |

### 6.2 一天能否跑通

能。验收脚本四条：①`node --check` 全过；②单题 × 单渠道 × n=1 实调产出**1 行** JSONL（`usage.inputTokens>0`、`finish_kind` ∈ 白名单、`ttft_ms` 为整数）；③`eval` 子对象被写回、`cordis.patch.yml` 可见；④工具文本摘要含 `budget: calls=x/y tokens=a/b`。
宿主侧无新增依赖：`llm` 已在 `index.js:31` 的 inject；`tools`/`configEditor` 现成；`resolveModelInfo` 可选链降级。

### 6.3 三个「跑不通就得改设计」的硬风险

| # | 风险 | 判据（可观测） | 降级 |
|---|---|---|---|
| R1 | 策略门/凭据：eval 想跑 zai / opencode-go 等包月渠道，被门拒或凭据缺失 | `finish{kind:'error'}` 且 `failure.code ∈ {AUTH, MISSING_CREDENTIAL, QUOTA}`，或准备期 route not allowed | provider 集合收窄为 `listProviders() ∩ 注册表 ∩ 本轮实测可用`；跑不通写 `status:'skipped_gate'`，**不阻塞整轮**，靠 deepseek 系兜底 |
| R2 | 档位不合法：effort 不在 `reasoning.efforts` 内（`UNSUPPORTED_REASONING_EFFORT`），或 `maxTokens` 与 `context.contextWindow` 冲突 | 上述错误码；或上游 400 | 钉 effort 前必走 `resolveModelInfo`；无合法档 → `effort=null` 但**显式记 `applied_effort:'default'`**（绝不静默），该模型本轮只出 provisional |
| R3 | 判分器自证：assert 全过但输出实际不可用（假阳性） | 哨兵对：must-pass 全 pass 且 must-fail 全 fail ⇒ TPR/TNR<0.9 | 整轮 `instrument_healthy:false`、**不进排名**，只发 `provisional` + Wilson 下界；仍写 JSONL 供复盘 |

### 6.4 一天时间盒（若实施）

- 上午：`runner.js` + `store.js` + 手工跑通 1 行真实记录（这一步就把 §2 伪代码验证完）。下午：`score.js` + 哨兵对 + `guard.js` 计数；工具壳与写回放最后半小时（有 `tool-sync-models.js` 现成模板）。明确**不做**：judge（通道③）、面板展示、多轮对比、定时任务。

## 7. E1-⑥：成本口径与四层护栏落点

- 单题量级：system ~80 + task ~120 + 示例 100–400 ≈ **300–800 输入 tokens**，输出 100–300 ⇒ **~500–1100 tokens/题**。轮次量级：L1（10 题 × 5 模型）= 50 次 ≈ 5 万 tokens（可忽略）；L2（50 题 × 8 模型）= 400 次 ≈ 40 万 tokens（必须有帽）。
- 预算默认：`eval_budget = {max_calls:200, max_tokens:400_000, max_cny:5}`，超限即停并写 `budget_exhausted`。

| 层 | 拦在哪一步 | 用什么计数 |
|---|---|---|
| L1 入口 | 工具参数校验**先于任何 IO**（沿用 mroute 纪律） | `题数 × 模型数` clamp 到 ≤ `max_calls` |
| L2 循环 | 每次调用完成后 | 累计 `calls` / `usage.totalTokens`，超帽 break |
| L3 渠道 | **跑前**筛 `pickChannels` | 读 quota 快照 `worst_used_pct`：周 ≥98% 不进本轮；包月优先（复用 `lib/ranking.js` 的 monthly>voucher>prepaid） |
| L4 写回 | 写 eval 子对象前 | 只写 eval + `last_run`，不触碰排序键；失败静默留 `meta.eval_write_error` |

- 关键判断：**成本风险不在 token 单量，而在包月渠道的 5h 窗口**——400 次调用若全压 zai/opencode-go，会吃掉用户当天额度并触发动态沉底（`lib/dynamic-state.js`），从而**回头污染派遣推荐**。所以 L3 是硬筛，不是事后标注。

## 8. 我与其他角度可能冲突的判断

1. **与「评测应自动定时跑」冲突**：MVP 不做后台定时，只做手动工具触发。理由：成本与包月窗口不可控，且自动跑会与用户真实会话抢同一批渠道（评测流量已进 `llm/stream` 瀑布，§1.5）。若产品侧坚持：默认 off + 每天最多 1 轮 + 空闲时跑，三条缺一不可。
2. **与 judge（通道③）冲突**：MVP 不做 judge。judge 引入第二个不受控成本与跨模型一致性问题，而 `TPR/TNR≥0.9` 本是判分器自证门槛——先让 assert 判分器过哨兵，再谈 judge。主张「LLM 裁判更真实」的先给哨兵通过证据。
3. **与「性能列进排名」冲突**：probe 不进 composite（`07:205` 已冻结），n=1 的 TTFT 方差 17–22%（§4）；面板若展示必须同时给 `samples/spread`，否则等于用噪声做决策。
4. **与「多并发提吞吐」冲突**：串行是特性不是妥协；并发 >2 让 TTFT 混入排队时间，与探针目标直接矛盾。

## 9. 证据索引（可复核）

- 宿主契约：`dsh-llm:2330,2332,2334,2337-2341,2351-2370,2360-2361,2293-2296,2303,2301,2305,1290-1317,1402-1409,1418-1425,1501-1506,2221-2223,2241-2272,2191-2211,2013-2015,2503-2508,2512-2524,1981`
- adapter 侧契约：`vendors/xiean676--dsh-freemodels-opencode/lib/index.js:1167-1180,1202-1207,1311,1388,1389-1403,1432-1459,1466-1476`；断言 `…/scripts/selftest.mjs:967`。现役先例：`vendors/NEETnina--dsh-model-master/index.js:779-787,796-817,899-923,969-971`；`vendors/dsh-feishu-plugin/lib/index.js:127296-127336`；`vendors/wingsky-1--dsh-plugin-hub_packages_dsh-provider-usage/lib/index.js:10704-10714,10886-10907,10917-10924,11096`
- mroute 现役：`plugin-mroute/index.js:31,90-128`；`lib/livecheck.js:27,36`；`lib/quota-cache.js:29-38,62-106,121-125`；`lib/decision-log.js:46-57`；`lib/tool-sync-models.js:243-290,5`
- 方案锚点：`mroute/07-assembly-plan.md:205`（eval 字段集）、`:34`（R2 探针复用）、`:40-41`（R8/R9）、`:73`（B20 usage 归因）、`:426`（M5 8–12 人日）

## 10. 只有真实跑一轮才能确认的事（交给实施/验收，不在本文断言）

1. 现役五个渠道在本机 `prepareCall` 下**是否都放行**（策略门实测面与历史记录不一致，`AGENTS.md §7` 有多次反复记录）。
2. `usage` chunk 是否真的每轮都到（DeepSeek 系 adapter 是否发占位 0）；`resolveModelInfo` 返回的 `reasoning.efforts` 是否对 `deepseek-v4.1-flash` / `glm-5.3` 等**列全**，决定 R2 的降级频率。
