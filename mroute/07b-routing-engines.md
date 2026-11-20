# 07b 路由引擎深读：7 家模型路由/备选社区插件源码分析（W8 产物）

> 任务：源码级回答每家 A-E 五问，支撑 mroute「财务优先级引擎」设计。
> 证据纪律：全部结论带文件+行号；其中 omdsh / penguin / autotier / Neptune810 四家的关键行号由第 2 次派发会话逐条抽验复核（标注「验」），Alice-Marx / quota-takeover / llm-governor 三家为第 2 次派发会话直接补读源码得出（树日志中无前次 progress 留痕，见文末「执行说明」）。
> 上游参照：`00-feasibility-report.md`、`01-dsh-feasibility.md`（红线定义与 C 判断）、`06-market-scan.md`。
> 路径约定：`vendors/<dir>/` 为插件根；相对路径均自插件根起。

---

## 0. 红线定义（引自 01-dsh-feasibility.md，作为 A/E 判据）

- `llm/stream` waterfall 宿主原话："Waterfall around every streaming model call (retry, replay, **routing**)"（01 文档 L96-99）。理论上监听者可改 `GenerateOptions` 的 route，但作用面是**所有**模型调用（父会话、compaction、标题等辅助调用全中），且 `GenerateOptions` 字段级可变语义未逐行验证——01 文档 C 判断：**理论可行、工程高风险，不作主方案**（01 L99/L156/L160）。
- 派遣瞬间替换模型：**参数层无官方改写通道**；宿主侧已有 `assertAllowedModelSelection` 硬门（dsh-tool-subagent L89-96）、换 route 丢 effort（L69-72）、`preflightChildLlmRoute` 的 `inheritParentReasoningEffort && !routeChanged`（L115-126）。
- **新情报（autotier 0.2.2 实证，见 §3）**：宿主演进出 step-fixed selection 后，`agent/request` 里改 provider/model/effort 会被拒绝并 fail step；持久落点只剩 `agent.model.select()`。

---

## 1. 逐插件 A-E 表（7 家）

### 1.1 omdsh-dev--dsh-llm-fallbacks（MIT）

| 维度 | 结论（证据） |
|---|---|
| **A 路由决策缝** | 双缝，全部不拦他人请求：①**虚拟 provider**：`llm.registerAdapter(['FallbacksChain'], adapter)` 一次注册承载 N 条命名链（`dist/index.js:816`【验】；`dist/virtual-adapter.d.ts:17`【验】）；`adapter.stream()` 把调用交给注入的 chain-walk，walk 内用 `llm.stream({provider,model})` **重入宿主**逐跳派遣（`dist/index.js:1105`【验】）——链遍历发生在自己的 adapter 里；用户须在模型选择器主动选中 `FallbacksChain/<链id>` 才走链（`index.js:3231`；子代理沿用派发代理的链 `index.js:2886-2887`）。②**派遣盖章**：包装 `subagents.startActivation`，用 `**Execute as**: <id>` 头正则解析角色（`index.js:1347-1348`【验】）→ 注入 `agentOptions={provider:'FallbacksChain', model:role.chain}`（`index.js:1585-1635`【验】）；无角色则派遣原样不动（`index.js:1537`） |
| **B 决策因子** | **角色**（Execute as 头→角色→专属链）是唯一派遣期因子；**额度不进派遣决策**——触发器是失败码 `triggerCodes`（默认 `['AUTH','QUOTA',…]` 宿主稳定失败码，`dist/config.d.ts:19,111`【验】）；`timeSlots` 分时槽可按时段前置不同链头（`config.d.ts:53`）。任务类型不参与 |
| **C 备选链与失败处理** | 最完整的链 schema：`NamedChain{ id, label, entries[], timeSlots }`（`config.d.ts:47-53`【验】），**链尾必须恰为一个官方模型**（conformance 门，`config.d.ts:43-45`）；全局 `FallbacksConfig{ triggerCodes, chains, cooldownMs, revertPolicy, maxSwitchesPerStep, recovery }`（`config.d.ts:111-116`【验】）；冷却过期恢复 `'timer' \| 'half-open'`（`config.d.ts:32-33`【验】）。守卫：自路由回 `FallbacksChain/*` 的条目永不可派遣（P1 递归守卫）、`provider/*` 通配永不作种子（P3）（`virtual-adapter.d.ts:52-58`【验】）；walk 持 failed-set + 每步切换上限。**已知宿主限制**：`providerRetryPolicy` 注册时按 provider 捕获一次，虚拟路由无法镜像链头策略，只能返回 undefined 用宿主默认（`virtual-adapter.d.ts:101-107`【验】） |
| **D UI 配置形态** | 模型选择器出现 `FallbacksChain/<链id>` 行（`index.js:818`）；Web 设置卡=TUI 设置卡完全同形：命名链（默认降级链+链尾+分时槽）/角色/高级选项（`index.js:2886-2887`）；子代理角色徽章 SubagentRoleBadge |
| **E llm/stream 红线** | **不碰**。自建虚拟 provider 承载链遍历，零瀑布监听 |

### 1.2 penguin-oo--dsh-delegate-router（MIT）

| 维度 | 结论（证据） |
|---|---|
| **A 路由决策缝** | 双缝，只作用于**子会话派遣**：①**工具重注册包装**：`agent.ctx.tools.register` 重注册 subagent/subagent_fork，定义加 provider/model 可选参数，`AsyncLocalStorage` 捕获调用目标（`lib/index.js:297`【验】, 工具注册在 `lib/index.js:408`【验】）；②**agent/request waterfall**：改写子会话首个（无持久 route 前）请求 `{...proposal, provider, model}`（`lib/index.js:475`【验】） |
| **B 决策因子** | **任务类型**=关键词**支配计分**（heavy 胜平局；纯 ASCII 词边界正则防 `list`→`specialist` 误配；CJK 关键词须 ≥2 字，`lib/index.js:77-93`【验】）+短任务长度 `shortTaskMaxChars`；**峰时**=北京高峰段（默认 9-12/14-18，`lib/index.js:108,191-194`【验】）未命中任务降级 Flash；**额度/预算**=会话 token 预算 `budgetCapTokens`（预算先于关键词，`scripts/test-routing.mjs:67`）；**手动参数最优先**（trigger 枚举含 `manual`，`lib/schemas.js:11`【验】） |
| **C 备选链与失败处理** | **无备选链**。触发枚举 `auto-light/auto-heavy/auto-short/auto-unknown/peak/flash-all/budget/manual`（`lib/schemas.js:11`）——一次性判决，失败不接管 |
| **D UI 配置形态** | `~/.dsh/*.json` 热加载 + `/delegate` 命令（`lib/index.js:482-500`）+ 侧栏账本面板（client `ctx.slots.register`，`lib/client.js:14675-14693`）；另附 `scripts/measure-savings.mjs` 峰谷省钱测算器（峰值全价/谷值半价模型） |
| **E llm/stream 红线** | **不碰 llm/stream**；agent/request 缝比 llm/stream 范围窄（仅子会话、仅首个持久请求前）——但同属 autotier 0.2.2 实证会撞墙的通道（§3） |

### 1.3 PerryLink--dsh-autotier（Apache-2.0）

| 维度 | 结论（证据） |
|---|---|
| **A 路由决策缝** | **版本分叉**：0.2.1=agent/request waterfall（`prepend:true`，返回替换 `LlmCallConfig`，resolveRoute 保采样参数）；**0.2.2 宿主 step-fixed selection 拒绝 request 时改 provider/model/effort → fail step**，改走 `agent/inbox/inserted`（`prepend:true`，`src/routing.ts:149`【验】）→ **`agent.model.select()` 持久落点**（`src/routing.ts:402`【验】；`lib/index.js:2352,2574`；宿主能力探测 `src/routing.ts:528`【验】；CHANGELOG L20-22 明文弃用 request 改写） |
| **B 决策因子** | **任务类型**=零 token 确定性意图层（规则表+双语关键词+结构信号 score 0..8，≥3 强升）+低置信回落 LLM judge（自发 `llm.stream` 小调用）+**指纹胜率学习**（模型×意图指纹的实测胜率回填选择） |
| **C 备选链与失败处理** | 失败码**三分类** permanent/transient/ignore + **逐档 escalation ladder**（effort 优先升档、保 KV 缓存前缀）+ `FallbackRecord{Tier, index, until}` TTL 冷却 |
| **D UI 配置形态** | 输入栏 pill + 设置卡 + `/tier` 命令 + 第三方 veto 事件（250ms 协商窗） |
| **E llm/stream 红线** | 不碰 llm/stream；但 agent/request 改写在 0.2.2+ 被宿主拒绝——**七家中唯一实证宿主演进约束的一手来源**（§3 展开） |

### 1.4 Alice-Marx--dsh-model-router（MIT）

| 维度 | 结论（证据） |
|---|---|
| **A 路由决策缝** | **不拦宿主请求**——自成体系的 Bot 工作台路由产品（「DSH Bot workspace with integrated model routing」，package.json:5）。规划器在插件内（`shared/router.mjs` candidateUtility），执行走官方 Agent Teams 工作包/官方 CLI/模型目录 API（`.dsh-plugin/router-core.mjs:609-642` createRoutePlan）。唯一 llm 接触=**自发咨询调用** `consultConfiguredModel → ctx.llm.stream({...})`（`router-core.mjs:671`【验】），带 4K 上限、字符限幅中止、usage/finish 解析（L671-713）——是「以谁的立场再问一个模型」，不是改道 |
| **B 决策因子** | **任务类型**=规则检测 signals 排序（`router.mjs:162-170`）+难度分带 simple/balanced/complex→`OBJECTIVE_WEIGHTS[difficulty]`；**多目标效用**：`score = w_q·quality + w_c·cost + w_l·latency + w_s·specialty + w_r·reasoningFit − w_risk·risk`（`router.mjs:701-706`【验】）；**预设倾斜**：economy 省钱优先（tilt cost 1.6/quality 0.75，floor −0.04）/balanced/quality 效果优先（tilt quality 1.35，floor +0.04），floor 夹 [0.5,0.97]（`shared/routing-presets.mjs:9-49`【验】）；**额度/预算**=budgetUsd+超预算动作（自动降级「省钱优先」或暂停询问，`router-core.mjs:1001,1059`）；**计费通道**=订阅优先、订阅额度耗尽同步骤切 API Key（`shared/subscription-billing.mjs:155-202` exhaustedUntil+cooldownMinutes）；**手动改派最优先**（manualAssignment） |
| **C 备选链与失败处理** | 订阅↔API **双通道 fallback**：非配额类订阅失败→**暂停步骤等用户裁决** `subscriptionChoice: api/subscription/cancel`（`router-core.mjs:2773`；task-executors pause L673-678）；配额耗尽→同步骤直接切 API（`subscription-billing` 冷却）；重跑=失败步+未集成下游步（`model_router_rerun_step`，保留上游结果，`router-core.mjs:1226-1335`）；质量门 qualityGateJson 咨询校验（L1331,1375） |
| **D UI 配置形态** | 完整 React 工作台：路由建议卡（明示「本地计算完成，未向模型发送任务内容」）、成本控制卡（今日/本月预算仪表+预占说明）、订阅与 API Key 体检表、执行记录+重跑/改派（client.js L30545-31194）；设置项 `dailyBudgetUsd`/`subscriptionCooldownMinutes`（client.js:42255-42258） |
| **E llm/stream 红线** | **不碰**（llm.stream 仅自发咨询）。额外亮点：决策带诚实标注 `semantics:'subjective-utility-not-objective-quality'`、`optimalityScope:'retained-candidates-and-surrogate-objective'`（`router.mjs:1176-1182`【验】） |

### 1.5 Neptune810--dsh-model-router（MIT）

| 维度 | 结论（证据） |
|---|---|
| **A 路由决策缝** | **agent/request waterfall `prepend:true`** 改写 `{...resolved, provider, model, reasoningEffort}`（`lib/index.js:2824`【验】`ctx.on('agent/request', onRequest, {prepend:true})`；effort 删/设 `lib/index.js:1765-1766`【验】；L22 头注自述 prepend 保持 router 最外层）。配套：`agent/pre-step`（步骤类别信号）+`agent/request-error`（失败记账+故障转移重试 `lib/index.js:2830`【验】）+`agent/inbox/claimed`/`inserted` |
| **B 决策因子** | **加性打分** `scoreEntry`（`lib/routing.js:421-473`【验位置】：档位基分+步骤类别（hard/engineering）加分+视觉加分+廉价加分−成本惩罚−峰时惩罚±cost/quality 感知项）+**渠道健康账本**（`lib/channels.js`：滚动窗口默认 20 次+TTFT EWMA，`failThreshold=3`/`cooldownMs=60000` 默认（L123-124【验】），streak≥3 → `cool(until=at+cooldownMs)`（L190-191【验】），**一次成功提前解除冷却**（L210,222-237【验】））+预算门+LLM 分类器（可答「不确定」；分类器自身带 `CircuitBreaker` 熔断 `lib/classifier2.js:180,198`【验】）+反馈闭环+种子实验。**手动选档在所属维度让位停机**（manual→auto 关闭该维度自动决策） |
| **C 备选链与失败处理** | `chooseEntry` 排序链（`lib/routing.js:520`【验位置】）：**冷却渠道沉底→分数→渠道排名→池相对成本→id**（确定性 tie-break 兜底）；failover 开关：失败转移时 `channelLedger.cool(channel, at, cfg.channels.cooldownMs)`（`lib/index.js:2227`【验】）；连续失败超阈+`quarantineMs>0` → 隔离（L1591【验】）。哲学：「Cooling is a demotion, not a ban: a benched entry sinks」（README.md:364） |
| **D UI 配置形态** | 配置驱动（`channels:{failover,failThreshold,cooldownMs,quarantineMs,fingerprint}`，docs/migration-0.14-to-1.0.md:39）+日志式渠道表输出（`lib/index.js:2758` 逐渠道 `successRate%` 行）；重面板形态未见（观测型） |
| **E llm/stream 红线** | **不碰 llm/stream**；agent/request 改写（同属 0.2.2 撞墙通道） |

### 1.6 puppy-bai--dsh-quota-takeover（MIT）

| 维度 | 结论（证据） |
|---|---|
| **A 路由决策缝** | **控制面外置，请求面零接触**：L1 计划编译器读平台序/模型档/别名表/额度/冷却→展平有序候选链→**写回 OFM combos**（`POST /combos`，`index.js:9-14` 头注；`src/compiler.js:35-90` replan 主流程【验】）——per-request 切换由 OFM 插件执行，本插件不改任何请求。L3 恢复面：`ctx.inject(['agents'])` 观察回合失败（`index.js:140`）+ `ctx.on('llm/stream')` **纯观察**（「记录落点，并在流以额度/限流类 error 结束时把失败交给续跑监督器」，`index.js:169-188`【验】）→ `agent.followup(createUserMessage「继续」)` 自动续跑（`src/resume.js:130-146`【验】；createUserMessage 取宿主的、缺失则同形兜底 L198-213） |
| **B 决策因子** | **额度**为一等公民：OFM 账号额度读数+按需刷新受 `probeBudgetPerHour` 每小时探测预算约束（`compiler.js:103-116`【验】）+平台健康度（0 账号/读不到→自动清理失效平台并落盘 `platformOrder`）；**冷却表** bench.json；任务类型/角色**不参与**（纯额度接力） |
| **C 备选链与失败处理** | 链=**档优先遍历** `for tier in modelTiers: for platform in platformOrder`（`compiler.js:8-14` 头注【验】）→ `chain[] + excluded[]`（why=exhausted\|cooling 留痕）；终局：`finalResort.fallbackModels` 兜底链，否则 `waiting=true + waitUntil=下一个 resetsAt/retryAfterMinutes`。**失败分类器**（`src/classify.js`【全文验】）：三级匹配（熔断文案优先→结构化 code CODE_MAP→文本规则→状态码兜底，L73-98）；action 五值 `SWITCH/RESUME/WAIT/GIVEUP/IGNORE`，scope `account/provider/request/transient`；`QUOTA_LIKE={quota,rate_limit,queue,overloaded}` 才触发续跑；**冷却常量** QUOTA 2min / **RATE_LIMIT 60s（刻意不是 5s：宿主连续 5 次上游限流后放弃本回合，5s 冷却会让 replan 把同一格选回→candidateHash 不变→requireCandidateChange 跳过续跑→任务还是断的）**/AUTH 10min/TRANSIENT 30s/MAX 30min（L18-27）；「stops amplifying」熔断文案→**provider 级**问题，冷却整个平台（L33-34,78-80）。**续跑幂等**：`candidateHash`+`minIntervalMs`+`requireCandidateChange`（`resume.js:109-110`【验】） |
| **D UI 配置形态** | client.js web 面板读 `plan.json`（chain/excluded/platformHealth+失效平台删除按钮，`compiler.js:61-77` plan 结构【验】）；配置 `~/.dsh/quota-takeover/config.json` 与 patch config 热合并（`index.js:70-72`【验】）；`journal.jsonl` 全程留痕 |
| **E llm/stream 红线** | **监听但仅观察**（不消费流、不改 GenerateOptions）；改道在请求外经 OFM combos 完成——「观察记账」类先例 |

### 1.7 young-tim--dsh-llm-governor（MIT）

| 维度 | 结论（证据） |
|---|---|
| **A 路由决策缝** | 四事件接线（`src/plugin/mod.ts:445` 注记+实现【验】）：①`agent/pre-step`→classifyStep（Hint/Rule/LLM 三级自动分类+能力/模态提取，图片输入→vision+image 模态，L497-517）；②`agent/request`→先 `next()` 取宿主默认配置，再 `service.selectModel` 准入+改 provider/model；**决策双写协议（pending→Session Event→committed）完成后才返回，审计失败 fail closed（AUDIT_PERSIST_FAILED）不产生 Provider 调用**（L519-539）；③`llm/stream`→`observeStream` **纯观察**（真实 attempt/Token/finish/时延，「不消费流」，L541-663）+**部分输出保护** onPartialOutput（首个语义 chunk 交付后禁止透明 Fallback，L623-624）；④`agent/request-error`→`excludeRouteAndCheckRetry` 可重试则返 `{kind:'retry'}`（L665-695；**Recovery Owner 唯一性=cordis.patch.yml 禁用基础 llm-retry**）。另有 session/event 生命周期清理（L701-725）+启动对账 pending 决策（L727+） |
| **B 决策因子** | **任务类型**：按 TaskType 的质量矩阵 `quality[taskType]`；**复杂度**→质量阈值映射 low75/medium85/high92（`src/routing/strategies.ts:263`【验】）；**置信度**：低置信→Quality First（L278-290【验】）；**倍率/单价** `multiplierPpm`（计费权重进排序）；**额度**：公共过滤器拒因含 `quota_exceeded`（strategies.ts:99-100【验】）+准入 `access_denied/provider_unavailable/capability_not_supported/disabled`。**四策略**：Manual（用户选择，只做公共过滤，**绝不自动替换**，L66-120【验】）/Quality First（quality 降序→倍率升序→routeId 字典序，L160-167）/Credit First（过滤 `quality≥minimum_quality`→**倍率升序**→quality 降序→字典序，L228-235【验】）/Auto（分类驱动，复杂度映射阈值→Credit First） |
| **C 备选链与失败处理** | **无预建链——带排除集重跑路由**：失败分类（`src/fallback/mod.ts`【全文验】：可重试码白名单 7 个 `RATE_LIMIT/TIMEOUT/SERVER_ERROR/SERVICE_UNAVAILABLE/PROVIDER_UNAVAILABLE/EMPTY_RESPONSE/TRANSPORT_UNAVAILABLE`+429/5xx；不可重试 401/403/用户取消/非法参数/内容安全/上下文窗，L9-43）→ `FallbackState{ excludedRoutes:Set, attemptCount<maxAttempts, partialOutputDelivered, afterPartialOutput=false 默认 chunk 后不切 }`（L46-103【验】）→ agent/request-error 返 retry → 重进 agent/request 带排除集重新选路，`fallbackIndex` 记位。**审计管线**：SessionStoreSink 双写+`NullSessionEventSink` fail-closed（无法落 durable ack 就拒绝决策，`src/plugin/audit-pipeline.ts:187-200`【验】） |
| **D UI 配置形态** | `/governor` web 兼容前缀+client inject（client-ui-settings/model-selection/conversation/trajectory，package.json:47-54）；决策卡=`governor/routing-decision` Session Event 投影（`src/plugin/client-registration.ts:150` toCardState）；轨迹管线 conversationEvents.register（`src/client/browser.ts:1402`）；配置**严格校验 fail closed**（未知字段/范围越界/条件必填缺失→抛错拒绝加载，`plugin/mod.ts:441-442`）；SQLite 仓库 `~/.dsh/dsh-llm-governor/governor.db` |
| **E llm/stream 红线** | **监听但仅观察**（透明 passthrough+记账）；改 provider/model 走 agent/request——同属 0.2.2 撞墙通道。附加工程纪律（AGENTS.md）：Governor 永不直连 provider HTTP、永不存凭据、域模块（routing/fallback/classifier/credits）独立可测 |

---

## 2. 汇总章：财务优先级引擎设计建议

### 2.1 主缝裁决：派遣前查询工具（七家先例一致背书）

**七家全部不碰 llm/stream 改道**。逐一归类它们的「改道」实现位置：

| 实现位置 | 插件 | 请求面接触 |
|---|---|---|
| 虚拟 provider（自注册 adapter，用户选中才生效） | omdsh | adapter 内 llm.stream 重入，零瀑布监听 |
| agent/request waterfall 改写 | penguin② / autotier 0.2.1 / Neptune810 / governor | 改子会话或当前步的 provider/model（**0.2.2 起被宿主拒绝，见 §2.2**） |
| 控制面写回第三方执行器 | quota-takeover→OFM combos | 零请求接触 |
| 自家产品内规划+执行 | Alice-Marx | 仅自发咨询 llm.stream |
| llm/stream 监听 | governor / quota-takeover | **仅观察记账**（observeStream 不消费流/纯记录落点）——两家均不改写 |

这与上游 01 文档 C 判断完全吻合：插件不能在派遣瞬间替换模型；推荐组合=**①为核**（注册 `model_route_query` Tool，聚合 `llm.listProviders()/listModels()` + 插件自有 channel_type 优先级/备选链/余额数据）+ ③Config 承载静态优先级 + ②systemPrompt.section 提示「派遣前先查」+ ④人工查看面板。**不要碰 llm/stream 改道**（01 L117）。

**可选增强两条**（均为渐进、可回退）：
1. **omdsh 式派遣盖章**：包装 `subagents.startActivation`，按角色/任务注入 agentOptions（omdsh index.js:1585-1635 模式）。比 agent/request 缝更早、作用点明确；但注意它仍属「派遣参数注入」，宿主演进时同样需要回归验证。
2. **虚拟 provider 链**：`llm.registerAdapter(['FallbacksChain'], adapter)` 模式（omdsh）——链遍历在自己 adapter 内、经 `llm.stream` 重入宿主，用户在模型选择器选中 `FallbacksChain/<链id>` 才生效。优点：完全不经 waterfall、天然支持链遍历/冷却/每步上限；代价：用户须手动选中（可由①的查询工具+systemPrompt 引导选中），且接受 providerRetryPolicy 无法镜像链头的已文档化降级（virtual-adapter.d.ts:101-107）。

### 2.2 重要情报：宿主 0.2.2 step-fixed selection 约束（mroute v2 硬约束）

autotier 0.2.2 一手实证：新宿主采用 **step-fixed selection**——`agent/request` 监听器返回中改变 provider/model/effort 会被**拒绝并 fail step**；唯一持久落点=**`agent.model.select()`**（经 `agent/inbox/inserted` 触达，autotier `src/routing.ts:149,402,509-528`；CHANGELOG L20-22）。

对 mroute 的推论：
- §1 表中所有走 **agent/request 改写**的先例（penguin②、Neptune810、autotier 0.2.1、governor）在 0.2.2+ 宿主上都有失效/撞墙风险——它们是「过去时」参考，不是「进行时」模板。
- mroute 主方案**不得依赖** agent/request 改写；若 v2 评估需要「会话级持久换档」，评估对象应是 `agent.model.select()` 落点（这是宿主给的正门），而非 waterfall 改写。
- governor 的双写审计协议 + 部分输出保护是换档语义的安全下限：任何换档决策先落 durable 记录、首个语义 chunk 后禁止透明切换。

### 2.3 channel_type 排序落法：三层组合

「财务优先级」= 让便宜且可达的渠道先被派遣。三家人各供一层，组合后即完整排序引擎：

| 层 | 来源 | 机制 | 落法 |
|---|---|---|---|
| **静态层（真源）** | governor credit_first | 过滤 `quality[taskType] ≥ minimum_quality`（按 channel_type 档位定门槛）→ **倍率/单价升序** → quality 降序 → id 字典序（strategies.ts:228-235） | channel_type 序写入插件 Config；排序函数**确定性、零 token、每步产出可审计 DecisionRecord**（candidates/excluded/selected 全留痕） |
| **动态层（mask）** | quota-takeover | 账本命中即跳格：exhausted-until / cooldown-until / 连续失败阈值；分类器决定 scope（account→冷却该账号、provider→冷却整个平台，classify.js AMPLIFY_RE 先例）+幂等 candidateHash | 静态序不变，账本做 **mask（沉底或出列）**；excluded[] 留痕 why=exhausted\|cooling；「waiting=true+waitUntil=resetsAt」语义承接全空终局 |
| **感知层（微调）** | Neptune810 scoreEntry/chooseEntry | 加性打分：基分+任务类别加减+成本惩罚+峰时惩罚−健康惩罚（滚动窗口成功率+TTFT EWMA，failThreshold=3/cooldownMs=60s/一次成功提前解除）；排序 tie-break：冷却沉底→分→排名→相对成本→**id 兜底** | 同 channel_type 档内用打分器微调；**健康惩罚必须可恢复**（一次成功解除，非封禁）；最终 tie-break 强制确定性（id 兜底，Neptune810 已示范） |

组合纪律：三层各自产出可解释中间量（静态序=配置、mask=账本条目、微调=逐项加减分），最终排序仍须可重放（同输入同输出）——这是三家共同的可审计风格（governor DecisionRecord / quota-takeover plan.json / Neptune810 渠道表）。

### 2.4 备选链结构：借鉴 omdsh（唯一完整链 schema）

omdsh 是七家中唯一给出完整备选链合同的一家，建议 mroute 直接采用其字段形状并扩展：

- `NamedChain{ id, label, entries[], timeSlots }`：链尾**必须恰为一个官方模型**（conformance 门，保证链必有可执行终点）；
- 全局 `FallbacksConfig{ triggerCodes(默认 AUTH/QUOTA/…宿主稳定失败码), chains[], cooldownMs, maxSwitchesPerStep, revertPolicy, recovery: 'timer'|'half-open' }`（config.d.ts:32-33,111-116）；
- 守卫三件套：自路由递归守卫（`FallbacksChain/*` 永不可派遣）、通配不作种子、failed-set+每步切换上限；
- 分时槽 `timeSlots`（首匹配前置）承接「峰谷价差」——penguin 的北京峰时段（9-12/14-18，谷半价）可作槽值来源。

失败处理各家可抄的部件（按需组合，不必全收）：
- **governor**：7 码白名单+401/403 黑名单+`afterPartialOutput=false`（首个语义 chunk 后绝不切模型）+排除集重跑（无预建链也能获得链效果）；
- **quota-takeover**：action 五值 `SWITCH/RESUME/WAIT/GIVEUP/IGNORE`+三级匹配（文案→code→status）+**provider 级放大熔断**（宿主「stops amplifying」文案=整个上游域名问题）+续跑幂等 candidateHash；
- **autotier**：失败三分类 permanent/transient/ignore+**effort 优先升档保 KV 前缀**（换 effort 不换模型优先，省缓存）+`FallbackRecord{tier,index,until}` TTL。

### 2.5 一句话总纲

> 主缝=派遣前查询工具（先例零例外不碰 llm/stream 改道）；换档持久落点只认 `agent.model.select()`；排序=governor 静态倍率序（真源）+quota-takeover 账本 mask（耗尽/冷却跳格）+Neptune810 感知打分（档内微调、id 兜底）；备选链抄 omdsh 合同（entries/链尾恰一官方/triggerCodes/cooldownMs/maxSwitchesPerStep/revertPolicy/half-open）；失败处理按需拼 governor 白名单+部分输出保护、quota-takeover 三级分类+放大熔断、autotier effort 保前缀。

---

## 3. 复用分级表

| 分级 | 对象 | 依据 | LICENSE |
|---|---|---|---|
| **直接复用** | governor `routing/strategies.ts`（credit_first/quality_first/manual 四策略+DecisionRecord）、`fallback/mod.ts`（失败分类+FallbackState）、`routing/filter.ts`（公共过滤器）；quota-takeover `src/classify.js`（纯函数零依赖分类器）；omdsh 链 schema 字段合同（config.d.ts） | 域模块独立无 DSH 依赖（governor AGENTS.md 自律：不直连 provider HTTP/不存凭据/域模块可测——复用时保持同纪律）；classify.js/quota-takeover 全家纯 JS | MIT（young-tim package.json:13；puppy-bai:61；omdsh LICENSE「MIT License, (c) 2026 dsh-external」【验】） |
| **改造借鉴** | Neptune810 `scoreEntry/chooseEntry` 加性打分+渠道健康账本（channels.js）；governor `audit-pipeline.ts` 决策双写+fail-closed；quota-takeover `compiler.js`（档优先遍历+excluded 留痕+waiting 语义+candidateHash）；autotier FallbackRecord TTL+意图层结构信号；omdsh `startActivation` 派遣盖章（可选增强，宿主演进需回归） | 需适配 mroute 的 channel_type 模型与宿主版本；打分权重/冷却常量按 mroute 财务口径重标定 | MIT（Neptune810 package.json:96；young-tim:13；puppy-bai:61；omdsh【验】） |
| **仅参考（概念）** | Alice-Marx 全产品：预设 tilt（economy/quality 权重倾斜+floor 夹取）、预算超限动作（自动降级/暂停询问）、订阅↔API 双通道 fallback、`semantics:'subjective-utility-not-objective-quality'` 诚实标注；penguin 关键词支配计分+北京峰时降级+峰谷省钱测算器 | 自成体系量级过大（639 文件）不直接取码；省钱视角的概念与 UI 文案值得抄 | MIT（Alice-Marx package.json:355；penguin-oo:15） |

**LICENSE 汇总**：六家 MIT（omdsh-dev、penguin-oo、Alice-Marx、Neptune810、puppy-bai、young-tim，均 package.json `"license":"MIT"` 逐条核验），**autotier Apache-2.0**（package.json:243【验】；其 THIRD_PARTY_NOTICES.md 声明自有新增为 Apache-2.0、内联的守卫规则库为 MIT）。引用 autotier 思想无需改许可；**直接拷代码**时按来源携带相应许可与 NOTICE。

---

## 执行说明（第 2 次派发）

前次执行者中断于 m4-partial（Neptune810 后），树日志 progress 留痕仅覆盖 4/7 家（omdsh/penguin/autotier/Neptune810）。本次：①对这四家的关键行号逐条抽验（上文标【验】，全部吻合；前次记录中 Neptune810 缝行号「L1770-1767」系笔误，实为 L1765-1766 effort 处理+L2824 事件注册）；②Alice-Marx/quota-takeover/llm-governor 三家直接补读源码（行号均为本次一手核验）；③LICENSE 七家全部从 package.json/LICENSE 原文核验。财务优先级设计建议在 §2 基于核验后的证据展开，前次给出的四条要点（主缝查询工具、autotier 0.2.2 情报、三层排序组合、omdsh 链结构）全部经一手源码证实。
