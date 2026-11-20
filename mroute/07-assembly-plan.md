# mroute「组装+自研」工程方案（07-assembly-plan.md）

- 树节点：mroute / mroute-W11-assembly
- 综合来源：`00-feasibility-report.md`（原综合）× `05-report-extension.md`（增补重排 M1–M6）× `06-market-scan.md`（市场空白确认）× `07a-balance-adapters.md`（W7 六包余额适配）× `07b-routing-engines.md`（W8 七家路由引擎）× `07c-subagent-dispatch.md`（W9 五插件派遣接缝）× `07d-eval-monitoring.md`（W10 八插件评测监测）
- 报告日期：2026-11-13
- 性质：**工程开工方案**——回答「哪些直接拿来、哪些抄设计改实现、哪些必须自研」，并把 M1 拆到可直接执行的颗粒度
- 引用约定：`07a§X`/`07b§X`/`07c§X`/`07d§X` = 四份源码分析章节；`00§X`/`05§X`/`06§X` 同前；`插件@文件:行号` = vendors/ 本地 checkout 源码位置

---

## 0. 一页结论

**mroute ≈ 三成直接复用 + 四成改造借鉴 + 三成自研。** 19 个社区插件源码（26 个 MIT/Apache-2.0 已逐包核验）提供了渠道端点实现、签名算法、宿主接缝、评测零件的全部「砖块」；mroute 自己要浇筑的只有 6 块「梁柱」——而其中最核心的 `channel_type` 财务排序引擎、券衰减、评测排名写回闭环、派遣前查询工具四件事，经 06 市场扫描确认在 10,778 个插件中**无任何先例**，差异化成立。

**五条关键裁决**（全部有源码级证据背书）：

| # | 裁决 | 依据 |
|---|------|------|
| 1 | 主缝 = 派遣前查询工具 `model_route_query`，**不改写任何请求**；v1 红线不碰 `llm/stream` 与 `agent/request` | 七家路由插件**零例外**不碰 llm/stream 改道（07b§2.1）；`agent/request` 改写在宿主 0.2.2 step-fixed selection 下被拒（autotier 0.2.2 一手实证，07b§2.2） |
| 2 | 适配器契约骨架抄 provider-usage v2，渠道形状抄 balance-monitor 六字段对象，目录/特殊签名抄 quota-panel；**唯一自设计分叉 = `describe()`→QuotaView JSON**（机读视图，不做 HTML 渲染） | 07a§汇总「契约骨架抄 Pkg 2、渠道形状抄 Pkg 5、目录抄 Pkg 1」+ 推荐接口草案 |
| 3 | 排序引擎 = 三层组合：**governor 静态倍率序（真源）+ quota-takeover 账本 mask（耗尽/冷却跳格）+ Neptune810 加性打分（档内微调、id 兜底）**，channel_type 作一级键、确定性全序、DecisionRecord 全留痕 | 07b§2.3 三家人各供一层；三家共同的可审计风格 |
| 4 | 换档持久落点只认 `agent.model.select()`（v2 才评估）；运行中额度 failover 的机读信号 = `agent/request-error` 五类码 + `turn/end QUOTA_EXCEEDED` | 07b§2.2；07c§0 核心新事实 2/3 |
| 5 | 评测通道②（宿主 llm 服务）被 4 插件独立实证；**effort 钉死用 `prepareCall` 第三参 configure 回调**（04 遗留点 1 的 effort 半边已补证）；指纹监测必须走通道①；finish kind 词表存在代次漂移 → 判分器宽表兼容 | 07d§2.1 表 + §2.2/§四修正表 |

---

## 1. 三分清单

### 1.1 直接复用（装现成插件 / 整文件·函数级移植，注明来源+LICENSE）

| # | 部件 | 来源插件 @ 路径 | LICENSE | 移植方式与落点 |
|---|------|----------------|---------|----------------|
| R1 | 指纹探针 + `diffCycle` 6 类比对 + FNV-1a hash + SHAPE_IGNORED 忽略表 | big-coming `lib/probe.js`（纯函数零依赖） | MIT | **整文件移植**；改 baseURL/凭据来源走 `ctx.credentials`；作 `reviewed_against` 的事件驱动复核锚点（07d§2.5） |
| R2 | TTFT/TPS 测量全套（`runProbeOnce`：prepareCall configure 回调钉 effort + bursty 防护 + usage 优先 + 3–5 采样中位数 + ttftSpread） | model-master `index.js:740-1025` | MIT | 函数级移植进 M5 性能探针模块；注释一起搬（「不钉 effort 静默继承会话档位」教训） |
| R3 | 阿里 ACS3-HMAC-SHA256 签名（纯函数）+ **黄金哈希测试** `test/bss-sign.test.mjs` | aliyun-balance `lib/bss-client.js` | MIT | B 类阿里 BSS 适配器核心；**连测试一起搬，禁止凭记忆重写**（07a 附·结论 2） |
| R4 | 阿里 RPC-V1 HMAC-SHA1 签名（官方黄金向量 `OLeaidS1JvxuMvnyHOwuJ+uX5qY=` 锁定 + percentEncode Java 对齐） | qwen-balance | MIT | 第二套阿里签名；**逐字抄**（注释明令不许「改进」Timestamp 格式——它是签名材料） |
| R5 | 方舟 AK/SK SigV4 变体签名（固定头序 `host;x-date;x-content-sha256;content-type` / 裸算法串 / `/request` scope）+「200+ResponseMetadata.Error」响应陷阱 | quota-panel | MIT | B 类方舟适配器核心；三处与 AWS 的差异注释必须随码移植 |
| R6 | balance-monitor 四渠道文件 `channels/{deepseek,kimi,zhipu,teamo}.js`（六字段渠道对象 + fetch 实现） | balance-monitor | MIT | **近乎原样移植**（去渲染层，fetch 返回改喂 describe()）；M2 首批三渠道的直接来源 |
| R7 | 渠道状态机（idle/loading/ready/unconfigured/error + stale 保留旧值 + revision 单调快照） | balance-monitor `service.js` | MIT | 平移进 mroute health 模块 |
| R8 | connection-test 探针（`probeAttempt/probeModel`：verdict 判决对象 + 错误码三集 RETRY/RETRY_ONCE/TRANSIENT + jittered backoff + same-origin fence） | connection-test `index.js:36-296` | MIT | M5 渠道探针 + webServer 围栏；错误码三集兼作熔断器失败分类（07d§2.3-6） |
| R9 | 模型枚举 + runtime 探针 + 200-但-错误对象校验（`collectRegistryModels/probeViaRuntime/validateSuccessBody`） | model-health `dist/index.js:224-505` | MIT | M5 评测前的模型清点与连通确认 |
| R10 | 模型目录聚合（33 行纯函数：listProviders + 逐家 listModels 单家失败降级 + current 路由） | subagent-setup `catalog-runtime.mjs:4-33` | MIT | `model_route_query` 目录数据源，逐行可抄 |
| R11 | 路由活校验 + **双 TTL 缓存**（成功 10min / 失败 1min；「catalog 读不到≠校验通过」不缓存成功） | route-pin `index.js:871-903` | MIT | 活校验模块；补充 00§3.3 缓存设计的「失败短缓存」细节 |
| R12 | 路由行渲染格式 + catalog 输出 schema（`- alias: displayName (provider/model) {efforts} — description`） | subagent-setup `catalog.mjs:24-57`、`tools.mjs:57-113` | MIT | `model_route_query` 输出渲染 |
| R13 | 失败分类器（三级匹配 文案→code→status + action 五值 SWITCH/RESUME/WAIT/GIVEUP/IGNORE + 冷却常量表 + provider 级放大熔断） | quota-takeover `src/classify.js`（纯函数零依赖） | MIT | M6 策略门失败分类；QUOTA/RATE_LIMIT 冷却常量照抄（60s 刻意非 5s 的注释一起搬） |
| R14 | governor 四策略 + DecisionRecord（`routing/strategies.ts` credit_first/quality_first/manual + 公共过滤器 `routing/filter.ts` + `fallback/mod.ts` 失败分类+FallbackState） | llm-governor | MIT | **排序引擎静态层真源**；域模块无 DSH 依赖（作者自律：不直连 provider HTTP/不存凭据），可直接搬（07b§3） |
| R15 | swarm-router 排名三函数 + usage 记账形状（`ranking.js` 63 行 + records 滚动 2000/byProvider/byModel/byKind 三桶） | swarm-router | MIT | v2 反馈排名可选用件（07d§2.6：v1 不做） |
| R16 | 整插件直接装（不抄码、与 mroute 并存）：**dsh-aliyun-balance** 悬浮挂件 | aliyun-balance | MIT | 立即可给阿里券数据一个可视化出口；mroute B 类适配器落地前的人工对账窗口 |

### 1.2 改造借鉴（抄哪个模块的哪个设计、怎么改）

| # | 抄什么 | 来源 | 怎么改（mroute 化） |
|---|--------|------|---------------------|
| B1 | provider-usage **v2 契约骨架**：ADAPTER_CONTRACT_VERSION / name 白名单 / providers 认领 / FetchContext 注入面（apiEndpoint/apiKey/timeout 5s/signal/utils+esc）/ **错误码闭集** / 结构校验器（`describeUsageStatsAdapterShape` 一次列全） | provider-usage `lib/shared/contracts.d.ts`（07a§Pkg2-D） | **把 formatCapsule/formatPanel 双渲染函数替换为一个 `describe()` 归一化函数，输出 QuotaView JSON 而非 HTML**——这是 mroute 唯一自设计分叉（07a§汇总）。错误码闭集追加财务特有项：`not-subscribed` / `html-response`（旧 one-api 200+HTML）/ `endpoint-forbidden` |
| B2 | quota-panel **目录驱动 + 双凭据引用**（refs+secretRefs AK/SK 双引用、目录条目 id/refs/secretRefs/endpoint/format/currency/tiers） | quota-panel（07a§Pkg1-A/B） | 并入 mroute 契约的 `CredentialSpec{refs, secretRefs?, envRefs?}`；目录驱动结构改为注册表 channels[] |
| B3 | balance-monitor **凭据三优先级**（env > model provider refs > user config ref，多候选冲突不擅自选）+ provider-usage **五级链** | balance-monitor `service.js resolveCredential`；provider-usage `registry/provider-config.js` | 合并为 mroute 三级精简链：`credentials seam（llm 目录→settingsPath 下钻→apiKeyEnv→resolve）> env {PROVIDER}_API_KEY > 显式配置`（07a§宿主侧纪律 1） |
| B4 | omdsh **备选链合同**（唯一完整链 schema）：`NamedChain{id,label,entries[],timeSlots}` + 链尾恰一官方模型 conformance 门 + `FallbacksConfig{triggerCodes 默认 AUTH/QUOTA…, cooldownMs, maxSwitchesPerStep, revertPolicy, recovery:'timer'|'half-open'}` + 守卫三件套（自路由递归守卫/通配不作种子/failed-set） | omdsh `config.d.ts:32-58,111-116`（07b§1.1/§2.4） | 直接采用字段形状进注册表 `fallbacks[]` 与全局链配置；`timeSlots` 承接峰谷价差（penguin 北京峰时段作槽值来源） |
| B5 | quota-takeover **编译器纪律**：档优先遍历 `for tier: for platform` + `chain[]+excluded[]`（why=exhausted\|cooling 留痕）+ `waiting=true+waitUntil=下一个 resetsAt` 终局语义 + candidateHash 续跑幂等 | quota-takeover `src/compiler.js`（07b§1.6/§2.3） | 落为排序引擎**动态层 mask**：静态序不变，账本命中即沉底/出列；全空时返回 waiting 语义让 lead 知道「等 reset 而非硬派」 |
| B6 | Neptune810 **加性打分 + 渠道健康账本**：`scoreEntry`（基分+类别加减−成本惩罚−峰时惩罚±感知项）+ 滚动窗口 20 次 + TTFT EWMA + failThreshold=3 + cooldownMs=60s + **一次成功提前解除冷却** + tie-break「冷却沉底→分→排名→相对成本→id 兜底」 | Neptune810 `lib/routing.js:421-473`、`lib/channels.js`（07b§1.5/§2.3） | 落为排序引擎**感知层**；打分权重按 mroute 财务口径重标定（channel_type 档位基分替代其 model tier 基分）；「Cooling is a demotion, not a ban」哲学照收 |
| B7 | governor **决策双写审计 + 部分输出保护**：pending→Session Event→committed 双写协议、审计失败 fail-closed（AUDIT_PERSIST_FAILED 不产生 Provider 调用）、`afterPartialOutput=false`（首个语义 chunk 后绝不切模型） | governor `audit-pipeline.ts:187-200`、`fallback/mod.ts`（07b§1.7/§2.2） | mroute v1 查询工具本身零副作用，但**排序结果 DecisionRecord 落盘沿用此纪律**（candidates/excluded/selected 全留痕、可重放）；双写协议存档为 v2 换档语义的安全下限 |
| B8 | eval-harness **assert 12 键集 + 哨兵 + 校准**：断言键到通道②可观测量的一一映射（07d§2.2 表）+ 哨兵 must-pass/must-fail 破判整轮 `instrument_unhealthy` + judge 末行 PASS/FAIL 协议 + TPR/TNR≥0.9 校准 + Wilson 95% 下界 provisional | eval-harness `src/types.ts`、`src/assert.ts`、`src/judge.ts`（07d§1.5/§2.2/§2.3） | **吸收键集映射，不整体复用 YAML 形状**（那是 headless-agent/session.jsonl 口径，mroute v1 是通道②流级观测）；`tool_result_contains` 降级为 `tool_args_schema` 顶替；⚠️ checkout 无 LICENSE 文件——抄代码前从 GitHub 补取 LICENSE，或仅借鉴形状不抄实现 |
| B9 | picker **换模执行链**（v2 可选，唯一采纳形态）：per-agent scoped 三瀑布（system-prompt/assemble 快照 + agent/request 改写 + agent/pre-step notice）+ `planInstall` noop/dispose/install 三态 + 复用既有 `model/selection` 事件类型 + `agent.id` 键控 override 表 | teammate-model-picker `index.js:100-196`、`route.mjs`（07c§5/§6.2） | v1 完全不做；v2 触发条件见 07c§6.2（三种实测症状之一才立项）；采纳时必修 policy 交集 + effort 剥离 + 幂等三护栏 |
| B10 | route-pin **startActivation 猴补纪律**（once-per-service：重挂只换 slot 不重复包；`Symbol.for` 能力旗标；dispose 按 hadOwn 精确还原 raw；probe 上报 seams）+ **armFailover**（`agent/request-error` 五类车道码 → WeakSet exactly-once 一次性改写） | route-pin `index.js:1129-1551, 1483-1530`（07c§4） | v2 的 continuable 注入与运行中额度 failover 蓝本；mroute 化 = 把静态 `failoverRoute` 升级为「按 mroute 排序表选下一可用路由」 |
| B11 | subagent-custom **policy 交集四态标注**（`routeAdviceFor`：named/allowlist/child-default/fork）+ **派遣可行性预检**（`tools.get(toolName,agent)` 可见性 / `subagents.getProvider` / `resolveMaxDepth` vs 委派深度） | subagent-custom `capabilities.mjs:34-128`（07c§1/§6.1-3/5） | **M6 的 policy 整合提前到查询层**：`model_route_query` 返回里直接给每条路由标四态+预检结果，让模型派遣前就知道哪条会过门 |
| B12 | director **校验分层**：schema 管逐字段形状（必填/非空白/kebab 键），跨字段语义**读时补**（悬空引用告警去重、不拒写）+ **双命名空间纪律**（transportProvider ≠ routeProvider） | director `settings.js:111-169`、`config.js:8-15`（07c§3/§6.3） | 注册表校验照此分层；注册表字段用 `routeProvider` 命名杜绝 R2 混淆；`fallbacks` 悬空引用读时告警 |
| B13 | agent-bench **compareScorecards**（三值 verdict 只由确定性断言驱动 + LLM drift 只记 note）+ **隔离 DSH_HOME**（`prepareBenchHome` 凭据只读复制绝不回写 + overlay YAML） | agent-bench `lib/scorecard.js:196-258`、`lib/host.js:96-190`（07d§1.4/§2.1/§三） | M5 两次 run 对比（「换模型哪条退化」呈现直接复用）；通道③ tier 争议抽检仲裁蓝本 |
| B14 | freemodels **人工评级四纪律**：grade 从 score 派生从不并存存储 / heuristic 回退封顶 63 < 最低人工评级 64 / 档位词整 token 匹配非子串 / 全序排序（score→context→effort→id）+ reason 必填 + `source:'table'|'heuristic'` 显式区分 | freemodels `src/rank.ts:1-276`（07d§1.8/§三） | M4 面板人工确认 tier 与 M5 suggested_tier 的数据结构：建议与人工不一致时显式 source 区分，「机器估分永远压不过人工确认」 |
| B15 | provider-usage **adapter-state.json 持久化纪律**（独占临时文件+fsync+原子 rename+目录 fsync；坏 JSON no-clobber 隔离 `.bak-<ts>` 留证、轮转 5 份、不自动回灌 fail-closed）+ JSONL 按天分片历史（maxAgeDays/maxSizeMB 清理） | provider-usage（07a§Pkg2-C） | mroute 插件数据目录：`eval-history/`（逐题明细）、`ledger/`（额度账本）、`leaderboards/`（榜单快照）全部照此纪律 |
| B16 | aliyun-balance **test-before-save**（测试连接绝不先落盘，缺哪侧回退用已存侧支持只换 SK）+ **幂等激活**（disposers 闭包活数组 + inject fiber 一并释放，防 duplicate route 双轮询） | aliyun-balance（07a§Pkg3-A/C） | mroute 凭据设置流程与 `apply()` 激活骨架的直接纪律来源 |
| B17 | musage **懒预热轮询**（只覆盖 client 请求过的 provider）+ **失败退避缓存**（5s×2^n 封顶 30min，失败结果也占缓存位） | musage（07a§Pkg6-C） | 并入 00§3.3 缓存设计：余额缓存 TTL≥60s + 单飞去重 + 失败退避占位 + 懒预热（没人看的渠道不盲拉） |
| B18 | model-master **榜单快照工程模式**（provenance 字段 sourceKind/isOnline/surveyDate + 快照逐字节相同不写盘 + in-flight 去重 + 最小间隔 60s/force 10s）+ **OpenRouter /api/v1/models 作榜单第 0 源**（免鉴权机读含三指数+Elo+定价+上下文） | model-master `index.js:119-313`（07d§1.1/§2.5） | M6 外部榜单同步器直接照抄；M6 榜单清单把 OpenRouter 列为第 0 源（Aider/SWE-bench 顺延） |
| B19 | eval-harness **finish kind 词表分歧处置**（三插件三种词表：completed|stop|tool-calls vs completed|max-tokens|error|aborted vs +refusal） | connection-test `index.js:214`、swarm-router `index.js:51-60`（07d§四-2） | mroute 判分器对 finish kind **宽表兼容**（`completed|stop` 均算成功，未知 kind 显式失败附原文，不许静默放行） |
| B20 | swarm-router **usage 采集 sessionId 归因**（`llm/stream` global 监听 + `options.sessionId===childSessionId` 相关性过滤 + **逐 chunk forward** 保下游） | swarm-router `index.js:362-415` 注释实录（07d§1.7） | M5 通道②跨子会话 usage 采集的必守纪律（并发子会话交叉污染防线） |

### 1.3 自研核心（mroute 独有，市场无先例）

| # | 模块 | 为什么市场无先例 | 依托的组装件 |
|---|------|------------------|--------------|
| S1 | **channel_type 财务排序引擎**（monthly > voucher > prepaid 三池分离；包月与预充值是独立额度池，不拿「有余额」冒充「套餐有剩余」） | 06§三空白 1：最接近的 quota-takeover 绑定单一 OFM 网关、llm-governor 极小众渠道不明——「财务维度 × 通用多渠道」无人做 | R14（governor 静态层）+ B5（quota-takeover mask 层）+ B6（Neptune810 感知层）；**三层组合本身即自研** |
| S2 | **券衰减排序**：限期券「剩余额 ÷ 剩余天数」衰减加权、先用快过期的券 | 06§三空白 2；aliyun-balance/qwen-balance 有券**数据**但无衰减**排序** | R3/R4（券端点与字段）+ R16（券到期日先例数据源） |
| S3 | **评测→suggested_tier→人工确认→写回注册表闭环**（EvalReport diff 高亮 → 面板「确认采纳」→ Host 侧 configEditor.edit 原子写回 registry_version+1 + eval 摘要 + reviewed_at 刷新） | 06§三空白 3：零件齐全（eval-harness 框架 / model-master 实测 / freemodels 人工评级）**无人串联** | B8（判分纪律）+ R2（探针）+ B13（run 对比）+ B14（人工评级纪律）+ 05§2.2 数据流二 |
| S4 | **model_route_query 查询工具**（主动查询 + 余额/健康排序 + policy 四态 + 派遣预检 + 降级 inherit 语义） | 06§一：subagent-setup 是被动元数据表（静态别名清单），无人做「查询时点的动态余额排序参考」 | R10/R11/R12（目录/活校验/渲染）+ B11（policy 四态/预检）+ S1（排序引擎） |
| S5 | **注册表 volatile schema**（各字段 .volatile() 化 + eval 子对象 + manual 统一落点 + reviewed_at/reviewed_against 三锚点 + 指纹事件驱动复核） | 无先例对象可抄——是 00§3.1 × 05§6 风险 8 × 07c§6.3 × 07d§2.4 四方约束的交集设计 | B12（校验分层）+ R1（指纹锚点）+ 07a§宿主侧纪律 8（schemastery 三级解析兜底） |
| S6 | **QuotaView 归一化机读视图**（describe()→JSON：kind/currency/balance/total/used/windows/vouchers + 「缺失绝不伪造 0%」） | 07a 明确指认的唯一自设计分叉点（所有先例都渲染 HTML 给人看，mroute 输出结构化 JSON 给模型看） | B1（契约骨架）+ B2（视图模型纪律：上游原始 JSON 不出宿主） |

---

## 2. 组装架构图（文字版）

在 05§2 架构图基础上，**每个模块标注来源（〔复用〕〔借鉴〕〔自研〕+ 源码出处）**：

```
┌─ 注入层 ────────────────────────────────────────────────────────────────┐
│ ① Host Tool: model_route_query（核，模型消费）                            │
│    〔自研 S4〕骨架；目录/活校验/渲染 =〔复用〕setup catalog-runtime.mjs /   │
│    route-pin checkRoute / setup catalog.mjs；policy 四态+预检 =〔借鉴〕    │
│    subagent-custom capabilities.mjs                                       │
│ ② systemPrompt.section：「派遣前先查路由」一句提示 〔自研：一句文案〕        │
│ ⑤ 设置面板分区「模型路由」（M4，Client slot+React）                        │
│    〔借鉴〕宿主 subagent 授权模型清单页同构 + freemodels rank.ts 人工评级   │
│    四纪律 + picker 客户端主题做法（类名前缀/只走 --dsw-alias-* token）      │
│ ⑥ Host Tool: model_eval_run（M5 辅入口，配 tools.guard/ask）              │
│    〔借鉴〕connection-test webServer 围栏（R8）+ 04§E 成本护栏设计          │
└──────┬──────────────────────────────────────────────────────┬───────────┘
       │ 读（缓存优先）                                          │ 人工触发
┌─ 查询/排序层 ─▼────────────────────────────────────────┐ ┌─ 评测层（M5）▼──────────────────┐
│ model_route_query{capability, budget, tier_min, ...}    │ │ 通道② ctx.llm.stream / prepareCall│
│ = 读注册表 → 逐渠道取余额（缓存优先）                     │ │   〔复用 R2 model-master 钉 effort；│
│   → 财务/能力加权排序                                    │ │   〔复用 R9 model-health 枚举+200 校验〕│
│ 排序因子：channel_type > tier > priority                 │ │ ×①直连 HTTP：〔复用 R1 big-coming  │
│           > eval.composite（tier 内次级，建议性）         │ │   指纹快照〕（宿主流不透出信封字段）   │
│ ★排序引擎〔自研 S1〕= 三层组合：                          │ │ ×③子会话仲裁：〔借鉴 B13 agent-bench│
│   L1 静态真源〔复用 R14 governor strategies.ts〕          │ │   隔离 DSH_HOME〕                 │
│   L2 账本 mask〔借鉴 B5 quota-takeover compiler〕        │ │ 资产：自建固定集（四类各10-20题，    │
│   L3 感知打分〔借鉴 B6 Neptune810 scoreEntry〕           │ │   suite_version 化）+ 判分器       │
│ 产出 DecisionRecord〔借鉴 B7 governor 双写留痕〕          │ │   〔借鉴 B8 eval-harness 键集映射+  │
└──────┬──────────────────────────────────────────────────┘ │   宽表 finish kind〕               │
       │ 两条写链（05§2.1/2.2 原样有效）                       │ → EvalReport + fingerprint diff    │
┌─ 数据层 ─▼───────────────────────────────────────────────────┐ │   〔复用 R1 diffCycle〕            │
│ 模型注册表 = 插件自有 volatile Config 〔自研 S5〕               │ │ → 面板 diff 高亮 → 人工「确认采纳」  │
│   channel_type/tier/priority/fallbacks/reviewed_at            │ │   〔自研 S3 闭环；借鉴 B14 freemodels│
│   各自 .volatile()；eval 子对象（M1 预留 / M5 填充：            │ │   评级纪律〕→ Host configEditor.edit│
│   applied_effort/instrument_healthy/probe/fingerprint）        │ │   写回（registry_version+1）        │
│   校验分层〔借鉴 B12 director：schema 管形状、读时管语义〕        │ │ 成本护栏：预算帽/余额联动/包月优先/   │
│ 适配器层（A Key直读 / B AK·CLI / C 未文档化(熔断) / D 人工）     │ │   prepaid 冒烟/串行限流/熔断续跑     │
│   契约骨架〔借鉴 B1 provider-usage v2 → describe() 分叉〕       │ └─────────────────────────────────┘
│   渠道对象〔复用 R6 balance-monitor channels/*.js〕             │
│   签名实现〔复用 R3 aliyun ACS3 / R4 qwen RPC-V1 / R5 方舟〕    │
│   QuotaView 归一化视图〔自研 S6〕                               │
│ 缓存+熔断：TTL≥60s+单飞+失败退避占位〔借鉴 B17 musage〕          │
│   + health 状态机+revision 快照〔复用 R7 balance-monitor〕      │
│   + 失败分类〔复用 R8 connection-test 错误码三集〕               │
│ 凭据：ctx.credentials（绝不进 Config）                          │
│   解析链〔借鉴 B3 balance-monitor×provider-usage 合并三级链〕    │
│   设置流程〔借鉴 B16 aliyun-balance test-before-save〕          │
│ 插件数据目录〔借鉴 B15 provider-usage 原子写/分片纪律〕           │
│   eval-history/<run_id>.json / ledger/ / leaderboards/         │
│   （榜单同步器 M6：〔借鉴 B18 model-master 快照模式 +            │
│     OpenRouter /api/v1/models 第 0 源〕）                       │
└───────────────────────────────────────────────────────────────┘
```

**图上不出现的红线**（组装方案的边界）：`llm/stream` 改道（01§C-②，00§5 风险 5 明确不做）；`agent/request` 改写（v2 才评估且只采纳 picker scoped 形态）；llm/stream 监听仅限「观察记账」先例形态（governor/quota-takeover 07b§1 表）。

---

## 3. 修订后 M1 开工方案（可直接执行的颗粒度）

> M1 范围沿用 05§5.1 判定**不变**：静态注册表 + 查询工具 + manual 登记 + 排序引擎（纯参考层，零外呼）；验收在 00§6 原四条上加 05§5.3 两条。适配器四渠道为 **M2 首批**，但接口与目录在 M1 定稿（M1 落 manual stub，查询层对「适配器缺席」已降级）。

### 3.1 包结构建议（Host 半 / Client 半文件清单）

```
mroute/                              ← 插件包根（cordis 标准四导出）
├── package.json                     ← name: "dsh-mroute"；engines.dsh 声明；接缝包 peer optional
├── LICENSE                          ← MIT（mroute 本体）
├── NOTICE.md                        ← ★第三方复用出处表（R1-R16：插件名@版本 / 文件 / LICENSE）——§4.2 合规的落点
├── README.md
├── lib/                             ══ Host 半（M1 全部交付）══
│   ├── index.js                     ← name/inject/Config/apply 四导出
│   │                                  apply 骨架抄〔B16〕幂等激活纪律（disposers 活数组+fiber 释放）
│   ├── config-schema.js             ← 注册表 schemastery schema（§3.2 定稿要点全落这里）
│   │                                  schemastery 三级解析兜底〔07a Pkg4 实录〕
│   ├── registry-read.js             ← 读时语义校验〔借鉴 B12〕：悬空 fallbacks/未知 provider 告警去重、
│   │                                  registry_version/reviewed_at 超期提示
│   ├── catalog.js                   ← llm.listProviders()+逐家 listModels() 聚合降级+current
│   │                                  〔复用 R10：setup catalog-runtime.mjs 33 行〕
│   ├── livecheck.js                 ← 活校验+双 TTL 缓存（成功 10min/失败 1min）
│   │                                  〔复用 R11：route-pin index.js:871-903〕
│   ├── policy.js                    ← policy 四态标注（named/allowlist/child-default/fork）
│   │                                  〔借鉴 B11：subagent-custom routeAdviceFor〕
│   ├── precheck.js                  ← 派遣可行性预检（工具可见性/provider 可路由/深度上限）
│   │                                  〔借鉴 B11：subagent-custom capabilities.mjs:34-99 整段搬〕
│   ├── ranking.js                   ← ★三层排序引擎（纯函数+DecisionRecord）〔自研 S1〕
│   │                                  静态层抄〔R14 governor strategies.ts〕、mask 层借〔B5〕、
│   │                                  感知层借〔B6〕；留痕纪律借〔B7〕
│   ├── ledger.js                    ← 动态账本（exhausted-until/cooldown-until/连续失败计数）
│   │                                  M1 空账本占位（manual-only 时全空→退化为静态序）；M2 起 QUOTA
│   │                                  信号写入（07c§0：turn/end QUOTA_EXCEEDED 机读信号）
│   ├── health.js                    ← health 状态机+熔断器〔复用 R7 状态机 + R8 错误码三集〕
│   │                                  M1 占位（manual 渠道恒 ok/unknown）；M2 起 A 类生效
│   ├── adapters/
│   │   ├── contract.js              ← 适配器契约+结构校验器〔借鉴 B1 provider-usage v2〕
│   │   │                              describe()→QuotaView 分叉〔自研 S6〕在此定义
│   │   ├── manual.js                ← D 类读数 stub（M1 全量走这个；manual 缺失→unknown 不伪造）
│   │   └── deepseek.js / kimi.js / siliconflow.js / openrouter.js
│   │                                ← M2 首批（M1 仅建目录与契约占位，§3.3）
│   ├── quota-cache.js               ← 缓存+单飞+失败退避+懒预热〔借鉴 B17〕（M2 启用；M1 直读 manual）
│   ├── tool-query.js                ← model_route_query 工具定义+execute（§3.4 返回 schema）
│   ├── prompt-section.js            ← systemPrompt.section 提示（一句话+调用示例+降级说明）
│   └── webserver.js                 ← 只读诊断路由（/api/mroute/registry-dump，loopback+same-origin
│                                      围栏抄〔B16/R8〕；M1 可选，调试用）
└── client/                          ══ Client 半（M1 不交付）══
    └── (M4 填充：index.js + registry-editor 组件 + eval-diff 组件 + locale 词典×8)
                                       M1 仅在 package.json dsh.client manifest 预留声明位
```

**M1 起就不引入的东西**：包装 provider、startActivation 猴补、agent/request 监听、llm/stream 监听、外部 HTTP 依赖（评测 judge v2 才有且直连）。

### 3.2 注册表 schema 定稿要点（volatile 化 + eval 子对象 + 嵌套降级预案）

1. **volatile 化结构**（05§5.3 验收 5；05§6 风险 8）：可 UI 编辑字段（channel_type/tier/priority/fallbacks/manual/reviewed_at/…）按「**对象根下固定命名字段各自 `.volatile()`**」定稿；**禁止**把整张注册表做成一个 volatile dict（宿主 volatile 路径校验拒绝动态路径）。
2. **数组 volatile 陷阱**（07a Pkg4 实录）：数组自身 volatile 后，其**元素字段不能再标 volatile**；数组编辑统一**整条替换**语义（正好匹配列表编辑）。`channels[]` 与 `fallbacks[]` 均按整条替换设计。
3. **嵌套对象降级预案**（07c§4-D route-pin `stepsJson` 坑实录；07c§6.3-2）：schemastery 3.18.5 部分构建缺 `z.record/z.dict`、`z.any` 丢嵌套对象。**M1 定稿前对目标 DSH 版本做一次实测**：`capability{}`、`manual{}`、`eval{}` 三个嵌套对象写入 Config 后重启读回，验证逐键存活；任一不通过 → 该字段降级为 **JSON 字符串字段**（`capabilityJson/manualJson/evalJson`）+ 读取侧 parse + schema_version 标注。实测结论写进 `config-schema.js` 头注。
4. **eval 子对象预留**（05§5.3 验收 6；07d§2.4 字段集）：M1 预留可空对象；M5 填充清单冻结为——`last_run / scores{四类} / composite / suggest{tier,priority} / evidence_refs`（04§D-3 原 fields）+ **追加四个源码实证字段**：`applied_effort`（评的是哪个档）、`instrument_healthy`（哨兵破判整轮不进排名）、`probe{ttft_ms,tps,samples,ttft_spread}`（性能参考列，不进 composite）、`fingerprint{system_fingerprint,prompt_tokens,shape_hash,checked_at}`（事件驱动复核锚）。
5. **校验分层**（借鉴 B12）：schemastery 只管逐字段形状（必填/枚举闭集/kebab-case id/正整数 priority）；跨字段语义**读时补**——`fallbacks` 引用不存在的 channel id、`provider` 不在 `llm.listProviders()` 交集、`reviewed_at` 超 90 天，全部 `registry-read.js` 读时告警并降权，**不拒写**（避免把编辑器锁死）。
6. **双命名空间纪律**（07c§6.3-4）：字段名用 `routeProvider`（LLM 路由，进 assignee），**不用裸 `provider`**；`transportProvider`（spawn/fork）v1 不注册不使用，仅文档注明区别。
7. **凭据字段**：`credential_ref` 用 `z.string().role('credential-ref')`（balance-monitor 实录，设置 UI 按凭据引用渲染）；**密钥本体永不进 Config**（00§5 风险 2）。
8. **复核锚三件套**：`registry_version`（整型递增）/ `reviewed_at`（人工复核日期）/ `reviewed_against`（M5 起挂三锚点：`eval-suite@x.y.z + arena@日期 + fingerprint@hash`，07d§2.4）。
9. **schema 演进兼容**：`registry_version` 驱动读侧兼容（老版本缺 eval → 视为空对象；缺 manual → 视为 unknown），对齐 freemodels `catalogVersion` 形状版本做法（B14）。

### 3.3 首版适配器清单（M1 落 manual stub；四个 A 类渠道为 M2 首批，实现出处如下）

| # | 渠道 | 适配器 | 端点与解析 | 实现出处（移植源） | 备注 |
|---|------|--------|-----------|---------------------|------|
| 1 | DeepSeek | A | `GET api.deepseek.com/user/balance`（Bearer）→ `balance_infos[]{currency,total_balance,topped_up_balance,granted_balance}` + `is_available` | balance-monitor `channels/deepseek.js`（R6 近原样）；quota-panel/musage 同端点三家互证（07a 速查表） | 实现时先探宿主 `deepseekAccount.getBalance` 先例可用性（00§3.2），宿主服务在则优先走宿主、HTTP 兜底 |
| 2 | Kimi（CN） | A | `GET api.moonshot.cn/v1/users/me/balance` → `{status,code,data:{available_balance,cash_balance,voucher_balance}}` | balance-monitor `channels/kimi.js`（R6） | 与 Moonshot 国际站 / Kimi Coding **非同一账户体系**，不误触发（balance-monitor README 实录） |
| 3 | SiliconFlow | A | `GET api.siliconflow.{com,cn}/v1/user/info` → `data:{balance,chargeBalance,totalUsage}` | quota-panel format 适配器（07a§Pkg1-B 表；双站点独立 id） | 国际/国内双 endpoint 按 credentialRef 分行 |
| 4 | OpenRouter | A | `GET openrouter.ai/api/v1/credits` → `data:{total_credits,total_usage}`，余额=差值 | quota-panel 与 balance-monitor 同端点两家互证 | `/credits` 即可，无需 Management Key；M3 可选 /credits 全量版 |

**M1 阶段这四渠道的行为**：注册表内置静态条目（tier/channel_type/capability/fallbacks 齐全），`balance.adapter` 已标 A，但查询层发现适配器未注册 → 走 `manual` 登记值 + 返回标注「人工登记（自动余额 M2 接入）」——manual 是所有适配器失败/缺席的统一落点（00§3.1 设计要点），这保证 M1 的排序表已完整可演示。

### 3.4 model_route_query 工具返回 schema 草案（对齐 07c policy 四态 + 活校验 + 预检）

**入参**（全部可选，缺省=全量排序表）：

```jsonc
{
  "capability": "coding",            // 能力需求（对 capability 子字段过滤）
  "tier_min": "domestic_sota",       // 最低档位
  "budget": "monthly_first",         // 预留：排序倾向（v1 仅 monthly_first 一档）
  "exclude_degraded": true,          // 剔除 degraded 渠道（缺省只降权标注不剔除）
  "refresh": false                   // 强制绕过缓存
}
```

**返回**（QuotaView 机读纪律：上游原始 JSON 不出宿主，借鉴 B2/07a Pkg1）：

```jsonc
{
  "current": { "provider": "zai-coding-cn", "model": "glm-…" },      // 〔R10〕当前会话路由
  "routes": [                                                        // 已按排序引擎全序输出
    {
      "rank": 1,
      "channel_id": "zai-coding-cn",
      "route": { "provider": "zai-coding-cn", "model": "glm-…" },    // routeProvider 命名纪律（§3.2-6）
      "tier": "domestic_sota",
      "channel_type": "monthly",
      "efforts": ["low", "mid", "high*"],                            // 〔R12〕* =模型默认档
      "description": "GLM Coding 包月，coding 强；适合日常实现与审查", // ★措辞纪律（§下方注 1）
      "quota": {                                   // 〔自研 S6 QuotaView〕
        "kind": "usage", "balance": null, "currency": null,
        "windows": [{ "lane": "five_hour", "usedPercent": 28, "resetsAt": "…" }],
        "source": "manual",                        // manual | machine（M1 恒 manual）
        "as_of": "2026-11-13T12:00:00Z", "note": "人工登记（自动余额 M2 接入）"
      },
      "health": { "state": "ok", "last_check_at": "…", "note": null },  // ok|degraded|unknown〔R7〕
      "policy": "named",                           // 〔B11 四态〕named|allowlist|child-default|fork
      "dispatch_precheck": {                       // 〔B11 预检〕
        "can_dispatch": true,
        "provider_routable": true,                 // 活校验通过〔R11 双 TTL〕
        "tool_visibility_ok": true,
        "max_depth": 3, "depth_remaining": 2
      },
      "score": {                                   // DecisionRecord 摘要〔B7〕：三层明细可解释
        "static": 95,                              // L1：channel_type 序×tier×priority
        "mask": null,                              // L2：null=无账本命中；否则 {why:"cooling",until:"…"}
        "adjust": -2, "adjust_note": "eval.composite 未建立（M5 前）；峰时惩罚 0"
      },
      "reason": "包月优先 + coding 强 + policy 命中清单",   // 一句话排序理由（00§4 返回示例口径）
      "review_alerts": []                          // reviewed_at 超期/指纹变化〔S5/R1〕，命中则填
    }
  ],
  "excluded": [                                    // 被淘汰/沉底条目及原因〔B5 留痕纪律〕
    { "channel_id": "deepseek-official", "why": "exhausted", "until": "2026-11-13T18:00:00Z" }
  ],
  "inherit_fallback": "无可用路由时不填 provider/model——子代理继承父路由（宿主缺省链语义）",
                                                   // 〔07c§6.1-7〕降级语义写进返回
  "meta": {
    "registry_version": 3, "reviewed_at": "2026-11-13",
    "catalog_staleness": "fresh",                  // 活校验缓存状态〔R11〕
    "ranking_version": "1"
  }
}
```

> **注 1（输出措辞纪律，07c§6.1-4）**：路由条目以「用途描述」为主键、provider/model 为注脚——subagent-setup 中性别名实验实测：带模型身份暗示的句柄使命令模型按名字脑补（0/2 命中），中性句柄 8/8 命中。`channel_id` 保持中性（渠道语义名而非模型能力名），强弱势信息只写进 description。
> **注 2（v1 红线，07c§6.1-8）**：本工具零副作用、不改写任何请求；`tools.guard()` 拒绝（欠费/禁用渠道+替代建议）是 M6 项；插件不做 policy 权威，只做四态**标注**。

### 3.5 排序引擎伪代码（channel_type 三层组合落到代码形状）

```js
// ranking.js —— 纯函数；同输入同输出可重放；产出 DecisionRecord
function rankRoutes({ channels, quota, ledger, evalScores, ctx }) {
  const decision = { candidates: [], excluded: [], steps: [] };

  // ── 第 0 步：硬过滤（静态层前置，governor 公共过滤器模式〔R14 filter.ts〕）
  let pool = channels.filter(ch => {
    const live = ctx.livecheck(ch.routeProvider, ch.models);        // 〔R11〕双 TTL 活校验
    if (!live.ok) { decision.excluded.push({ id: ch.id, why: 'unroutable', detail: live.reason }); return false; }
    if (!capabilityMatch(ch, ctx.capability)) { decision.excluded.push({ id: ch.id, why: 'capability' }); return false; }
    return true;
  });

  // ── L1 静态层（真源，governor credit_first 改造〔R14〕：倍率升序→quality 降序→字典序）
  //    mroute 化：channel_type 作一级键；同档内「成本升序」=包月(0) < 券(1) < 预充值(2)，
  //    同 channel_type 内按 priority 降序 → routeProvider 字典序（确定性兜底）
  const STATIC_RANK = { monthly: 0, voucher: 1, prepaid: 2 };
  pool.sort((a, b) =>
    STATIC_RANK[a.channel_type] - STATIC_RANK[b.channel_type] ||
    b.priority - a.priority ||
    (a.routeProvider < b.routeProvider ? -1 : 1));

  //    券衰减（自研 S2）：voucher 档内重排——先用快过期的券
  //    decayKey = remaining / max(remainingDays, 1)；小者（接近过期且还剩得多）排前
  pool = stableReorderWithin(pool, 'voucher', ch => {
    const v = ch.manual?.voucher ?? quota(ch.id)?.vouchers?.[0];
    if (!v?.expiryTime || v.balance == null) return 0;              // 缺数据不打乱原序
    const days = daysUntil(v.expiryTime);
    return (Number(v.balance) / Math.max(days, 1));                 // 剩余额 ÷ 剩余天数
  });

  // ── L2 动态层（mask，quota-takeover 模式〔B5〕）：静态序不变，账本命中即沉底/出列
  pool = pool.map(ch => {
    const hit = ledger.lookup(ch.id);                               // {kind:'exhausted'|'cooling', until}
    if (hit) {
      decision.excluded.push({ id: ch.id, why: hit.kind, until: hit.until });
      return { ...ch, __mask: hit };                                // exhausted→出列；cooling→沉底
    }
    if (quota(ch.id)?.health?.state === 'degraded')                 // 〔R7〕熔断降权（标注不隐藏）
      return { ...ch, __mask: { kind: 'degraded' } };
    return ch;
  });

  // ── L3 感知层（微调，Neptune810 加性打分改造〔B6〕）：同 channel_type 档内微调
  //    score = base(channel_type/tier) + eval.composite 加分(M5 前=0)
  //            − costPenalty − peakPenalty − healthPenalty
  //    健康惩罚必须可恢复：一次成功解除（R7/R6 状态机语义），非封禁
  for (const ch of pool) ch.__score = scoreEntry(ch, { evalScores, ctx });

  // ── 终序：mask 沉底 → 分数降序 → priority 降序 → id 字典序（Neptune810 tie-break 纪律：
  //    「冷却沉底→分→排名→相对成本→id 兜底」，全序确定性）
  pool.sort((a, b) => maskRank(a) - maskRank(b) || b.__score - a.__score ||
                      b.priority - a.priority || cmpId(a, b));

  // ── 全空终局（quota-takeover waiting 语义〔B5〕）：全部 exhausted/cooldown 时
  //    不硬派——返回 waiting + 最近 resetsAt，让 lead 决定等待或走 inherit
  if (pool.every(ch => ch.__mask?.kind === 'exhausted')) {
    return { routes: [], waiting: true, waitUntil: minResetAt(pool), decision };
  }
  return { routes: pool, waiting: false, decision };   // decision 进 DecisionRecord 落盘〔B7〕
}
```

**组合纪律**（07b§2.3 原文有效）：三层各自产出可解释中间量（静态序=配置、mask=账本条目、微调=逐项加减分），最终排序可重放；DecisionRecord（candidates/excluded/selected/逐项加减分）落 `ledger/decision-<ts>.json`（B15 原子写纪律）。

### 3.6 M1 实施步骤与每步验收标准

| 步骤 | 内容（颗粒度） | 验收标准（对齐 00§6 M1 + 05§5.3 增补） |
|------|----------------|----------------------------------------|
| S1 | 包骨架：package.json / 四导出 / apply 幂等激活〔B16〕/ NOTICE.md 出处在册 | 插件在本机 profile 可安装激活、可停用，二次激活无 duplicate route（对应 00§6-M1.1 前置）；NOTICE 覆盖全部 R 项（§4.2 自查表） |
| S2 | config-schema.js 定稿：§3.2 全部要点落码；**嵌套对象 Config 实测**（capability/manual/eval 写入→重启→读回逐键核对；不过则降级 JSON 字符串） | ① 不合 schema 的注册表在激活时报**可读**校验错误（00§6-M1.2）；② volatile 结构审查通过：可编辑字段各自 `.volatile()`、无整表 volatile dict、无「数组 volatile 后元素再标」（05§5.3-5）；③ eval 子对象位存在且 schema 演进文档注明 M5 填充清单（05§5.3-6）；④ 嵌套实测结论写入 config-schema.js 头注（通过/降级二选一有据） |
| S3 | catalog.js + livecheck.js：目录聚合降级〔R10〕+ 双 TTL 活校验〔R11〕 | `provider/models` 与 `llm.listProviders()` 交集校验生效——注册表写了不存在的 provider 时条目标 unknown 并降权（00§6-M1.3）；制造一次 catalog 失败→1min 失败 TTL 生效、恢复后不把「读不到」当「通过」（07c§6.1-2） |
| S4 | ranking.js 三层引擎 + ledger.js 空账本：§3.5 伪代码落码 + DecisionRecord 落盘〔B7/B15〕 | 排序确定性：同一注册表+同一账本输入，连续两次调用输出全序一致、DecisionRecord 逐字节一致；channel_type 一级键生效（monthly 券 prepaid 分档）；DecisionRecord 含 excluded[] 与逐项加减分 |
| S5 | tool-query.js + prompt-section.js：§3.4 返回 schema；policy 四态〔B11〕+ 预检〔B11〕+ 降级 inherit 语义 | ① `model_route_query` 会话内可调用，返回带排序理由的渠道列表（含 manual 余额与「人工登记」标注）（00§6-M1.1）；② policy 四态标注与 `sessionProjections`/settings 两读法之一实读一致；③ 无可用路由时返回 inherit 语义明示；④ systemPrompt.section 在新会话提示文本中出现（00§6-M1.4） |
| S6 | 端到端联调：本机 5 provider（deepseek-official/deepseek-account/opencode-go/zai-coding-cn/xiaomi，00§7 实测清单）跑通「查询→选路→派遣」闭环 | 完整闭环一次：查询返回排序表 → lead 选第 1 名填派遣参数 → 宿主活校验/策略门通过 → 派遣发生；被 policy 拒时 lead 按表换下一项成功（00§4 消费路径全重放）；M1 六条验收全绿 |

---

## 4. 依赖与冲突风险

### 4.1 与已装插件的同装冲突清单

| 冲突面 | 涉及插件 | 冲突内容 | mroute 对策 |
|--------|----------|----------|-------------|
| 工具重名顶替 | subagent-setup（5 工具）/ subagent-director（subagent_role） | setup README:151-156 实录：同类插件同装时工具重名顶替 | mroute **不建任何委派工具**，`model_route_query` 全市场无重名先例（06 全目录扫描）；与上述插件机制正交 |
| systemPrompt 指引叠加 | subagent-setup（别名清单段）/ 各路由插件提示段 | 两套「如何选路」并存 → 模型指引混乱（setup README 同装三条之一） | mroute 提示文案限定为一句话+工具名；若用户已装 setup，建议二选一（§4.4） |
| webServer 路由 | quota-panel/balance-monitor/musage/aliyun-balance | 各家前缀独立（`/api/<插件名>/*`），**无路径冲突** | 维持 mroute 独立前缀 `/api/mroute/*`；围栏标准取各家最严并集（B16/R8） |
| credentials ref 共享 | quota-panel/balance-monitor/musage | 都按 `<UPPER>_API_KEY` 规范解析同一 ref（如 DEEPSEEK_API_KEY） | **共享即互补无冲突**：mroute 沿用命名规范，模型 Key 与余额查询凭证分槽（00§3.2 凭证隔离纪律照守） |
| 改写缝叠加（未来） | picker/route-pin（v2 若做） | 多插件同挂 agent/request scoped 瀑布时序未定义 | v1 无此面；v2 立项时先审同装矩阵，且猴补纪律 once-per-service（B10）防重复包 |
| catalog 双源 | subagent-setup catalog 工具 | 目录聚合能力重叠（R10 来源即它） | 抄码不装插件——mroute 内嵌 33 行聚合函数，不依赖 setup 在装 |

### 4.2 许可合规（引用方式）

- **MIT（26 个来源包中除 autotier 外全部）**：允许复制/修改/商用/再分发，义务=保留版权与许可声明。落地方式：
  1. 每个移植文件头保留原版权行 + `Source: <插件名>@<版本> <文件路径>`（NOTICE.md 汇总表同步）；
  2. mroute 自身 LICENSE 用 MIT，NOTICE.md 列全 R1–R16 出处；
  3. **测试与代码一起搬**（R3 黄金哈希 / R4 官方向量）——签名实现的正确性锚不可分离。
- **Apache-2.0（仅 autotier）**：引用**思想**（意图分层/FallbackRecord TTL/宿主能力探测模式）无需改许可；**直接拷代码**才需携带 NOTICE 与许可文本。mroute 对 autotier 取「仅参考」，不取码——规避双许可管理成本。
- **eval-harness 特别注意**（07d§三）：package.json 声明 MIT 但 checkout **无 LICENSE 文件**——B8 借鉴项默认「只借鉴形状不抄实现」；若未来要抄 judge 协议实现，先从 GitHub 仓库补取 LICENSE 并留档。
- **自我约束继承**：governor 域模块的作者自律（不直连 provider HTTP/不存凭据/域模块独立可测，07b§1.7-AGENTS.md）随 R14 移植一并继承进 mroute 编码规范。

### 4.3 维护边界（复用代码升级漂移）

1. **移植即冻结**：抄进 mroute 的代码从上游版本 fork 后自行维护；NOTICE.md 记录来源版本号（如 `quota-panel@0.1.7-rc.1-v0.1@2026-11-13`），上游升级**不自动跟进**，回迁靠人工 diff。
2. **漂移高危面与兜底**：
   - **端点漂移**（智谱 quota/limit、方舟 Action、百炼控制台端点均属未文档化/易变面，02§二）：熔断器（R7/R8）+ `reviewed_against` 锚点（S5/R1 指纹）兜底——接口失效表现为 degraded 落 manual 值，不阻塞主链路；
   - **宿主 API 漂移**（07d§四-3 实录：`subagents.start` vs `startActivation` 代次漂移）：实现时**以宿主当前 d.ts/实源为准**，不照抄任一插件；peerDependencies 声明引擎线（是否精确 pin 到 rc 版本，仿 quota-panel 的宿主线 pin 策略由实现期决定，07a Pkg1-C）；
   - **词表漂移**（finish kind 三插件三样，B19）：宽表兼容 + 未知显式失败，天然抗漂移。
3. **复用部件的已知 bug 清单随码移植**：`AbortError` 必须重抛（provider-usage 实录）、200+HTML 先判再 parse（qwen-balance）、火山 200+ResponseMetadata.Error 查体不看状态（quota-panel）、undici `agent:false` 防 Windows 崩溃（qwen-balance）——这些「教训注释」是复用价值的一部分，禁止在移植时删除。

### 4.4 功能重叠与用户二选一（对 06 路 A/B/B' 的工程化结论）

| 已装插件 | 与 mroute 重叠度 | 建议 |
|----------|------------------|------|
| **dsh-quota-panel**（★12） | M4 面板上线前**互补**（它给人看余额全景 16 渠道，mroute 给模型看排序）；M4 后 UI 面板重叠 | 可共存到 M4；M4 上线后由用户决定去留——mroute 面板强在「编辑器+评测入口」，quota-panel 强在 ChatGPT 订阅/代理引擎等广度 |
| dsh-balance-monitor / dsh-musage | 同上，广度更小 | 与 quota-panel 同判 |
| dsh-delegate-router / dsh-autotier / dsh-llm-fallbacks | **指引语义重叠**（两套「怎么给子会话选模型」并存会互相打架） | **建议二选一**：要财务维度选 mroute；要任务轻重分派选它们（06 路 A 的正当性） |
| dsh-llm-governor | 「额度优先路由」字样重叠，但它走 agent/request 改写（0.2.2 撞墙通道）且渠道覆盖不明 | 二选一倾向 mroute（宿主演进安全）；若用户已装且满意则无迁移压力 |
| dsh-quota-takeover | 绑定 OFM 网关，与 mroute 通用多渠道不构成重叠 | 可共存 |
| dsh-aliyun-balance | 无重叠（悬浮挂件 vs 查询工具） | **推荐共存**（R16）：mroute B 类适配器上线前，它就是阿里券的人工对账窗口 |
| dsh-model-master | M5 上线后性能探针重叠 | M5 前推荐共存（TTFT 手测入口）；M5 后 mroute probe 列覆盖其功能 |
| dsh-eval-harness / dsh-agent-bench | 评「agent/插件」vs mroute 评「模型能力排名」 | 不重叠，共存 |

---

## 5. 工期估算（按复用比例粗估，单位人日）

> 口径：1 人日 = 一个熟悉 DSH 插件开发的开发者全天；复用比例越高估算越紧。自研占比：M1 ≈70% 自研、M2 ≈40%、M4 ≈50%、M5 ≈60%。

| 期 | 内容 | 复用支撑 | 人日估算 | 拆解 |
|----|------|----------|----------|------|
| **M1** | 注册表+查询工具+manual 登记+排序引擎（纯 Host 半） | catalog/活校验/渲染/policy 四态/预检可抄约 300 行 | **6–9** | S1 骨架 0.5；S2 schema 定稿+嵌套实测 1–1.5；S3 目录+活校验 1；S4 排序引擎（三层+DecisionRecord）2–3；S5 工具+提示 1.5；S6 端到端联调+验收 1–1.5 |
| **M2** | A 类四渠道自动余额+缓存+熔断 | 三渠道近原样移植+契约骨架+状态机可抄 | **4–6** | contract.js+describe()/QuotaView 1.5；四适配器移植联调 2（0.5/个）；缓存/单飞/退避/懒预热+熔断状态机 1.5；验收（真实 Key×4+缓存证明+密钥无明文+degraded 演练）1 |
| **M4** | 注册表可视化编辑器（Client 半启动） | 宿主同构先例+03§D.1 量化 400–700 行 | **5–8** | 分区挂载+导航 1；tier/priority/fallbacks/manual/reviewed_at 五类控件 2–3；两条写链（volatile 热更+configEditor）与冲突恢复 1.5；密钥侧牌+三层校验+locale×8+主题 token 1–1.5；验收 1 |
| **M5** | 评测引擎（suite+判分+通道②+护栏+写回闭环） | 探针/指纹/run 对比可移植；判分器与护栏自研为主 | **8–12** | suite schema+判分器（宽表 finish+哨兵+assert 映射）2；通道② runner（prepareCall 钉 effort+串行+断点）2；成本护栏四层 1.5；性能探针（R2）+指纹（R1）移植 1.5；EvalReport+面板 diff+「确认采纳」写回联动 2–2.5；验收 1.5 |
| M3（附注） | B/C 类适配器+D 类估算+券衰减 | 三套签名可抄（R3/R4/R5），熔断联调量大 | 5–8 | 券衰减排序属自研 S2，含在此期 |
| M6（附注） | 策略门整合+外部榜单 | guard 拒绝+四态前置已随 M1 的 policy.js 落了半边 | 3–5 | B18 榜单快照器 1.5；alias 映射队列+面板展示 1.5 |

**合计主线（M1→M2→M4→M5）约 23–35 人日**；若走 06 路 B'（先装 quota-panel 顶余额展示、mroute 只做 M1+排序+评测闭环）可再压缩 M2/M4 约 6–9 人日——但 M1 的 schema volatile 化与 eval 预留位**不可省**（05§7.2：返工成本不对称）。

---

## 6. 开工顺序建议（第一周）

1. **Day 1**：S1 包骨架 + NOTICE.md 出处在册 + S2 的嵌套对象 Config 实测（结论决定 §3.2-3 走哪条路，是 M1 唯一的环境风险点）；
2. **Day 2–3**：S2 schema 定稿 + S3 catalog/活校验（抄 R10/R11，两块合起来不到 100 行新代码）；
3. **Day 4–6**：S4 排序引擎（本方案自研核心 S1/S2 的最小实现：三层中 M1 先落 L1 静态层+L2 空账本占位，L3 感知层打分函数留桩但 tie-break 全序先固定）；
4. **Day 7–9**：S5 工具+提示 + S6 端到端联调（本机 5 provider 闭环）→ M1 六条验收 → 交 M2（四适配器移植，素材已备齐于 §3.3 出处表）。

---

## 附：本方案与上游文档的差异清零表（无一处推翻上游，仅落地化）

| 上游表述 | 本方案处理 |
|----------|-----------|
| 00§3.1 注册表 schema（草案） | §3.2 落地为定稿要点（volatile 化/嵌套降级/routeProvider 命名/eval 字段集冻结），字段语义未改 |
| 00§6 M1–M3 + 05§5.1 M1–M6 重排 | 全盘沿用；本方案只把 M1 拆到 S1–S6 步骤级，并预告 M2 首批四渠道出处 |
| 00§3.2 适配器四类 | 契约形状由 07a§汇总推荐接口冻结（B1 改造 + describe() 分叉），A/B/C/D 分类与熔断策略未改 |
| 05§2 架构图与两条数据流 | §2 重绘并叠加来源标注；两条写链机制原样有效 |
| 05§5.3 各期验收 | §3.6 M1 六条原样承接；M2/M4/M5 验收散入 §5 拆解列，未增删判据 |
| 06§三 空白 1–4 | 分别由自研 S1/S2/S3/S4 承接，定位表述未改 |
| 07a-d 四份复用分级表 | §1 三分清单为其并集去重版；许可结论（全 MIT+autotier Apache-2.0+eval-harness 无 LICENSE 需补取）逐条继承 |

*本方案为组装施工图：所有「复用/借鉴」判定以 07a–07d 源码分析的行号证据为准；行号与版本回溯到 vendors/ 本地 checkout 与 NOTICE.md。*
